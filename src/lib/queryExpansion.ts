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
 * Expand a user message into one or more query variants for multi-path retrieval.
 * - Primary: user message as-is.
 * - Code-style: symbols from the message + "implementation definition" to favor definition chunks.
 * Deduplicates so we never return two identical strings.
 */
export function expandQuery(userMessage: string): string[] {
	const trimmed = userMessage.trim();
	if (!trimmed) return [trimmed];

	const symbols = trimmed.match(SYMBOL_REGEX);
	const seen = new Set<string>();
	const variants: string[] = [];

	// Always include original
	variants.push(trimmed);
	seen.add(trimmed);

	// Code-style variant: emphasize symbols and code-search intent
	if (symbols && symbols.length > 0) {
		const codeStyle = symbols.join(" ") + " implementation definition";
		if (!seen.has(codeStyle)) {
			variants.push(codeStyle);
			seen.add(codeStyle);
		}
	}

	return variants;
}
