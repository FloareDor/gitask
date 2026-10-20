/**
 * The retrieval ablation, run on the eval questions.
 *
 * The existing ablation grades retrieval against a fixed CodeSearchNet corpus.
 * This runs the same configs against the real index for the real questions, so
 * the deck's "RAG baseline is strong" table and its "agent beats RAG" table are
 * about the same 45 questions rather than two unrelated corpora.
 *
 * Relevance labels come from `deriveRelevance`, not from a stored annotation —
 * a chunk is relevant when it overlaps a gold span.
 */

import { ABLATION_CONFIGS, meanReciprocalRank, ndcgAtK, recallAtK } from "../ablationConfigs";
import type { VectorStore } from "../vectorStore";
import { questionsForRepo } from "./questions";
import type { EvalQuestion } from "./types";
import { deriveRelevance } from "./scoring";

export interface AblationRow {
	config: string;
	description: string;
	repo: string;
	/**
	 * Which questions this row covers. The split is the point: a component that
	 * only matters when the answer is spread across files should show up here
	 * and nowhere else, and an aggregate row averages that signal away.
	 */
	questionType: "all" | "lookup" | "multihop";
	/** Questions with at least one relevant chunk in this index. */
	questions: number;
	avgRecallAt5: number;
	avgMRR: number;
	avgNdcgAt10: number;
	avgLatencyMs: number;
	/**
	 * Standard error across questions. Retrieval is deterministic, so there is no
	 * run-to-run variance to report — but 15 questions is a small sample and the
	 * spread between them is the honest uncertainty on each mean.
	 */
	stderrRecallAt5: number;
	stderrMRR: number;
	stderrNdcgAt10: number;
}

export interface AblationProgress {
	config: string;
	done: number;
	total: number;
}

export interface RunAblationOptions {
	embedQuery: (text: string) => Promise<number[]>;
	limit?: number;
	onProgress?: (progress: AblationProgress) => void;
	signal?: AbortSignal;
}

const DEFAULT_LIMIT = 10;

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stderr(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance / values.length);
}

export async function runAblationForRepo(
	store: VectorStore,
	repo: string,
	options: RunAblationOptions
): Promise<AblationRow[]> {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const chunks = store.getAll();
	const questions = questionsForRepo(repo);

	// Embed once and reuse across configs: the ablation is about retrieval, and
	// re-embedding per config would put the embedder in every latency number.
	const prepared: { text: string; type: EvalQuestion["type"]; embedding: number[]; relevantChunkIds: string[]; relevanceScores: Record<string, number> }[] = [];
	for (const question of questions) {
		if (options.signal?.aborted) return [];
		const derived = deriveRelevance(chunks, question);
		// Nothing to find means nothing to score — usually the index is at the
		// wrong ref. Counting it as a miss would understate every config equally.
		if (derived.relevantChunkIds.length === 0) continue;
		prepared.push({
			text: question.question,
			type: question.type,
			embedding: await options.embedQuery(question.question),
			relevantChunkIds: derived.relevantChunkIds,
			relevanceScores: derived.relevanceScores,
		});
	}

	const rows: AblationRow[] = [];
	for (const config of ABLATION_CONFIGS) {
		type Measured = { type: EvalQuestion["type"]; recall: number; mrr: number; ndcg: number; latency: number };
		const measured: Measured[] = [];

		for (const [index, question] of prepared.entries()) {
			if (options.signal?.aborted) return rows;
			options.onProgress?.({ config: config.name, done: index, total: prepared.length });

			const started = performance.now();
			const results = await config.run(store, question.embedding, question.text, limit);
			const latency = performance.now() - started;

			measured.push({
				type: question.type,
				recall: recallAtK(results, question.relevantChunkIds, 5),
				mrr: meanReciprocalRank(results, question.relevantChunkIds),
				ndcg: ndcgAtK(results, question.relevanceScores, 10),
				latency,
			});
		}

		const emit = (questionType: AblationRow["questionType"], subset: Measured[]) => {
			if (subset.length === 0) return;
			rows.push({
				config: config.name,
				description: config.description,
				repo,
				questionType,
				questions: subset.length,
				avgRecallAt5: mean(subset.map((m) => m.recall)),
				avgMRR: mean(subset.map((m) => m.mrr)),
				avgNdcgAt10: mean(subset.map((m) => m.ndcg)),
				avgLatencyMs: mean(subset.map((m) => m.latency)),
				stderrRecallAt5: stderr(subset.map((m) => m.recall)),
				stderrMRR: stderr(subset.map((m) => m.mrr)),
				stderrNdcgAt10: stderr(subset.map((m) => m.ndcg)),
			});
		};

		emit("all", measured);
		emit("lookup", measured.filter((m) => m.type === "lookup"));
		emit("multihop", measured.filter((m) => m.type === "multihop"));
	}

	return rows;
}
