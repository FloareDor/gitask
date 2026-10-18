import { describe, it, expect } from "vitest";
import type { CodeChunk } from "../chunker";
import { deriveRelevance, scoreCitations, normalizePath } from "./scoring";
import type { EvalQuestion } from "./types";

function chunk(id: string, filePath: string, startLine: number, endLine: number): CodeChunk {
	return { id, filePath, language: "python", nodeType: "function", name: id, code: "", startLine, endLine };
}

const question: EvalQuestion = {
	id: "q1",
	repo: "pallets/flask",
	ref: "85c5d93",
	source: "swe-qa",
	type: "multihop",
	question: "?",
	goldAnswer: "",
	goldLocations: [
		{ path: "src/flask/app.py", startLine: 100, endLine: 120 },
		{ path: "./src/flask/ctx.py", startLine: 10, endLine: 20 },
	],
};

describe("normalizePath", () => {
	it("strips the leading ./ gold answers tend to use", () => {
		expect(normalizePath("./src/flask/app.py")).toBe("src/flask/app.py");
		expect(normalizePath("/src/flask/app.py")).toBe("src/flask/app.py");
		expect(normalizePath("src/flask/app.py")).toBe("src/flask/app.py");
	});
});

describe("deriveRelevance", () => {
	it("grades overlap above same-file and ignores everything else", () => {
		const chunks = [
			chunk("a", "src/flask/app.py", 90, 110),   // overlaps
			chunk("b", "src/flask/app.py", 300, 320),  // same file, wrong lines
			chunk("c", "src/flask/ctx.py", 10, 20),    // overlaps the ./-prefixed gold
			chunk("d", "src/flask/cli.py", 1, 50),     // unrelated
		];
		const derived = deriveRelevance(chunks, question);
		expect(derived.relevantChunkIds.sort()).toEqual(["a", "c"]);
		expect(derived.relevanceScores).toEqual({ a: 3, b: 1, c: 3 });
		expect(derived.missingPaths).toEqual([]);
	});

	it("reports gold files the index never saw", () => {
		const derived = deriveRelevance([chunk("a", "src/flask/app.py", 100, 110)], question);
		expect(derived.missingPaths).toEqual(["src/flask/ctx.py"]);
	});

	it("counts a chunk that merely touches the gold span", () => {
		const derived = deriveRelevance([chunk("a", "src/flask/app.py", 120, 400)], question);
		expect(derived.relevantChunkIds).toEqual(["a"]);
	});
});

describe("scoreCitations", () => {
	it("credits a citation that overlaps a gold span", () => {
		const score = scoreCitations(
			[{ path: "src/flask/app.py", startLine: 105, endLine: 108 }],
			question.goldLocations
		);
		expect(score).toEqual({ total: 1, correct: 1, precision: 1, missedPaths: ["src/flask/ctx.py"] });
	});

	it("rejects the right file at the wrong lines", () => {
		const score = scoreCitations(
			[{ path: "src/flask/app.py", startLine: 500, endLine: 510 }],
			question.goldLocations
		);
		expect(score.correct).toBe(0);
		expect(score.precision).toBe(0);
		expect(score.missedPaths).toHaveLength(2);
	});

	it("has no precision to report when the answer cited nothing", () => {
		const score = scoreCitations([], question.goldLocations);
		expect(score.precision).toBeNull();
		expect(score.total).toBe(0);
	});

	it("mixes hits and misses", () => {
		const score = scoreCitations(
			[
				{ path: "src/flask/app.py", startLine: 110, endLine: 115 },
				{ path: "src/flask/ctx.py", startLine: 15, endLine: 15 },
				{ path: "src/flask/cli.py", startLine: 1, endLine: 9 },
			],
			question.goldLocations
		);
		expect(score.correct).toBe(2);
		expect(score.precision).toBeCloseTo(2 / 3);
		expect(score.missedPaths).toEqual([]);
	});
});
