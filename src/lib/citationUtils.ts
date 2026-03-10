import type { SearchResult } from "@/lib/vectorStore";

export const EVIDENCE_STOP_WORDS = new Set([
	"the", "a", "an", "and", "or", "but", "to", "for", "of", "in", "on", "at",
	"by", "with", "from", "is", "are", "was", "were", "be", "what", "which",
	"how", "does", "do", "did", "this", "that", "these", "those", "value",
	"values", "config", "configuration", "model", "models", "repo", "repository", "project",
	// conversational query words that are never meaningful code identifiers
	"all", "any", "some", "used", "use", "using", "again", "back", "tell",
	"show", "list", "get", "give", "also", "just", "still", "ever", "here",
]);

export function extractEvidenceTerms(query: string): string[] {
	const raw = query.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}/g) ?? [];
	const terms = raw
		.map((term) => term.trim())
		.filter((term) => term.length >= 3 && !EVIDENCE_STOP_WORDS.has(term));
	return [...new Set(terms)].slice(0, 12);
}

export function chunkContainsTerm(chunk: SearchResult["chunk"], term: string): boolean {
	const haystack = `${chunk.filePath}\n${chunk.code}`.toLowerCase();
	return haystack.includes(term);
}

export function buildGroundedCitationResults(
	results: SearchResult[],
	evidenceTerms: string[]
): SearchResult[] {
	const positive = results.filter((result) => result.score > 0);
	if (positive.length === 0) return [];
	if (evidenceTerms.length === 0) return positive;
	const matched = positive.filter((result) =>
		evidenceTerms.some((term) => chunkContainsTerm(result.chunk, term))
	);
	return matched.length > 0 ? matched : positive;
}

export function countTermHits(chunk: SearchResult["chunk"], terms: string[]): number {
	let hits = 0;
	for (const term of terms) {
		if (chunkContainsTerm(chunk, term)) hits++;
	}
	return hits;
}

export function buildCorrelatedCitationResults(
	results: SearchResult[],
	query: string,
	answer: string,
	excludedChunkIds?: Set<string>
): SearchResult[] {
	const positive = results.filter(
		(result) =>
			result.score > 0 &&
			(!excludedChunkIds || !excludedChunkIds.has(result.chunk.id))
	);
	if (positive.length === 0) return [];

	const queryTerms = extractEvidenceTerms(query);
	const answerTerms = extractEvidenceTerms(answer).slice(0, 18);
	const answerLower = answer.toLowerCase();

	const ranked = positive
		.map((result) => {
			const queryHits = countTermHits(result.chunk, queryTerms);
			const answerHits = countTermHits(result.chunk, answerTerms);
			const fileMentioned = answerLower.includes(result.chunk.filePath.toLowerCase());
			const correlation =
				answerHits * 3 +
				queryHits +
				(fileMentioned ? 4 : 0) +
				Math.min(2, result.score * 2);
			return { result, queryHits, answerHits, fileMentioned, correlation };
		})
		.filter(
			(item) =>
				item.fileMentioned ||
				item.answerHits > 0 ||
				(item.queryHits >= 2 && item.result.score >= 0.55)
		)
		.sort((a, b) => b.correlation - a.correlation || b.result.score - a.result.score)
		.map((item) => item.result);

	// Prefer no sources over weakly-related sources.
	return ranked.length > 0 ? ranked : [];
}

export function evaluateEvidenceCoverage(
	evidenceTerms: string[],
	results: SearchResult[]
): { matched: string[]; missing: string[]; maxScore: number } {
	if (evidenceTerms.length === 0 || results.length === 0) {
		return {
			matched: [],
			missing: evidenceTerms,
			maxScore: results[0]?.score ?? 0,
		};
	}
	const matched: string[] = [];
	const missing: string[] = [];
	for (const term of evidenceTerms) {
		const has = results.some((result) => chunkContainsTerm(result.chunk, term));
		if (has) matched.push(term);
		else missing.push(term);
	}
	const maxScore = results.reduce((max, result) => Math.max(max, result.score), 0);
	return { matched, missing, maxScore };
}
