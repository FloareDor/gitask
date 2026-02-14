/**
 * Hybrid Search — combines vector search (Hamming distance) with
 * keyword regex search, then reranks with cosine similarity.
 */

import { binarize, hammingDistance, cosineSimilarity } from "./quantize";
import type { EmbeddedChunk } from "./embedder";
import type { VectorStore, SearchResult } from "./vectorStore";

export interface SearchOptions {
	/** Max results to return */
	limit?: number;
	/** Number of coarse candidates before reranking */
	coarseCandidates?: number;
	/** RRF constant (default 60) */
	rrfK?: number;
}

/**
 * Reciprocal Rank Fusion — merges two ranked lists.
 * Higher score = more relevant.
 */
export function reciprocalRankFusion(
	lists: Map<string, number>[],
	k: number = 60
): Map<string, number> {
	const scores = new Map<string, number>();

	for (const ranked of lists) {
		// Convert from ranked list to RRF scores
		const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1]);
		sorted.forEach(([id], rank) => {
			const prev = scores.get(id) ?? 0;
			scores.set(id, prev + 1 / (k + rank + 1));
		});
	}

	return scores;
}

/**
 * Keyword search: finds chunks containing exact symbol matches.
 * Returns a map of chunk ID → match count.
 */
export function keywordSearch(
	chunks: EmbeddedChunk[],
	query: string
): Map<string, number> {
	const scores = new Map<string, number>();

	// Extract potential symbol patterns (alphanumeric + underscore, 2+ chars)
	const symbols = query.match(/[a-zA-Z_]\w+/g) ?? [];
	if (symbols.length === 0) return scores;

	for (const chunk of chunks) {
		let matchCount = 0;
		for (const sym of symbols) {
			const regex = new RegExp(`\\b${escapeRegex(sym)}\\b`, "gi");
			const matches = chunk.code.match(regex);
			if (matches) matchCount += matches.length;
		}
		if (matchCount > 0) {
			scores.set(chunk.id, matchCount);
		}
	}

	return scores;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Vector search using binary quantisation + Hamming distance.
 * Returns top-N chunks sorted by similarity (ascending Hamming = most similar).
 */
export function vectorSearch(
	chunks: EmbeddedChunk[],
	queryEmbedding: number[],
	limit: number = 50
): Map<string, number> {
	const queryBinary = binarize(new Float32Array(queryEmbedding));
	const scored: { id: string; dist: number }[] = [];

	for (const chunk of chunks) {
		const chunkBinary = binarize(new Float32Array(chunk.embedding));
		const dist = hammingDistance(queryBinary, chunkBinary);
		scored.push({ id: chunk.id, dist });
	}

	// Sort by distance (ascending = most similar first)
	scored.sort((a, b) => a.dist - b.dist);

	const results = new Map<string, number>();
	for (let i = 0; i < Math.min(limit, scored.length); i++) {
		// Invert distance so higher = better for RRF
		results.set(scored[i].id, 1 / (1 + scored[i].dist));
	}

	return results;
}

/**
 * Full hybrid search pipeline:
 * 1. Binary Hamming vector search (coarse)
 * 2. Keyword regex search
 * 3. Reciprocal Rank Fusion
 * 4. Cosine similarity reranking (Matryoshka-style full dims)
 */
export function hybridSearch(
	store: VectorStore,
	queryEmbedding: number[],
	query: string,
	options: SearchOptions = {}
): SearchResult[] {
	const {
		limit = 5,
		coarseCandidates = 50,
		rrfK = 60,
	} = options;

	const chunks = store.getAll();
	if (chunks.length === 0) return [];

	// 1. Vector search (coarse)
	const vectorScores = vectorSearch(chunks, queryEmbedding, coarseCandidates);

	// 2. Keyword search
	const keywordScores = keywordSearch(chunks, query);

	// 3. RRF merge
	const fusedScores = reciprocalRankFusion([vectorScores, keywordScores], rrfK);

	// 4. Get top candidates and rerank with full cosine similarity
	const candidates = [...fusedScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, coarseCandidates);

	// 3.5 Graph Expansion
	// For top/seed candidates, find what files they import and add those chunks
	const SEED_COUNT = 20;
	const EXPANSION_WEIGHT = 0.5; // Weight for expanded interactions
	const graph = store.getGraph();

	const seenIds = new Set(candidates.map((c) => c[0]));

	// Take the top N candidates as seeds
	const seeds = candidates.slice(0, SEED_COUNT);
	const chunkMap = new Map(chunks.map((c) => [c.id, c]));

	for (const [seedId, seedScore] of seeds) {
		const chunk = chunkMap.get(seedId);
		if (!chunk) continue;

		// Get dependencies for this file
		const deps = graph[chunk.filePath];
		if (!deps || !deps.imports) continue;

		// For each import, try to resolve it to a file in the store
		// Note: imports are raw strings (e.g. './utils'), we need to fuzzy match or resolve to absolute paths.
		// For now, we do a naive suffix check or exact match if possible.
		// Since we don't have a full resolver, we iterate all files? No, that's slow.
		// We can iterate the graph keys to find matching files.

		for (const importPath of deps.imports) {
			// Resolve importPath to filePath. 
			// Heuristic: check if any file in the graph ends with the import path + extension
			// or if importPath is relative, resolve it relative to chunk.filePath

			const targetFile = resolveImport(chunk.filePath, importPath, Object.keys(graph));
			if (targetFile) {
				const neighborChunks = store.getChunksByFile(targetFile);
				for (const neighbor of neighborChunks) {
					if (!seenIds.has(neighbor.id)) {
						candidates.push([neighbor.id, seedScore * EXPANSION_WEIGHT]);
						seenIds.add(neighbor.id);
					}
				}
			}
		}
	}

	const reranked: SearchResult[] = [];
	for (const [id] of candidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;

		const score = cosineSimilarity(queryEmbedding, chunk.embedding);
		reranked.push({ chunk, score, embedding: chunk.embedding });
	}

	reranked.sort((a, b) => b.score - a.score);

	return reranked.slice(0, limit);
}

/**
 * Simple import resolver heuristic.
 * Tries to match `importPath` to a file in `allFiles`.
 */
function resolveImport(currentFile: string, importPath: string, allFiles: string[]): string | null {
	// 1. Exact match (rare for imports)
	if (allFiles.includes(importPath)) return importPath;

	// 2. Normalize import path (remove quotes, handled by extractor)
	// Handle relative imports
	if (importPath.startsWith(".")) {
		// This is tricky without a real path resolver.
		// Let's try to match the filename at the end.
		const basename = importPath.split("/").pop();
		if (!basename) return null;

		// Find files that look like .../basename.ts or .../basename/index.ts
		return allFiles.find(f => {
			if (f.includes(basename)) {
				// Very loose check: verify extensions
				if (f.endsWith(`${basename}.ts`) || f.endsWith(`${basename}.tsx`) ||
					f.endsWith(`${basename}.js`) || f.endsWith(`${basename}/index.ts`)) {
					return true;
				}
			}
			return false;
		}) || null;
	}

	// 3. Absolute/Package imports
	// Try to find a file that *ends with* the import path (e.g. "lib/utils" -> "src/lib/utils.ts")
	return allFiles.find(f => {
		const noExt = f.replace(/\.[^/.]+$/, "");
		return noExt.endsWith(importPath);
	}) || null;
}
