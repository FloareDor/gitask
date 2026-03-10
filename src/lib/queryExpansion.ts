/**
 * Query expansion for CodeRAG-style multi-path retrieval.
 *
 * Two modes:
 *  - LLM-powered (when expansion enabled + non-local provider): generateQueryVariants
 *    uses world knowledge for synonyms, follow-up resolution, and vocab bridging.
 *  - Heuristic fallback (when expansion disabled or local provider):
 *    buildContextualQuery enriches follow-up queries from prior turns,
 *    expandQuery adds a code-symbol variant for free 2-path RRF without LLM.
 *
 * @see Zhang et al., "CodeRAG", EMNLP 2025. https://arxiv.org/abs/2509.16112
 */

// ── Heuristic helpers ─────────────────────────────────────────────────────────

const EXPANSION_STOP_WORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "must", "shall", "can", "cannot",
	"this", "that", "these", "those", "it", "its",
	"what", "which", "who", "whom", "whose", "when", "where", "why", "how",
	"and", "or", "but", "not", "so", "for", "in", "on", "at", "to", "from",
	"of", "with", "by", "about", "i", "me", "my", "we", "our", "you", "your",
	"he", "him", "his", "she", "her", "they", "them", "their", "there", "here",
	"any", "all", "some", "no", "get", "make", "use", "like", "just", "tell",
	"show", "give", "find", "know", "see", "say", "go", "put", "set", "let",
	"try", "help", "need", "want", "code", "file", "line", "add", "run", "work",
	"project", "repo", "repository", "app", "application",
]);

/** ≤2 non-stop-word tokens → follow-up query that needs context injection. */
function isFollowUpQuery(query: string): boolean {
	const tokens = query.toLowerCase().match(/[a-z]+/g) ?? [];
	return tokens.filter((t) => t.length >= 3 && !EXPANSION_STOP_WORDS.has(t)).length <= 2;
}

function extractRetrievalTerms(text: string, limit: number): string[] {
	const tokens = text.match(/[a-zA-Z_]\w+/g) ?? [];
	return [...new Set(
		tokens.filter((t) => t.length >= 3 && !EXPANSION_STOP_WORDS.has(t.toLowerCase()))
	)].slice(0, limit);
}

/**
 * Enrich a follow-up query with key terms from prior conversation turns.
 * "is it the same?" → "is it the same? handleError tryCatch fetchUser …"
 * No-ops when the query already has enough retrieval signal.
 */
export function buildContextualQuery(
	userMessage: string,
	priorMessages: Array<{ role: "user" | "assistant"; content: string }>
): string {
	const trimmed = userMessage.trim();
	if (priorMessages.length === 0 || !isFollowUpQuery(trimmed)) return trimmed;

	const contextTerms: string[] = [];
	const lastUser = [...priorMessages].reverse().find((m) => m.role === "user");
	if (lastUser) contextTerms.push(...extractRetrievalTerms(lastUser.content, 8));

	const lastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
	if (lastAssistant) contextTerms.push(...extractRetrievalTerms(lastAssistant.content.slice(0, 600), 8));

	const unique = [...new Set(contextTerms)];
	return unique.length === 0 ? trimmed : `${trimmed} ${unique.join(" ")}`;
}

/**
 * Heuristic multi-path expansion: original query + a code-symbol variant.
 * The code-symbol variant is only added when the query contains real identifiers
 * (camelCase / snake_case / long tokens) — avoids noise on plain NL questions.
 */
export function expandQuery(userMessage: string): string[] {
	const trimmed = userMessage.trim();
	if (!trimmed) return [trimmed];

	const codeSymbols = (trimmed.match(/[a-zA-Z_]\w+/g) ?? []).filter(
		(s) =>
			s.length >= 3 &&
			!EXPANSION_STOP_WORDS.has(s.toLowerCase()) &&
			(/[A-Z]/.test(s) || s.includes("_") || s.length >= 6)
	);

	if (codeSymbols.length === 0) return [trimmed];

	const codeVariant = `${codeSymbols.join(" ")} implementation definition`;
	return codeVariant === trimmed ? [trimmed] : [trimmed, codeVariant];
}

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
