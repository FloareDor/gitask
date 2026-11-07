/**
 * File-centered navigation: the same retriever, a different interface.
 *
 * The flat tools in `tools.ts` hand the model a list of chunks. A chunk list
 * answers "which code looks like the query" but not "which function in this
 * file is the one you want" — and that second question is where localisation
 * actually fails. RepoNav (arXiv 2609.08355) measured 44–58% of function-level
 * misses landing in the *correct file* on the *wrong function*.
 *
 * So nothing here touches retrieval. `semanticSearchByFile` runs the identical
 * `hybridSearch` call `semanticSearch` runs, with the identical limit, and only
 * reshapes the result: hits grouped under their file, each one named, plus a
 * sketch of the sibling symbols the search did not return. `listSymbols` is the
 * on-demand version of that sketch for any file. Both read the names the AST
 * chunker already wrote onto every chunk, so there is no new index, no new
 * embedding pass, and no graph to keep current.
 *
 * Keeping the retriever fixed is the whole point: the `agent` and `agent_nav`
 * arms differ in presentation only, so the eval delta is attributable to the
 * interface rather than to a better search.
 */

import { embedText } from "../embedder";
import { hybridSearch } from "../search";
import type { VectorStore } from "../vectorStore";
import { missingFileMessage } from "./tools";
import { TOOL_LIMITS, ToolError, clip, envelope, type ToolResult } from "./types";

export interface SymbolEntry {
	name: string;
	nodeType: string;
	startLine: number;
	endLine: number;
}

export interface FileOutline {
	path: string;
	totalLines: number;
	/** Named symbols the chunker found, in source order. */
	symbols: SymbolEntry[];
	/** How many were dropped by the cap, so the model knows the sketch is partial. */
	omittedSymbols: number;
}

export interface FileMatch extends SymbolEntry {
	snippet: string;
	score: number;
}

export interface FileGroup {
	path: string;
	totalLines: number;
	/** Best score among this file's hits — the order the files are shown in. */
	score: number;
	/** The chunks search actually returned, in source order. */
	matches: FileMatch[];
	/**
	 * Named symbols in the same file that search did *not* return. This is the
	 * cheap fix for right-file/wrong-function: the model can see that
	 * `refresh_session` sits next to `refresh_token` without spending a
	 * read_file call to find out.
	 */
	otherSymbols: string[];
	omittedSymbols: number;
}

/** Anonymous chunks (a module body, a config blob) have nothing to navigate by. */
function isNamed(chunk: { name?: string }): boolean {
	return typeof chunk.name === "string" && chunk.name.trim().length > 0;
}

function bySourceOrder(a: { startLine: number }, b: { startLine: number }): number {
	return a.startLine - b.startLine;
}

function countLines(content: string): number {
	return content.split("\n").length;
}

/**
 * Every named symbol in one file, with its line range.
 *
 * The model is expected to call this before `read_file` on an unfamiliar file:
 * the outline costs a fraction of the bytes and usually makes the read
 * unnecessary or much narrower.
 */
export function listSymbols(store: VectorStore, path: string): ToolResult<FileOutline> {
	const content = store.getFile(path);
	if (content === undefined) throw new ToolError(missingFileMessage(store, path));

	const seen = new Set<string>();
	const symbols: SymbolEntry[] = [];
	for (const chunk of store.getChunksByFile(path)) {
		if (!isNamed(chunk)) continue;
		// One entry per symbol per position: a chunker can emit the same name
		// twice (an overload, a re-export) and both are worth showing, but the
		// identical chunk split across passes is not.
		const key = `${chunk.name}:${chunk.startLine}`;
		if (seen.has(key)) continue;
		seen.add(key);
		symbols.push({
			name: chunk.name,
			nodeType: chunk.nodeType,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
		});
	}
	symbols.sort(bySourceOrder);

	const capped = symbols.slice(0, TOOL_LIMITS.MAX_OUTLINE_SYMBOLS);
	const omittedSymbols = symbols.length - capped.length;

	return envelope(
		{ path, totalLines: countLines(content), symbols: capped, omittedSymbols },
		omittedSymbols > 0
	);
}

/**
 * Hybrid search, grouped by file.
 *
 * `k` still means "how many chunks to retrieve", not "how many files to show" —
 * the retrieval call is byte-for-byte the one `semanticSearch` makes, so the
 * two tools see the same evidence and differ only in how it is laid out. A
 * `k` of 5 that lands three hits in one file returns three files, not five.
 */
export async function semanticSearchByFile(
	store: VectorStore,
	query: string,
	k: number = 5,
	snippetChars: number = TOOL_LIMITS.MAX_SNIPPET_CHARS
): Promise<ToolResult<FileGroup[]>> {
	if (!query.trim()) throw new ToolError("semantic_search needs a non-empty query.");

	const limit = Math.min(Math.max(1, Math.floor(k)), TOOL_LIMITS.MAX_SEARCH_RESULTS);
	const embedding = await embedText(query);
	const results = await hybridSearch(store, embedding, query, { limit });

	let truncated = limit < k;
	const groups = new Map<string, FileGroup>();

	for (const { chunk, score } of results) {
		const snippet = clip(chunk.code, snippetChars);
		if (snippet.length < chunk.code.length) truncated = true;

		let group = groups.get(chunk.filePath);
		if (!group) {
			const content = store.getFile(chunk.filePath);
			group = {
				path: chunk.filePath,
				// A file can be indexed from an older snapshot that stored chunks
				// but not raw text; 0 reads as "unknown" rather than crashing.
				totalLines: content === undefined ? 0 : countLines(content),
				score: Number(score.toFixed(4)),
				matches: [],
				otherSymbols: [],
				omittedSymbols: 0,
			};
			groups.set(chunk.filePath, group);
		}

		group.matches.push({
			name: isNamed(chunk) ? chunk.name : "(unnamed)",
			nodeType: chunk.nodeType,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			snippet,
			score: Number(score.toFixed(4)),
		});
	}

	for (const group of groups.values()) {
		group.matches.sort(bySourceOrder);

		// Siblings are keyed by name+line so a symbol that matched at one
		// position still shows at another, but a matched chunk never shows twice.
		const matched = new Set(group.matches.map((m) => `${m.name}:${m.startLine}`));
		const siblings: SymbolEntry[] = [];
		for (const chunk of store.getChunksByFile(group.path)) {
			if (!isNamed(chunk)) continue;
			if (matched.has(`${chunk.name}:${chunk.startLine}`)) continue;
			siblings.push({
				name: chunk.name,
				nodeType: chunk.nodeType,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
			});
		}
		siblings.sort(bySourceOrder);

		const capped = siblings.slice(0, TOOL_LIMITS.MAX_SIBLING_SYMBOLS);
		group.omittedSymbols = siblings.length - capped.length;
		// Lines included: the model can go straight to read_file on a sibling
		// without a find_definition round trip.
		group.otherSymbols = capped.map((s) => `${s.name} (${s.nodeType}) ${s.startLine}-${s.endLine}`);
		if (group.omittedSymbols > 0) truncated = true;
	}

	const ordered = [...groups.values()].sort((a, b) => b.score - a.score);
	return envelope(ordered, truncated);
}
