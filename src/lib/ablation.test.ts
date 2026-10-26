/**
 * Ablation Study - Benchmarks the GitAsk retrieval pipeline
 * across configurations measuring Recall@5, MRR, NDCG@10, and latency.
 *
 * The configs themselves live in `ablationConfigs.ts` so the browser-side
 * ablation in `eval/ablation.ts` runs the same code against a real index.
 * The two configs below stay here because they call the embedder, which this
 * file mocks out to replay precomputed query vectors.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EVAL_CHUNKS,
  EVAL_QUERIES,
  REPO_EVAL_CHUNKS,
  REPO_EVAL_QUERIES,
  type EvalQuery,
} from "./eval-data";
import {
  ABLATION_CONFIGS,
  recallAtK,
  meanReciprocalRank,
  ndcgAtK,
  type AblationSearchFn,
} from "./ablationConfigs";
import { multiPathHybridSearch } from "./search";
import type { EmbeddedChunk } from "./embedder";
import type { SearchResult } from "./vectorStore";
import { VectorStore } from "./vectorStore";
import { buildPageIndexTree } from "./pageIndexTree";
import { pageIndexSearch } from "./pageIndexSearch";

const LATENCY_WARMUP_QUERIES = 5;
const LATENCY_SAMPLES_PER_QUERY = 3;

let activeQueryEmbedding: number[] = [];
vi.mock("./embedder", () => ({
  embedText: vi.fn(async () => activeQueryEmbedding),
}));

const storeCache = new WeakMap<EmbeddedChunk[], VectorStore>();

/**
 * The eval corpora are bare chunk lists with no import graph, so one is
 * synthesised from chunk names to give graph expansion something to walk.
 */
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

/** These two baselines are measured without the import graph, as published. */
const graphlessCache = new WeakMap<EmbeddedChunk[], VectorStore>();

function getGraphlessStore(chunks: EmbeddedChunk[]): VectorStore {
  const cached = graphlessCache.get(chunks);
  if (cached) return cached;
  const store = new VectorStore();
  store.insert(chunks);
  store.setGraph({});
  graphlessCache.set(chunks, store);
  return store;
}

const searchCodeRagMultiPath: AblationSearchFn = (store, queryEmbedding, queryText, limit = 5) => {
  activeQueryEmbedding = queryEmbedding;
  return multiPathHybridSearch(getGraphlessStore(store.getAll()), [queryText], {
    limit,
    coarseCandidates: 50,
    rrfK: 60,
    preferenceAlpha: 0.7,
  });
};

const searchPageIndexKeyword: AblationSearchFn = async (store, _queryEmbedding, queryText) => {
  const graphless = getGraphlessStore(store.getAll());
  const tree = buildPageIndexTree(graphless);
  const { results } = await pageIndexSearch(tree, graphless, queryText, "mlc");
  return results;
};

const CONFIGS: { name: string; fn: AblationSearchFn }[] = [
  ...ABLATION_CONFIGS.map((config) => ({ name: config.name, fn: config.run })),
  { name: "CodeRAG Multi-Path", fn: searchCodeRagMultiPath },
  { name: "PageIndex (Keyword)", fn: searchPageIndexKeyword },
];

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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runBenchmark(
  name: string,
  searchFn: AblationSearchFn,
  chunks: EmbeddedChunk[],
  queries: EvalQuery[]
): Promise<AblationResult> {
  const store = getStoreForChunks(chunks);
  const perQuery: AblationResult["perQuery"] = [];

  // Warm up caches/JIT to reduce one-off latency spikes in reported metrics.
  for (const q of queries.slice(0, Math.min(LATENCY_WARMUP_QUERIES, queries.length))) {
    activeQueryEmbedding = q.queryEmbedding;
    await searchFn(store, q.queryEmbedding, q.query, 10);
  }

  for (const q of queries) {
    const latencySamples: number[] = [];
    let measuredResults: SearchResult[] = [];

    for (let i = 0; i < LATENCY_SAMPLES_PER_QUERY; i += 1) {
      activeQueryEmbedding = q.queryEmbedding;
      const start = performance.now();
      measuredResults = await searchFn(store, q.queryEmbedding, q.query, 10);
      latencySamples.push((performance.now() - start) * 1000);
    }

    perQuery.push({
      queryId: q.id,
      recallAt5: recallAtK(measuredResults, q.relevantChunkIds, 5),
      mrr: meanReciprocalRank(measuredResults, q.relevantChunkIds),
      ndcgAt10: ndcgAtK(measuredResults, q.relevanceScores, 10),
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

function printTable(title: string, results: AblationResult[]): void {
  console.log(`\n${title}`);
  console.log("Configuration | Recall@5 | MRR | NDCG@10 | Latency(us)");
  console.log("--- | --- | --- | --- | ---");
  for (const result of results) {
    console.log([
      result.config,
      `${(result.avgRecallAt5 * 100).toFixed(1)}%`,
      result.avgMRR.toFixed(4),
      result.avgNdcgAt10.toFixed(4),
      result.avgLatencyUs.toFixed(0),
    ].join(" | "));
  }
}

function expectValidResult(result: AblationResult, queryCount: number): void {
  expect(result.avgRecallAt5).toBeGreaterThanOrEqual(0);
  expect(result.avgRecallAt5).toBeLessThanOrEqual(1);
  expect(result.avgMRR).toBeGreaterThanOrEqual(0);
  expect(result.avgMRR).toBeLessThanOrEqual(1);
  expect(result.avgNdcgAt10).toBeGreaterThanOrEqual(0);
  expect(result.avgNdcgAt10).toBeLessThanOrEqual(1);
  expect(result.avgLatencyUs).toBeGreaterThan(0);
  expect(result.perQuery.length).toBe(queryCount);
}

describe("Ablation Study", () => {
  for (const { name, fn } of CONFIGS) {
    it(`${name} - produces valid results`, { timeout: 60_000 }, async () => {
      expectValidResult(await runBenchmark(name, fn, EVAL_CHUNKS, EVAL_QUERIES), EVAL_QUERIES.length);
    });
  }

  it("prints summary table", { timeout: 120_000 }, async () => {
    const results = await Promise.all(
      CONFIGS.map(({ name, fn }) => runBenchmark(name, fn, EVAL_CHUNKS, EVAL_QUERIES))
    );
    printTable("Ablation Results", results);
    console.log(`ABLATION_RESULTS_JSON=${JSON.stringify(results, null, 2)}`);
    expect(results.length).toBe(CONFIGS.length);
  });
});

describe("Repo Eval Ablation", () => {
  for (const { name, fn } of CONFIGS) {
    it(`${name} - produces valid results on repo corpus`, { timeout: 60_000 }, async () => {
      expectValidResult(
        await runBenchmark(name, fn, REPO_EVAL_CHUNKS, REPO_EVAL_QUERIES),
        REPO_EVAL_QUERIES.length
      );
    });
  }

  it("prints summary table", { timeout: 120_000 }, async () => {
    const results = await Promise.all(
      CONFIGS.map(({ name, fn }) => runBenchmark(name, fn, REPO_EVAL_CHUNKS, REPO_EVAL_QUERIES))
    );
    printTable("Repo Eval Ablation Results (gitask src/lib/*.ts, manually annotated)", results);
    console.log(`REPO_ABLATION_RESULTS_JSON=${JSON.stringify(results, null, 2)}`);
    expect(results.length).toBe(CONFIGS.length);
  });
});
