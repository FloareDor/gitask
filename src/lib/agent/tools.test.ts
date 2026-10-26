/**
 * Tests for the agent toolbox — behaviour over a small fixture index.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorStore } from "../vectorStore";
import type { EmbeddedChunk } from "../embedder";
import { globToRegExp, grepFiles } from "./grep";
import {
	findDefinition,
	findReferences,
	grep,
	readFile,
	semanticSearch,
} from "./tools";
import { TOOL_LIMITS, ToolError } from "./types";

vi.mock("../embedder", () => ({
	embedText: vi.fn(() => Promise.resolve(new Array(384).fill(0.5))),
}));

const AUTH = `export function signToken(user) {
	return hash(user.id);
}
`;

const SERVER = `import { signToken } from "./auth";

export function handler(req) {
	const token = signToken(req.user);
	return { token };
}
`;

function chunk(overrides: Partial<EmbeddedChunk> & { id: string }): EmbeddedChunk {
	return {
		filePath: "src/auth.ts",
		language: "typescript",
		nodeType: "function_declaration",
		name: "signToken",
		code: "export function signToken(user) {\n\treturn hash(user.id);\n}",
		startLine: 1,
		endLine: 3,
		embedding: new Array(384).fill(0.5),
		...overrides,
	};
}

function makeStore(): VectorStore {
	const store = new VectorStore();
	store.insert([
		chunk({ id: "a" }),
		chunk({
			id: "b",
			filePath: "src/server.ts",
			name: "handler",
			code: "export function handler(req) {\n\tconst token = signToken(req.user);\n\treturn { token };\n}",
			startLine: 3,
			endLine: 6,
		}),
	]);
	store.setFiles({ "src/auth.ts": AUTH, "src/server.ts": SERVER });
	store.setGraph({
		"src/auth.ts": { imports: [], definitions: ["signToken"] },
		"src/server.ts": { imports: ["./auth"], definitions: ["handler"] },
	});
	return store;
}

let store: VectorStore;

beforeEach(() => {
	store = makeStore();
});

describe("globToRegExp", () => {
	it("keeps * inside a path segment but lets ** cross them", () => {
		expect(globToRegExp("*.ts").test("auth.ts")).toBe(true);
		expect(globToRegExp("*.ts").test("src/auth.ts")).toBe(false);
		expect(globToRegExp("src/**/*.ts").test("src/a/b/auth.ts")).toBe(true);
		// `**/` matches zero directories too.
		expect(globToRegExp("src/**/*.ts").test("src/auth.ts")).toBe(true);
	});

	it("treats dots as literals", () => {
		expect(globToRegExp("*.ts").test("authxts")).toBe(false);
	});
});

describe("grep", () => {
	it("returns 1-based line numbers for matching lines", () => {
		const hits = grep(store, "signToken").result;
		expect(hits).toEqual([
			{ path: "src/auth.ts", line: 1, text: "export function signToken(user) {" },
			{ path: "src/server.ts", line: 1, text: 'import { signToken } from "./auth";' },
			{ path: "src/server.ts", line: 4, text: "const token = signToken(req.user);" },
		]);
	});

	it("honours the glob filter", () => {
		const hits = grep(store, "signToken", { glob: "src/auth.ts" }).result;
		expect(hits.map((h) => h.path)).toEqual(["src/auth.ts"]);
	});

	it("flags truncation once the hit cap is reached", () => {
		const files = { "big.ts": "match\n".repeat(TOOL_LIMITS.MAX_GREP_HITS + 5) };
		const outcome = grepFiles(files, "match");
		expect(outcome.hits).toHaveLength(TOOL_LIMITS.MAX_GREP_HITS);
		expect(outcome.truncated).toBe(true);
	});

	it("reports a broken pattern instead of throwing a raw SyntaxError", () => {
		expect(() => grep(store, "func(")).toThrow(ToolError);
	});
});

describe("readFile", () => {
	it("numbers the lines it returns", () => {
		const slice = readFile(store, "src/server.ts", 3, 4).result;
		expect(slice.content).toBe("3| export function handler(req) {\n4| \tconst token = signToken(req.user);");
		expect(slice.startLine).toBe(3);
		expect(slice.endLine).toBe(4);
		expect(slice.totalLines).toBe(7);
	});

	it("reads the whole file by default", () => {
		const { result, truncated } = readFile(store, "src/auth.ts");
		expect(result.startLine).toBe(1);
		expect(result.endLine).toBe(4);
		expect(truncated).toBe(false);
	});

	it("caps long reads and says so", () => {
		store.setFile("long.ts", "x\n".repeat(TOOL_LIMITS.MAX_READ_LINES + 50));
		const { result, truncated } = readFile(store, "long.ts");
		expect(result.endLine).toBe(TOOL_LIMITS.MAX_READ_LINES);
		expect(truncated).toBe(true);
	});

	it("suggests near misses for an unknown path", () => {
		expect(() => readFile(store, "auth.ts")).toThrow(/Did you mean: src\/auth\.ts/);
	});

	it("rejects a start line past the end of the file", () => {
		expect(() => readFile(store, "src/auth.ts", 99)).toThrow(/does not exist/);
	});
});

describe("findDefinition", () => {
	it("prefers an exact chunk-name match", () => {
		const hits = findDefinition(store, "signToken").result;
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ path: "src/auth.ts", nodeType: "function_declaration", startLine: 1 });
	});

	it("falls back to a case-insensitive match", () => {
		expect(findDefinition(store, "SIGNTOKEN").result[0].path).toBe("src/auth.ts");
	});

	it("uses the graph for symbols the chunker never named", () => {
		store.setGraph({ "src/server.ts": { imports: [], definitions: ["token"] } });
		const hits = findDefinition(store, "token").result;
		expect(hits).toEqual([
			{ path: "src/server.ts", name: "token", nodeType: "declaration", startLine: 4, endLine: 4, snippet: "const token = signToken(req.user);" },
		]);
	});

	it("returns nothing for an unknown symbol", () => {
		expect(findDefinition(store, "nope").result).toEqual([]);
	});
});

describe("findReferences", () => {
	it("drops the lines inside the definition", () => {
		const hits = findReferences(store, "signToken").result;
		expect(hits).toEqual([
			{ path: "src/server.ts", line: 1, text: 'import { signToken } from "./auth";' },
			{ path: "src/server.ts", line: 4, text: "const token = signToken(req.user);" },
		]);
	});

	it("matches whole words only", () => {
		store.setFile("src/other.ts", "signTokenLater();\n");
		expect(findReferences(store, "signToken").result.map((h) => h.path)).not.toContain("src/other.ts");
	});
});

describe("semanticSearch", () => {
	it("returns citable locations with scores", async () => {
		const { result } = await semanticSearch(store, "how is a token signed", 2);
		expect(result.length).toBeGreaterThan(0);
		expect(result[0]).toHaveProperty("startLine");
		expect(result[0]).toHaveProperty("endLine");
		expect(result.every((r) => r.path.startsWith("src/"))).toBe(true);
	});

	it("clamps k to the result cap", async () => {
		const { truncated } = await semanticSearch(store, "token", 999);
		expect(truncated).toBe(true);
	});

	it("rejects an empty query", async () => {
		await expect(semanticSearch(store, "  ")).rejects.toThrow(ToolError);
	});
});
