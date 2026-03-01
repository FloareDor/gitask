/**
 * Query expansion for CodeRAG-style multi-path retrieval.
 * Produces 2 (or more) query variants from the user message so we can run
 * retrieval per variant and fuse with RRF.
 *
 * @see Zhang et al., "CodeRAG: Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion", EMNLP 2025. https://arxiv.org/abs/2509.16112
 */

/** Extract identifiers (symbols) from text — same pattern as search keywordSearch. */
const SYMBOL_REGEX = /[a-zA-Z_]\w+/g;

/**
 * Common English words that are not meaningful code identifiers.
 * The code-style query variant is only generated when there are symbols
 * outside this set — otherwise it degrades to generic noise.
 */
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

/**
 * Expand a user message into one or more query variants for multi-path retrieval.
 * - Primary: user message as-is.
 * - Code-style: only generated if the query contains real code identifiers
 *   (non-stop-word tokens), to avoid creating a noisy duplicate for plain
 *   natural-language questions like "what does this project do?".
 * Deduplicates so we never return two identical strings.
 */
export function expandQuery(userMessage: string): string[] {
	const trimmed = userMessage.trim();
	if (!trimmed) return [trimmed];

	const rawSymbols = trimmed.match(SYMBOL_REGEX) ?? [];
	// Only keep identifiers that look like real code tokens (camelCase, snake_case,
	// PascalCase, or long enough to be meaningful) and are not stop words.
	const codeSymbols = rawSymbols.filter(
		(s) =>
			s.length >= 3 &&
			!EXPANSION_STOP_WORDS.has(s.toLowerCase()) &&
			// Treat it as a code identifier if it has mixed case, underscores, or
			// is long enough to plausibly be an identifier rather than a plain word.
			(/[A-Z]/.test(s) || s.includes("_") || s.length >= 6)
	);

	const seen = new Set<string>();
	const variants: string[] = [];

	// Always include original
	variants.push(trimmed);
	seen.add(trimmed);

	// Code-style variant: only when there are real code identifiers in the query
	if (codeSymbols.length > 0) {
		const codeStyle = codeSymbols.join(" ") + " implementation definition";
		if (!seen.has(codeStyle)) {
			variants.push(codeStyle);
			seen.add(codeStyle);
		}
	}

	return variants;
}
