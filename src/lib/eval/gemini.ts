/**
 * One plain Flash call, with the token counts.
 *
 * The eval deliberately talks to Gemini directly instead of going through
 * `llm.ts`: both arms then use the same SDK, the same model id and the same
 * temperature, and both report real `usageMetadata` rather than an estimate.
 * The prompt the RAG arm sends is still the app's — see `lib/ragAnswer.ts`.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { KeyScope } from "../agent/providers/gemini";
import { GEMINI_MODEL, billedOutputTokens, withThinkingLevel } from "../geminiModel";
import { withRetry } from "../retry";

export interface OneShotResult {
	text: string;
	tokensIn: number;
	tokensOut: number;
}

export interface OneShotOptions {
	system?: string;
	prompt: string;
	model?: string;
	/** Ask for JSON back. Used by the judge. */
	json?: boolean;
}

export async function geminiOneShot(withKey: KeyScope, options: OneShotOptions): Promise<OneShotResult> {
	return withRetry(() => withKey(async (apiKey) => {
		const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
			model: options.model ?? GEMINI_MODEL,
			systemInstruction: options.system,
			generationConfig: withThinkingLevel({
				temperature: 0,
				...(options.json ? { responseMimeType: "application/json" } : {}),
			}),
		});
		const { response } = await model.generateContent(options.prompt);
		const usage = response.usageMetadata;
		return {
			text: response.text(),
			tokensIn: usage?.promptTokenCount ?? 0,
			tokensOut: billedOutputTokens(usage),
		};
	}));
}
