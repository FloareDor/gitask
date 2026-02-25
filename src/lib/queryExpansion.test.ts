/**
 * Tests for query expansion — CodeRAG-style multi-path query variants.
 */

import { describe, it, expect } from "vitest";
import { expandQuery } from "./queryExpansion";

describe("expandQuery", () => {
	it("returns at least original message", () => {
		const variants = expandQuery("how does it work?");
		expect(variants.length).toBeGreaterThanOrEqual(1);
		expect(variants[0]).toBe("how does it work?");
	});

	it("returns two variants when message contains identifiers", () => {
		const variants = expandQuery("where is hybridSearch defined?");
		expect(variants.length).toBeGreaterThanOrEqual(2);
		expect(variants[0]).toBe("where is hybridSearch defined?");
		expect(variants[1]).toContain("hybridSearch");
		expect(variants[1]).toContain("implementation definition");
	});

	it("never returns duplicate query strings", () => {
		const variants = expandQuery("someFunction and otherSymbol");
		const unique = [...new Set(variants)];
		expect(unique.length).toBe(variants.length);
	});

	it("extracts multiple symbols for code-style variant", () => {
		const variants = expandQuery("how does embedText call the pipeline?");
		expect(variants.length).toBeGreaterThanOrEqual(2);
		expect(variants[1]).toContain("embedText");
		expect(variants[1]).toContain("pipeline");
	});

	it("trims and handles empty", () => {
		expect(expandQuery("")).toEqual([""]);
		expect(expandQuery("  ")).toEqual([""]);
	});
});
