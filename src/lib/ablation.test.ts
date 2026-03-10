/**
 * Ablation Study - Benchmarks the GitAsk retrieval pipeline
 * across configurations measuring Recall@5, MRR, NDCG@10, and latency.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EVAL_CHUNKS,
  EVAL_QUERIES,
  REPO_EVAL_CHUNKS,
  REPO_EVAL_QUERIES,
  type EvalQuery,
} from "./eval-data";
import { cosineSimilarity } from "./quantize";
import {
  vectorSearch,
  reciprocalRankFusion,
  multiPathHybridSearch,
  hybridSearch,
} from "./search";
import { bm25Search } from "./bm25";
import { expandCandidatesWithGraph } from "./graphExpansion";
import type { EmbeddedChunk } from "./embedder";
import type { SearchResult } from "./vectorStore";
import { VectorStore } from "./vectorStore";
import { buildPageIndexTree } from "./pageIndexTree";
import { pageIndexSearch } from "./pageIndexSearch";

const COSINE_RERANK_WEIGHT = 0.7;
const FUSED_PRIOR_WEIGHT = 1 - COSINE_RERANK_WEIGHT;
const GRAPH_EXPANSION_SEED_COUNT = 20;
const GRAPH_EXPANSION_WEIGHT = 0.5;
const LATENCY_WARMUP_QUERIES = 5;
const LATENCY_SAMPLES_PER_QUERY = 3;

let activeQueryEmbedding: number[] = [];
vi.mock("./embedder", () => ({
  embedText: vi.fn(async () => activeQueryEmbedding),
}));

const storeCache = new WeakMap<EmbeddedChunk[], VectorStore>();

function getStoreForChunks(chunks: EmbeddedChunk[]): VectorStore {
	const cached = storeCache.get(chunks);
	if (cached) return cached;

	const store = new VectorStore();
	store.insert(chunks);
	const graph: Record<string, { imports: string[]; definitions: string[] }> = {};
	for (const chunk of chunks) {
		const current = graph[chunk.filePath] ?? { imports: [], definitions: [] };
		if (chunk.name && !current.definitions.includes(chunk.name)) {
			current.definitions.push(chunk.name);
		}
		graph[chunk.filePath] = current;
	}
	store.setGraph(graph);
	storeCache.set(chunks, store);
	return store;
}

async function searchFullPipeline(
  chunks: EmbeddedChunk[],
  queryEmb: number[],
  queryText: string,
  limit: number = 5
): Promise<SearchResult[]> {
  const store = getStoreForChunks(chunks);
  return hybridSearch(store, queryEmb, queryText, {
    limit,
    coarseCandidates: 50,
    rrfK: 60,
  });
}

async function searchNoQuantization(
  chunks: EmbeddedChunk[],
  queryEmb: number[],
  queryText: string,
  limit: number = 5
): Promise<SearchResult[]> {
  const store = getStoreForChunks(chunks);
  const cosScores = new Map<string, number>();
  for (const chunk of chunks) {
    const score = cosineSimilarity(queryEmb, chunk.embedding);
    cosScores.set(chunk.id, score);
  }

  const sparseScores = await bm25Search(chunks, queryText, { limit: 50 });
  const fused = reciprocalRankFusion([cosScores, sparseScores], 60);
  const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  const expanded = expandCandidatesWithGraph(store, candidates, {
    seedCount: GRAPH_EXPANSION_SEED_COUNT,
    expansionWeight: GRAPH_EXPANSION_WEIGHT,
  });
  const maxFusedScore = expanded.reduce((max, [, fusedScore]) => Math.max(max, fusedScore), 0);

  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  const reranked: SearchResult[] = [];
  for (const [id, fusedScore] of expanded) {
    const chunk = chunkMap.get(id);
    if (!chunk) continue;
    const cosineScore = cosineSimilarity(queryEmb, chunk.embedding);
    const fusedPrior = maxFusedScore > 0 ? fusedScore / maxFusedScore : 0;
    const score = cosineScore * COSINE_RERANK_WEIGHT + fusedPrior * FUSED_PRIOR_WEIGHT;
    reranked.push({ chunk, score, embedding: chunk.embedding });
  }
  reranked.sort((a, b) => b.score - a.score);
  return reranked.slice(0, limit);
}

function searchVectorOnly(
  chunks: EmbeddedChunk[],
  queryEmb: number[],
  _queryText: string,
  limit: number = 5
): SearchResult[] {
  const store = getStoreForChunks(chunks);
  const vectorScores = vectorSearch(chunks, queryEmb, 50, store.getAllBinaries());
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

async function searchNoReranking(
  chunks: EmbeddedChunk[],
  queryEmb: number[],
  queryText: string,
  limit: number = 5
): Promise<SearchResult[]> {
  const store = getStoreForChunks(chunks);
  const vectorScores = vectorSearch(chunks, queryEmb, 50, store.getAllBinaries());
  const sparseScores = await bm25Search(chunks, queryText, { limit: 50 });
  const fused = reciprocalRankFusion([vectorScores, sparseScores], 60);
  const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  const expanded = expandCandidatesWithGraph(store, candidates, {
    seedCount: GRAPH_EXPANSION_SEED_COUNT,
    expansionWeight: GRAPH_EXPANSION_WEIGHT,
  });
  const top = expanded.sort((a, b) => b[1] - a[1]).slice(0, limit);

  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  const results: SearchResult[] = [];
  for (const [id, score] of top) {
    const chunk = chunkMap.get(id);
    if (!chunk) continue;
    results.push({ chunk, score, embedding: chunk.embedding });
  }
  return results;
}

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
  const variants = [queryText];
  return multiPathHybridSearch(store, variants, {
    limit,
    coarseCandidates: 50,
    rrfK: 60,
    preferenceAlpha: 0.7,
  });
}

function recallAtK(results: SearchResult[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const topK = results.slice(0, k).map((r) => r.chunk.id);
  const hits = relevant.filter((id) => topK.includes(id)).length;
  return hits / relevant.length;
}

function meanReciprocalRank(results: SearchResult[], relevant: string[]): number {
  for (let i = 0; i < results.length; i += 1) {
    if (relevant.includes(results[i].chunk.id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function ndcgAtK(
  results: SearchResult[],
  relevanceScores: Record<string, number>,
  k: number
): number {
  const dcg = results.slice(0, k).reduce((sum, result, index) => {
    const rel = relevanceScores[result.chunk.id] ?? 0;
    const gain = Math.pow(2, rel) - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);

  const idealRelevances = Object.values(relevanceScores)
    .filter((rel) => rel > 0)
    .sort((a, b) => b - a)
    .slice(0, k);

  const idcg = idealRelevances.reduce((sum, rel, index) => {
    const gain = Math.pow(2, rel) - 1;
    return sum + gain / Math.log2(index + 2);
  }, 0);

  return idcg === 0 ? 0 : dcg / idcg;
}

export interface AblationResult {
  config: string;
  avgRecallAt5: number;
  avgMRR: number;
  avgNdcgAt10: number;
  avgLatencyUs: number;
  perQuery: {
    queryId: string;
    recallAt5: number;
    mrr: number;
    ndcgAt10: number;
    latencyUs: number;
  }[];
}

type SearchFn = (
  chunks: EmbeddedChunk[],
  queryEmb: number[],
  queryText: string,
  limit?: number
) => SearchResult[] | Promise<SearchResult[]>;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

async function runBenchmark(
  name: string,
  searchFn: SearchFn,
  chunks: EmbeddedChunk[],
  queries: EvalQuery[]
): Promise<AblationResult> {
  const perQuery: AblationResult["perQuery"] = [];

  // Warm up caches/JIT to reduce one-off latency spikes in reported metrics.
  const warmupQueries = queries.slice(0, Math.min(LATENCY_WARMUP_QUERIES, queries.length));
  for (const q of warmupQueries) {
    activeQueryEmbedding = q.queryEmbedding;
    await searchFn(chunks, q.queryEmbedding, q.query, 10);
  }

  for (const q of queries) {
    const latencySamples: number[] = [];
    let measuredResults: SearchResult[] | null = null;

    for (let i = 0; i < LATENCY_SAMPLES_PER_QUERY; i++) {
      activeQueryEmbedding = q.queryEmbedding;
      const start = performance.now();
      const results = await searchFn(chunks, q.queryEmbedding, q.query, 10);
      const elapsed = (performance.now() - start) * 1000;
      latencySamples.push(elapsed);
      measuredResults = results;
    }

    const results = measuredResults ?? [];

    perQuery.push({
      queryId: q.id,
      recallAt5: recallAtK(results, q.relevantChunkIds, 5),
      mrr: meanReciprocalRank(results, q.relevantChunkIds),
      ndcgAt10: ndcgAtK(results, q.relevanceScores, 10),
      latencyUs: median(latencySamples),
    });
  }

  const avg = (arr: number[]) => arr.reduce((sum, value) => sum + value, 0) / arr.length;

  return {
    config: name,
    avgRecallAt5: avg(perQuery.map((p) => p.recallAt5)),
    avgMRR: avg(perQuery.map((p) => p.mrr)),
    avgNdcgAt10: avg(perQuery.map((p) => p.ndcgAt10)),
    avgLatencyUs: avg(perQuery.map((p) => p.latencyUs)),
    perQuery,
  };
}

async function searchPageIndexKeyword(
  chunks: EmbeddedChunk[],
  _queryEmb: number[],
  queryText: string,
  _limit: number = 5
): Promise<SearchResult[]> {
  const store = new VectorStore();
  store.insert(chunks);
  store.setGraph({});
  const tree = buildPageIndexTree(store);
  const { results } = await pageIndexSearch(tree, store, queryText, "mlc");
  return results;
}

const CONFIGS: { name: string; fn: SearchFn }[] = [
  { name: "Full Pipeline", fn: searchFullPipeline },
  { name: "No Quantization", fn: searchNoQuantization },
  { name: "Vector-Only", fn: searchVectorOnly },
  { name: "No Reranking", fn: searchNoReranking },
  { name: "CodeRAG Multi-Path", fn: searchCodeRagMultiPath },
  { name: "PageIndex (Keyword)", fn: searchPageIndexKeyword },
];

describe("Ablation Study", () => {
  for (const { name, fn } of CONFIGS) {
    it(`${name} - produces valid results`, { timeout: 60_000 }, async () => {
      const result = await runBenchmark(name, fn, EVAL_CHUNKS, EVAL_QUERIES);

      expect(result.avgRecallAt5).toBeGreaterThanOrEqual(0);
      expect(result.avgRecallAt5).toBeLessThanOrEqual(1);
      expect(result.avgMRR).toBeGreaterThanOrEqual(0);
      expect(result.avgMRR).toBeLessThanOrEqual(1);
      expect(result.avgNdcgAt10).toBeGreaterThanOrEqual(0);
      expect(result.avgNdcgAt10).toBeLessThanOrEqual(1);
      expect(result.avgLatencyUs).toBeGreaterThan(0);
      expect(result.perQuery.length).toBe(EVAL_QUERIES.length);
    });
  }

  it("prints summary table", { timeout: 120_000 }, async () => {
    const results = await Promise.all(
      CONFIGS.map(({ name, fn }) => runBenchmark(name, fn, EVAL_CHUNKS, EVAL_QUERIES))
    );

    console.log("\nAblation Results");
    console.log("Configuration | Recall@5 | MRR | NDCG@10 | Latency(us)");
    console.log("--- | --- | --- | --- | ---");
    for (const result of results) {
      const recall = `${(result.avgRecallAt5 * 100).toFixed(1)}%`;
      const mrr = result.avgMRR.toFixed(4);
      const ndcg = result.avgNdcgAt10.toFixed(4);
      const latency = result.avgLatencyUs.toFixed(0);
      console.log(`${result.config} | ${recall} | ${mrr} | ${ndcg} | ${latency}`);
    }

    console.log(`ABLATION_RESULTS_JSON=${JSON.stringify(results, null, 2)}`);

    expect(results.length).toBe(6);
  });
});

describe("Repo Eval Ablation", () => {
  for (const { name, fn } of CONFIGS) {
    it(`${name} - produces valid results on repo corpus`, async () => {
      const result = await runBenchmark(name, fn, REPO_EVAL_CHUNKS, REPO_EVAL_QUERIES);

      expect(result.avgRecallAt5).toBeGreaterThanOrEqual(0);
      expect(result.avgRecallAt5).toBeLessThanOrEqual(1);
      expect(result.avgMRR).toBeGreaterThanOrEqual(0);
      expect(result.avgMRR).toBeLessThanOrEqual(1);
      expect(result.avgNdcgAt10).toBeGreaterThanOrEqual(0);
      expect(result.avgNdcgAt10).toBeLessThanOrEqual(1);
      expect(result.avgLatencyUs).toBeGreaterThan(0);
      expect(result.perQuery.length).toBe(REPO_EVAL_QUERIES.length);
    });
  }

  it("prints summary table", async () => {
    const results = await Promise.all(
      CONFIGS.map(({ name, fn }) => runBenchmark(name, fn, REPO_EVAL_CHUNKS, REPO_EVAL_QUERIES))
    );

    console.log("\nRepo Eval Ablation Results (gitask src/lib/*.ts, manually annotated)");
    console.log("Configuration | Recall@5 | MRR | NDCG@10 | Latency(us)");
    console.log("--- | --- | --- | --- | ---");
    for (const result of results) {
      const recall = `${(result.avgRecallAt5 * 100).toFixed(1)}%`;
      const mrr = result.avgMRR.toFixed(4);
      const ndcg = result.avgNdcgAt10.toFixed(4);
      const latency = result.avgLatencyUs.toFixed(0);
      console.log(`${result.config} | ${recall} | ${mrr} | ${ndcg} | ${latency}`);
    }

    console.log(`REPO_ABLATION_RESULTS_JSON=${JSON.stringify(results, null, 2)}`);

    expect(results.length).toBe(6);
  });
});
