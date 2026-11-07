/**
 * The agent loop.
 *
 * Calls the model with tools, runs whatever it asks for, feeds the results back,
 * and stops. Everything interesting here is a guard rail: the loop assumes the
 * model will loop, over-read, and skip citations, and makes each of those
 * bounded rather than fatal.
 */

import { recordAgent } from "../metrics";
import type { VectorStore } from "../vectorStore";
import { parseCitations, type Citation } from "./citations";
import type { AgentMessage, ProviderReply, ToolCall, ToolProvider } from "./provider";
import {
	ALL_TOOL_NAMES,
	TOOL_SETS,
	runTool,
	schemasForToolSet,
	type RunToolOptions,
	type ToolSet,
} from "./schemas";
import { TOOL_LIMITS, ToolError } from "./types";

export const DEFAULT_MAX_STEPS = 12;
/** Total tool output the model may accumulate before it has to answer. */
export const DEFAULT_MAX_CONTEXT_BYTES = 60_000;

export type StopReason = "answered" | "step_cap" | "context_budget";

export type AgentEvent =
	| { type: "thinking"; step: number; text: string }
	| { type: "tool_call"; step: number; id: string; name: string; args: Record<string, unknown> }
	| {
		type: "tool_result";
		step: number;
		id: string;
		name: string;
		text: string;
		truncated: boolean;
		bytes: number;
		elapsedMs: number;
		/** The call was suppressed as a repeat; nothing actually ran. */
		duplicate: boolean;
		isError: boolean;
	}
	| {
		type: "answer";
		text: string;
		citations: Citation[];
		steps: number;
		toolBytes: number;
		tokensIn: number;
		tokensOut: number;
		elapsedMs: number;
		stopReason: StopReason;
	}
	| { type: "error"; message: string };

export interface AgentOptions {
	provider: ToolProvider;
	maxSteps?: number;
	maxContextBytes?: number;
	/** `owner/repo`, for the prompt and for metrics. */
	repo?: string;
	signal?: AbortSignal;
	/** Which tools the model is offered. Default: all of them. */
	toolSet?: ToolSet;
}

/**
 * The "How to work" lines. The full set is the prompt every measured agent run
 * used, and must stay byte-identical; the search-only variant only drops the
 * instructions that name tools it does not have.
 */
function workingRules(toolSet: ToolSet, maxSteps: number): string[] {
	if (toolSet === "search_only") {
		return [
			"- Your only tool is semantic_search. Each result gives a file path, a line range, and the code in that range.",
			"- Never describe code you have not seen in a search result.",
			"- Follow the trail. If the answer depends on what another function does, search for it by name.",
			`- Stop as soon as you can answer. You have at most ${maxSteps} turns of tool calls.`,
			"- If a result says it was truncated, you are not seeing everything. Narrow your query rather than assuming.",
		];
	}
	// The nav rules are the full rules plus the two habits the interface exists
	// to encourage: work file-first, and check the neighbours before committing
	// to a symbol. Everything else is identical, so the arms stay comparable.
	if (toolSet === "nav") {
		return [
			"- Locate code first with semantic_search or find_definition. Use grep for exact strings like config keys or error messages.",
			"- semantic_search returns files, not loose snippets. Work one file at a time: look at what matched in it and at the neighbouring symbols listed beside the matches.",
			"- Before you settle on a function, check the other symbols in its file. A file often holds several similarly named functions and only one of them answers the question.",
			"- Call list_symbols on an unfamiliar file before read_file. The outline is cheap and usually tells you exactly which lines to read.",
			"- Read a file before describing it. Never describe code you have not seen in a tool result.",
			"- Follow the trail. If the answer depends on what another function does, go look at it.",
			`- Stop as soon as you can answer. You have at most ${maxSteps} turns of tool calls.`,
			"- If a result says it was truncated, you are not seeing everything. Narrow your query rather than assuming.",
		];
	}
	return [
		"- Locate code first with semantic_search or find_definition. Use grep for exact strings like config keys or error messages.",
		"- Read a file before describing it. Never describe code you have not seen in a tool result.",
		"- Follow the trail. If the answer depends on what another function does, go look at it.",
		`- Stop as soon as you can answer. You have at most ${maxSteps} turns of tool calls.`,
		"- If a result says it was truncated, you are not seeing everything. Narrow your query rather than assuming.",
	];
}

export function buildSystemPrompt(
	repo: string | undefined,
	maxSteps: number,
	toolSet: ToolSet = "full"
): string {
	const target = repo ? `the ${repo} repository` : "this repository";
	return [
		`You are a code investigator working on ${target}. Answer the question by reading the code, not by guessing.`,
		"",
		"How to work:",
		...workingRules(toolSet, maxSteps),
		"",
		// "Only what you have seen" stops invention but says nothing about
		// relevance, so the model cited every file it opened while narrowing
		// down. Measured: a third of multi-hop citations pointed at files that
		// were visited and then turned out to be irrelevant.
		"Citations are mandatory, and a citation is a claim that those exact lines show what you just said:",
		"- Follow every factual claim with a citation of the form path:startLine-endLine, for example src/lib/search.ts:151-170.",
		"- Cite the narrowest range that actually supports the claim, and only lines you have seen in a tool result.",
		toolSet === "search_only"
			? "- Seeing code in a search result is not a reason to cite it. Most of what you see while narrowing down does not belong in the answer — if a line does not support a specific claim, leave it out."
			: "- Opening a file is not a reason to cite it. Most of what you read while narrowing down does not belong in the answer — if a line does not support a specific claim, leave it out.",
		"- If you could not find something, say so plainly. Never invent a file, symbol, or line number.",
	].join("\n");
}

const FORCE_ANSWER_PROMPT =
	"You have used all your tool calls. Answer now using only what you have already read, " +
	"and say which parts you could not confirm.";

const CITATION_RETRY_PROMPT =
	"That answer has no citations. Rewrite it with a path:startLine-endLine citation after every " +
	"factual claim, using only line numbers from the tool results above, and citing the narrowest " +
	"range that supports each claim rather than every file you looked at.";

/** Stable key for duplicate detection — argument order must not matter. */
function callKey(call: ToolCall): string {
	const sorted = Object.keys(call.args)
		.sort()
		.map((k) => [k, call.args[k]] as const);
	return `${call.name}(${JSON.stringify(sorted)})`;
}

/** Tool output the model sees. Compact on purpose; it pays for every byte. */
function renderResult(name: string, result: unknown, truncated: boolean): string {
	const body = JSON.stringify(result);
	const note = truncated ? `\n[truncated — ${name} hit its output cap]` : "";
	return body + note;
}

export async function* runAgent(
	question: string,
	store: VectorStore,
	options: AgentOptions
): AsyncGenerator<AgentEvent> {
	const {
		provider,
		maxSteps = DEFAULT_MAX_STEPS,
		maxContextBytes = DEFAULT_MAX_CONTEXT_BYTES,
		repo,
		signal,
		toolSet = "full",
	} = options;

	const allowed = new Set(TOOL_SETS[toolSet]);
	const schemas = schemasForToolSet(toolSet);
	// Without read_file, search results are the only view of the code, so they
	// show as much of each chunk as the RAG arm's context does. The nav arm
	// keeps the default snippet size — it has read_file, and the extra bytes it
	// spends go on the neighbour sketch instead.
	const runOptions: RunToolOptions =
		toolSet === "search_only"
			? { snippetChars: TOOL_LIMITS.MAX_SNIPPET_CHARS_SEARCH_ONLY }
			: toolSet === "nav"
				? { groupByFile: true }
				: {};

	const startedAt = Date.now();
	const system = buildSystemPrompt(repo, maxSteps, toolSet);
	const messages: AgentMessage[] = [{ role: "user", text: question }];
	const seenCalls = new Map<string, number>();

	let step = 0;
	let toolBytes = 0;
	let tokensIn = 0;
	let tokensOut = 0;

	const tally = (reply: ProviderReply) => {
		tokensIn += reply.tokensIn ?? 0;
		tokensOut += reply.tokensOut ?? 0;
		return reply;
	};

	const ask = (useTools: boolean) => {
		if (signal?.aborted) throw new Error("Agent run cancelled.");
		return provider
			.callWithTools(messages, { system, tools: useTools ? schemas : [], signal })
			.then(tally);
	};

	try {
		let final: ProviderReply | null = null;
		let stopReason: StopReason = "answered";

		while (step < maxSteps) {
			// Once the budget is spent the model gets no tools, which forces prose.
			const withinBudget = toolBytes < maxContextBytes;
			const reply = await ask(withinBudget);

			if (reply.toolCalls.length === 0) {
				final = reply;
				stopReason = withinBudget ? "answered" : "context_budget";
				break;
			}

			step++;
			const thinking = reply.text.trim();
			if (thinking) yield { type: "thinking", step, text: thinking };
			messages.push({ role: "model", text: reply.text || undefined, toolCalls: reply.toolCalls });

			for (const call of reply.toolCalls) {
				yield { type: "tool_call", step, id: call.id, name: call.name, args: call.args };

				const key = callKey(call);
				const previousStep = seenCalls.get(key);
				const callStartedAt = Date.now();

				let text: string;
				let truncated = false;
				let bytes = 0;
				let isError = false;

				if (previousStep !== undefined) {
					// Re-running it would burn a turn for the same bytes. Say so instead.
					text =
						`You already ran this exact call at step ${previousStep}. ` +
						"The result has not changed. Use a different tool or different arguments.";
				} else {
					seenCalls.set(key, step);
					try {
						// The model only saw the allowed schemas, but nothing stops it naming
						// another tool. Running it anyway would quietly void the ablation.
						if (ALL_TOOL_NAMES.includes(call.name) && !allowed.has(call.name)) {
							throw new ToolError(
								`Tool "${call.name}" is not available. Available: ${[...allowed].join(", ")}.`
							);
						}
						const outcome = await runTool(store, call, runOptions);
						truncated = outcome.truncated;
						bytes = outcome.bytes;
						toolBytes += bytes;
						text = renderResult(call.name, outcome.result, outcome.truncated);
					} catch (e) {
						isError = true;
						// ToolError is the model's mistake and is recoverable; anything
						// else is ours, and the run should stop.
						if (!(e instanceof ToolError)) throw e;
						text = `Error: ${e.message}`;
					}
				}

				yield {
					type: "tool_result",
					step,
					id: call.id,
					name: call.name,
					text,
					truncated,
					bytes,
					elapsedMs: Date.now() - callStartedAt,
					duplicate: previousStep !== undefined,
					isError,
				};
				messages.push({ role: "tool", callId: call.id, name: call.name, text });
			}
		}

		if (!final) {
			stopReason = "step_cap";
			messages.push({ role: "user", text: FORCE_ANSWER_PROMPT });
			final = await ask(false);
		}

		let text = final.text.trim();
		let citations = parseCitations(text);

		// One retry. An uncited answer is unverifiable, and Phase 6 has nothing to check.
		if (citations.length === 0 && text) {
			messages.push({ role: "model", text });
			messages.push({ role: "user", text: CITATION_RETRY_PROMPT });
			const retry = await ask(false);
			const retryCitations = parseCitations(retry.text);
			if (retryCitations.length > 0) {
				text = retry.text.trim();
				citations = retryCitations;
			}
		}

		const elapsedMs = Date.now() - startedAt;
		recordAgent(provider.id, elapsedMs, tokensIn, tokensOut, step, repo);

		yield {
			type: "answer",
			text,
			citations,
			steps: step,
			toolBytes,
			tokensIn,
			tokensOut,
			elapsedMs,
			stopReason,
		};
	} catch (e) {
		yield { type: "error", message: e instanceof Error ? e.message : String(e) };
	}
}
