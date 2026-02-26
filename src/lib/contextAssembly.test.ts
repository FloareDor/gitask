import { describe, expect, it } from "vitest";
import { buildScopedContext, type ContextAssemblyLimits, type ContextCandidate } from "./contextAssembly";
import type { CodeChunk } from "./chunker";

function mkChunk(filePath: string, code: string, nodeType: string = "text_chunk"): CodeChunk {
	return {
		id: `${filePath}::0`,
		filePath,
		language: "text",
		nodeType,
		name: "chunk",
		code,
		startLine: 1,
		endLine: 1,
	};
}

const tightLimits: ContextAssemblyLimits = {
	maxChars: 1_200,
	maxTokens: 320,
	maxFileChars: 350,
	maxDirChars: 500,
	maxDirFiles: 1,
	maxSnippetChars: 120,
};

describe("contextAssembly", () => {
	it("keeps raw context when under budget", () => {
		const candidates: ContextCandidate[] = [
			{ chunk: mkChunk("src/a.ts", "const a = 1;"), score: 0.9 },
			{ chunk: mkChunk("src/b.ts", "const b = 2;"), score: 0.8 },
		];
		const out = buildScopedContext(candidates, tightLimits);
		expect(out.meta.compactionStage).toBe("none");
		expect(out.meta.truncated).toBe(false);
		expect(out.context).toContain("src/a.ts");
	});

	it("compacts overflowing files before directory/repo", () => {
		const longText = "x".repeat(420);
		const overflowLimits: ContextAssemblyLimits = { ...tightLimits, maxChars: 700, maxTokens: 180 };
		const candidates: ContextCandidate[] = [
			{ chunk: mkChunk("src/a.ts", longText), score: 0.9 },
			{ chunk: mkChunk("src/a.ts", longText), score: 0.8 },
		];
		const out = buildScopedContext(candidates, overflowLimits);
		expect(["file", "directory", "repo", "truncated"]).toContain(out.meta.compactionStage);
		expect(out.context).toContain("FILE_COMPACTION_SUMMARY");
	});

	it("escalates to directory compaction when directory overflows", () => {
		const medium = "y".repeat(260);
		const overflowLimits: ContextAssemblyLimits = { ...tightLimits, maxChars: 850, maxTokens: 220 };
		const candidates: ContextCandidate[] = [
			{ chunk: mkChunk("src/dir/a.ts", medium), score: 0.95 },
			{ chunk: mkChunk("src/dir/b.ts", medium), score: 0.94 },
			{ chunk: mkChunk("src/dir/c.ts", medium), score: 0.93 },
		];
		const out = buildScopedContext(candidates, overflowLimits);
		expect(["directory", "repo", "truncated"]).toContain(out.meta.compactionStage);
		expect(out.context).toContain("DIRECTORY_COMPACTION_SUMMARY");
	});
});
