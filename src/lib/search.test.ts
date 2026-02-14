/**
 * Tests for hybrid search — validates RRF fusion, keyword search,
 * and the vector search + reranking pipeline.
 */

import { describe, it, expect } from "vitest";
import { reciprocalRankFusion, keywordSearch, vectorSearch, hybridSearch } from "./search";
import type { EmbeddedChunk } from "./embedder";
import { VectorStore } from "./vectorStore";

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
});
