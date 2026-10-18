import { describe, it, expect } from "vitest";
import type { TraceStep } from "./arms";
import { bucketCounts, classify, classifyAll } from "./failures";
import type { EvalRecord } from "./harness";
import type { EvalQuestion } from "./types";

const question: EvalQuestion = {
	id: "q1",
	repo: "psf/requests",
	ref: "46e939b",
	source: "swe-qa",
	type: "multihop",
	question: "?",
	goldAnswer: "gold",
	goldLocations: [
		{ path: "src/requests/sessions.py", startLine: 100, endLine: 200 },
		{ path: "src/requests/models.py", startLine: 10, endLine: 20 },
	],
};

function step(overrides: Partial<TraceStep> = {}): TraceStep {
	return {
		step: 1,
		tool: "read_file",
		args: { path: "src/requests/sessions.py" },
		bytes: 500,
		truncated: false,
		duplicate: false,
		isError: false,
		elapsedMs: 10,
		...overrides,
	};
}

function record(overrides: Partial<EvalRecord> = {}): EvalRecord {
	return {
		questionId: "q1",
		repo: "psf/requests",
		type: "multihop",
		source: "swe-qa",
		arm: "agent",
		run: 1,
		answer: "an answer",
		verdict: "wrong",
		judgeReason: "missed the point",
		citation: { total: 1, correct: 1, precision: 1, missedPaths: [] },
		tokensIn: 100,
		tokensOut: 50,
		judgeTokensIn: 10,
		judgeTokensOut: 5,
		elapsedMs: 1000,
		steps: 3,
		toolBytes: 500,
		stopReason: "answered",
		trace: [step()],
		...overrides,
	};
}

describe("classify", () => {
	it("skips runs the judge called correct", () => {
		expect(classify(record({ verdict: "correct" }), question)).toBeNull();
	});

	it("buckets a partial — a near miss is still a failure to explain", () => {
		expect(classify(record({ verdict: "partial" }), question)).not.toBeNull();
	});

	it("puts a provider error above everything else it also matched", () => {
		const result = classify(record({
			error: "timed out after 180s",
			citation: { total: 0, correct: 0, precision: null, missedPaths: [] },
			stopReason: "step_cap",
		}), question);
		expect(result?.primary).toBe("provider_error");
		// The other matches are kept so co-occurrence stays answerable.
		expect(result?.matched).toContain("step_cap");
		expect(result?.matched).toContain("no_citation");
	});

	it("does not blame the arm when the judge was unreadable", () => {
		const result = classify(record({ judgeUnreadable: true, verdict: "partial" }), question);
		expect(result?.primary).toBe("judge_unreadable");
	});

	it("buckets a RAG refusal as its own thing", () => {
		const result = classify(record({ arm: "rag", refused: true, trace: undefined }), question);
		expect(result?.primary).toBe("refused");
	});

	it("catches a repeated call the loop did not flag as duplicate", () => {
		const result = classify(record({
			trace: [step({ step: 1 }), step({ step: 2 })],
		}), question);
		expect(result?.matched).toContain("tool_loop");
		expect(result?.evidence).toContain("repeated read_file");
	});

	it("catches a duplicate the loop did flag", () => {
		const result = classify(record({
			trace: [step({ step: 1, args: { path: "a.py" } }), step({ step: 2, duplicate: true })],
		}), question);
		expect(result?.matched).toContain("tool_loop");
	});

	it("flags a run that never opened a gold file", () => {
		const result = classify(record({
			trace: [step({ args: { path: "src/requests/adapters.py" } })],
		}), question);
		expect(result?.primary).toBe("never_opened_gold");
		expect(result?.evidence).toContain("adapters.py");
	});

	it("flags truncation only when it hit a gold file", () => {
		const onGold = classify(record({ trace: [step({ truncated: true })] }), question);
		expect(onGold?.matched).toContain("truncation");

		const elsewhere = classify(record({
			trace: [step({ args: { path: "src/requests/adapters.py" }, truncated: true })],
		}), question);
		// Truncation somewhere irrelevant isn't why the answer was wrong.
		expect(elsewhere?.matched).not.toContain("truncation");
		expect(elsewhere?.primary).toBe("never_opened_gold");
	});

	it("separates citing nothing from citing the wrong lines", () => {
		const none = classify(record({
			citation: { total: 0, correct: 0, precision: null, missedPaths: [] },
		}), question);
		expect(none?.matched).toContain("no_citation");

		const wrong = classify(record({
			citation: { total: 3, correct: 0, precision: 0, missedPaths: ["a"] },
		}), question);
		expect(wrong?.matched).toContain("wrong_citation");
		expect(wrong?.matched).not.toContain("no_citation");
	});

	it("says unexplained rather than inventing a cause", () => {
		// Opened a gold file, cited it correctly, no cap, no loop — still wrong.
		const result = classify(record({ judgeReason: "answer contradicts the reference" }), question);
		expect(result?.primary).toBe("unexplained");
		expect(result?.evidence).toContain("contradicts");
	});

	it("degrades to outcome buckets when there is no trace", () => {
		const result = classify(record({
			arm: "rag",
			trace: undefined,
			citation: { total: 2, correct: 0, precision: 0, missedPaths: ["a"] },
		}), question);
		expect(result?.primary).toBe("wrong_citation");
	});

	it("handles a question it has no gold for", () => {
		expect(classify(record(), undefined)?.primary).toBe("unexplained");
	});
});

describe("bucketCounts", () => {
	it("counts primary and co-occurring matches separately", () => {
		const classified = classifyAll([
			record({ run: 1, stopReason: "step_cap", citation: { total: 0, correct: 0, precision: null, missedPaths: [] } }),
			record({ run: 2, stopReason: "step_cap" }),
			record({ run: 3, citation: { total: 0, correct: 0, precision: null, missedPaths: [] } }),
			record({ run: 4, verdict: "correct" }),
		], [question]);

		expect(classified).toHaveLength(3);
		const counts = bucketCounts(classified);
		const stepCap = counts.find((c) => c.bucket === "step_cap");
		const noCitation = counts.find((c) => c.bucket === "no_citation");
		expect(stepCap).toEqual({ bucket: "step_cap", primary: 2, matched: 2 });
		// Two runs cited nothing, but only one had it as the primary explanation.
		expect(noCitation).toEqual({ bucket: "no_citation", primary: 1, matched: 2 });
	});

	it("leaves out buckets nothing matched", () => {
		const counts = bucketCounts(classifyAll([record()], [question]));
		expect(counts.map((c) => c.bucket)).not.toContain("context_budget");
	});

	it("can narrow to one arm", () => {
		const records = [record({ arm: "agent" }), record({ arm: "rag", trace: undefined })];
		expect(classifyAll(records, [question], "rag")).toHaveLength(1);
	});
});
