/**
 * LLM-powered query expansion for RAG-Fusion style multi-path retrieval.
 *
 * Replaces all heuristic stopword/symbol approaches with two LLM calls:
 *   1. generateQueryVariants — world knowledge handles synonyms, abbreviations,
 *      follow-up resolution, and codebase vocabulary bridging in one shot.
 *   2. getRetrievalRefinement — sufficiency check after a weak first pass;
 *      asks the LLM what to search for instead and runs a second retrieval.
 *
 * Both functions fall back gracefully and never block retrieval.
 * Callers must gate on `config.provider !== "mlc"` before calling.
 */

/**
 * Generate 3 alternative query phrasings via LLM for multi-path retrieval.
 * Returns [original, ...variants] deduplicated (up to 4 total).
 *
 * Handles:
 *  - Synonym/abbreviation expansion: "llm" → "language model", "gemini groq"
 *  - Follow-up resolution: "is it the same?" + chat context → self-contained query
 *  - Codebase vocab bridging: README used as a hint, not the answer
 */
export async function generateQueryVariants(
	query: string,
	priorMessages: Array<{ role: "user" | "assistant"; content: string }>,
	readmeContent: string,
): Promise<string[]> {
	const trimmed = query.trim();
	const fallback = [trimmed];
	if (!trimmed) return fallback;

	try {
		const { getLLMStatus, generateFull } = await import("./llm");
		if (getLLMStatus() !== "ready") return fallback;

		const recentTurns = priorMessages
			.slice(-4)
			.map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
			.join("\n");
		const contextBlock = recentTurns ? `\n\nRecent conversation:\n${recentTurns}` : "";
		const readmeBlock = readmeContent.trim()
			? `\n\nRepo README (vocabulary hint only):\n${readmeContent.slice(0, 600)}`
			: "";

		const messages = [
			{
				role: "system" as const,
				content:
					"You expand search queries for a code repository. Given a user query, output 3 alternative phrasings that would find the same code through different wording. Expand abbreviations, add synonyms, use technical identifiers. If the query is a follow-up using pronouns like \"it\"/\"they\"/\"this\", rewrite it as a standalone query using the conversation context. Output 3 queries only, one per line, no numbering, no explanation.",
			},
			{
				role: "user" as const,
				content: `Query: "${trimmed}"${contextBlock}${readmeBlock}`,
			},
		];

		const response = (await generateFull(messages)).trim();
		if (!response) return fallback;

		const variants = response
			.split("\n")
			.map((l) => l.replace(/^\d+[\.\)]\s*/, "").trim())
			.filter((l) => l.length > 2 && l.length < 250);

		const seen = new Set<string>();
		const all: string[] = [];
		for (const v of [trimmed, ...variants]) {
			const key = v.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				all.push(v);
			}
		}
		return all.slice(0, 4); // original + max 3 variants
	} catch {
		return [trimmed];
	}
}

/**
 * Retrieval sufficiency check — runs after a weak first retrieval pass.
 * Asks the LLM what to search for instead; returns a refined query string,
 * or null if results are already sufficient or the call fails.
 *
 * Triggers when: fewer than 2 results OR top score < 0.4.
 */
export async function getRetrievalRefinement(
	query: string,
	results: Array<{ filePath: string; code: string; score: number }>,
): Promise<string | null> {
	const isWeak = results.length < 2 || results[0]?.score < 0.4;
	if (!isWeak) return null;

	try {
		const { getLLMStatus, generateFull } = await import("./llm");
		if (getLLMStatus() !== "ready") return null;

		const summary = results
			.slice(0, 3)
			.map((r) => `${r.filePath}: ${r.code.slice(0, 100)}`)
			.join("\n") || "(no results found)";

		const messages = [
			{
				role: "system" as const,
				content:
					"You improve code search queries. Given a query and weak search results, output ONE better search query using specific function names, file names, or identifiers. If the results are actually sufficient to answer the question, output only: SUFFICIENT",
			},
			{
				role: "user" as const,
				content: `Query: "${query}"\n\nCurrent results:\n${summary}`,
			},
		];

		const response = (await generateFull(messages)).trim();
		if (!response || response === "SUFFICIENT" || response.length > 200) return null;
		return response;
	} catch {
		return null;
	}
}
