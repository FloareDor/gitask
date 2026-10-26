/**
 * Line-oriented regex search over the raw file text the indexer stored.
 *
 * Pure function over `{ path: content }` so it can move into a worker later
 * (same split bm25-core/bm25 uses) without any caller changing.
 */

import { TOOL_LIMITS, ToolError, clip } from "./types";

export interface GrepHit {
	path: string;
	/** 1-based, matching what read_file prints and what citations use. */
	line: number;
	text: string;
}

export interface GrepOptions {
	/** Restrict to paths matching a glob, e.g. every `.ts` file under `src`. */
	glob?: string;
	ignoreCase?: boolean;
	maxHits?: number;
	maxLineChars?: number;
}

export interface GrepOutcome {
	hits: GrepHit[];
	truncated: boolean;
}

/**
 * Translate a glob to an anchored regex. Supports `*` (within a path segment),
 * `**` (across segments) and `?`. Enough for "only look at Python files".
 */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				pattern += ".*";
				i++;
				// `**/` should also match zero directories, so swallow the slash.
				if (glob[i + 1] === "/") i++;
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}

function compile(pattern: string, ignoreCase: boolean): RegExp {
	try {
		return new RegExp(pattern, ignoreCase ? "i" : "");
	} catch (e) {
		throw new ToolError(
			`Invalid regex ${JSON.stringify(pattern)}: ${(e as Error).message}`
		);
	}
}

export function grepFiles(
	files: Record<string, string>,
	pattern: string,
	options: GrepOptions = {}
): GrepOutcome {
	const {
		glob,
		ignoreCase = false,
		maxHits = TOOL_LIMITS.MAX_GREP_HITS,
		maxLineChars = TOOL_LIMITS.MAX_LINE_CHARS,
	} = options;

	const matcher = compile(pattern, ignoreCase);
	const pathFilter = glob ? globToRegExp(glob) : null;
	const hits: GrepHit[] = [];

	// Sorted so the same query gives the same answer run to run — the eval
	// compares traces across runs.
	for (const path of Object.keys(files).sort()) {
		if (pathFilter && !pathFilter.test(path)) continue;

		const lines = files[path].split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!matcher.test(lines[i])) continue;
			if (hits.length >= maxHits) return { hits, truncated: true };
			hits.push({ path, line: i + 1, text: clip(lines[i].trim(), maxLineChars) });
		}
	}

	return { hits, truncated: false };
}
