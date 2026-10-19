import type { GenerationConfig } from "@google/generative-ai";

/**
 * The one Gemini model id.
 *
 * The eval's whole claim is that RAG and agent differ only in retrieval
 * strategy, so both arms and the judge have to be on the same model. Keeping
 * that as one constant means the claim can't quietly stop being true when
 * someone bumps a string in one file.
 *
 * gemini-2.5-flash was retired for new API keys ("no longer available to new
 * users") — it still shows up in ListModels but 404s on generateContent, so a
 * naive availability check passes and the actual call fails.
 */
export const GEMINI_MODEL = "gemini-3.8-flash";

/**
 * The shape we need out of `usageMetadata`. Declared structurally because the
 * pinned SDK (@google/generative-ai 0.24.1) predates Gemini 3 and its
 * `UsageMetadata` type has no `thoughtsTokenCount`, though the API sends one.
 */
interface GeminiUsage {
	candidatesTokenCount?: number;
	thoughtsTokenCount?: number;
}

/**
 * Output tokens we actually pay for.
 *
 * Gemini 3 reports reasoning tokens in their own field but bills them at the
 * output rate. Reading `candidatesTokenCount` alone undercounts, and it
 * undercounts the agent arm worst — it calls the model six to twelve times per
 * question where the RAG arm calls once — which would flatter exactly the arm
 * whose cost is the argument against it.
 */
export function billedOutputTokens(usage: GeminiUsage | undefined): number {
	return (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
}

/**
 * How hard the model thinks before answering.
 *
 * Gemini 3 reasons first and bills those tokens at the output rate. Left unset
 * the depth is undocumented and varies call to call, so token counts — and the
 * cost numbers built on them — stop being reproducible. Measured on 3.8 Flash,
 * an unpinned trivial call spent 44 thinking tokens against 24 visible ones.
 *
 * "low" is the floor, not a preference: 3.8 Flash rejects "minimal" outright
 * ("Thinking level MINIMAL is not supported for this model") and Flash models
 * can't turn thinking off altogether.
 */
const THINKING_LEVEL = "low";

/**
 * Adds the thinking level to a generation config.
 *
 * Cast because the pinned SDK (0.24.1) predates the field — it forwards it to
 * the API regardless, which is verified by the thought count dropping to zero.
 */
export function withThinkingLevel(config: GenerationConfig = {}): GenerationConfig {
	return { ...config, thinkingConfig: { thinkingLevel: THINKING_LEVEL } } as GenerationConfig;
}
