/**
 * Hybrid Search — combines vector search (Hamming distance) with
 * keyword regex search, then reranks with cosine similarity.
 */

import { embedText } from "./embedder";
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
	const allFiles = [...new Set(chunks.map((c) => c.filePath))];

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

			const targetFile = resolveImport(chunk.filePath, importPath, allFiles);
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

/** Extract identifiers from query for preference scoring (same pattern as keywordSearch). */
function extractQuerySymbols(query: string): string[] {
	const symbols = query.match(/[a-zA-Z_]\w+/g) ?? [];
	return [...new Set(symbols)];
}

/**
 * Compute a preference score for a chunk (definition + keyword overlap).
 * Used to favor chunks that define symbols mentioned in the query.
 */
function computePreferenceScore(
	chunk: EmbeddedChunk,
	querySymbols: string[],
	graph: Record<string, { imports: string[]; definitions: string[] }>
): number {
	if (querySymbols.length === 0) return 0;

	let definitionBonus = 0;
	const fileDefs = graph[chunk.filePath]?.definitions ?? [];
	const symbolSet = new Set(querySymbols.map((s) => s.toLowerCase()));
	// Chunk defines a query symbol if chunk.name matches or file-level definitions include it
	if (chunk.name && symbolSet.has(chunk.name.toLowerCase())) {
		definitionBonus = 1;
	} else if (fileDefs.some((d) => symbolSet.has(d.toLowerCase()))) {
		const mentioned = fileDefs.some((d) => {
			if (!symbolSet.has(d.toLowerCase())) return false;
			const regex = new RegExp(`\\b${escapeRegex(d)}\\b`, "i");
			return regex.test(chunk.code);
		});
		definitionBonus = mentioned ? 0.6 : 0;
	}

	let keywordCount = 0;
	for (const sym of querySymbols) {
		const regex = new RegExp(`\\b${escapeRegex(sym)}\\b`, "gi");
		if (regex.test(chunk.code)) keywordCount++;
	}
	const keywordRatio = keywordCount / querySymbols.length;

	// Combine: definition is strong signal, keyword overlap helps
	return Math.min(1, definitionBonus * 0.5 + keywordRatio * 0.5);
}

export interface MultiPathSearchOptions extends SearchOptions {
	/** Weight for cosine vs preference in final rerank (default 0.7 = cosine dominates) */
	preferenceAlpha?: number;
}

/**
 * Multi-path hybrid search (CodeRAG-style): run retrieval for each query variant,
 * fuse with RRF, then preference-aware rerank.
 *
 * @see Zhang et al., "CodeRAG: Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion", EMNLP 2025. https://arxiv.org/abs/2509.16112
 */
export async function multiPathHybridSearch(
	store: VectorStore,
	queryVariants: string[],
	options: MultiPathSearchOptions = {}
): Promise<SearchResult[]> {
	const {
		limit = 5,
		coarseCandidates = 50,
		rrfK = 60,
		preferenceAlpha = 0.7,
	} = options;

	const uniqueVariants = [...new Set(queryVariants.map((q) => q.trim()).filter(Boolean))];
	if (uniqueVariants.length === 0) return [];

	const chunks = store.getAll();
	if (chunks.length === 0) return [];

	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const querySymbols = extractQuerySymbols(uniqueVariants[0]);

	// Single path: no RRF, just hybridSearch + preference rerank
	if (uniqueVariants.length === 1) {
		const queryEmbedding = await embedText(uniqueVariants[0]);
		const results = hybridSearch(store, queryEmbedding, uniqueVariants[0], {
			limit,
			coarseCandidates,
			rrfK,
		});
		const graph = store.getGraph();
		return applyPreferenceRerank(results, querySymbols, graph, limit, preferenceAlpha);
	}

	// Embed all variants in parallel
	const embeddings = await Promise.all(uniqueVariants.map((q) => embedText(q)));

	// Run hybridSearch per variant with a higher per-path limit so RRF has a good pool
	const perPathLimit = Math.max(limit * 2, 10);
	const pathResults = await Promise.all(
		uniqueVariants.map((q, i) =>
			hybridSearch(store, embeddings[i], q, {
				limit: perPathLimit,
				coarseCandidates,
				rrfK,
			})
		)
	);

	// Convert each path to Map<chunkId, score> for RRF (score = cosine from SearchResult)
	const scoreMaps = pathResults.map((results) => {
		const m = new Map<string, number>();
		results.forEach((r) => m.set(r.chunk.id, r.score));
		return m;
	});

	const fusedScores = reciprocalRankFusion(scoreMaps, rrfK);
	const rrfTopIds = [...fusedScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, coarseCandidates)
		.map(([id]) => id);

	// Build candidate results with cosine score from primary (first) query embedding
	const primaryEmbedding = embeddings[0];
	const candidates: SearchResult[] = [];
	for (const id of rrfTopIds) {
		const chunk = chunkMap.get(id) as EmbeddedChunk | undefined;
		if (!chunk) continue;
		const score = cosineSimilarity(primaryEmbedding, chunk.embedding);
		candidates.push({ chunk, score, embedding: chunk.embedding });
	}

	const graph = store.getGraph();
	return applyPreferenceRerank(candidates, querySymbols, graph, limit, preferenceAlpha);
}

/**
 * Apply preference rerank: combine cosine score with definition/keyword preference.
 */
function applyPreferenceRerank(
	results: SearchResult[],
	querySymbols: string[],
	graph: Record<string, { imports: string[]; definitions: string[] }>,
	limit: number,
	alpha: number
): SearchResult[] {
	if (querySymbols.length === 0) {
		return results.slice(0, limit);
	}

	const scored = results.map((r) => {
		const pref = computePreferenceScore(r.chunk as EmbeddedChunk, querySymbols, graph);
		const finalScore = alpha * r.score + (1 - alpha) * pref;
		return { ...r, score: finalScore };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/**
 * Simple import resolver heuristic.
 * Tries to match `importPath` to a file in `allFiles`.
 */
function resolveImport(currentFile: string, importPath: string, allFiles: string[]): string | null {
	const normalize = (p: string) => p.replace(/\\/g, "/");
	const current = normalize(currentFile);
	const requested = normalize(importPath);
	const normalizedFiles = allFiles.map(normalize);

	const hasExt = /\.[^/.]+$/.test(requested);
	const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
	const candidatePaths = new Set<string>();

	const addModuleCandidates = (base: string) => {
		const clean = base.replace(/\/+$/, "");
		candidatePaths.add(clean);
		if (!hasExt) {
			for (const ext of extensions) candidatePaths.add(`${clean}${ext}`);
			for (const ext of extensions) candidatePaths.add(`${clean}/index${ext}`);
		}
	};

	// 1. Relative imports: resolve against current file directory.
	if (requested.startsWith(".")) {
		const parts = current.split("/");
		parts.pop(); // filename
		for (const segment of requested.split("/")) {
			if (!segment || segment === ".") continue;
			if (segment === "..") parts.pop();
			else parts.push(segment);
		}
		addModuleCandidates(parts.join("/"));
	}

	// 2. Workspace absolute-like imports (e.g. src/lib/utils) and package-like suffixes.
	addModuleCandidates(requested);

	for (const candidate of candidatePaths) {
		const exactIdx = normalizedFiles.indexOf(candidate);
		if (exactIdx !== -1) return allFiles[exactIdx];
	}

	// 3. Fallback suffix match (for aliases) with longest match preference.
	const suffixMatches = normalizedFiles
		.map((f, idx) => ({ f, idx }))
		.filter(({ f }) => {
			const noExt = f.replace(/\.[^/.]+$/, "");
			return noExt.endsWith(requested);
		})
		.sort((a, b) => b.f.length - a.f.length);
	if (suffixMatches.length > 0) {
		return allFiles[suffixMatches[0].idx];
	}

	return null;
}
