/**
 * Failure taxonomy.
 *
 * Buckets every run the judge didn't call correct, so Phase 5 can say *why* an
 * arm failed rather than just how often. The buckets are the ones the plan
 * named; what's new here is that they're computed from the record rather than
 * read off by hand, so the same taxonomy applies to a rerun without anyone
 * re-reading 270 answers.
 *
 * A failure usually matches several buckets at once — an agent that looped also
 * hit the step cap, and probably never opened the right file either. Each run
 * gets exactly one primary bucket, assigned by the priority order below, which
 * runs from "the run never really happened" through mechanism to outcome. The
 * secondary matches are kept too, because "how often did truncation co-occur
 * with a wrong answer" is a question the fix selection will want to ask.
 */

import { citationsOverlap, type Citation } from "../agent/citations";
import type { TraceStep } from "./arms";
import type { EvalRecord } from "./harness";
import { normalizePath } from "./scoring";
import type { EvalQuestion } from "./types";

export type FailureBucket =
	/** Threw, or was cut off by the run timeout. Says nothing about retrieval. */
	| "provider_error"
	/** The judge failed, so this row says nothing about the arm either. */
	| "judge_unreadable"
	/** RAG declined to answer: injection block or no evidence found. */
	| "refused"
	/** Ran out of its context budget before answering. */
	| "context_budget"
	/** Ran out of steps before answering. */
	| "step_cap"
	/** Repeated a call it had already made. */
	| "tool_loop"
	/** Answered without ever reading a file the gold answer points at. */
	| "never_opened_gold"
	/** Saw a gold file but only a truncated slice of it. */
	| "truncation"
	/** Answered with no citation at all. */
	| "no_citation"
	/** Cited, but nothing it cited overlaps a gold span. */
	| "wrong_citation"
	/** Wrong for a reason none of the above explains — read these by hand. */
	| "unexplained";

/** Most-fundamental first: a run that errored tells you nothing about retrieval. */
export const BUCKET_PRIORITY: FailureBucket[] = [
	"provider_error",
	"judge_unreadable",
	"refused",
	"context_budget",
	"step_cap",
	"tool_loop",
	"never_opened_gold",
	"truncation",
	"no_citation",
	"wrong_citation",
	"unexplained",
];

export interface Classified {
	questionId: string;
	arm: EvalRecord["arm"];
	run: number;
	type: EvalRecord["type"];
	verdict: EvalRecord["verdict"];
	primary: FailureBucket;
	/** Every bucket that matched, including the primary one. */
	matched: FailureBucket[];
	/** One line of evidence, so a bucket count can be spot-checked. */
	evidence: string;
}

/** Paths a tool call actually touched, as far as the args reveal. */
function pathsTouched(trace: TraceStep[]): Set<string> {
	const paths = new Set<string>();
	for (const step of trace) {
		for (const key of ["path", "file", "filePath", "glob"]) {
			const value = step.args[key];
			if (typeof value === "string" && value.includes(".")) paths.add(normalizePath(value));
		}
	}
	return paths;
}

/** A repeated (tool, args) pair, whether or not the loop suppressed it. */
function repeatedCall(trace: TraceStep[]): TraceStep | undefined {
	const seen = new Set<string>();
	for (const step of trace) {
		if (step.duplicate) return step;
		const key = `${step.tool}:${JSON.stringify(step.args)}`;
		if (seen.has(key)) return step;
		seen.add(key);
	}
	return undefined;
}

export function classify(record: EvalRecord, question: EvalQuestion | undefined): Classified | null {
	// Only failures are bucketed. A partial is a failure to fully answer, so it
	// is bucketed too — the fix selection cares about near-misses.
	if (record.verdict === "correct") return null;

	const matched: FailureBucket[] = [];
	const notes: string[] = [];
	const trace = record.trace ?? [];
	const gold = question?.goldLocations ?? [];

	if (record.error) {
		matched.push("provider_error");
		notes.push(record.error.slice(0, 120));
	}
	if (record.judgeUnreadable) {
		matched.push("judge_unreadable");
		notes.push(record.judgeReason.slice(0, 120));
	}
	if (record.refused) {
		matched.push("refused");
		notes.push("arm declined to answer");
	}
	if (record.stopReason === "context_budget") {
		matched.push("context_budget");
		notes.push(`${record.toolBytes ?? 0}B of tool output`);
	}
	if (record.stopReason === "step_cap") {
		matched.push("step_cap");
		notes.push(`${record.steps ?? 0} steps`);
	}

	const repeat = repeatedCall(trace);
	if (repeat) {
		matched.push("tool_loop");
		notes.push(`repeated ${repeat.tool} at step ${repeat.step}`);
	}

	if (trace.length > 0 && gold.length > 0) {
		const touched = pathsTouched(trace);
		const goldPaths = new Set(gold.map((location) => normalizePath(location.path)));
		const opened = [...touched].filter((path) => goldPaths.has(path));
		if (opened.length === 0) {
			matched.push("never_opened_gold");
			notes.push(`touched ${[...touched].slice(0, 3).join(", ") || "no files"}`);
		} else if (trace.some((step) => step.truncated && opened.some((p) => JSON.stringify(step.args).includes(p)))) {
			matched.push("truncation");
			notes.push(`truncated result on ${opened[0]}`);
		}
	}

	if (record.citation.total === 0) {
		matched.push("no_citation");
		notes.push("answer cited nothing");
	} else if (record.citation.correct === 0) {
		matched.push("wrong_citation");
		notes.push(`${record.citation.total} citations, none on a gold span`);
	}

	if (matched.length === 0) {
		matched.push("unexplained");
		notes.push(record.judgeReason.slice(0, 120) || "judge said wrong, nothing else fired");
	}

	const primary = BUCKET_PRIORITY.find((bucket) => matched.includes(bucket)) as FailureBucket;
	return {
		questionId: record.questionId,
		arm: record.arm,
		run: record.run,
		type: record.type,
		verdict: record.verdict,
		primary,
		matched,
		evidence: notes.join(" · "),
	};
}

export interface BucketCount {
	bucket: FailureBucket;
	/** Runs where this is the primary explanation. */
	primary: number;
	/** Runs where it matched at all, primary or not. */
	matched: number;
}

export function bucketCounts(classified: Classified[]): BucketCount[] {
	return BUCKET_PRIORITY
		.map((bucket) => ({
			bucket,
			primary: classified.filter((c) => c.primary === bucket).length,
			matched: classified.filter((c) => c.matched.includes(bucket)).length,
		}))
		.filter((row) => row.matched > 0)
		.sort((a, b) => b.primary - a.primary || b.matched - a.matched);
}

/** Bucket every failing run in an export. Successes are skipped. */
export function classifyAll(
	records: EvalRecord[],
	questions: EvalQuestion[],
	arm?: EvalRecord["arm"]
): Classified[] {
	const byId = new Map(questions.map((question) => [question.id, question]));
	return records
		.filter((record) => !arm || record.arm === arm)
		.map((record) => classify(record, byId.get(record.questionId)))
		.filter((row): row is Classified => row !== null);
}

/** Citations the agent made that land nowhere near gold — Phase 6's starting list. */
export function unsupportedCitations(
	record: EvalRecord,
	question: EvalQuestion,
	citations: Citation[]
): Citation[] {
	const gold = question.goldLocations.map((location) => ({
		...location,
		path: normalizePath(location.path),
	}));
	return citations.filter((citation) =>
		!gold.some((location) => citationsOverlap({ ...citation, path: normalizePath(citation.path) }, location))
	);
}
