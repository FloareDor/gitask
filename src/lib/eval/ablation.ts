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
import { deriveRelevance } from "./scoring";

export interface AblationRow {
	config: string;
	description: string;
	repo: string;
	/** Questions with at least one relevant chunk in this index. */
	questions: number;
	avgRecallAt5: number;
	avgMRR: number;
	avgNdcgAt10: number;
	avgLatencyMs: number;
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
	const prepared: { text: string; embedding: number[]; relevantChunkIds: string[]; relevanceScores: Record<string, number> }[] = [];
	for (const question of questions) {
		if (options.signal?.aborted) return [];
		const derived = deriveRelevance(chunks, question);
		// Nothing to find means nothing to score — usually the index is at the
		// wrong ref. Counting it as a miss would understate every config equally.
		if (derived.relevantChunkIds.length === 0) continue;
		prepared.push({
			text: question.question,
			embedding: await options.embedQuery(question.question),
			relevantChunkIds: derived.relevantChunkIds,
			relevanceScores: derived.relevanceScores,
		});
	}

	const rows: AblationRow[] = [];
	for (const config of ABLATION_CONFIGS) {
		const recalls: number[] = [];
		const mrrs: number[] = [];
		const ndcgs: number[] = [];
		const latencies: number[] = [];

		for (const [index, question] of prepared.entries()) {
			if (options.signal?.aborted) return rows;
			options.onProgress?.({ config: config.name, done: index, total: prepared.length });

			const started = performance.now();
			const results = await config.run(store, question.embedding, question.text, limit);
			latencies.push(performance.now() - started);

			recalls.push(recallAtK(results, question.relevantChunkIds, 5));
			mrrs.push(meanReciprocalRank(results, question.relevantChunkIds));
			ndcgs.push(ndcgAtK(results, question.relevanceScores, 10));
		}

		const avg = (values: number[]) => values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
		rows.push({
			config: config.name,
			description: config.description,
			repo,
			questions: prepared.length,
			avgRecallAt5: avg(recalls),
			avgMRR: avg(mrrs),
			avgNdcgAt10: avg(ndcgs),
			avgLatencyMs: avg(latencies),
		});
	}

	return rows;
}
