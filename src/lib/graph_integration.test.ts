
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorStore } from "./vectorStore";
import { hybridSearch } from "./search";
import type { CodeChunk } from "./chunker";

// Mock dependencies
const mockGraph = {
	"src/utils.ts": {
		imports: [],
		definitions: ["helperFunction"]
	},
	"src/main.ts": {
		imports: ["./utils"],
		definitions: ["mainFunction"]
	}
};

describe("GraphRAG Integration", () => {
	let store: VectorStore;

	beforeEach(() => {
		store = new VectorStore();

		// Populate store with mock chunks
		const chunks: CodeChunk[] = [
			{
				id: "src/utils.ts::helperFunction",
				filePath: "src/utils.ts",
				language: "typescript",
				nodeType: "function_declaration",
				name: "helperFunction",
				code: "export function helperFunction() { return 'I do the work'; }",
				startLine: 1,
				endLine: 1
			},
			{
				id: "src/main.ts::mainFunction",
				filePath: "src/main.ts",
				language: "typescript",
				nodeType: "function_declaration",
				name: "mainFunction",
				code: "import { helperFunction } from './utils';\nexport function mainFunction() { helperFunction(); }",
				startLine: 1,
				endLine: 2
			}
		];

		// Mock embeddings (simple 1-hot like for testing)
		const embeddings = [
			{ chunk: chunks[0], embedding: new Array(384).fill(0.1) }, // utils
			{ chunk: chunks[1], embedding: new Array(384).fill(0.9) }  // main
		];

		// We need to insert EmbeddedChunks. 
		const embeddedChunks = chunks.map((c, i) => ({
			...c,
			embedding: embeddings[i].embedding
		}));

		store.insert(embeddedChunks);
		store.setGraph(mockGraph);
	});

	it("expands search results to include dependencies", () => {
		// Query that matches 'mainFunction' (imports utils)
		const queryEmbedding = new Array(384).fill(0.9);
		const query = "mainFunction";

		const results = hybridSearch(store, queryEmbedding, query, {
			limit: 5,
			coarseCandidates: 10
		});

		// We expect mainFunction to be found directly
		const mainChunk = results.find(r => r.chunk.name === "mainFunction");
		expect(mainChunk).toBeDefined();

		// AND we expect helperFunction to be found via graph expansion
		const helperChunk = results.find(r => r.chunk.name === "helperFunction");
		expect(helperChunk).toBeDefined();
	});

	it("resolves relative imports correctly", () => {
		const queryEmbedding = new Array(384).fill(0.9);
		const results = hybridSearch(store, queryEmbedding, "main", { limit: 10 });

		const filePaths = results.map(r => r.chunk.filePath);
		expect(filePaths).toContain("src/utils.ts");
	});

	it("resolves absolute-like imports (mocked package structure)", () => {
		// Add a file that mimics an absolute import target
		const libChunk: CodeChunk = {
			id: "src/lib/logger.ts::log",
			filePath: "src/lib/logger.ts",
			language: "typescript",
			nodeType: "function_declaration",
			name: "log",
			code: "export function log(msg: string) { console.log(msg); }",
			startLine: 1,
			endLine: 1
		};
		const appChunk: CodeChunk = {
			id: "src/app.ts::run",
			filePath: "src/app.ts",
			language: "typescript",
			nodeType: "function_declaration",
			name: "run",
			code: "import { log } from 'lib/logger';\nexport function run() { log('hello'); }",
			startLine: 1,
			endLine: 2
		};

		const libEmbedding = new Array(384).fill(0.2);
		const appEmbedding = new Array(384).fill(0.8);

		// Store with new chunks
		const newStore = new VectorStore();
		newStore.insert([
			{ ...libChunk, embedding: libEmbedding },
			{ ...appChunk, embedding: appEmbedding }
		]);

		// Mock graph with the import "lib/logger"
		newStore.setGraph({
			"src/app.ts": { imports: ["lib/logger"], definitions: ["run"] },
			"src/lib/logger.ts": { imports: [], definitions: ["log"] }
		});

		const results = hybridSearch(newStore, appEmbedding, "run", { limit: 5 });

		// Expect 'log' from 'src/lib/logger.ts' to be found via 'lib/logger' match
		const helperChunk = results.find(r => r.chunk.filePath === "src/lib/logger.ts");
		expect(helperChunk).toBeDefined();
	});
});
