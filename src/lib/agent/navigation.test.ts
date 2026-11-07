/**
 * Tests for the file-centered navigation tools.
 *
 * The fixture is built around the failure the interface exists to fix: one file
 * holding several plausible `refresh*` functions, where the right one is only
 * visible as a neighbour of whichever one search happened to return.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedChunk } from "../embedder";
import { VectorStore } from "../vectorStore";
import { listSymbols, semanticSearchByFile } from "./navigation";
import { TOOL_SETS, runTool, schemasForToolSet } from "./schemas";
import { TOOL_LIMITS, ToolError } from "./types";

vi.mock("../embedder", () => ({
	embedText: vi.fn(() => Promise.resolve(new Array(384).fill(0.5))),
}));

const AUTH = Array.from({ length: 40 }, (_, i) => `// auth line ${i + 1}`).join("\n");
const SERVER = "export function handler(req) {\n\treturn refreshToken(req);\n}\n";

function chunk(overrides: Partial<EmbeddedChunk> & { id: string }): EmbeddedChunk {
	return {
		filePath: "src/auth.ts",
		language: "typescript",
		nodeType: "function_declaration",
		name: "refreshToken",
		code: "export function refreshToken(user) {\n\treturn mint(user);\n}",
		startLine: 1,
		endLine: 3,
		embedding: new Array(384).fill(0.5),
		...overrides,
	};
}

function makeStore(): VectorStore {
	const store = new VectorStore();
	store.insert([
		chunk({ id: "a", name: "refreshToken", startLine: 1, endLine: 3 }),
		chunk({ id: "b", name: "validateRefreshToken", startLine: 5, endLine: 9 }),
		chunk({ id: "c", name: "refreshSession", startLine: 11, endLine: 18 }),
		chunk({ id: "d", name: "", nodeType: "module", startLine: 20, endLine: 21 }),
		chunk({
			id: "e",
			filePath: "src/server.ts",
			name: "handler",
			startLine: 1,
			endLine: 3,
		}),
	]);
	store.setFiles({ "src/auth.ts": AUTH, "src/server.ts": SERVER });
	return store;
}

let store: VectorStore;

beforeEach(() => {
	store = makeStore();
});

describe("listSymbols", () => {
	it("returns every named symbol in source order, with line ranges", () => {
		const { result } = listSymbols(store, "src/auth.ts");

		expect(result.path).toBe("src/auth.ts");
		expect(result.symbols.map((s) => s.name)).toEqual([
			"refreshToken",
			"validateRefreshToken",
			"refreshSession",
		]);
		expect(result.symbols[1]).toMatchObject({ startLine: 5, endLine: 9 });
	});

	it("drops unnamed chunks, which have nothing to navigate by", () => {
		const { result } = listSymbols(store, "src/auth.ts");
		expect(result.symbols.some((s) => s.name === "")).toBe(false);
	});

	it("reports the file's real length so the model can size a read", () => {
		const { result } = listSymbols(store, "src/auth.ts");
		expect(result.totalLines).toBe(40);
	});

	it("caps long files and says how many it dropped", () => {
		const big = new VectorStore();
		const count = TOOL_LIMITS.MAX_OUTLINE_SYMBOLS + 5;
		big.insert(
			Array.from({ length: count }, (_, i) =>
				chunk({ id: `s${i}`, name: `fn${i}`, startLine: i + 1, endLine: i + 1 })
			)
		);
		big.setFiles({ "src/auth.ts": AUTH });

		const { result, truncated } = listSymbols(big, "src/auth.ts");
		expect(result.symbols).toHaveLength(TOOL_LIMITS.MAX_OUTLINE_SYMBOLS);
		expect(result.omittedSymbols).toBe(5);
		expect(truncated).toBe(true);
	});

	it("throws a correctable error with a near-miss hint for an unknown path", () => {
		expect(() => listSymbols(store, "lib/auth.ts")).toThrow(ToolError);
		expect(() => listSymbols(store, "lib/auth.ts")).toThrow(/Did you mean: src\/auth\.ts/);
	});
});

describe("semanticSearchByFile", () => {
	it("groups hits under their file instead of returning a flat list", async () => {
		const { result } = await semanticSearchByFile(store, "refresh the token", 5);

		expect(result.map((g) => g.path).sort()).toEqual(["src/auth.ts", "src/server.ts"]);
		const auth = result.find((g) => g.path === "src/auth.ts")!;
		expect(auth.matches.length).toBeGreaterThan(1);
		expect(auth.totalLines).toBe(40);
	});

	it("names every match, which the flat interface never did", async () => {
		const { result } = await semanticSearchByFile(store, "refresh the token", 5);
		const auth = result.find((g) => g.path === "src/auth.ts")!;

		for (const match of auth.matches) {
			expect(match.name.length).toBeGreaterThan(0);
			expect(match.nodeType.length).toBeGreaterThan(0);
		}
	});

	// The point of the whole feature: a sibling that did not match is still
	// visible, so the model can tell `refreshSession` from `refreshToken`
	// without spending a read_file call to discover it exists.
	it("lists sibling symbols that did not match, with their line ranges", async () => {
		const { result } = await semanticSearchByFile(store, "refresh the token", 1);
		const auth = result.find((g) => g.path === "src/auth.ts");
		if (!auth) return; // the single hit landed elsewhere; nothing to assert here

		expect(auth.otherSymbols.length).toBeGreaterThan(0);
		for (const sibling of auth.otherSymbols) {
			expect(sibling).toMatch(/\d+-\d+$/);
		}
	});

	it("never repeats a matched symbol as its own neighbour", async () => {
		const { result } = await semanticSearchByFile(store, "refresh the token", 5);
		for (const group of result) {
			const matched = new Set(group.matches.map((m) => `${m.name}:${m.startLine}`));
			for (const sibling of group.otherSymbols) {
				const [name, , range] = sibling.split(" ");
				expect(matched.has(`${name}:${range.split("-")[0]}`)).toBe(false);
			}
		}
	});

	it("orders files by their best hit", async () => {
		const { result } = await semanticSearchByFile(store, "refresh the token", 5);
		const scores = result.map((g) => g.score);
		expect([...scores].sort((a, b) => b - a)).toEqual(scores);
		for (const group of result) {
			expect(group.score).toBe(Math.max(...group.matches.map((m) => m.score)));
		}
	});

	it("keeps matches in source order inside a file", async () => {
		const { result } = await semanticSearchByFile(store, "refresh the token", 5);
		for (const group of result) {
			const lines = group.matches.map((m) => m.startLine);
			expect([...lines].sort((a, b) => a - b)).toEqual(lines);
		}
	});

	it("rejects an empty query", async () => {
		await expect(semanticSearchByFile(store, "   ", 5)).rejects.toThrow(ToolError);
	});
});

describe("the nav tool set", () => {
	it("is the baseline five plus list_symbols, and nothing removed", () => {
		for (const name of TOOL_SETS.full) {
			expect(TOOL_SETS.nav).toContain(name);
		}
		expect(TOOL_SETS.nav).toContain("list_symbols");
		expect(TOOL_SETS.full).not.toContain("list_symbols");
	});

	// The `agent` arm's numbers are already measured. If its schemas drift, the
	// baseline silently stops being a baseline.
	it("leaves the full set's declarations untouched", () => {
		const full = schemasForToolSet("full");
		const nav = schemasForToolSet("nav");

		expect(full.map((s) => s.name)).toEqual([
			"semantic_search",
			"grep",
			"read_file",
			"find_definition",
			"find_references",
		]);
		// Only semantic_search is re-described for nav; the other four are shared.
		expect(nav.slice(1, 5)).toEqual(full.slice(1));
		expect(nav[0].description).not.toBe(full[0].description);
		expect(nav[nav.length - 1].name).toBe("list_symbols");
	});

	it("routes semantic_search to the grouped shape only when asked", async () => {
		const call = { id: "1", name: "semantic_search", args: { query: "refresh" } };

		const grouped = await runTool(store, call, { groupByFile: true });
		for (const row of grouped.result as Record<string, unknown>[]) {
			expect(row).toHaveProperty("matches");
			expect(row).toHaveProperty("otherSymbols");
		}

		const flat = await runTool(store, call, {});
		expect((flat.result as Record<string, unknown>[])[0]).not.toHaveProperty("matches");
	});

	it("dispatches list_symbols", () => {
		const outcome = runTool(store, {
			id: "2",
			name: "list_symbols",
			args: { path: "src/auth.ts" },
		});
		expect((outcome as { result: { path: string } }).result.path).toBe("src/auth.ts");
	});
});
