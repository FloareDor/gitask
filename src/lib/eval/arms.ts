/**
 * The two things being compared.
 *
 * Both arms get the same index, the same model and the same question. The RAG
 * arm runs the app's own retrieval and prompt (`lib/ragAnswer.ts`); the agent
 * arm runs the app's own loop (`lib/agent/loop.ts`). Nothing about retrieval is
 * reimplemented here — this file only drives them and records what came out.
 */

import type { Citation } from "../agent/citations";
import { parseCitations } from "../agent/citations";
import { geminiProvider, type KeyScope } from "../agent/providers/gemini";
import { runAgent, type StopReason } from "../agent/loop";
import { defaultLimitsForProvider } from "../contextAssembly";
import { buildCorrelatedCitationResults } from "../citationUtils";
import { assembleRagContext, buildRagSystemPrompt, retrieveForQuery } from "../ragAnswer";
import type { SearchResult, VectorStore } from "../vectorStore";
import { geminiOneShot } from "./gemini";
import type { EvalQuestion } from "./types";

export type Arm = "rag" | "agent";

/**
 * One tool call from an agent run, kept so Phase 5 can bucket failures.
 *
 * Aggregates alone can't tell "looped on a tool" from "read the wrong file"
 * from "truncation hid the answer" — those need the per-step record, and the
 * run is far too expensive to repeat just to recover it.
 */
export interface TraceStep {
	step: number;
	tool: string;
	args: Record<string, unknown>;
	bytes: number;
	truncated: boolean;
	duplicate: boolean;
	isError: boolean;
	elapsedMs: number;
}

export interface ArmRun {
	arm: Arm;
	answer: string;
	citations: Citation[];
	tokensIn: number;
	tokensOut: number;
	elapsedMs: number;
	/** Agent only. */
	steps?: number;
	toolBytes?: number;
	stopReason?: StopReason;
	/** Agent only: what it actually did, step by step. */
	trace?: TraceStep[];
	/** The RAG arm refused rather than answering: injection block or no evidence. */
	refused?: boolean;
	/** The run threw. The harness keeps the row so failures are visible. */
	error?: string;
}

/** One citation per cited chunk. Merging per file would inflate RAG's precision. */
function citationsFromResults(results: SearchResult[]): Citation[] {
	const seen = new Set<string>();
	const citations: Citation[] = [];
	for (const result of results) {
		const startLine = Math.max(1, Math.floor(result.chunk.startLine ?? 1));
		const endLine = Math.max(startLine, Math.floor(result.chunk.endLine ?? startLine));
		const key = `${result.chunk.filePath}:${startLine}-${endLine}`;
		if (seen.has(key)) continue;
		seen.add(key);
		citations.push({ path: result.chunk.filePath, startLine, endLine });
	}
	return citations;
}

export interface ArmOptions {
	withKey: KeyScope;
	model?: string;
	maxSteps?: number;
}

export async function runRagArm(
	store: VectorStore,
	question: EvalQuestion,
	options: ArmOptions
): Promise<ArmRun> {
	const started = performance.now();
	const [owner, repo] = question.repo.split("/");
	// Fixed at the hosted-provider budget: the eval is not measuring what a 0.5B
	// local model can fit, and both arms must see the same ceiling.
	const limits = defaultLimitsForProvider("gemini");

	try {
		const retrieval = await retrieveForQuery(store, {
			userMessage: question.question,
			queryText: question.question,
			priorMessages: [],
			provider: "gemini",
			queryExpansion: true,
		});

		const assembled = assembleRagContext(store, retrieval.results, question.question, limits);

		if (assembled.blocked || assembled.ungrounded) {
			// A refusal is an answer the user got. It is graded, not skipped.
			return {
				arm: "rag",
				answer: assembled.blocked
					? "Blocked: the retrieved code looked like a prompt injection."
					: "I couldn't find enough relevant code to answer this confidently.",
				citations: citationsFromResults(assembled.groundedCitationResults),
				tokensIn: 0,
				tokensOut: 0,
				elapsedMs: performance.now() - started,
				refused: true,
			};
		}

		const safeContext = assembled.safeContext!;
		const reply = await geminiOneShot(options.withKey, {
			system: buildRagSystemPrompt({
				owner,
				repo,
				provider: "gemini",
				context: safeContext.safeContext,
				injectionScan: assembled.injectionScan,
			}),
			prompt: question.question,
			model: options.model,
		});

		const correlated = buildCorrelatedCitationResults(
			retrieval.results, question.question, reply.text, safeContext.excludedCitationIds
		);
		const cited = correlated.length > 0 ? correlated : assembled.groundedCitationResults;

		return {
			arm: "rag",
			answer: reply.text,
			citations: citationsFromResults(cited),
			tokensIn: reply.tokensIn,
			tokensOut: reply.tokensOut,
			elapsedMs: performance.now() - started,
		};
	} catch (error) {
		return {
			arm: "rag",
			answer: "",
			citations: [],
			tokensIn: 0,
			tokensOut: 0,
			elapsedMs: performance.now() - started,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runAgentArm(
	store: VectorStore,
	question: EvalQuestion,
	options: ArmOptions
): Promise<ArmRun> {
	const started = performance.now();
	const run: ArmRun = {
		arm: "agent",
		answer: "",
		citations: [],
		tokensIn: 0,
		tokensOut: 0,
		elapsedMs: 0,
		steps: 0,
		toolBytes: 0,
		trace: [],
	};
	const trace = run.trace as TraceStep[];
	// A call's args arrive with tool_call and its outcome with tool_result, so
	// the two halves are stitched by id.
	const pendingArgs = new Map<string, { step: number; args: Record<string, unknown> }>();

	try {
		for await (const event of runAgent(question.question, store, {
			provider: geminiProvider({ withKey: options.withKey, model: options.model }),
			repo: question.repo,
			maxSteps: options.maxSteps,
		})) {
			if (event.type === "tool_call") {
				pendingArgs.set(event.id, { step: event.step, args: event.args });
			} else if (event.type === "tool_result") {
				const call = pendingArgs.get(event.id);
				trace.push({
					step: call?.step ?? event.step,
					tool: event.name,
					args: call?.args ?? {},
					bytes: event.bytes,
					truncated: event.truncated,
					duplicate: event.duplicate,
					isError: event.isError,
					elapsedMs: event.elapsedMs,
				});
				pendingArgs.delete(event.id);
			} else if (event.type === "answer") {
				run.answer = event.text;
				run.citations = event.citations;
				run.tokensIn = event.tokensIn;
				run.tokensOut = event.tokensOut;
				run.steps = event.steps;
				run.toolBytes = event.toolBytes;
				run.stopReason = event.stopReason;
			} else if (event.type === "error") {
				run.error = event.message;
			}
		}
		// The loop rejects uncited answers, but a provider error can still leave
		// text with citations only in prose. Parse as a backstop.
		if (run.citations.length === 0 && run.answer) {
			run.citations = parseCitations(run.answer);
		}
	} catch (error) {
		run.error = error instanceof Error ? error.message : String(error);
	}

	run.elapsedMs = performance.now() - started;
	return run;
}

export function runArm(
	arm: Arm,
	store: VectorStore,
	question: EvalQuestion,
	options: ArmOptions
): Promise<ArmRun> {
	return arm === "rag" ? runRagArm(store, question, options) : runAgentArm(store, question, options);
}
