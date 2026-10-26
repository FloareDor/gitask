import { describe, it, expect } from "vitest";
import { citationsOverlap, parseCitations } from "./citations";

describe("parseCitations", () => {
	it("reads a line range and a bare line number", () => {
		expect(parseCitations("see src/lib/search.ts:151-170 and src/lib/bm25.ts:12")).toEqual([
			{ path: "src/lib/search.ts", startLine: 151, endLine: 170 },
			{ path: "src/lib/bm25.ts", startLine: 12, endLine: 12 },
		]);
	});

	it("deduplicates repeated citations", () => {
		const text = "a.ts:1-3 does it, and a.ts:1-3 again";
		expect(parseCitations(text)).toHaveLength(1);
	});

	it("ignores prose that only looks like a citation", () => {
		expect(parseCitations("step 2: 3 files changed")).toEqual([]);
		expect(parseCitations("at 10:30 we shipped")).toEqual([]);
	});

	it("drops a backwards range", () => {
		expect(parseCitations("a.ts:40-10")).toEqual([]);
	});

	it("returns nothing for an uncited answer", () => {
		expect(parseCitations("Tokens are signed on startup.")).toEqual([]);
	});
});

describe("citationsOverlap", () => {
	const gold = { path: "src/auth.ts", startLine: 10, endLine: 20 };

	it("matches a range that touches the gold range", () => {
		expect(citationsOverlap(gold, { path: "src/auth.ts", startLine: 18, endLine: 40 })).toBe(true);
		expect(citationsOverlap(gold, { path: "src/auth.ts", startLine: 20, endLine: 20 })).toBe(true);
	});

	it("rejects a different file or a disjoint range", () => {
		expect(citationsOverlap(gold, { path: "src/other.ts", startLine: 10, endLine: 20 })).toBe(false);
		expect(citationsOverlap(gold, { path: "src/auth.ts", startLine: 21, endLine: 30 })).toBe(false);
	});
});
