/**
 * Tool declarations handed to the model, and the dispatch that runs them.
 *
 * Descriptions are part of the prompt: they're where the model learns to narrow
 * down before reading, and that every answer needs line numbers.
 */

import type { VectorStore } from "../vectorStore";
import type { ToolCall, ToolSchema } from "./provider";
import { listSymbols, semanticSearchByFile } from "./navigation";
import { findDefinition, findReferences, grep, readFile, semanticSearch } from "./tools";
import { TOOL_LIMITS, ToolError, type ToolResult } from "./types";

export const TOOL_SCHEMAS: ToolSchema[] = [
	{
		name: "semantic_search",
		description:
			"Find code by meaning. Use this first when you don't know which file to look in. " +
			"Returns file paths with line ranges and a snippet of each match.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What you are looking for, in plain words." },
				k: {
					type: "number",
					description: `How many results, 1-${TOOL_LIMITS.MAX_SEARCH_RESULTS}. Default 5.`,
				},
			},
			required: ["query"],
		},
	},
	{
		name: "grep",
		description:
			"Regex search over every indexed file. Use it for exact strings, config keys, or " +
			`error messages. Returns up to ${TOOL_LIMITS.MAX_GREP_HITS} matching lines with line numbers.`,
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "A JavaScript regular expression." },
				glob: {
					type: "string",
					description: "Optional path filter, e.g. 'src/**/*.ts'. Supports * ** and ?.",
				},
				ignoreCase: { type: "boolean", description: "Case-insensitive match. Default false." },
			},
			required: ["pattern"],
		},
	},
	{
		name: "read_file",
		description:
			"Read a slice of a file with line numbers. Narrow down with semantic_search or grep " +
			`first — this returns at most ${TOOL_LIMITS.MAX_READ_LINES} lines per call.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Repository-relative path, e.g. 'src/lib/search.ts'." },
				startLine: { type: "number", description: "1-based first line. Default 1." },
				endLine: { type: "number", description: "1-based last line, inclusive." },
			},
			required: ["path"],
		},
	},
	{
		name: "find_definition",
		description:
			"Where a function, class, or variable is defined. Faster and more precise than grep " +
			"when you already know the name.",
		parameters: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "Exact symbol name." },
			},
			required: ["symbol"],
		},
	},
	{
		name: "find_references",
		description:
			"Every place a symbol is used, excluding where it is defined. Use this to trace how " +
			"something flows through the codebase.",
		parameters: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "Exact symbol name." },
			},
			required: ["symbol"],
		},
	},
];

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.name);

/**
 * The navigation interface: one extra tool, and a semantic_search that returns
 * files instead of a flat chunk list.
 *
 * Declared separately rather than appended to TOOL_SCHEMAS so that `full` keeps
 * exactly the five tools, in the order, with the descriptions, that every
 * measured agent run saw. The baseline has to stay byte-identical or the
 * `agent` numbers already on disk stop being a comparison.
 */
export const LIST_SYMBOLS_SCHEMA: ToolSchema = {
	name: "list_symbols",
	description:
		"The outline of one file: every function, class, and top-level symbol it defines, with " +
		"line ranges. Call this before read_file on a file you do not know — it is far cheaper " +
		`than reading, and it shows you which of several similar names is the one you want. ` +
		`Lists at most ${TOOL_LIMITS.MAX_OUTLINE_SYMBOLS} symbols.`,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Repository-relative path, e.g. 'src/lib/search.ts'." },
		},
		required: ["path"],
	},
};

const NAV_SEARCH_SCHEMA: ToolSchema = {
	...TOOL_SCHEMAS[0],
	description:
		"Find code by meaning. Use this first when you don't know which file to look in. " +
		"Returns matching files; under each one, the matched symbols with their line ranges " +
		"and code, plus the names of nearby symbols in the same file that did not match. " +
		"Check those neighbours before you settle on a match — the right file often contains " +
		"several similarly named functions and only one of them is the answer.",
};

/**
 * Which tools the agent gets.
 *
 * `search_only` is the ablation that answers "why an agent and not iterative
 * RAG?": same loop, same budget, same model, but the only action is the same
 * hybrid search the RAG arm runs. Whatever the full agent gains over it comes
 * from the exact tools (grep, read_file, definitions, references), not from
 * looping.
 *
 * `nav` is the file-centered interface from RepoNav (arXiv 2609.08355): the
 * same five tools, the same retriever, the same budget, plus list_symbols and
 * search results grouped by file. It is the other half of the same question —
 * search_only asks what the exact tools buy, nav asks what *presenting* them
 * by file buys. Since retrieval is untouched, any delta against `full` is the
 * interface and nothing else.
 */
export type ToolSet = "full" | "search_only" | "nav";

/**
 * Every tool name that exists, across all sets.
 *
 * The loop checks calls against this rather than against TOOL_NAMES: a model
 * that names a tool it was not given must be refused, and a tool outside the
 * baseline five would otherwise fall through the check and run anyway, quietly
 * voiding the ablation it was excluded from.
 */
export const ALL_TOOL_NAMES: readonly string[] = [...TOOL_NAMES, LIST_SYMBOLS_SCHEMA.name];

export const TOOL_SETS: Record<ToolSet, readonly string[]> = {
	full: TOOL_NAMES,
	search_only: ["semantic_search"],
	nav: ALL_TOOL_NAMES,
};

/** The declarations for one tool set, in the order the model sees them. */
export function schemasForToolSet(toolSet: ToolSet): ToolSchema[] {
	if (toolSet === "nav") {
		return [NAV_SEARCH_SCHEMA, ...TOOL_SCHEMAS.slice(1), LIST_SYMBOLS_SCHEMA];
	}
	const allowed = new Set(TOOL_SETS[toolSet]);
	return TOOL_SCHEMAS.filter((schema) => allowed.has(schema.name));
}

export interface RunToolOptions {
	/** Per-hit code shown by semantic_search. */
	snippetChars?: number;
	/** Group semantic_search hits by file and sketch their neighbours. */
	groupByFile?: boolean;
}

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
	const value = args[key];
	if (value === undefined || value === null || value === "") {
		if (required) throw new ToolError(`Missing required argument "${key}".`);
		return undefined;
	}
	if (typeof value !== "string") throw new ToolError(`Argument "${key}" must be a string.`);
	return value;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) throw new ToolError(`Argument "${key}" must be a number.`);
	return parsed;
}

/** Run one tool call. Throws ToolError for anything the model can fix by retrying. */
export function runTool(
	store: VectorStore,
	call: ToolCall,
	options: RunToolOptions = {}
): Promise<ToolResult<unknown>> | ToolResult<unknown> {
	const { name, args } = call;
	switch (name) {
		case "semantic_search": {
			const query = str(args, "query", true);
			const k = num(args, "k") ?? 5;
			return options.groupByFile
				? semanticSearchByFile(store, query, k, options.snippetChars)
				: semanticSearch(store, query, k, options.snippetChars);
		}
		case "grep":
			return grep(store, str(args, "pattern", true), {
				glob: str(args, "glob"),
				ignoreCase: args.ignoreCase === true,
			});
		case "read_file":
			return readFile(store, str(args, "path", true), num(args, "startLine"), num(args, "endLine"));
		case "find_definition":
			return findDefinition(store, str(args, "symbol", true));
		case "find_references":
			return findReferences(store, str(args, "symbol", true));
		case "list_symbols":
			return listSymbols(store, str(args, "path", true));
		default:
			throw new ToolError(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}.`);
	}
}
