/**
 * Tests for LLM-powered query expansion.
 * The LLM won't be available in test env, so we verify fallback behaviour.
 */

import { describe, it, expect } from "vitest";
import { generateQueryVariants, getRetrievalRefinement } from "./queryExpansion";

describe("generateQueryVariants", () => {
	it("returns original query as fallback when LLM not available", async () => {
		const variants = await generateQueryVariants("how does it work?", [], "");
		expect(variants.length).toBeGreaterThanOrEqual(1);
		expect(variants[0]).toBe("how does it work?");
	});

	it("handles empty query", async () => {
		const variants = await generateQueryVariants("", [], "");
		expect(variants).toEqual([""]);
	});

	it("returns an array of strings", async () => {
		const variants = await generateQueryVariants("where is hybridSearch defined?", [], "");
		for (const v of variants) {
			expect(typeof v).toBe("string");
		}
	});

	it("never returns duplicate strings", async () => {
		const variants = await generateQueryVariants("what llms are used?", [], "");
		const lower = variants.map((v) => v.toLowerCase());
		const unique = [...new Set(lower)];
		expect(unique.length).toBe(lower.length);
	});
});

describe("getRetrievalRefinement", () => {
	it("returns null when results are sufficient", async () => {
		const results = [
			{ filePath: "src/llm.ts", code: "export function generate()", score: 0.9 },
			{ filePath: "src/llm.ts", code: "export function generateFull()", score: 0.85 },
			{ filePath: "src/gemini.ts", code: "const model = new GoogleGenerativeAI()", score: 0.8 },
		];
		const refined = await getRetrievalRefinement("how does generate work?", results);
		expect(refined).toBeNull();
	});

	it("returns null on empty results when LLM not available", async () => {
		const refined = await getRetrievalRefinement("what llms are used?", []);
		expect(refined).toBeNull();
	});
});
