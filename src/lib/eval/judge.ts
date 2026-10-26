/**
 * The LLM judge.
 *
 * One Flash call per answer, scoring it against the gold answer. It is told
 * nothing about which arm produced the answer, and it never sees the retrieved
 * context — only the question, the gold answer and the candidate — so it can't
 * reward an arm for showing its work. Citation correctness is scored separately
 * and mechanically in `scoring.ts`; the judge is only asked about substance.
 */

import type { KeyScope } from "../agent/providers/gemini";
import { geminiOneShot } from "./gemini";

export type Verdict = "correct" | "partial" | "wrong";

export interface JudgeResult {
	verdict: Verdict;
	/** One line from the judge, kept so failures can be read in Phase 5. */
	reason: string;
	/** True when the reply couldn't be parsed — excluded from the headline number. */
	unreadable?: boolean;
	tokensIn: number;
	tokensOut: number;
}

const SYSTEM = [
	"You grade answers about a codebase against a reference answer.",
	"",
	"correct — every substantive claim in the reference is present and nothing in the answer contradicts it.",
	"partial — some of the reference is covered, or the answer is right but incomplete on a key point.",
	"wrong — the answer misses the reference's point, contradicts it, or says it could not find anything.",
	"",
	"Judge substance, not wording, length or formatting. An answer that reaches the",
	"reference's conclusion by a different route is correct. Do not reward or penalise",
	"an answer for citing file paths and line numbers; those are scored elsewhere.",
	"",
	'Reply with JSON only: {"verdict": "correct" | "partial" | "wrong", "reason": "<one sentence>"}',
].join("\n");

function parseVerdict(text: string): { verdict: Verdict; reason: string; unreadable?: boolean } {
	// Flash wraps JSON in a fence often enough to be worth handling.
	const match = text.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
			if (parsed.verdict === "correct" || parsed.verdict === "partial" || parsed.verdict === "wrong") {
				return { verdict: parsed.verdict, reason: parsed.reason ?? "" };
			}
		} catch {
			// fall through
		}
	}
	// A verdict we can't read says nothing about the answer. It is flagged so the
	// harness can drop it rather than quietly scoring it as a failure.
	return { verdict: "partial", reason: `unparseable judge reply: ${text.slice(0, 160)}`, unreadable: true };
}

export async function judgeAnswer(
	withKey: KeyScope,
	input: { question: string; goldAnswer: string; answer: string },
	model?: string
): Promise<JudgeResult> {
	if (!input.answer.trim()) {
		return { verdict: "wrong", reason: "empty answer", tokensIn: 0, tokensOut: 0 };
	}

	const prompt = [
		`Question:\n${input.question}`,
		`Reference answer:\n${input.goldAnswer}`,
		`Answer to grade:\n${input.answer}`,
	].join("\n\n");

	const reply = await geminiOneShot(withKey, { system: SYSTEM, prompt, model, json: true });
	return { ...parseVerdict(reply.text), tokensIn: reply.tokensIn, tokensOut: reply.tokensOut };
}
