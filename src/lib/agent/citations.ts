/**
 * Citation parsing.
 *
 * The agent is told to write `path:startLine-endLine` after every claim. Pulling
 * those back out is what lets the loop reject an uncited answer, what Phase 4
 * scores mechanically against gold locations, and what Phase 6 re-reads to check
 * the lines actually support the claim.
 */

export interface Citation {
	path: string;
	startLine: number;
	endLine: number;
}

// A path with an extension, then `:12` or `:12-40`. Deliberately strict about the
// extension so prose like "step 2: 3-4 files" doesn't parse as a citation.
const CITATION_RE = /([A-Za-z0-9._\-/]+\.[A-Za-z0-9]+):(\d+)(?:\s*-\s*(\d+))?/g;

export function parseCitations(text: string): Citation[] {
	const seen = new Set<string>();
	const citations: Citation[] = [];

	for (const match of text.matchAll(CITATION_RE)) {
		const [, path, start, end] = match;
		const startLine = Number(start);
		const endLine = end ? Number(end) : startLine;
		if (endLine < startLine) continue;

		const key = `${path}:${startLine}-${endLine}`;
		if (seen.has(key)) continue;
		seen.add(key);
		citations.push({ path, startLine, endLine });
	}

	return citations;
}

/** True when two line ranges in the same file touch — Phase 4's citation check. */
export function citationsOverlap(a: Citation, b: Citation): boolean {
	return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}
