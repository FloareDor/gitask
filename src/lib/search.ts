/**
 * Hybrid Search — combines dense vector search with BM25 sparse retrieval,
 * then reranks with cosine similarity.
 */

import { embedText } from "./embedder";
import { binarize, hammingDistance, cosineSimilarity } from "./quantize";
import { bm25Search } from "./bm25";
import { expandCandidatesWithGraph } from "./graphExpansion";
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

const COSINE_RERANK_WEIGHT = 0.7;
const FUSED_PRIOR_WEIGHT = 1 - COSINE_RERANK_WEIGHT;

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
 * Common English words that carry no signal for code search.
 * These are filtered out of keyword extraction so they don't
 * incorrectly boost chunks that happen to contain them.
 */
const KEYWORD_STOP_WORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "must", "shall", "can", "cannot",
	"this", "that", "these", "those", "it", "its",
	"what", "which", "who", "whom", "whose", "when", "where", "why", "how",
	"and", "or", "but", "not", "nor", "so", "yet", "for", "in", "on", "at",
	"to", "from", "of", "with", "by", "about", "into", "through", "during",
	"i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
	"she", "her", "they", "them", "their", "there", "here",
	"any", "all", "some", "no", "few", "more", "most", "other", "such",
	"only", "own", "same", "than", "too", "very", "just", "get", "got",
	"use", "used", "using", "make", "made", "like", "also", "then", "than",
	"out", "up", "over", "after", "before", "between", "each", "both",
	"if", "as", "until", "while", "because", "though", "although",
	"tell", "show", "give", "find", "know", "see", "look", "say",
	"go", "put", "set", "let", "try", "help", "need", "want", "code",
	"file", "line", "add", "new", "old", "run", "work",
]);

/**
 * Keyword search: finds chunks containing exact technical identifier matches.
 * Generic English words are excluded to avoid noise from natural-language queries.
 * Returns a map of chunk ID → match count.
 */
export function keywordSearch(
	chunks: EmbeddedChunk[],
	query: string
): Map<string, number> {
	const scores = new Map<string, number>();

	// Extract symbol patterns (alphanumeric + underscore, 2+ chars), then strip stop words
	const rawSymbols = query.match(/[a-zA-Z_]\w+/g) ?? [];
	const symbols = rawSymbols.filter(
		(s) => s.length >= 2 && !KEYWORD_STOP_WORDS.has(s.toLowerCase())
	);
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
	limit: number = 50,
	chunkBinaries?: Uint32Array[]
): Map<string, number> {
	const queryBinary = binarize(new Float32Array(queryEmbedding));
	const scored: { id: string; dist: number }[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const chunkBinary =
			chunkBinaries && i < chunkBinaries.length
				? chunkBinaries[i]
				: binarize(new Float32Array(chunk.embedding));
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
 * 2. BM25 sparse search
 * 3. Reciprocal Rank Fusion
 * 4. Cosine similarity reranking (Matryoshka-style full dims)
 */
export async function hybridSearch(
	store: VectorStore,
	queryEmbedding: number[],
	query: string,
	options: SearchOptions = {}
): Promise<SearchResult[]> {
	const {
		limit = 5,
		coarseCandidates = 50,
		rrfK = 60,
	} = options;

	const chunks = store.getAll();
	if (chunks.length === 0) return [];
	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const chunkBinaries = store.getAllBinaries();

	// 2. Kick off BM25 sparse retrieval first; it can run in a worker while dense search runs on main thread.
	const bm25ScoresPromise = bm25Search(chunks, query, { limit: coarseCandidates });

	// 1. Vector search (coarse)
	const vectorScores = vectorSearch(chunks, queryEmbedding, coarseCandidates, chunkBinaries);

	// 2. BM25 sparse search (await worker result)
	const bm25Scores = await bm25ScoresPromise;

	// 3. RRF merge
	const fusedScores = reciprocalRankFusion([vectorScores, bm25Scores], rrfK);

	// 4. Get top candidates and rerank with full cosine similarity
	const candidates = [...fusedScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, coarseCandidates);

	const expandedCandidates = expandCandidatesWithGraph(store, candidates, {
		seedCount: 20,
		expansionWeight: 0.5,
	});

	const maxFusedScore = expandedCandidates.reduce(
		(max, [, fusedScore]) => Math.max(max, fusedScore),
		0
	);
	const reranked: SearchResult[] = [];
	for (const [id, fusedScore] of expandedCandidates) {
		const chunk = chunkMap.get(id);
		if (!chunk) continue;

		const cosineScore = cosineSimilarity(queryEmbedding, chunk.embedding);
		const fusedPrior = maxFusedScore > 0 ? fusedScore / maxFusedScore : 0;
		const score = cosineScore * COSINE_RERANK_WEIGHT + fusedPrior * FUSED_PRIOR_WEIGHT;
		reranked.push({ chunk, score, embedding: chunk.embedding });
	}

	reranked.sort((a, b) => b.score - a.score);

	return reranked.slice(0, limit);
}

/** Extract identifiers from query for preference scoring (same pattern as keywordSearch). */
function extractQuerySymbols(query: string): string[] {
	const symbols = query.match(/[a-zA-Z_]\w+/g) ?? [];
	const filtered = symbols
		.map((s) => s.toLowerCase())
		.filter((s) => s.length >= 2 && !KEYWORD_STOP_WORDS.has(s));
	return [...new Set(filtered)];
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
	/** Called after each variant's search resolves — useful for progress UI. */
	onProgress?: (completed: number, total: number) => void;
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
		onProgress,
	} = options;

	const uniqueVariants = [...new Set(queryVariants.map((q) => q.trim()).filter(Boolean))];
	if (uniqueVariants.length === 0) return [];

	const chunks = store.getAll();
	if (chunks.length === 0) return [];

	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const querySymbols = [...new Set(uniqueVariants.flatMap((variant) => extractQuerySymbols(variant)))];

	// Single path: no RRF, just hybridSearch + preference rerank
	if (uniqueVariants.length === 1) {
		const queryEmbedding = await embedText(uniqueVariants[0]);
		const results = await hybridSearch(store, queryEmbedding, uniqueVariants[0], {
			limit,
			coarseCandidates,
			rrfK,
		});
		onProgress?.(1, 1);
		const graph = store.getGraph();
		return applyPreferenceRerank(results, querySymbols, graph, limit, preferenceAlpha);
	}

	// Embed all variants in parallel
	const embeddings = await Promise.all(uniqueVariants.map((q) => embedText(q)));

	// Run hybridSearch per variant with a higher per-path limit so RRF has a good pool
	const perPathLimit = Math.max(limit * 2, 10);
	let completedPaths = 0;
	const pathResults = await Promise.all(
		uniqueVariants.map((q, i) =>
			hybridSearch(store, embeddings[i], q, {
				limit: perPathLimit,
				coarseCandidates,
				rrfK,
			}).then((r) => {
				onProgress?.(++completedPaths, uniqueVariants.length);
				return r;
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
