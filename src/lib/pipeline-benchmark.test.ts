/**
 * Pipeline Speed Benchmark — real chunking and embedding throughput.
 *
 * Target: TanStack/tanstack-router-ai-example (configurable below).
 * No mocks — real GitHub HTTP, real chunkCode, real WASM embedder.
 *
 * Storage is cleared before each benchmark phase (fresh in-memory VectorStore).
 *
 * Run:
 *   npx vitest run src/lib/pipeline-benchmark.test.ts
 *
 * Note: first run downloads the embedding model from HuggingFace (~25 MB).
 * Expected wall time: 30–120 s depending on network and CPU.
 */

import { describe, it } from "vitest";
import { fetchRepoTree, fetchFileContent, isIndexable, prioritiseFiles } from "./github";
import { chunkCode, detectLanguage } from "./chunker";
import { initEmbedder, embedChunks } from "./embedder";
import { pooledMap } from "./indexer";

// ---- Configure target repo here --------------------------------------------
const BENCH_OWNER = "TanStack";
const BENCH_REPO  = "tanstack.com";   // ← change to the AI example repo you want
const MAX_FILES   = 20;               // cap so the benchmark stays under ~2 min
const CONCURRENCY = 5;                // mirrors the live FETCH_CONCURRENCY constant
// ----------------------------------------------------------------------------

type FileMeta = { path: string; size: number; sha: string; url: string };
type FetchResult = { file: FileMeta; content: string; elapsedMs: number };
type ChunkResult = { file: FileMeta; content: string; chunkCount: number; elapsedMs: number };

function fmt(ms: number, dp = 1): string {
	return ms.toFixed(dp) + " ms";
}

function fmtThroughput(count: number, totalMs: number, unit: string): string {
	const perSec = count / (totalMs / 1000);
	return `${perSec.toFixed(1)} ${unit}/s`;
}

// ---------------------------------------------------------------------------

describe("Pipeline Speed Benchmark", () => {
	it(
		`chunking + embedding throughput on ${BENCH_OWNER}/${BENCH_REPO} (top ${MAX_FILES} files)`,
		async () => {
			// ----------------------------------------------------------------
			// 0. Fetch repo tree (always fresh — no cache)
			// ----------------------------------------------------------------
			console.log(`\n${"=".repeat(60)}`);
			console.log(`Benchmark: ${BENCH_OWNER}/${BENCH_REPO}  (max ${MAX_FILES} files)`);
			console.log("=".repeat(60));

			const t0 = performance.now();
			const tree = await fetchRepoTree(BENCH_OWNER, BENCH_REPO);
			const treeFetchMs = performance.now() - t0;

			const files: FileMeta[] = prioritiseFiles(
				tree.files.filter((f) => isIndexable(f.path))
			).slice(0, MAX_FILES);

			console.log(`\nRepo tree fetched in ${fmt(treeFetchMs)}`);
			console.log(`SHA: ${tree.sha}  |  indexable files selected: ${files.length}`);

			// ----------------------------------------------------------------
			// 1. FETCH PHASE — sequential baseline
			// ----------------------------------------------------------------
			console.log(`\n── FETCH (sequential, ${files.length} files) ──`);

			const seqFetchStart = performance.now();
			const seqFetched: FetchResult[] = [];
			for (const file of files) {
				const t = performance.now();
				const content = await fetchFileContent(BENCH_OWNER, BENCH_REPO, file.path, undefined, tree.sha);
				seqFetched.push({ file, content, elapsedMs: performance.now() - t });
			}
			const seqFetchTotalMs = performance.now() - seqFetchStart;

			const seqAvgMs = seqFetchTotalMs / files.length;
			console.log(`  Total : ${fmt(seqFetchTotalMs)}`);
			console.log(`  Avg   : ${fmt(seqAvgMs)} / file`);
			console.log(`  Rate  : ${fmtThroughput(files.length, seqFetchTotalMs, "files")}`);

			// ----------------------------------------------------------------
			// 2. FETCH PHASE — pooled (FETCH_CONCURRENCY = 5)
			// ----------------------------------------------------------------
			console.log(`\n── FETCH (pooled, concurrency=${CONCURRENCY}, ${files.length} files) ──`);

			const poolFetchStart = performance.now();
			const poolFetched = await pooledMap<FileMeta, FetchResult>(
				files,
				async (file) => {
					const t = performance.now();
					const content = await fetchFileContent(BENCH_OWNER, BENCH_REPO, file.path, undefined, tree.sha);
					return { file, content, elapsedMs: performance.now() - t };
				},
				CONCURRENCY
			);
			const poolFetchTotalMs = performance.now() - poolFetchStart;
			const poolFetchSuccesses = poolFetched.filter(Boolean).length;

			console.log(`  Total : ${fmt(poolFetchTotalMs)}  (${poolFetchSuccesses}/${files.length} succeeded)`);
			console.log(`  Rate  : ${fmtThroughput(poolFetchSuccesses, poolFetchTotalMs, "files")}`);
			console.log(`  Speedup vs sequential: ${(seqFetchTotalMs / poolFetchTotalMs).toFixed(2)}×`);

			// ----------------------------------------------------------------
			// 3. CHUNKING PHASE — using pooled results (clear + re-chunk fresh)
			// ----------------------------------------------------------------
			console.log(`\n── CHUNKING (${poolFetchSuccesses} files) ──`);

			const successfulFetches = poolFetched.filter((r): r is FetchResult => r !== null);
			const chunkStart = performance.now();
			const chunkResults: ChunkResult[] = [];
			let totalChunks = 0;
			let totalContentChars = 0;

			for (const { file, content } of successfulFetches) {
				const t = performance.now();
				const lang = detectLanguage(file.path);
				const chunks = chunkCode(file.path, content, lang ?? undefined);
				const elapsedMs = performance.now() - t;

				chunkResults.push({ file, content, chunkCount: chunks.length, elapsedMs });
				totalChunks += chunks.length;
				totalContentChars += content.length;
			}
			const chunkTotalMs = performance.now() - chunkStart;

			const avgChunksPerFile = totalChunks / chunkResults.length;
			console.log(`  Total : ${fmt(chunkTotalMs)}`);
			console.log(`  Chunks: ${totalChunks}  (avg ${avgChunksPerFile.toFixed(1)}/file)`);
			console.log(`  Chars : ${(totalContentChars / 1000).toFixed(0)} k chars total`);
			console.log(`  Rate  : ${fmtThroughput(chunkResults.length, chunkTotalMs, "files")}`);
			console.log(`  Rate  : ${fmtThroughput(totalChunks, chunkTotalMs, "chunks")}`);

			// Per-file details (top 5 slowest)
			const slowest = [...chunkResults].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5);
			console.log("  Slowest files:");
			for (const r of slowest) {
				console.log(`    ${r.file.path} — ${r.chunkCount} chunks, ${fmt(r.elapsedMs)}`);
			}

			// ----------------------------------------------------------------
			// 4. RE-CHUNK with pooledMap (simulates the live pipeline wave loop)
			// ----------------------------------------------------------------
			console.log(`\n── CHUNKING via pooledMap (concurrency=${CONCURRENCY}) ──`);

			const poolChunkStart = performance.now();
			await pooledMap(
				successfulFetches,
				async ({ file, content }) => {
					const lang = detectLanguage(file.path);
					return chunkCode(file.path, content, lang ?? undefined);
				},
				CONCURRENCY
			);
			const poolChunkTotalMs = performance.now() - poolChunkStart;

			console.log(`  Total : ${fmt(poolChunkTotalMs)}`);
			console.log(`  (chunkCode is CPU-bound/sync so concurrency has minimal impact here)`);

			// ----------------------------------------------------------------
			// 5. EMBEDDING PHASE — real WASM embedder, no mocks
			//    Storage is fresh: we never inserted into any VectorStore.
			// ----------------------------------------------------------------
			console.log(`\n── EMBEDDING (${totalChunks} chunks, WASM backend) ──`);

			// Collect all chunks across all files
			const allChunks: ReturnType<typeof chunkCode> = [];
			for (const { file, content } of successfulFetches) {
				const lang = detectLanguage(file.path);
				allChunks.push(...chunkCode(file.path, content, lang ?? undefined));
			}

			console.log(`  Loading embedding model (Xenova/all-MiniLM-L12-v2)…`);
			const modelLoadStart = performance.now();
			await initEmbedder((msg) => console.log(`  [model] ${msg}`));
			const modelLoadMs = performance.now() - modelLoadStart;
			console.log(`  Model ready in ${fmt(modelLoadMs)}`);

			const embedStart = performance.now();
			let embeddedCount = 0;
			await embedChunks(
				allChunks,
				(done, total) => {
					if (done % 8 === 0 || done === total) {
						const pct = Math.round((done / total) * 100);
						const elapsed = performance.now() - embedStart;
						const rate = done / (elapsed / 1000);
						console.log(`  ${done}/${total} (${pct}%)  ${rate.toFixed(1)} chunks/s`);
					}
					embeddedCount = done;
				},
				1 // batchSize — matches production (1 chunk at a time to reduce load)
			);
			const embedTotalMs = performance.now() - embedStart;

			console.log(`\n── SUMMARY ──`);
			console.log(`  Fetch (sequential) : ${fmt(seqFetchTotalMs)}`);
			console.log(`  Fetch (pooled ×${CONCURRENCY})  : ${fmt(poolFetchTotalMs)}  (${(seqFetchTotalMs / poolFetchTotalMs).toFixed(2)}× faster)`);
			console.log(`  Chunk              : ${fmt(chunkTotalMs)}  → ${fmtThroughput(totalChunks, chunkTotalMs, "chunks")}`);
			console.log(`  Embed              : ${fmt(embedTotalMs)}  → ${fmtThroughput(embeddedCount, embedTotalMs, "chunks")}`);
			console.log(`  Model load (1st)   : ${fmt(modelLoadMs)}`);
			console.log(`  Total pipeline     : ${fmt(poolFetchTotalMs + chunkTotalMs + embedTotalMs)}`);
			console.log(`  vs old sequential  : ${fmt(seqFetchTotalMs + chunkTotalMs + embedTotalMs)}  (fetch bottleneck)`);
			console.log("=".repeat(60));
		},
		/* timeout */ 300_000
	);
});
