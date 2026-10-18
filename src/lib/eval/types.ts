/**
 * The eval set schema.
 *
 * One record per question, shared by both arms (RAG and agent) and by the
 * retrieval ablation. The only things annotated by hand are `type` and
 * `goldLocations`; chunk-level relevance is derived from `goldLocations`
 * against whatever index is loaded, so the labels survive a re-chunk.
 */

/** A span of a file that a correct answer has to be looking at. */
export interface GoldLocation {
	path: string;
	startLine: number;
	endLine: number;
}

export interface EvalQuestion {
	id: string;
	/** `owner/repo`, as the app addresses it. */
	repo: string;
	/** Commit the gold answer was written against. Index at this ref or the lines drift. */
	ref: string;
	/** Where the question came from, so the deck can separate borrowed from authored. */
	source: "swe-qa" | "authored";
	/** `lookup` is answerable from one place; `multihop` needs two or more. */
	type: "lookup" | "multihop";
	question: string;
	goldAnswer: string;
	goldLocations: GoldLocation[];
}

export interface EvalSet {
	name: string;
	/** How the SWE-QA half was selected and what was annotated by hand. */
	provenance: string;
	questions: EvalQuestion[];
}

/** Graded relevance for the retrieval ablation, derived rather than annotated. */
export const RELEVANCE = {
	/** Chunk overlaps a gold span. */
	ON_TARGET: 3,
	/** Chunk is in a gold file but misses the span — useful, not the answer. */
	SAME_FILE: 1,
} as const;
