/**
 * The eval set, as data.
 *
 * `questions.json` is generated — see `scripts/build_eval_questions.py` for how
 * the SWE-QA half is lifted and `scripts/eval_authored_build.py` for the rest.
 * Don't hand-edit the JSON; edit the script and re-run it.
 */

import payload from "./questions.json";
import type { EvalQuestion, EvalSet } from "./types";

export const EVAL_SET = payload as EvalSet;
export const EVAL_QUESTIONS: EvalQuestion[] = EVAL_SET.questions;

/** Repos the set covers, in the order they first appear. */
export function evalRepos(): string[] {
	return [...new Set(EVAL_QUESTIONS.map((question) => question.repo))];
}

/**
 * Questions for one repo. The harness runs a repo at a time because it needs
 * that repo's index loaded, and indexing is the slow part.
 */
export function questionsForRepo(repo: string): EvalQuestion[] {
	return EVAL_QUESTIONS.filter((question) => question.repo === repo);
}

/** The ref a repo has to be indexed at for its gold line numbers to hold. */
export function refForRepo(repo: string): string | undefined {
	return EVAL_QUESTIONS.find((question) => question.repo === repo)?.ref;
}
