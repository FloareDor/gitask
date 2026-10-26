/**
 * Tool declarations handed to the model, and the dispatch that runs them.
 *
 * Descriptions are part of the prompt: they're where the model learns to narrow
 * down before reading, and that every answer needs line numbers.
 */

import type { VectorStore } from "../vectorStore";
import type { ToolCall, ToolSchema } from "./provider";
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
	call: ToolCall
): Promise<ToolResult<unknown>> | ToolResult<unknown> {
	const { name, args } = call;
	switch (name) {
		case "semantic_search":
			return semanticSearch(store, str(args, "query", true), num(args, "k") ?? 5);
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
		default:
			throw new ToolError(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}.`);
	}
}
