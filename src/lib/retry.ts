/**
 * Retry for transient provider failures.
 *
 * A rate-limited call is not a wrong answer. Letting a 429 surface as an error
 * would score it as one, quietly penalising whichever arm happened to be
 * running when the quota ran out — so both the agent provider and the eval's
 * one-shot calls go through this.
 */

/** 429 and 503 are what free-tier keys hand out; the rest are their wordings. */
export function isTransientProviderError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b(429|500|503)\b|rate.?limit|quota|overloaded|unavailable|try again/i.test(message);
}

/**
 * Four tries became six after a provider spike emptied a whole re-run: the
 * backoff doubles, so this stretches the window a single call can survive from
 * about 28 seconds to about two minutes. It cannot ride out a sustained
 * outage - nothing can - but the spikes that actually show up are short.
 */
export const RETRY_ATTEMPTS = 5;
export const RETRY_BACKOFF_MS = 4000;

export async function withRetry<T>(
	fn: () => Promise<T>,
	attempts: number = RETRY_ATTEMPTS
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= attempts; attempt += 1) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (!isTransientProviderError(error) || attempt === attempts) break;
			await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * 2 ** attempt));
		}
	}
	throw lastError;
}
