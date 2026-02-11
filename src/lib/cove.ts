/**
 * Chain-of-Verification (CoVe) — single-pass self-correction.
 *
 * After the LLM generates an answer, CoVe:
 * 1. Extracts claims from the answer.
 * 2. Verifies each claim against the vector store.
 * 3. Produces a corrected answer if needed.
 *
 * Kept to a single pass since Qwen2-0.5B is lightweight.
 */

import { generateFull, type ChatMessage } from "./llm";
import { hybridSearch } from "./search";
import { embedText } from "./embedder";
import type { VectorStore } from "./vectorStore";

/**
 * Run a single CoVe pass on an initial answer.
 * Returns the refined answer.
 */
export async function verifyAndRefine(
	initialAnswer: string,
	userQuestion: string,
	store: VectorStore
): Promise<string> {
	// Step 1: Extract claims
	const claimsPrompt: ChatMessage[] = [
		{
			role: "system",
			content:
				"Extract the key factual claims from the following answer as a numbered list. Only include claims about code functionality, not opinions.",
		},
		{ role: "user", content: initialAnswer },
	];

	const claimsText = await generateFull(claimsPrompt);
	const claims = claimsText
		.split("\n")
		.filter((line) => /^\d+[\.\)]/.test(line.trim()))
		.map((line) => line.replace(/^\d+[\.\)]\s*/, "").trim());

	if (claims.length === 0) return initialAnswer;

	// Step 2: Verify claims against the codebase
	const verifications: string[] = [];

	for (const claim of claims.slice(0, 3)) {
		// Limit to 3 claims for speed
		const queryEmbedding = await embedText(claim);
		const results = hybridSearch(store, queryEmbedding, claim, { limit: 2 });

		if (results.length > 0) {
			const evidence = results
				.map((r) => `File: ${r.chunk.filePath}\n\`\`\`\n${r.chunk.code.slice(0, 300)}\n\`\`\``)
				.join("\n");
			verifications.push(`Claim: "${claim}"\nEvidence:\n${evidence}`);
		}
	}

	if (verifications.length === 0) return initialAnswer;

	// Step 3: Refine the answer
	const refinePrompt: ChatMessage[] = [
		{
			role: "system",
			content:
				"You are a code assistant. The user asked a question and you gave an initial answer. " +
				"Here are some claims from your answer verified against the actual codebase. " +
				"If any claims are incorrect based on the evidence, correct them. " +
				"Return the refined answer. Keep it concise.",
		},
		{
			role: "user",
			content: `Question: ${userQuestion}\n\nInitial answer: ${initialAnswer}\n\nVerifications:\n${verifications.join("\n\n")}`,
		},
	];

	return generateFull(refinePrompt);
}
