/**
 * Turning records into the numbers that go on a slide.
 *
 * Pure functions over `EvalRecord[]` — no model calls — so the deck's tables can
 * be regenerated from a saved export, and so the arithmetic is testable.
 *
 * Scoring: correct = 1, partial = 0.5, wrong = 0. A question's score is the mean
 * over its N runs; the headline number is the mean over questions, and the error
 * bar is the standard error over questions. Averaging per question first matters
 * — otherwise a question that happened to run more times would count more.
 */

import type { EvalRecord } from "./harness";
import type { Arm } from "./arms";

export const VERDICT_SCORE = { correct: 1, partial: 0.5, wrong: 0 } as const;

export interface Cell {
	arm: Arm;
	/** null means "both types pooled". */
	type: "lookup" | "multihop" | null;
	questions: number;
	runs: number;
	/** Mean per-question score, 0–1. */
	score: number;
	/** Standard error of that mean, across questions. */
	stderr: number;
	/** Share of runs the judge called correct outright. */
	correctRate: number;
	/** Runs where the arm's N attempts didn't all agree — a stability signal. */
	unstableQuestions: number;
	meanTokensIn: number;
	meanTokensOut: number;
	meanLatencyMs: number;
	/** Mean over runs that cited anything; null when none did. */
	citationPrecision: number | null;
	/** Share of runs that cited nothing at all. */
	uncitedRate: number;
	meanSteps: number | null;
	errorRate: number;
	refusalRate: number;
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stderr(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance / values.length);
}

/** Judge replies we couldn't parse say nothing about the answer. Drop them. */
function scorable(records: EvalRecord[]): EvalRecord[] {
	return records.filter((record) => !record.judgeUnreadable);
}

export function summarize(records: EvalRecord[], arm: Arm, type: Cell["type"]): Cell {
	const rows = records.filter((r) => r.arm === arm && (type === null || r.type === type));
	const graded = scorable(rows);

	const byQuestion = new Map<string, EvalRecord[]>();
	for (const record of graded) {
		const list = byQuestion.get(record.questionId);
		if (list) list.push(record);
		else byQuestion.set(record.questionId, [record]);
	}

	const perQuestion = [...byQuestion.values()].map((runs) =>
		mean(runs.map((r) => VERDICT_SCORE[r.verdict]))
	);
	const unstable = [...byQuestion.values()]
		.filter((runs) => new Set(runs.map((r) => r.verdict)).size > 1).length;

	const cited = rows.filter((r) => r.citation.precision !== null);

	return {
		arm,
		type,
		questions: byQuestion.size,
		runs: rows.length,
		score: mean(perQuestion),
		stderr: stderr(perQuestion),
		correctRate: graded.length === 0 ? 0 : graded.filter((r) => r.verdict === "correct").length / graded.length,
		unstableQuestions: unstable,
		meanTokensIn: mean(rows.map((r) => r.tokensIn)),
		meanTokensOut: mean(rows.map((r) => r.tokensOut)),
		meanLatencyMs: mean(rows.map((r) => r.elapsedMs)),
		citationPrecision: cited.length === 0 ? null : mean(cited.map((r) => r.citation.precision as number)),
		uncitedRate: rows.length === 0 ? 0 : (rows.length - cited.length) / rows.length,
		meanSteps: arm === "agent" && rows.length > 0 ? mean(rows.map((r) => r.steps ?? 0)) : null,
		errorRate: rows.length === 0 ? 0 : rows.filter((r) => r.error).length / rows.length,
		refusalRate: rows.length === 0 ? 0 : rows.filter((r) => r.refused).length / rows.length,
	};
}

/** The headline table: each arm, pooled and split by question type. */
export function summaryTable(records: EvalRecord[]): Cell[] {
	const arms: Arm[] = ["rag", "agent"];
	const types: Cell["type"][] = [null, "lookup", "multihop"];
	const cells: Cell[] = [];
	for (const arm of arms) {
		for (const type of types) {
			const cell = summarize(records, arm, type);
			if (cell.runs > 0) cells.push(cell);
		}
	}
	return cells;
}

export interface StopReasonCount {
	reason: string;
	count: number;
}

/** Why agent runs ended — the first cut of the Phase 5 failure taxonomy. */
export function stopReasons(records: EvalRecord[]): StopReasonCount[] {
	const counts = new Map<string, number>();
	for (const record of records) {
		if (record.arm !== "agent") continue;
		const reason = record.error ? "error" : record.stopReason ?? "unknown";
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count);
}

export interface Disagreement {
	questionId: string;
	type: EvalRecord["type"];
	ragScore: number;
	agentScore: number;
}

/** Questions the two arms answer differently — slide 4 and the router's oracle. */
export function disagreements(records: EvalRecord[]): Disagreement[] {
	const byQuestion = new Map<string, { rag: number[]; agent: number[]; type: EvalRecord["type"] }>();
	for (const record of scorable(records)) {
		const entry = byQuestion.get(record.questionId)
			?? { rag: [], agent: [], type: record.type };
		entry[record.arm].push(VERDICT_SCORE[record.verdict]);
		byQuestion.set(record.questionId, entry);
	}

	return [...byQuestion.entries()]
		.map(([questionId, entry]) => ({
			questionId,
			type: entry.type,
			ragScore: mean(entry.rag),
			agentScore: mean(entry.agent),
		}))
		.filter((row) => row.ragScore !== row.agentScore)
		.sort((a, b) => (b.agentScore - b.ragScore) - (a.agentScore - a.ragScore));
}
