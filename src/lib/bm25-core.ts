/**
 * BM25 core scoring utilities shared by main-thread and worker retrieval.
 */

export interface BM25Doc {
	id: string;
	text: string;
}

export interface BM25ScoreOptions {
	limit?: number;
	k1?: number;
	b?: number;
}

export interface NormalizedBM25Options {
	limit: number;
	k1: number;
	b: number;
}

export interface BM25Index {
	docIds: string[];
	docLengths: number[];
	avgDocLength: number;
	docFreq: Map<string, number>;
	termFreqByDoc: Array<Map<string, number>>;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

const TOKEN_STOP_WORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "must", "shall", "can", "cannot",
	"this", "that", "these", "those", "it", "its",
	"what", "which", "who", "whom", "whose", "when", "where", "why", "how",
	"and", "or", "but", "not", "nor", "so", "yet", "for", "in", "on", "at",
	"to", "from", "of", "with", "by", "about", "into", "through", "during",
	"i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
	"she", "her", "they", "them", "their", "there", "here",
	"any", "all", "some", "no", "few", "more", "most", "other", "such",
	"only", "own", "same", "than", "too", "very", "just", "get", "got",
	"use", "used", "using", "make", "made", "like", "also", "then", "than",
	"out", "up", "over", "after", "before", "between", "each", "both",
	"if", "as", "until", "while", "because", "though", "although",
	"tell", "show", "give", "find", "know", "see", "look", "say",
	"go", "put", "set", "let", "try", "help", "need", "want", "code",
	"file", "line", "add", "new", "old", "run", "work",
]);

function normalizeBM25Options(options: BM25ScoreOptions = {}): NormalizedBM25Options {
	return {
		limit: Math.max(1, options.limit ?? DEFAULT_LIMIT),
		k1: Math.max(0.1, options.k1 ?? DEFAULT_K1),
		b: Math.min(1, Math.max(0, options.b ?? DEFAULT_B)),
	};
}

function isSignalToken(token: string): boolean {
	if (token.length < 2) return false;
	return !TOKEN_STOP_WORDS.has(token);
}

function pushTokenIfSignal(bucket: string[], token: string): void {
	const normalized = token.toLowerCase();
	if (!isSignalToken(normalized)) return;
	bucket.push(normalized);
}

function splitIdentifierParts(token: string): string[] {
	return token
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.split(/[_\s]+/)
		.filter(Boolean);
}

/**
 * Tokenizer that preserves code identifiers while still breaking camelCase and snake_case.
 */
export function tokenizeForCodeSearch(text: string): string[] {
	const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? [];
	const tokens: string[] = [];

	for (const token of raw) {
		const normalizedToken = token.toLowerCase();
		pushTokenIfSignal(tokens, token);
		const parts = splitIdentifierParts(token);
		for (const part of parts) {
			// Skip parts that are identical to the whole token to avoid double-counting
			// plain single-word tokens (e.g. "vector" → splitIdentifierParts → ["vector"])
			if (part.toLowerCase() !== normalizedToken) {
				pushTokenIfSignal(tokens, part);
			}
		}
	}

	return tokens;
}

function countTerms(tokens: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) {
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return counts;
}

export function buildBM25Index(docs: BM25Doc[]): BM25Index {
	const docIds: string[] = [];
	const docLengths: number[] = [];
	const docFreq = new Map<string, number>();
	const termFreqByDoc: Array<Map<string, number>> = [];

	let totalDocLength = 0;

	for (const doc of docs) {
		docIds.push(doc.id);
		const tokens = tokenizeForCodeSearch(doc.text);
		const termFreq = countTerms(tokens);
		termFreqByDoc.push(termFreq);

		const docLength = tokens.length;
		docLengths.push(docLength);
		totalDocLength += docLength;

		for (const term of new Set(termFreq.keys())) {
			docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
		}
	}

	return {
		docIds,
		docLengths,
		avgDocLength: docs.length > 0 ? totalDocLength / docs.length : 0,
		docFreq,
		termFreqByDoc,
	};
}

export function scoreBM25Index(
	index: BM25Index,
	query: string,
	options: BM25ScoreOptions = {}
): Array<[string, number]> {
	if (index.docIds.length === 0) return [];
	const normalized = normalizeBM25Options(options);
	const queryTerms = countTerms(tokenizeForCodeSearch(query));
	if (queryTerms.size === 0) return [];

	const docCount = index.docIds.length;
	const avgDocLength = index.avgDocLength > 0 ? index.avgDocLength : 1;
	const scores: Array<[string, number]> = [];

	for (let docIdx = 0; docIdx < docCount; docIdx++) {
		const termFreq = index.termFreqByDoc[docIdx];
		const docLength = index.docLengths[docIdx];
		let score = 0;

		for (const [term, queryTermFreq] of queryTerms.entries()) {
			const tf = termFreq.get(term) ?? 0;
			if (tf === 0) continue;

			const df = index.docFreq.get(term) ?? 0;
			if (df === 0) continue;

			// BM25 idf variant with +1 inside log for numerical stability.
			const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
			const norm = tf + normalized.k1 * (1 - normalized.b + normalized.b * (docLength / avgDocLength));
			const tfNorm = (tf * (normalized.k1 + 1)) / Math.max(norm, 1e-9);
			const queryWeight = 1 + Math.log1p(queryTermFreq);
			score += idf * tfNorm * queryWeight;
		}

		if (score > 0) {
			scores.push([index.docIds[docIdx], score]);
		}
	}

	scores.sort((a, b) => b[1] - a[1]);
	return scores.slice(0, normalized.limit);
}
