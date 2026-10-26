/**
 * The agent's toolbox.
 *
 * Every tool reads from an indexed VectorStore and nothing else — no network,
 * no hidden state — so a tool call is reproducible for a given index. Each one
 * returns the `ToolResult` envelope and caps its own output.
 */

import { embedText } from "../embedder";
import { hybridSearch } from "../search";
import type { VectorStore } from "../vectorStore";
import { grepFiles, type GrepHit, type GrepOptions } from "./grep";
import {
	TOOL_LIMITS,
	ToolError,
	clip,
	envelope,
	escapeRegExp,
	type ToolResult,
} from "./types";

export interface SearchHit {
	path: string;
	startLine: number;
	endLine: number;
	snippet: string;
	score: number;
}

export interface DefinitionHit {
	path: string;
	name: string;
	nodeType: string;
	startLine: number;
	endLine: number;
	snippet: string;
}

export interface FileSlice {
	path: string;
	startLine: number;
	endLine: number;
	/** Line-numbered text, so the model has to cite lines that exist. */
	content: string;
	totalLines: number;
}

/**
 * Hybrid search over the index — the same retrieval path the RAG arm uses, so
 * the agent-vs-RAG comparison isolates the loop, not the retriever.
 */
export async function semanticSearch(
	store: VectorStore,
	query: string,
	k: number = 5
): Promise<ToolResult<SearchHit[]>> {
	if (!query.trim()) throw new ToolError("semantic_search needs a non-empty query.");

	const limit = Math.min(Math.max(1, Math.floor(k)), TOOL_LIMITS.MAX_SEARCH_RESULTS);
	const embedding = await embedText(query);
	const results = await hybridSearch(store, embedding, query, { limit });

	let truncated = limit < k;
	const hits = results.map(({ chunk, score }) => {
		const snippet = clip(chunk.code, TOOL_LIMITS.MAX_SNIPPET_CHARS);
		if (snippet.length < chunk.code.length) truncated = true;
		return {
			path: chunk.filePath,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			snippet,
			score: Number(score.toFixed(4)),
		};
	});

	return envelope(hits, truncated);
}

/** Regex search over every indexed file. */
export function grep(
	store: VectorStore,
	pattern: string,
	options: GrepOptions = {}
): ToolResult<GrepHit[]> {
	const { hits, truncated } = grepFiles(store.getFiles(), pattern, options);
	return envelope(hits, truncated);
}

/**
 * Read a slice of a file. Defaults to the first `MAX_READ_LINES` lines; the
 * model is expected to narrow down with grep or semantic_search first.
 */
export function readFile(
	store: VectorStore,
	path: string,
	startLine?: number,
	endLine?: number
): ToolResult<FileSlice> {
	const content = store.getFile(path);
	if (content === undefined) throw new ToolError(missingFileMessage(store, path));

	const lines = content.split("\n");
	const from = Math.max(1, Math.floor(startLine ?? 1));
	if (from > lines.length) {
		throw new ToolError(`${path} has ${lines.length} lines; line ${from} does not exist.`);
	}

	const requestedTo = Math.min(lines.length, Math.floor(endLine ?? lines.length));
	const to = Math.min(requestedTo, from + TOOL_LIMITS.MAX_READ_LINES - 1);
	const slice = lines.slice(from - 1, to);
	const width = String(to).length;

	return envelope(
		{
			path,
			startLine: from,
			endLine: to,
			content: slice
				.map((line, i) => `${String(from + i).padStart(width)}| ${clip(line, TOOL_LIMITS.MAX_LINE_CHARS)}`)
				.join("\n"),
			totalLines: lines.length,
		},
		to < requestedTo
	);
}

/**
 * Where a symbol is defined. Chunk names come from the AST, so they're exact;
 * the dependency graph covers files whose definitions the chunker didn't name.
 */
export function findDefinition(store: VectorStore, symbol: string): ToolResult<DefinitionHit[]> {
	if (!symbol.trim()) throw new ToolError("find_definition needs a symbol name.");

	const chunks = store.getAll();
	const exact = chunks.filter((c) => c.name === symbol);
	const matches = exact.length > 0
		? exact
		: chunks.filter((c) => c.name.toLowerCase() === symbol.toLowerCase());

	const hits: DefinitionHit[] = matches.map((c) => ({
		path: c.filePath,
		name: c.name,
		nodeType: c.nodeType,
		startLine: c.startLine,
		endLine: c.endLine,
		snippet: clip(c.code, TOOL_LIMITS.MAX_SNIPPET_CHARS),
	}));

	// Files the graph says define the symbol but that produced no named chunk.
	// Grep gives them a real line number so they're still citable.
	const seen = new Set(hits.map((h) => h.path));
	for (const [path, entry] of Object.entries(store.getGraph())) {
		if (seen.has(path) || !entry.definitions.includes(symbol)) continue;
		const line = firstMatchingLine(store, path, symbol);
		if (!line) continue;
		hits.push({
			path,
			name: symbol,
			nodeType: "declaration",
			startLine: line.line,
			endLine: line.line,
			snippet: line.text,
		});
	}

	hits.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
	const capped = hits.slice(0, TOOL_LIMITS.MAX_DEFINITIONS);
	return envelope(capped, capped.length < hits.length);
}

/** Every mention of a symbol except the lines where it is defined. */
export function findReferences(store: VectorStore, symbol: string): ToolResult<GrepHit[]> {
	if (!symbol.trim()) throw new ToolError("find_references needs a symbol name.");

	const definitions = findDefinition(store, symbol).result;
	const { hits, truncated } = grepFiles(
		store.getFiles(),
		`\\b${escapeRegExp(symbol)}\\b`,
		// Ask for extra hits because definition sites are about to be dropped.
		{ maxHits: TOOL_LIMITS.MAX_GREP_HITS + TOOL_LIMITS.MAX_DEFINITIONS }
	);

	const references = hits.filter(
		(hit) => !definitions.some(
			(d) => d.path === hit.path && hit.line >= d.startLine && hit.line <= d.endLine
		)
	);
	const capped = references.slice(0, TOOL_LIMITS.MAX_GREP_HITS);
	return envelope(capped, truncated || capped.length < references.length);
}

function firstMatchingLine(store: VectorStore, path: string, symbol: string): GrepHit | undefined {
	const content = store.getFile(path);
	if (content === undefined) return undefined;
	return grepFiles({ [path]: content }, `\\b${escapeRegExp(symbol)}\\b`, { maxHits: 1 }).hits[0];
}

/** Wrong paths are the model's most common mistake, so point it at near misses. */
function missingFileMessage(store: VectorStore, path: string): string {
	const base = path.split("/").pop() ?? path;
	const near = Object.keys(store.getFiles())
		.filter((p) => p.endsWith(`/${base}`) || p === base)
		.slice(0, 3);
	const hint = near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "";
	return `${path} is not in the index.${hint}`;
}
