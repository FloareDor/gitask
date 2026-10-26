import { describe, it, expect } from "vitest";
import { EVAL_QUESTIONS, EVAL_SET, evalRepos, questionsForRepo, refForRepo } from "./questions";

describe("eval set", () => {
	it("has 45 questions, 15 per repo", () => {
		expect(EVAL_QUESTIONS).toHaveLength(45);
		for (const repo of evalRepos()) {
			expect(questionsForRepo(repo)).toHaveLength(15);
		}
	});

	it("is roughly 60/40 multihop to lookup, as the plan calls for", () => {
		const multihop = EVAL_QUESTIONS.filter((q) => q.type === "multihop").length;
		expect(multihop).toBe(27);
		expect(EVAL_QUESTIONS.length - multihop).toBe(18);
	});

	it("gives every question a unique id", () => {
		expect(new Set(EVAL_QUESTIONS.map((q) => q.id)).size).toBe(EVAL_QUESTIONS.length);
	});

	it("pins one ref per repo, so gold line numbers mean something", () => {
		for (const repo of evalRepos()) {
			const refs = new Set(questionsForRepo(repo).map((q) => q.ref));
			expect(refs.size).toBe(1);
			expect(refForRepo(repo)).toBe([...refs][0]);
		}
	});

	it("gives every question a gold answer and at least one gold location", () => {
		for (const question of EVAL_QUESTIONS) {
			expect(question.goldAnswer.length, question.id).toBeGreaterThan(80);
			expect(question.goldLocations.length, question.id).toBeGreaterThan(0);
			for (const location of question.goldLocations) {
				expect(location.startLine, question.id).toBeGreaterThan(0);
				expect(location.endLine, question.id).toBeGreaterThanOrEqual(location.startLine);
			}
		}
	});

	it("only cites paths the indexer would actually keep", () => {
		// isIndexable drops anything outside this list, so a gold .rst or .cfg
		// would be a question nothing can answer.
		const indexable = new Set(["py", "ts", "tsx", "js", "json", "md", "txt", "toml", "yaml", "yml"]);
		for (const question of EVAL_QUESTIONS) {
			for (const location of question.goldLocations) {
				const ext = location.path.split(".").pop() ?? "";
				expect(indexable.has(ext), `${question.id} cites ${location.path}`).toBe(true);
			}
		}
	});

	it("expects multihop questions to span more than one file", () => {
		for (const question of EVAL_QUESTIONS.filter((q) => q.type === "multihop")) {
			const files = new Set(question.goldLocations.map((l) => l.path));
			expect(files.size, question.id).toBeGreaterThan(1);
		}
	});

	it("says where the questions came from", () => {
		expect(EVAL_SET.provenance).toContain("SWE-QA");
		const sources = new Set(EVAL_QUESTIONS.map((q) => q.source));
		expect([...sources].sort()).toEqual(["authored", "swe-qa"]);
	});
});
