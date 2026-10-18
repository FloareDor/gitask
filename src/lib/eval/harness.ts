/**
 * The eval runner.
 *
 * Walks a repo's questions, runs each one through both arms N times, grades
 * every answer, and emits one flat record per run. Flat on purpose: the export
 * is meant to be grouped and re-grouped later (by arm, by question type, by
 * repo) without the harness having to guess which cuts the deck will want.
 *
 * Runs are sequential. The point is reproducible numbers, not throughput, and
 * firing a dozen Flash calls at once is how you get rate-limited halfway
 * through an hour-long run.
 */

import type { KeyScope } from "../agent/providers/gemini";
import { EMBEDDING_MODEL_ID } from "../embedder";
import type { VectorStore } from "../vectorStore";
import type { AblationRow } from "./ablation";
import { runArm, type Arm, type ArmRun } from "./arms";
import { judgeAnswer, type Verdict } from "./judge";
import { questionsForRepo, EVAL_SET } from "./questions";
import { deriveRelevance, scoreCitations, type CitationScore } from "./scoring";
import type { EvalQuestion } from "./types";

export interface EvalRecord {
	questionId: string;
	repo: string;
	type: EvalQuestion["type"];
	source: EvalQuestion["source"];
	arm: Arm;
	/** 1-based, so three runs read as 1 of 3. */
	run: number;
	answer: string;
	verdict: Verdict;
	judgeReason: string;
	/** The judge's reply couldn't be parsed; drop this row from correctness. */
	judgeUnreadable?: boolean;
	citation: CitationScore;
	tokensIn: number;
	tokensOut: number;
	judgeTokensIn: number;
	judgeTokensOut: number;
	elapsedMs: number;
	steps?: number;
	toolBytes?: number;
	stopReason?: ArmRun["stopReason"];
	refused?: boolean;
	error?: string;
}

export interface RepoSummary {
	repo: string;
	ref: string;
	questionCount: number;
	indexedChunks: number;
	/**
	 * Gold files the loaded index doesn't contain. Non-empty means the index is
	 * at the wrong ref, or `isIndexable` dropped the file — either way those
	 * questions can't be answered and the number has to be disclosed.
	 */
	missingGoldPaths: string[];
}

export interface EvalProgress {
	done: number;
	total: number;
	questionId: string;
	arm: Arm;
	run: number;
}

export interface RunEvalOptions {
	withKey: KeyScope;
	/** Runs per question per arm. Three is the floor for a variance bar. */
	runs?: number;
	arms?: Arm[];
	model?: string;
	maxSteps?: number;
	/** Narrow to a few questions — useful for a smoke run before the real one. */
	questionIds?: string[];
	onRecord?: (record: EvalRecord) => void;
	onProgress?: (progress: EvalProgress) => void;
	signal?: AbortSignal;
}

export const DEFAULT_RUNS = 3;
const DEFAULT_ARMS: Arm[] = ["rag", "agent"];

/** Gold files this index can't answer from, across the repo's questions. */
export function summarizeRepo(store: VectorStore, repo: string): RepoSummary {
	const questions = questionsForRepo(repo);
	const chunks = store.getAll();
	const missing = new Set<string>();
	for (const question of questions) {
		for (const path of deriveRelevance(chunks, question).missingPaths) missing.add(path);
	}
	return {
		repo,
		ref: questions[0]?.ref ?? "",
		questionCount: questions.length,
		indexedChunks: chunks.length,
		missingGoldPaths: [...missing].sort(),
	};
}

export async function runEvalForRepo(
	store: VectorStore,
	repo: string,
	options: RunEvalOptions
): Promise<EvalRecord[]> {
	const runs = options.runs ?? DEFAULT_RUNS;
	const arms = options.arms ?? DEFAULT_ARMS;
	const questions = questionsForRepo(repo)
		.filter((question) => !options.questionIds || options.questionIds.includes(question.id));

	const records: EvalRecord[] = [];
	const total = questions.length * arms.length * runs;
	let done = 0;

	for (const question of questions) {
		for (const arm of arms) {
			for (let run = 1; run <= runs; run += 1) {
				if (options.signal?.aborted) return records;
				options.onProgress?.({ done, total, questionId: question.id, arm, run });

				const result = await runArm(arm, store, question, {
					withKey: options.withKey,
					model: options.model,
					maxSteps: options.maxSteps,
				});

				// A run that threw never produced an answer; judging it would just
				// burn a call to be told the empty string is wrong.
				const judged = result.error
					? { verdict: "wrong" as Verdict, reason: result.error, tokensIn: 0, tokensOut: 0 }
					: await judgeAnswer(options.withKey, {
						question: question.question,
						goldAnswer: question.goldAnswer,
						answer: result.answer,
					}, options.model);

				const record: EvalRecord = {
					questionId: question.id,
					repo: question.repo,
					type: question.type,
					source: question.source,
					arm,
					run,
					answer: result.answer,
					verdict: judged.verdict,
					judgeReason: judged.reason,
					judgeUnreadable: "unreadable" in judged ? judged.unreadable : undefined,
					citation: scoreCitations(result.citations, question.goldLocations),
					tokensIn: result.tokensIn,
					tokensOut: result.tokensOut,
					judgeTokensIn: judged.tokensIn,
					judgeTokensOut: judged.tokensOut,
					elapsedMs: result.elapsedMs,
					steps: result.steps,
					toolBytes: result.toolBytes,
					stopReason: result.stopReason,
					refused: result.refused,
					error: result.error,
				};

				records.push(record);
				options.onRecord?.(record);
				done += 1;
			}
		}
	}

	options.onProgress?.({ done, total, questionId: "", arm: arms[0], run: runs });
	return records;
}

export interface EvalExport {
	generatedAt: string;
	evalSet: string;
	provenance: string;
	model: string;
	embeddingModel: string;
	runsPerQuestion: number;
	repos: RepoSummary[];
	records: EvalRecord[];
	/** The retrieval ablation, run on these same questions. */
	ablation: AblationRow[];
}

export function buildExport(options: {
	model: string;
	runs: number;
	repos: RepoSummary[];
	records: EvalRecord[];
	ablation: AblationRow[];
}): EvalExport {
	return {
		generatedAt: new Date().toISOString(),
		evalSet: EVAL_SET.name,
		provenance: EVAL_SET.provenance,
		model: options.model,
		embeddingModel: EMBEDDING_MODEL_ID,
		runsPerQuestion: options.runs,
		repos: options.repos,
		records: options.records,
		ablation: options.ablation,
	};
}
