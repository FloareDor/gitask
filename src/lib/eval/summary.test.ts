import { describe, it, expect } from "vitest";
import type { EvalRecord } from "./harness";
import { disagreements, stopReasons, summarize, summaryTable } from "./summary";
import type { Verdict } from "./judge";
import type { Arm } from "./arms";

let seq = 0;

function record(
	questionId: string,
	arm: Arm,
	verdict: Verdict,
	overrides: Partial<EvalRecord> = {}
): EvalRecord {
	seq += 1;
	return {
		questionId,
		repo: "pallets/flask",
		type: "multihop",
		source: "swe-qa",
		arm,
		run: seq,
		answer: "an answer",
		verdict,
		judgeReason: "",
		citation: { total: 1, correct: 1, precision: 1, missedPaths: [] },
		tokensIn: 1000,
		tokensOut: 100,
		judgeTokensIn: 50,
		judgeTokensOut: 10,
		elapsedMs: 2000,
		...overrides,
	};
}

describe("summarize", () => {
	it("averages per question before averaging across questions", () => {
		// q1 runs 3x correct, q2 runs once wrong. Pooling runs would give 0.75;
		// per-question gives 0.5, which is the number we want.
		const records = [
			record("q1", "rag", "correct"),
			record("q1", "rag", "correct"),
			record("q1", "rag", "correct"),
			record("q2", "rag", "wrong"),
		];
		const cell = summarize(records, "rag", null);
		expect(cell.questions).toBe(2);
		expect(cell.runs).toBe(4);
		expect(cell.score).toBe(0.5);
	});

	it("scores partial as a half", () => {
		const cell = summarize([record("q1", "rag", "partial")], "rag", null);
		expect(cell.score).toBe(0.5);
		expect(cell.correctRate).toBe(0);
	});

	it("flags a question whose runs disagree", () => {
		const records = [
			record("q1", "agent", "correct"),
			record("q1", "agent", "wrong"),
			record("q2", "agent", "correct"),
			record("q2", "agent", "correct"),
		];
		const cell = summarize(records, "agent", null);
		expect(cell.unstableQuestions).toBe(1);
		expect(cell.stderr).toBeGreaterThan(0);
	});

	it("reports no error bar from a single question", () => {
		expect(summarize([record("q1", "rag", "correct")], "rag", null).stderr).toBe(0);
	});

	it("drops rows the judge couldn't be read on", () => {
		const records = [
			record("q1", "rag", "correct"),
			record("q2", "rag", "partial", { judgeUnreadable: true }),
		];
		const cell = summarize(records, "rag", null);
		expect(cell.questions).toBe(1);
		expect(cell.score).toBe(1);
	});

	it("keeps uncited runs out of the precision mean but counts them", () => {
		const records = [
			record("q1", "agent", "correct"),
			record("q2", "agent", "correct", {
				citation: { total: 0, correct: 0, precision: null, missedPaths: ["a.py"] },
			}),
		];
		const cell = summarize(records, "agent", null);
		expect(cell.citationPrecision).toBe(1);
		expect(cell.uncitedRate).toBe(0.5);
	});

	it("splits by question type", () => {
		const records = [
			record("q1", "rag", "correct", { type: "lookup" }),
			record("q2", "rag", "wrong", { type: "multihop" }),
		];
		expect(summarize(records, "rag", "lookup").score).toBe(1);
		expect(summarize(records, "rag", "multihop").score).toBe(0);
	});

	it("only reports steps for the agent", () => {
		const records = [record("q1", "agent", "correct", { steps: 6 }), record("q1", "rag", "correct")];
		expect(summarize(records, "agent", null).meanSteps).toBe(6);
		expect(summarize(records, "rag", null).meanSteps).toBeNull();
	});
});

describe("summaryTable", () => {
	it("skips cells with no runs behind them", () => {
		const cells = summaryTable([record("q1", "rag", "correct", { type: "lookup" })]);
		expect(cells.map((c) => `${c.arm}:${c.type}`)).toEqual(["rag:null", "rag:lookup"]);
	});
});

describe("stopReasons", () => {
	it("counts agent outcomes, with errors as their own bucket", () => {
		const records = [
			record("q1", "agent", "correct", { stopReason: "answered" }),
			record("q2", "agent", "wrong", { stopReason: "step_cap" }),
			record("q3", "agent", "wrong", { stopReason: "step_cap" }),
			record("q4", "agent", "wrong", { error: "429" }),
			record("q5", "rag", "correct"),
		];
		expect(stopReasons(records)).toEqual([
			{ reason: "step_cap", count: 2 },
			{ reason: "answered", count: 1 },
			{ reason: "error", count: 1 },
		]);
	});
});

describe("disagreements", () => {
	it("lists only questions the arms scored differently, agent wins first", () => {
		const records = [
			record("same", "rag", "correct"),
			record("same", "agent", "correct"),
			record("agent-wins", "rag", "wrong"),
			record("agent-wins", "agent", "correct"),
			record("rag-wins", "rag", "correct"),
			record("rag-wins", "agent", "wrong"),
		];
		expect(disagreements(records).map((d) => d.questionId)).toEqual(["agent-wins", "rag-wins"]);
	});
});
