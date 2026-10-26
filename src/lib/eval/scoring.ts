/**
 * Mechanical grading — everything that can be scored without asking a model.
 *
 * Two jobs: turn hand-annotated `goldLocations` into chunk-level relevance for
 * the retrieval ablation, and check whether an answer's citations actually point
 * at the gold spans. Keeping both off the LLM is what lets the deck say the
 * citation number is measured, not judged.
 */

import type { CodeChunk } from "../chunker";
import { citationsOverlap, type Citation } from "../agent/citations";
import { RELEVANCE, type EvalQuestion, type GoldLocation } from "./types";

/** Gold answers write `./src/flask/app.py`; the index stores `src/flask/app.py`. */
export function normalizePath(path: string): string {
	return path.replace(/^\.?\//, "");
}

function spansOverlap(a: GoldLocation, b: { startLine: number; endLine: number }): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export interface DerivedRelevance {
	relevantChunkIds: string[];
	relevanceScores: Record<string, number>;
	/** Gold files the index doesn't contain — a question we can't fairly ask. */
	missingPaths: string[];
}

/**
 * Label every chunk against a question's gold spans. Derived at run time rather
 * than stored, so changing the chunker doesn't invalidate the eval set.
 */
export function deriveRelevance(chunks: CodeChunk[], question: EvalQuestion): DerivedRelevance {
	const goldByPath = new Map<string, GoldLocation[]>();
	for (const location of question.goldLocations) {
		const path = normalizePath(location.path);
		const list = goldByPath.get(path);
		if (list) list.push(location);
		else goldByPath.set(path, [location]);
	}

	const seenPaths = new Set<string>();
	const relevanceScores: Record<string, number> = {};
	const relevantChunkIds: string[] = [];

	for (const chunk of chunks) {
		const gold = goldByPath.get(normalizePath(chunk.filePath));
		if (!gold) continue;
		seenPaths.add(normalizePath(chunk.filePath));
		const score = gold.some((location) => spansOverlap(location, chunk))
			? RELEVANCE.ON_TARGET
			: RELEVANCE.SAME_FILE;
		relevanceScores[chunk.id] = score;
		if (score === RELEVANCE.ON_TARGET) relevantChunkIds.push(chunk.id);
	}

	return {
		relevantChunkIds,
		relevanceScores,
		missingPaths: [...goldByPath.keys()].filter((path) => !seenPaths.has(path)),
	};
}

export interface CitationScore {
	/** Citations the answer actually made. */
	total: number;
	/** How many land on a gold span. */
	correct: number;
	/** correct / total, or null when the answer cited nothing. */
	precision: number | null;
	/** Gold files the answer never pointed at. */
	missedPaths: string[];
}

/** Does the answer point at the right lines? Overlap with any gold span counts. */
export function scoreCitations(citations: Citation[], goldLocations: GoldLocation[]): CitationScore {
	const gold = goldLocations.map((location) => ({
		path: normalizePath(location.path),
		startLine: location.startLine,
		endLine: location.endLine,
	}));
	const hitPaths = new Set<string>();
	let correct = 0;

	for (const citation of citations) {
		const normalized = { ...citation, path: normalizePath(citation.path) };
		const hit = gold.find((location) => citationsOverlap(normalized, location));
		if (!hit) continue;
		correct += 1;
		hitPaths.add(hit.path);
	}

	return {
		total: citations.length,
		correct,
		precision: citations.length === 0 ? null : correct / citations.length,
		missedPaths: [...new Set(gold.map((location) => location.path))].filter((path) => !hitPaths.has(path)),
	};
}
