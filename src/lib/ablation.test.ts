/**
 * Ablation Study - Benchmarks the GitAsk retrieval pipeline
 * across configurations measuring Recall@5, MRR, and Latency.
 *
 * Configs:
 *   1. Full Pipeline       - Hamming coarse -> RRF (vector+keyword) -> Cosine rerank
 *   2. No Quantization     - Cosine-only vector search -> RRF -> Cosine rerank
 *   3. Vector-Only         - Hamming coarse -> Cosine rerank (no keyword, no RRF)
 *   4. No Reranking        - Hamming coarse -> RRF -> return RRF order (no cosine rerank)
 *   5. CodeRAG Multi-Path  - Query expansion -> per-path hybrid -> path RRF -> preference rerank
 */

import { describe, it, expect, vi } from "vitest";
import { EVAL_CHUNKS, EVAL_QUERIES, type EvalQuery } from "./eval-data";
import { cosineSimilarity } from "./quantize";
import {
	keywordSearch,
	vectorSearch,
	reciprocalRankFusion,
	multiPathHybridSearch,
} from "./search";
import { expandQuery } from "./queryExpansion";
import type { EmbeddedChunk } from "./embedder";
import type { SearchResult } from "./vectorStore";
import { VectorStore } from "./vectorStore";

let activeQueryEmbedding: number[] = [];
vi.mock("./embedder", () => ({
	embedText: vi.fn(async () => activeQueryEmbedding),
}));

/** Config 1: Full pipeline (default hybridSearch logic) */
function searchFullPipeline(
	chunks: EmbeddedChunk[],
	queryEmb: number[],
	queryText: string,
	limit: number = 5
): SearchResult[] {
	const vectorScores = vectorSearch(chunks, queryEmb, 50);
	const kw = keywordSearch(chunks, queryText);
	const fused = reciprocalRankFusion([vectorScores, kw], 60);
	const candidates = [...fused.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 50);

	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const reranked: SearchResult[] = [];
	for (const [id] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		const score = cosineSimilarity(queryEmb, chunk.embedding);
		reranked.push({ chunk, score, embedding: chunk.embedding });
	}
	reranked.sort((a, b) => b.score - a.score);
	return reranked.slice(0, limit);
}

/** Config 2: No quantization - use cosine for vector search instead of Hamming */
function searchNoQuantization(
	chunks: EmbeddedChunk[],
	queryEmb: number[],
	queryText: string,
	limit: number = 5
): SearchResult[] {
	const cosScores = new Map<string, number>();
	for (const chunk of chunks) {
		const score = cosineSimilarity(queryEmb, chunk.embedding);
		cosScores.set(chunk.id, score);
	}

	const kw = keywordSearch(chunks, queryText);
	const fused = reciprocalRankFusion([cosScores, kw], 60);
	const candidates = [...fused.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 50);

	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const reranked: SearchResult[] = [];
	for (const [id] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		const score = cosineSimilarity(queryEmb, chunk.embedding);
		reranked.push({ chunk, score, embedding: chunk.embedding });
	}
	reranked.sort((a, b) => b.score - a.score);
	return reranked.slice(0, limit);
}

/** Config 3: Vector-only - no keyword search, no RRF */
function searchVectorOnly(
	chunks: EmbeddedChunk[],
	queryEmb: number[],
	_queryText: string,
	limit: number = 5
): SearchResult[] {
	const vectorScores = vectorSearch(chunks, queryEmb, 50);
	const candidates = [...vectorScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 50);

	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const reranked: SearchResult[] = [];
	for (const [id] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		const score = cosineSimilarity(queryEmb, chunk.embedding);
		reranked.push({ chunk, score, embedding: chunk.embedding });
	}
	reranked.sort((a, b) => b.score - a.score);
	return reranked.slice(0, limit);
}

/** Config 4: No reranking - RRF scores determine final order */
function searchNoReranking(
	chunks: EmbeddedChunk[],
	queryEmb: number[],
	queryText: string,
	limit: number = 5
): SearchResult[] {
	const vectorScores = vectorSearch(chunks, queryEmb, 50);
	const kw = keywordSearch(chunks, queryText);
	const fused = reciprocalRankFusion([vectorScores, kw], 60);
	const candidates = [...fused.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit);

	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const results: SearchResult[] = [];
	for (const [id, score] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;
		results.push({ chunk, score, embedding: chunk.embedding });
	}
	return results;
}

/** Config 5: CodeRAG multi-path search */
async function searchCodeRagMultiPath(
	chunks: EmbeddedChunk[],
	queryEmb: number[],
	queryText: string,
	limit: number = 5
): Promise<SearchResult[]> {
	activeQueryEmbedding = queryEmb;
	const store = new VectorStore();
	store.insert(chunks);
	store.setGraph({});
	const variants = expandQuery(queryText);
	return multiPathHybridSearch(store, variants, {
		limit,
		coarseCandidates: 50,
		rrfK: 60,
		preferenceAlpha: 0.7,
	});
}

function recallAtK(results: SearchResult[], relevant: string[], k: number): number {
	const topK = results.slice(0, k).map((r) => r.chunk.id);
	const hits = relevant.filter((id) => topK.includes(id)).length;
	return hits / relevant.length;
}

function meanReciprocalRank(results: SearchResult[], relevant: string[]): number {
	for (let i = 0; i < results.length; i++) {
		if (relevant.includes(results[i].chunk.id)) {
			return 1 / (i + 1);
		}
	}
	return 0;
}

export interface AblationResult {
	config: string;
	avgRecallAt5: number;
	avgMRR: number;
	avgLatencyUs: number;
	perQuery: {
		queryId: string;
		recallAt5: number;
		mrr: number;
		latencyUs: number;
	}[];
}

type SearchFn = (
	chunks: EmbeddedChunk[],
	queryEmb: number[],
	queryText: string,
	limit?: number
) => SearchResult[] | Promise<SearchResult[]>;

async function runBenchmark(
	name: string,
	searchFn: SearchFn,
	chunks: EmbeddedChunk[],
	queries: EvalQuery[]
): Promise<AblationResult> {
	const perQuery: AblationResult["perQuery"] = [];

	for (const q of queries) {
		activeQueryEmbedding = q.queryEmbedding;
		const start = performance.now();
		const results = await searchFn(chunks, q.queryEmbedding, q.query, 5);
		const elapsed = (performance.now() - start) * 1000;

		perQuery.push({
			queryId: q.id,
			recallAt5: recallAtK(results, q.relevantChunkIds, 5),
			mrr: meanReciprocalRank(results, q.relevantChunkIds),
			latencyUs: elapsed,
		});
	}

	const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

	return {
		config: name,
		avgRecallAt5: avg(perQuery.map((p) => p.recallAt5)),
		avgMRR: avg(perQuery.map((p) => p.mrr)),
		avgLatencyUs: avg(perQuery.map((p) => p.latencyUs)),
		perQuery,
	};
}

const CONFIGS: { name: string; fn: SearchFn }[] = [
	{ name: "Full Pipeline", fn: searchFullPipeline },
	{ name: "No Quantization", fn: searchNoQuantization },
	{ name: "Vector-Only", fn: searchVectorOnly },
	{ name: "No Reranking", fn: searchNoReranking },
	{ name: "CodeRAG Multi-Path", fn: searchCodeRagMultiPath },
];

describe("Ablation Study", () => {
	const allResults: AblationResult[] = [];

	for (const { name, fn } of CONFIGS) {
		it(`${name} - produces valid results`, async () => {
			const result = await runBenchmark(name, fn, EVAL_CHUNKS, EVAL_QUERIES);
			allResults.push(result);

			expect(result.avgRecallAt5).toBeGreaterThanOrEqual(0);
			expect(result.avgRecallAt5).toBeLessThanOrEqual(1);
			expect(result.avgMRR).toBeGreaterThanOrEqual(0);
			expect(result.avgMRR).toBeLessThanOrEqual(1);
			expect(result.avgLatencyUs).toBeGreaterThan(0);
			expect(result.perQuery.length).toBe(EVAL_QUERIES.length);
		});
	}

	it("prints summary table", async () => {
		const results = await Promise.all(
			CONFIGS.map(({ name, fn }) => runBenchmark(name, fn, EVAL_CHUNKS, EVAL_QUERIES))
		);

		console.log("\nAblation Results");
		console.log("Configuration | Recall@5 | MRR | Latency(us)");
		console.log("--- | --- | --- | ---");
		for (const r of results) {
			const recall = (r.avgRecallAt5 * 100).toFixed(1) + "%";
			const mrr = r.avgMRR.toFixed(4);
			const latency = r.avgLatencyUs.toFixed(0);
			console.log(`${r.config} | ${recall} | ${mrr} | ${latency}`);
		}

		console.log("ABLATION_RESULTS_JSON=" + JSON.stringify(results, null, 2));

		expect(results.length).toBe(5);
	});
});
