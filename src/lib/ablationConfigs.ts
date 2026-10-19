/**
 * The retrieval ablation, as a module.
 *
 * Each config is the full pipeline with one component removed, so the table
 * reads as "what does this part buy us". Pulled out of `ablation.test.ts` so the
 * same configs can be run in the browser against a real index and the real eval
 * questions — the test file keeps the two configs that need a mocked embedder.
 *
 * Every config takes a `VectorStore` rather than a bare chunk list, because the
 * graph expansion step needs the import graph the indexer actually built.
 */

import { bm25Search } from "./bm25";
import type { EmbeddedChunk } from "./embedder";
import { expandCandidatesWithGraph } from "./graphExpansion";
import { cosineSimilarity } from "./quantize";
import { hybridSearch, reciprocalRankFusion, vectorSearch } from "./search";
import type { SearchResult, VectorStore } from "./vectorStore";

export const COSINE_RERANK_WEIGHT = 0.7;
const FUSED_PRIOR_WEIGHT = 1 - COSINE_RERANK_WEIGHT;
const GRAPH_EXPANSION_SEED_COUNT = 20;
const GRAPH_EXPANSION_WEIGHT = 0.5;
const COARSE_CANDIDATES = 50;
const RRF_K = 60;

export type AblationSearchFn = (
	store: VectorStore,
	queryEmbedding: number[],
	queryText: string,
	limit?: number
) => SearchResult[] | Promise<SearchResult[]>;

export const searchFullPipeline: AblationSearchFn = (store, queryEmbedding, queryText, limit = 5) =>
	hybridSearch(store, queryEmbedding, queryText, {
		limit,
		coarseCandidates: COARSE_CANDIDATES,
		rrfK: RRF_K,
	});

/** Full-precision cosine instead of the Hamming coarse pass. */
export const searchNoQuantization: AblationSearchFn = async (store, queryEmbedding, queryText, limit = 5) => {
	const chunks = store.getAll();
	const cosScores = new Map<string, number>();
	for (const chunk of chunks) cosScores.set(chunk.id, cosineSimilarity(queryEmbedding, chunk.embedding));

	const sparseScores = await bm25Search(chunks, queryText, { limit: COARSE_CANDIDATES });
	const fused = reciprocalRankFusion([cosScores, sparseScores], RRF_K);
	const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, COARSE_CANDIDATES);
	const expanded = expandCandidatesWithGraph(store, candidates, {
		seedCount: GRAPH_EXPANSION_SEED_COUNT,
		expansionWeight: GRAPH_EXPANSION_WEIGHT,
	});
	const maxFused = expanded.reduce((max, [, score]) => Math.max(max, score), 0);

	return rerank(chunks, expanded, queryEmbedding, maxFused).slice(0, limit);
};

/**
 * Dense retrieval and a cosine rerank, nothing else.
 *
 * This removes three things at once — BM25, RRF fusion and graph expansion —
 * so it is a "how far does dense alone get you" baseline rather than a clean
 * single-component ablation. Read it that way; the gap between this and the
 * full pipeline cannot be attributed to any one of the three.
 */
export const searchVectorOnly: AblationSearchFn = (store, queryEmbedding, _queryText, limit = 5) => {
	const chunks = store.getAll();
	const vectorScores = vectorSearch(chunks, queryEmbedding, COARSE_CANDIDATES, store.getAllBinaries());
	const candidates = [...vectorScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, COARSE_CANDIDATES);

	const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
	const results: SearchResult[] = [];
	for (const [id] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		results.push({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding), embedding: chunk.embedding });
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
};

/** Fused rank order straight through, with no cosine rerank on top. */
export const searchNoReranking: AblationSearchFn = async (store, queryEmbedding, queryText, limit = 5) => {
	const chunks = store.getAll();
	const vectorScores = vectorSearch(chunks, queryEmbedding, COARSE_CANDIDATES, store.getAllBinaries());
	const sparseScores = await bm25Search(chunks, queryText, { limit: COARSE_CANDIDATES });
	const fused = reciprocalRankFusion([vectorScores, sparseScores], RRF_K);
	const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, COARSE_CANDIDATES);
	const expanded = expandCandidatesWithGraph(store, candidates, {
		seedCount: GRAPH_EXPANSION_SEED_COUNT,
		expansionWeight: GRAPH_EXPANSION_WEIGHT,
	});

	const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
	const results: SearchResult[] = [];
	for (const [id, score] of expanded.sort((a, b) => b[1] - a[1]).slice(0, limit)) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		results.push({ chunk, score, embedding: chunk.embedding });
	}
	return results;
};

function rerank(
	chunks: EmbeddedChunk[],
	candidates: [string, number][],
	queryEmbedding: number[],
	maxFused: number
): SearchResult[] {
	const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
	const results: SearchResult[] = [];
	for (const [id, fusedScore] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		const fusedPrior = maxFused > 0 ? fusedScore / maxFused : 0;
		results.push({
			chunk,
			score: cosineSimilarity(queryEmbedding, chunk.embedding) * COSINE_RERANK_WEIGHT
				+ fusedPrior * FUSED_PRIOR_WEIGHT,
			embedding: chunk.embedding,
		});
	}
	results.sort((a, b) => b.score - a.score);
	return results;
}

export interface AblationConfig {
	name: string;
	description: string;
	run: AblationSearchFn;
}

/**
 * The configs that need nothing but an index and a query vector. The two that
 * drive `multiPathHybridSearch` or PageIndex call the embedder themselves and
 * live in `ablation.test.ts`, where it can be mocked.
 */
export const ABLATION_CONFIGS: AblationConfig[] = [
	{
		name: "Full Pipeline",
		description: "Hamming coarse retrieval + BM25 + RRF + graph expansion + cosine rerank",
		run: searchFullPipeline,
	},
	{
		name: "No Quantization",
		description: "Full cosine retrieval in place of the Hamming coarse pass",
		run: searchNoQuantization,
	},
	{
		name: "Vector-Only",
		description: "Hamming coarse retrieval + cosine rerank — no BM25, no RRF, no graph expansion",
		run: searchVectorOnly,
	},
	{
		name: "No Reranking",
		description: "Fused rank order straight through, no cosine rerank",
		run: searchNoReranking,
	},
];

// ─── Metrics ─────────────────────────────────────────────────────────────────

export function recallAtK(results: SearchResult[], relevant: string[], k: number): number {
	if (relevant.length === 0) return 0;
	const topK = new Set(results.slice(0, k).map((result) => result.chunk.id));
	return relevant.filter((id) => topK.has(id)).length / relevant.length;
}

export function meanReciprocalRank(results: SearchResult[], relevant: string[]): number {
	const relevantIds = new Set(relevant);
	for (let i = 0; i < results.length; i += 1) {
		if (relevantIds.has(results[i].chunk.id)) return 1 / (i + 1);
	}
	return 0;
}

export function ndcgAtK(
	results: SearchResult[],
	relevanceScores: Record<string, number>,
	k: number
): number {
	const dcg = results.slice(0, k).reduce((sum, result, index) => {
		const gain = Math.pow(2, relevanceScores[result.chunk.id] ?? 0) - 1;
		return sum + gain / Math.log2(index + 2);
	}, 0);

	const idcg = Object.values(relevanceScores)
		.filter((relevance) => relevance > 0)
		.sort((a, b) => b - a)
		.slice(0, k)
		.reduce((sum, relevance, index) => sum + (Math.pow(2, relevance) - 1) / Math.log2(index + 2), 0);

	return idcg === 0 ? 0 : dcg / idcg;
}
