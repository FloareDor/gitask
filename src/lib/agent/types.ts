/**
 * Shared types and limits for the agent's tools.
 *
 * Every tool returns the same envelope so the agent loop can budget context
 * without knowing what each tool does: it sums `bytes` and shows `truncated`
 * in the trace.
 */

export interface ToolResult<T> {
	result: T;
	/** True when a cap kicked in, so the model knows it isn't seeing everything. */
	truncated: boolean;
	/** UTF-8 size of the serialised result. */
	bytes: number;
}

/**
 * Caps on what a single tool call can hand back. These exist to stop one
 * `grep .` from eating the whole context window.
 */
export const TOOL_LIMITS = {
	/** Lines returned by one read_file call. */
	MAX_READ_LINES: 200,
	/** Matching lines returned by one grep / find_references call. */
	MAX_GREP_HITS: 40,
	/** Per-line clip, so a minified file can't blow the budget on one hit. */
	MAX_LINE_CHARS: 200,
	/** Results returned by one semantic_search call. */
	MAX_SEARCH_RESULTS: 10,
	/** Code shown per search result / definition. */
	MAX_SNIPPET_CHARS: 400,
	/** Definition sites returned by one find_definition call. */
	MAX_DEFINITIONS: 10,
} as const;

/**
 * Bad input from the model (missing file, broken regex). The loop catches these
 * and feeds the message back as the tool result so the model can correct itself.
 */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

const encoder = new TextEncoder();

/** Wrap a tool's payload in the standard envelope. */
export function envelope<T>(result: T, truncated: boolean): ToolResult<T> {
	return {
		result,
		truncated,
		bytes: encoder.encode(JSON.stringify(result)).length,
	};
}

/** Clip text to `max` characters, marking the cut so the model can tell. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
