/**
 * Step 4 of the CodeSearchNet benchmark: run every ablation config over the
 * fixed per-language corpus and score it at the function level.
 *
 * Each query has exactly one labelled function, so Recall@k here is Hit@k. A
 * function can produce several chunks; retrieved chunks are mapped back to
 * their function and collapsed in rank order before scoring.
 *
 * Latency is retrieval only — the query vector is precomputed — measured once
 * per query after a warm-up, in Node on this machine. BM25 runs synchronously
 * here (no Worker), as it does in the browser when the worker is unavailable.
 * Query-embedding latency is measured separately with the production ONNX
 * model, which also checks how closely its q8 vectors agree with the fp32
 * vectors the corpus was scored with.
 *
 *   npx vitest run --config scripts/csn/vitest.config.mts scripts/csn/bench.run.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";
import {
	searchBm25Only,
	searchDenseBm25Rrf,
	searchDenseExact,
	searchFullPipeline,
	searchNoGraphExpansion,
	searchNoQuantization,
	searchVectorOnly,
	type AblationSearchFn,
} from "../../src/lib/ablationConfigs";
import type { EmbeddedChunk } from "../../src/lib/embedder";
import { cosineSimilarity } from "../../src/lib/quantize";
import { VectorStore } from "../../src/lib/vectorStore";

const ROOT = resolve(__dirname, "../..");
const LANGUAGES = (process.env.CSN_LANGUAGES ?? "python,javascript").split(",");
const QUERY_LIMIT = Number(process.env.CSN_QUERY_LIMIT ?? "0") || Infinity;
const EMBED_LATENCY_QUERIES = Number(process.env.CSN_EMBED_LATENCY_QUERIES ?? "200");
const OUT_DIR = resolve(ROOT, "context/csn-benchmark");
const DIMS = 384;
/** Chunks requested per query; enough to fill ten distinct functions. */
const RETRIEVE_CHUNKS = 50;
const WARMUP_QUERIES = 20;
const BOOTSTRAP_SAMPLES = 2000;

const CONFIGS: { name: string; description: string; run: AblationSearchFn }[] = [
	{ name: "BM25 only", description: "BM25 over chunk text", run: searchBm25Only },
	{ name: "Dense only", description: "Hamming coarse top-50 + float32 cosine rerank", run: searchVectorOnly },
	{ name: "Dense + BM25 + RRF", description: "Hamming + BM25 fused with RRF, fused order", run: searchDenseBm25Rrf },
	{ name: "Hybrid + cosine rerank", description: "Dense + BM25 + RRF + cosine rerank, no graph hop", run: searchNoGraphExpansion },
	{ name: "Full gitask retrieval", description: "Hamming + BM25 + RRF + graph expansion + cosine rerank", run: searchFullPipeline },
	{ name: "Full, float32 coarse pass", description: "Full pipeline with exact cosine instead of Hamming", run: searchNoQuantization },
	{ name: "Dense exact (reference)", description: "Brute-force float32 cosine over every chunk", run: searchDenseExact },
];

interface ChunkRow extends Omit<EmbeddedChunk, "embedding"> {
	functionId: string;
}

interface QueryRow {
	id: string;
	query: string;
	functionId: string;
}

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function readVectors(path: string, count: number): number[][] {
	const buffer = readFileSync(path);
	const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
	if (floats.length !== count * DIMS) {
		throw new Error(`${path}: expected ${count} x ${DIMS} floats, found ${floats.length}`);
	}
	return Array.from({ length: count }, (_, i) => Array.from(floats.subarray(i * DIMS, (i + 1) * DIMS)));
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index];
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Seeded so the confidence intervals are reproducible run to run. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/** 95% percentile-bootstrap interval for the mean, or for the mean paired difference. */
function bootstrapCi(values: number[], seed = 7): [number, number] {
	const rng = makeRng(seed);
	const means: number[] = [];
	for (let s = 0; s < BOOTSTRAP_SAMPLES; s += 1) {
		let sum = 0;
		for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(rng() * values.length)];
		means.push(sum / values.length);
	}
	return [percentile(means, 2.5), percentile(means, 97.5)];
}

/** 1-based rank of the target among distinct functions, or null if not in the top 10. */
function functionRank(resultIds: string[], chunkToFunction: Map<string, string>, target: string): number | null {
	const seen = new Set<string>();
	for (const id of resultIds) {
		const fn = chunkToFunction.get(id);
		if (!fn || seen.has(fn)) continue;
		seen.add(fn);
		if (fn === target) return seen.size;
		if (seen.size >= 10) break;
	}
	return null;
}

interface ConfigResult {
	config: string;
	description: string;
	recallAt1: number;
	recallAt5: number;
	recallAt10: number;
	mrrAt10: number;
	ndcgAt10: number;
	recallAt5Ci: [number, number];
	mrrAt10Ci: [number, number];
	latencyMs: { p50: number; p95: number; mean: number };
	ranks: (number | null)[];
}

async function runConfig(
	config: (typeof CONFIGS)[number],
	store: VectorStore,
	queries: QueryRow[],
	queryVectors: number[][],
	chunkToFunction: Map<string, string>
): Promise<ConfigResult> {
	for (let i = 0; i < Math.min(WARMUP_QUERIES, queries.length); i += 1) {
		await config.run(store, queryVectors[i], queries[i].query, RETRIEVE_CHUNKS);
	}

	const ranks: (number | null)[] = [];
	const latencies: number[] = [];
	for (let i = 0; i < queries.length; i += 1) {
		const start = performance.now();
		const results = await config.run(store, queryVectors[i], queries[i].query, RETRIEVE_CHUNKS);
		latencies.push(performance.now() - start);
		ranks.push(functionRank(results.map((r) => r.chunk.id), chunkToFunction, queries[i].functionId));
	}

	const hit = (k: number) => ranks.map((rank) => (rank !== null && rank <= k ? 1 : 0));
	const reciprocal = ranks.map((rank) => (rank === null ? 0 : 1 / rank));
	return {
		config: config.name,
		description: config.description,
		recallAt1: mean(hit(1)),
		recallAt5: mean(hit(5)),
		recallAt10: mean(hit(10)),
		mrrAt10: mean(reciprocal),
		// One relevant function per query, so the ideal DCG is 1.
		ndcgAt10: mean(ranks.map((rank) => (rank === null ? 0 : 1 / Math.log2(rank + 1)))),
		recallAt5Ci: bootstrapCi(hit(5)),
		mrrAt10Ci: bootstrapCi(reciprocal),
		latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), mean: mean(latencies) },
		ranks,
	};
}

/** Production query path: ONNX all-MiniLM-L12-v2, q8 as on WASM, one query at a time. */
async function measureQueryEmbedding(queries: QueryRow[], fp32Vectors: number[][]) {
	const { AutoModel, AutoTokenizer } = await import("@huggingface/transformers");
	const modelId = "Xenova/all-MiniLM-L12-v2";
	const tokenizer = await AutoTokenizer.from_pretrained(modelId);
	const model = await AutoModel.from_pretrained(modelId, { dtype: "q8" });

	const embed = async (text: string) => {
		const inputs = tokenizer([text], { truncation: true, padding: true });
		const output = await model(inputs);
		const hidden = output.last_hidden_state;
		const [, seq, width] = hidden.dims as number[];
		const data = hidden.data as Float32Array;
		const pooled = new Float32Array(width);
		for (let t = 0; t < seq; t += 1) for (let j = 0; j < width; j += 1) pooled[j] += data[t * width + j];
		const norm = Math.hypot(...pooled);
		return Array.from(pooled, (v) => v / norm);
	};

	const sample = queries.slice(0, EMBED_LATENCY_QUERIES);
	for (const q of sample.slice(0, 5)) await embed(q.query);
	const latencies: number[] = [];
	const agreement: number[] = [];
	for (let i = 0; i < sample.length; i += 1) {
		const start = performance.now();
		const vector = await embed(sample[i].query);
		latencies.push(performance.now() - start);
		agreement.push(cosineSimilarity(vector, fp32Vectors[i]));
	}
	return {
		model: `${modelId} (ONNX q8, onnxruntime-node CPU)`,
		queries: sample.length,
		latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), mean: mean(latencies) },
		cosineVsFp32: { mean: mean(agreement), min: Math.min(...agreement) },
	};
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (value: number) => value.toFixed(1);

function renderMarkdown(lang: string, meta: Record<string, unknown>, results: ConfigResult[], deltas: Record<string, unknown>[]) {
	const lines = [
		`### ${lang}`,
		"",
		"```json",
		JSON.stringify(meta, null, 2),
		"```",
		"",
		"| Configuration | Recall@1 | Recall@5 (95% CI) | Recall@10 | MRR@10 (95% CI) | NDCG@10 | p50 ms | p95 ms |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...results.map((r) => `| ${r.config} | ${pct(r.recallAt1)} | ${pct(r.recallAt5)} (${pct(r.recallAt5Ci[0])}–${pct(r.recallAt5Ci[1])}) | ${pct(r.recallAt10)} | ${r.mrrAt10.toFixed(3)} (${r.mrrAt10Ci[0].toFixed(3)}–${r.mrrAt10Ci[1].toFixed(3)}) | ${r.ndcgAt10.toFixed(3)} | ${ms(r.latencyMs.p50)} | ${ms(r.latencyMs.p95)} |`),
		"",
		"Paired difference against Dense only (95% bootstrap CI):",
		"",
		"| Configuration | ΔRecall@5 | ΔMRR@10 |",
		"| --- | --- | --- |",
		...deltas.map((d) => `| ${d.config} | ${d.recallAt5} | ${d.mrrAt10} |`),
		"",
	];
	return lines.join("\n");
}

it("runs the CodeSearchNet retrieval benchmark", async () => {
	mkdirSync(OUT_DIR, { recursive: true });
	const sections: string[] = [];

	for (const lang of LANGUAGES) {
		const dir = resolve(ROOT, ".context/csn", lang);
		const chunkRows = readJsonl<ChunkRow>(resolve(dir, "chunks.jsonl"));
		const chunkVectors = readVectors(resolve(dir, "chunk_embeddings.f32"), chunkRows.length);
		const allQueries = readJsonl<QueryRow>(resolve(dir, "queries.jsonl"));
		const allQueryVectors = readVectors(resolve(dir, "query_embeddings.f32"), allQueries.length);
		const queries = allQueries.slice(0, QUERY_LIMIT);
		const queryVectors = allQueryVectors.slice(0, QUERY_LIMIT);

		const chunks: EmbeddedChunk[] = chunkRows.map(({ functionId: _functionId, ...chunk }, i) => ({
			...chunk,
			embedding: chunkVectors[i],
		}));
		const chunkToFunction = new Map(chunkRows.map((chunk) => [chunk.id, chunk.functionId]));

		// Isolated functions carry no imports, so the graph hop has no edges to follow.
		const store = new VectorStore();
		store.insert(chunks);
		const graph: Record<string, { imports: string[]; definitions: string[] }> = {};
		for (const chunk of chunks) {
			const entry = (graph[chunk.filePath] ??= { imports: [], definitions: [] });
			if (chunk.name) entry.definitions.push(chunk.name);
		}
		store.setGraph(graph);

		const functionCount = new Set(chunkToFunction.values()).size;
		console.log(`${lang}: ${queries.length} queries over ${functionCount} functions / ${chunks.length} chunks`);

		const results: ConfigResult[] = [];
		for (const config of CONFIGS) {
			const result = await runConfig(config, store, queries, queryVectors, chunkToFunction);
			results.push(result);
			console.log(
				`  ${config.name.padEnd(26)} R@1 ${pct(result.recallAt1)}  R@5 ${pct(result.recallAt5)}  ` +
				`R@10 ${pct(result.recallAt10)}  MRR@10 ${result.mrrAt10.toFixed(3)}  ` +
				`p50 ${ms(result.latencyMs.p50)}ms  p95 ${ms(result.latencyMs.p95)}ms`
			);
		}

		const baseline = results.find((r) => r.config === "Dense only")!;
		const baselineHits = baseline.ranks.map((rank) => (rank !== null && rank <= 5 ? 1 : 0));
		const baselineRr = baseline.ranks.map((rank) => (rank === null ? 0 : 1 / rank));
		const deltas = results.filter((r) => r !== baseline).map((r) => {
			const hits = r.ranks.map((rank, i) => (rank !== null && rank <= 5 ? 1 : 0) - baselineHits[i]);
			const rr = r.ranks.map((rank, i) => (rank === null ? 0 : 1 / rank) - baselineRr[i]);
			const [hLo, hHi] = bootstrapCi(hits);
			const [rLo, rHi] = bootstrapCi(rr);
			const signed = (v: number, digits: number, scale = 1) => `${v >= 0 ? "+" : ""}${(v * scale).toFixed(digits)}`;
			return {
				config: r.config,
				recallAt5: `${signed(mean(hits), 1, 100)} pts (${signed(hLo, 1, 100)} to ${signed(hHi, 1, 100)})`,
				mrrAt10: `${signed(mean(rr), 3)} (${signed(rLo, 3)} to ${signed(rHi, 3)})`,
			};
		});

		const queryEmbedding = EMBED_LATENCY_QUERIES > 0 ? await measureQueryEmbedding(queries, queryVectors) : null;
		if (queryEmbedding) {
			console.log(
				`  query embedding: p50 ${ms(queryEmbedding.latencyMs.p50)}ms  p95 ${ms(queryEmbedding.latencyMs.p95)}ms  ` +
				`cosine vs fp32 mean ${queryEmbedding.cosineVsFp32.mean.toFixed(4)} min ${queryEmbedding.cosineVsFp32.min.toFixed(4)}`
			);
		}

		const meta = {
			dataset: `CodeSearchNet ${lang} test split`,
			queries: queries.length,
			corpusFunctions: functionCount,
			corpusChunks: chunks.length,
			chunking: [...new Set(chunks.map((c) => c.nodeType))].includes("text_chunk") && lang === "python"
				? "text fallback (shipped Python grammar fails to load; see chunk.run.ts)"
				: "tree-sitter AST",
			embeddingModel: "all-MiniLM-L12-v2, fp32, 512-token truncation",
			indexBytes: { float32: chunks.length * DIMS * 4, binary: chunks.length * (DIMS / 8) },
			latencyHost: `Node ${process.version}, ${process.platform}`,
			queryEmbedding,
		};

		writeFileSync(
			resolve(OUT_DIR, `${lang}.json`),
			JSON.stringify({ meta, results: results.map(({ ranks, ...rest }) => ({ ...rest, ranks })), deltas }, null, 2)
		);
		sections.push(renderMarkdown(lang, meta, results, deltas));
	}

	writeFileSync(resolve(OUT_DIR, "results.generated.md"), sections.join("\n"));
});
