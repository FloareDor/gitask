/**
 * Tests for hybrid search — validates RRF fusion, keyword search,
 * and the vector search + reranking pipeline.
 */

import { describe, it, expect, vi } from "vitest";
import { reciprocalRankFusion, keywordSearch, vectorSearch, hybridSearch, multiPathHybridSearch } from "./search";
import type { EmbeddedChunk } from "./embedder";
import { embedText } from "./embedder";
import { VectorStore } from "./vectorStore";

// Mock embedder for multiPathHybridSearch tests (avoid loading real model)
vi.mock("./embedder", () => ({
	embedText: vi.fn(() => Promise.resolve(new Array(384).fill(0.5))),
}));

function makeChunk(id: string, code: string, embedding: number[]): EmbeddedChunk {
	return {
		id,
		filePath: `src/${id}.ts`,
		language: "typescript",
		nodeType: "function_declaration",
		name: id,
		code,
		startLine: 1,
		endLine: 5,
		embedding,
	};
}

describe("reciprocalRankFusion", () => {
	it("merges two ranked lists with RRF scores", () => {
		const list1 = new Map([
			["a", 0.9],
			["b", 0.7],
			["c", 0.5],
		]);
		const list2 = new Map([
			["b", 0.95],
			["c", 0.8],
			["d", 0.6],
		]);

		const result = reciprocalRankFusion([list1, list2], 60);

		// 'b' appears in both lists → should have highest combined score
		const scores = [...result.entries()].sort((a, b) => b[1] - a[1]);
		expect(scores[0][0]).toBe("b");
		expect(result.size).toBe(4); // a, b, c, d
	});

	it("handles single list", () => {
		const list = new Map([["x", 1]]);
		const result = reciprocalRankFusion([list]);
		expect(result.get("x")).toBeGreaterThan(0);
	});

	it("handles empty lists", () => {
		const result = reciprocalRankFusion([new Map()]);
		expect(result.size).toBe(0);
	});
});

describe("keywordSearch", () => {
	const chunks: EmbeddedChunk[] = [
		makeChunk("auth", "function authenticate(user, password) { ... }", [0.1]),
		makeChunk("db", "function connectDatabase(url) { ... }", [0.2]),
		makeChunk("utils", "function formatDate(date) { return date.toISOString(); }", [0.3]),
	];

	it("finds exact symbol matches", () => {
		const scores = keywordSearch(chunks, "authenticate");
		expect(scores.has("auth")).toBe(true);
		expect(scores.has("db")).toBe(false);
	});

	it("finds partial word matches with word boundaries", () => {
		const scores = keywordSearch(chunks, "connectDatabase");
		expect(scores.has("db")).toBe(true);
	});

	it("returns empty for no matches", () => {
		const scores = keywordSearch(chunks, "xyz123nonexistent");
		expect(scores.size).toBe(0);
	});
});

describe("vectorSearch", () => {
	it("ranks similar vectors higher", () => {
		const chunks: EmbeddedChunk[] = [
			makeChunk("similar", "similar code", [0.5, 0.3, -0.1, 0.8]),
			makeChunk("different", "different code", [-0.5, -0.3, 0.1, -0.8]),
		];

		const query = [0.5, 0.3, -0.1, 0.8]; // same as "similar"
		const results = vectorSearch(chunks, query, 10);
		const ranked = [...results.entries()].sort((a, b) => b[1] - a[1]);

		// "similar" should rank first
		expect(ranked[0][0]).toBe("similar");
	});

	it("respects limit parameter", () => {
		const chunks: EmbeddedChunk[] = Array.from({ length: 20 }, (_, i) =>
			makeChunk(`chunk_${i}`, `code ${i}`, [i * 0.1, i * 0.05, -i * 0.02, i * 0.08])
		);

		const results = vectorSearch(chunks, [0.5, 0.3, -0.1, 0.8], 5);
		expect(results.size).toBeLessThanOrEqual(5);
	});
});

describe("hybridSearch with Graph Expansion", () => {
	it("expands results using dependency graph", () => {
		const store = new VectorStore();

		// Seed chunk (found by vector/keyword search)
		// Embedding matches query [1, 1]
		const seedChunk = makeChunk("seed", "import { foo } from './dep';", [1, 1]);
		seedChunk.filePath = "src/seed.ts";

		// Dependency chunk (not similar to query, but imported by seed)
		// Embedding is opposite [-1, -1]
		const depChunk = makeChunk("dep", "export const foo = 1;", [-1, -1]);
		depChunk.filePath = "src/dep.ts";

		// Irrelevant chunk
		const randomChunk = makeChunk("random", "irrelevant", [0, 0]);
		randomChunk.filePath = "src/random.ts";

		store.insert([seedChunk, depChunk, randomChunk]);

		// Set up graph
		store.setGraph({
			"src/seed.ts": { imports: ["./dep"], definitions: [] },
			"src/dep.ts": { imports: [], definitions: ["foo"] },
		});

		// Query that matches seedChunk strongly
		const queryEmbedding = [1, 1];
		const query = "seed";

		const results = hybridSearch(store, queryEmbedding, query, {
			limit: 10,
			coarseCandidates: 5,
		});

		const ids = results.map((r) => r.chunk.id);

		expect(ids).toContain("seed");
		expect(ids).toContain("dep"); // Should be included due to graph expansion
	});

	it("resolves relative imports using current file directory", () => {
		const store = new VectorStore();

		const seedChunk = makeChunk("seed", "import { util } from './utils';", [1, 1]);
		seedChunk.filePath = "src/feature/seed.ts";

		const featureUtils = makeChunk("feature-utils", "export const util = 1;", [-1, -1]);
		featureUtils.filePath = "src/feature/utils.ts";

		const sharedUtils = makeChunk("shared-utils", "export const util = 2;", [-1, -1]);
		sharedUtils.filePath = "src/shared/utils.ts";

		store.insert([seedChunk, featureUtils, sharedUtils]);
		store.setGraph({
			"src/shared/utils.ts": { imports: [], definitions: ["util"] },
			"src/feature/seed.ts": { imports: ["./utils"], definitions: [] },
			"src/feature/utils.ts": { imports: [], definitions: ["util"] },
		});

		const results = hybridSearch(store, [1, 1], "seed", {
			limit: 10,
			coarseCandidates: 1,
		});

		const ids = results.map((r) => r.chunk.id);
		expect(ids).toContain("feature-utils");
		expect(ids).not.toContain("shared-utils");
	});
});

describe("multiPathHybridSearch", () => {
	it("returns empty when no variants", async () => {
		const store = new VectorStore();
		const results = await multiPathHybridSearch(store, [], { limit: 5 });
		expect(results).toEqual([]);
	});

	it("with single variant behaves like hybridSearch plus preference rerank", async () => {
		const store = new VectorStore();
		const chunk = makeChunk("foo", "function foo() { return 1; }", new Array(384).fill(0.5));
		store.insert([chunk]);
		store.setGraph({ "src/foo.ts": { imports: [], definitions: ["foo"] } });

		const results = await multiPathHybridSearch(store, ["foo"], { limit: 5 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].chunk.id).toBe("foo");
	});

	it("with two identical variants deduplicates and returns consistent results", async () => {
		const store = new VectorStore();
		const chunks: EmbeddedChunk[] = [
			makeChunk("a", "function a() {}", new Array(384).fill(0.6)),
			makeChunk("b", "function b() {}", new Array(384).fill(0.4)),
		];
		store.insert(chunks);

		vi.mocked(embedText).mockClear();
		const results = await multiPathHybridSearch(store, ["function a", "function a"], { limit: 5 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		const ids = results.map((r) => r.chunk.id);
		expect(ids).toContain("a");
		expect(vi.mocked(embedText)).toHaveBeenCalledTimes(1);
	});

	it("does not apply definition bonus to unrelated chunks in a defining file", async () => {
		const store = new VectorStore();
		const unrelated = makeChunk("unrelated", "const x = 1;", new Array(384).fill(0.5));
		unrelated.filePath = "src/a.ts";
		const mention = makeChunk("mention", "function foo() { return 1; }", new Array(384).fill(0.5));
		mention.filePath = "src/b.ts";
		store.insert([unrelated, mention]);
		store.setGraph({
			"src/a.ts": { imports: [], definitions: ["foo"] },
			"src/b.ts": { imports: [], definitions: [] },
		});

		const results = await multiPathHybridSearch(store, ["foo"], {
			limit: 2,
			preferenceAlpha: 0,
		});
		expect(results[0].chunk.id).toBe("mention");
	});
});
