/**
 * PageIndex Search
 *
 * LLM-navigated (Gemini) or keyword-scored (MLC fallback) tree search.
 * Traverses root → dir → file using 2 LLM calls, then retrieves chunks
 * for the selected files.
 *
 * No changes to IndexedDB, embeddings, or VectorStore required.
 */

import { generateFull } from "./llm";
import type { VectorStore } from "./vectorStore";
import type { SearchResult } from "./vectorStore";
import type { PageIndexTree } from "./pageIndexTree";
import type { LLMProvider } from "./llm";

const MAX_DIRS_SHOWN = 20;
const MAX_FILES_SHOWN = 25;
const TOP_DIRS = 3;
const TOP_FILES = 4;

// Stop-words to exclude from keyword scoring
const STOP_WORDS = new Set([
	"a", "an", "the", "is", "it", "in", "of", "on", "to", "for", "and",
	"or", "but", "not", "be", "are", "was", "were", "this", "that",
	"with", "from", "by", "at", "as", "do", "does", "did", "how",
	"what", "where", "when", "which", "who", "why", "has", "have",
	"had", "can", "could", "would", "should", "will", "may", "might",
]);

/** Attempt to parse JSON array from LLM response; fall back to regex extraction. */
function parseJsonArray(response: string): string[] {
	const trimmed = response.trim();
	// Try to find JSON array in the response
	const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
	if (arrayMatch) {
		try {
			const parsed = JSON.parse(arrayMatch[0]);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch {
			// fall through
		}
	}
	// Regex fallback: extract double-quoted strings
	const matches = trimmed.match(/"([^"]+)"/g);
	return matches ? matches.map((s) => s.slice(1, -1)) : [];
}

/** Tokenize a query into lowercase terms, filtering stop-words. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Score a node summary by counting how many query tokens appear in it. */
function keywordScore(summary: string, queryTokens: string[]): number {
	const lower = summary.toLowerCase();
	return queryTokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
}

/**
 * MLC fallback: keyword-score dir and file nodes, return top chunks.
 * No LLM calls — instant, works with any provider.
 */
function mlcKeywordSearch(
	tree: PageIndexTree,
	store: VectorStore,
	query: string
): { results: SearchResult[]; navPath: string[] } {
	const queryTokens = tokenize(query);
	const rootNode = tree.nodes[tree.rootId];
	if (!rootNode) return { results: [], navPath: [] };

	// Score dir nodes
	const scoredDirs = rootNode.childIds
		.map((dirId) => ({
			dirId,
			score: keywordScore(tree.nodes[dirId]?.summary ?? "", queryTokens),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, TOP_DIRS);

	const navPath: string[] = [];
	const selectedFileIds: string[] = [];

	for (const { dirId } of scoredDirs) {
		const dirNode = tree.nodes[dirId];
		if (!dirNode) continue;
		navPath.push(dirNode.path);

		// Score file nodes within this dir
		const scoredFiles = dirNode.childIds
			.map((fileId) => ({
				fileId,
				score: keywordScore(tree.nodes[fileId]?.summary ?? "", queryTokens),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, Math.ceil(TOP_FILES / TOP_DIRS));

		for (const { fileId } of scoredFiles) {
			selectedFileIds.push(fileId);
			const fileNode = tree.nodes[fileId];
			if (fileNode) navPath.push(fileNode.path);
		}
	}

	const results: SearchResult[] = [];
	for (const fileId of selectedFileIds) {
		const fileNode = tree.nodes[fileId];
		if (!fileNode) continue;
		const chunks = store.getChunksByFile(fileNode.path);
		for (const chunk of chunks) {
			results.push({ chunk, score: 1.0 });
		}
	}

	return { results, navPath };
}

/**
 * Gemini path: 2 LLM calls to navigate root → dir → file → chunks.
 */
async function geminiLLMSearch(
	tree: PageIndexTree,
	store: VectorStore,
	query: string
): Promise<{ results: SearchResult[]; navPath: string[] }> {
	const rootNode = tree.nodes[tree.rootId];
	if (!rootNode) return { results: [], navPath: [] };

	// ── Step 1: Dir selection ────────────────────────────────────────────────
	const dirNodeIds = rootNode.childIds.slice(0, MAX_DIRS_SHOWN);
	const dirLines = dirNodeIds.map((dirId, i) => {
		const node = tree.nodes[dirId];
		return `[${i + 1}] ${node.path || "(root)"}   — ${node.summary.slice(0, 120)}`;
	});

	const dirPrompt = `Repository query: "${query}"

Below are the top-level directories in this codebase.
Pick up to ${TOP_DIRS} directories most likely to contain the answer.
Respond with ONLY a JSON array of directory paths, e.g. ["src/lib/", "src/app/"].

${dirLines.join("\n")}`;

	let selectedDirs: string[] = [];
	try {
		const dirResponse = await generateFull([
			{ role: "user", content: dirPrompt },
		]);
		selectedDirs = parseJsonArray(dirResponse);
	} catch (err) {
		console.warn("[PageIndex] Dir selection LLM call failed:", err);
		// Fallback: pick first TOP_DIRS dirs
		selectedDirs = dirNodeIds.slice(0, TOP_DIRS).map((id) => tree.nodes[id]?.path ?? "");
	}

	// Resolve dir IDs by matching paths
	const selectedDirIds = selectedDirs
		.map((path) => dirNodeIds.find((id) => tree.nodes[id]?.path === path))
		.filter((id): id is string => !!id);

	// If nothing matched, fall back to top dirs
	if (selectedDirIds.length === 0) {
		selectedDirIds.push(...dirNodeIds.slice(0, TOP_DIRS));
	}

	// ── Step 2: File selection ───────────────────────────────────────────────
	const fileNodeIds: string[] = [];
	for (const dirId of selectedDirIds) {
		const dirNode = tree.nodes[dirId];
		if (dirNode) fileNodeIds.push(...dirNode.childIds);
	}
	const cappedFileIds = fileNodeIds.slice(0, MAX_FILES_SHOWN);

	const fileLines = cappedFileIds.map((fileId, i) => {
		const node = tree.nodes[fileId];
		return `[${i + 1}] ${node?.path ?? fileId}   — ${(node?.summary ?? "").slice(0, 120)}`;
	});

	const filePrompt = `Repository query: "${query}"

Below are files from the selected directories.
Pick up to ${TOP_FILES} files most likely to contain the answer.
Respond with ONLY a JSON array of file paths, e.g. ["src/lib/llm.ts", "src/lib/search.ts"].

${fileLines.join("\n")}`;

	let selectedFiles: string[] = [];
	try {
		const fileResponse = await generateFull([
			{ role: "user", content: filePrompt },
		]);
		selectedFiles = parseJsonArray(fileResponse);
	} catch (err) {
		console.warn("[PageIndex] File selection LLM call failed:", err);
		selectedFiles = cappedFileIds.slice(0, TOP_FILES).map((id) => tree.nodes[id]?.path ?? "");
	}

	// Resolve file IDs by matching paths
	const selectedFileIds = selectedFiles
		.map((path) => cappedFileIds.find((id) => tree.nodes[id]?.path === path))
		.filter((id): id is string => !!id);

	if (selectedFileIds.length === 0) {
		selectedFileIds.push(...cappedFileIds.slice(0, TOP_FILES));
	}

	// ── Collect chunks ───────────────────────────────────────────────────────
	const navPath: string[] = [
		...selectedDirIds.map((id) => tree.nodes[id]?.path ?? id),
		...selectedFileIds.map((id) => tree.nodes[id]?.path ?? id),
	];

	const results: SearchResult[] = [];
	for (const fileId of selectedFileIds) {
		const fileNode = tree.nodes[fileId];
		if (!fileNode) continue;
		const chunks = store.getChunksByFile(fileNode.path);
		for (const chunk of chunks) {
			results.push({ chunk, score: 1.0 });
		}
	}

	return { results, navPath };
}

/**
 * Main entry point: run PageIndex search using either the Gemini LLM navigator
 * or the MLC keyword-scoring fallback.
 */
export async function pageIndexSearch(
	tree: PageIndexTree,
	store: VectorStore,
	query: string,
	provider: LLMProvider
): Promise<{ results: SearchResult[]; navPath: string[] }> {
	if (provider === "gemini") {
		return geminiLLMSearch(tree, store, query);
	}
	return mlcKeywordSearch(tree, store, query);
}
