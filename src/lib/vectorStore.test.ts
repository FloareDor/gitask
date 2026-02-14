import { describe, it, expect, beforeEach } from "vitest";
import { VectorStore } from "./vectorStore";
import type { EmbeddedChunk } from "./embedder";

describe("VectorStore", () => {
	let store: VectorStore;

	beforeEach(() => {
		store = new VectorStore();
	});

	it("indexes chunks by file", () => {
		const chunk: EmbeddedChunk = {
			id: "a",
			filePath: "file1.ts",
			code: "code",
			embedding: [0.1, 0.2],
			startLine: 1,
			endLine: 10,
			language: "typescript",
			nodeType: "function",
			name: "test"
		};

		store.insert([chunk]);

		expect(store.getChunksByFile("file1.ts")).toHaveLength(1);
		expect(store.getChunksByFile("file1.ts")[0]).toBe(chunk);
		expect(store.getChunksByFile("other.ts")).toHaveLength(0);
	});

	it("stores and retrieves dependency graph", () => {
		const graph = {
			"file1.ts": { imports: ["file2.ts"], definitions: ["foo"] },
		};
		store.setGraph(graph);
		expect(store.getGraph()).toEqual(graph);
	});

	it("clears everything", () => {
		const chunk: EmbeddedChunk = {
			id: "a",
			filePath: "file1.ts",
			code: "code",
			embedding: [],
			startLine: 1,
			endLine: 10,
			language: "typescript",
			nodeType: "function",
			name: "test"
		};

		store.insert([chunk]);
		store.setGraph({ "file1.ts": { imports: [], definitions: [] } });

		store.clear();
		expect(store.size).toBe(0);
		expect(store.getChunksByFile("file1.ts")).toHaveLength(0);
		expect(store.getGraph()).toEqual({});
	});
});
