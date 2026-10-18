/**
 * Gemini function calling, called straight from the browser with the user's key
 * (same shape as the Groq path in `llm.ts` — keys stay in the BYOK vault and
 * never reach our server).
 *
 * This file is the only place that knows Gemini's wire format. Everything the
 * loop sees is `provider.ts`.
 */

import {
	GoogleGenerativeAI,
	type Content,
	type FunctionDeclaration,
	type Part,
} from "@google/generative-ai";
import type {
	AgentMessage,
	CallOptions,
	ProviderReply,
	ToolCall,
	ToolProvider,
	ToolSchema,
} from "../provider";
import { withRetry } from "../../retry";

export const GEMINI_AGENT_MODEL = "gemini-2.5-flash";

/**
 * Runs `fn` with a decrypted key in scope. Vault-backed keys are only readable
 * inside such a scope, so the provider borrows the key per call rather than
 * holding one.
 */
export type KeyScope = <T>(fn: (apiKey: string) => Promise<T>) => Promise<T>;

/** A scope over a key we already have in hand — devtools, evals, tests. */
export function staticKeyScope(apiKey: string): KeyScope {
	return (fn) => fn(apiKey);
}

export interface GeminiProviderOptions {
	withKey: KeyScope;
	model?: string;
}

/**
 * Gemini's FunctionDeclaration is JSON Schema with a narrower type enum, and our
 * schemas already use its lowercase spellings ("object", "string", "number").
 */
function toDeclaration(tool: ToolSchema): FunctionDeclaration {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown as FunctionDeclaration["parameters"],
	};
}

function toContents(messages: AgentMessage[]): Content[] {
	return messages.map((message): Content => {
		if (message.role === "user") {
			return { role: "user", parts: [{ text: message.text }] };
		}
		if (message.role === "tool") {
			// Results go back as `function` role, not as user text, so the model
			// treats them as evidence rather than instructions.
			return {
				role: "function",
				parts: [
					{ functionResponse: { name: message.name, response: { result: message.text } } },
				],
			};
		}

		const parts: Part[] = [];
		if (message.text) parts.push({ text: message.text });
		for (const toolCall of message.toolCalls ?? []) {
			parts.push({ functionCall: { name: toolCall.name, args: toolCall.args } });
		}
		// Gemini rejects an empty parts array.
		if (parts.length === 0) parts.push({ text: "" });
		return { role: "model", parts };
	});
}

export function geminiProvider({ withKey, model = GEMINI_AGENT_MODEL }: GeminiProviderOptions): ToolProvider {
	return {
		id: "gemini",
		callWithTools(messages: AgentMessage[], options: CallOptions): Promise<ProviderReply> {
			const { system, tools } = options;
			// A rate-limited step would otherwise end the whole investigation.
			return withRetry(() => withKey(async (apiKey) => {
				const generativeModel = new GoogleGenerativeAI(apiKey).getGenerativeModel({
					model,
					systemInstruction: system,
					// No tools at all is how the loop says "answer now"; passing an
					// empty declarations array would be rejected.
					...(tools.length > 0
						? { tools: [{ functionDeclarations: tools.map(toDeclaration) }] }
						: {}),
				});

				// The SDK has no AbortSignal hook, so cancellation lands between calls,
				// not mid-flight. The loop checks the signal before every call.
				const { response } = await generativeModel.generateContent({
					contents: toContents(messages),
				});

				const toolCalls: ToolCall[] = (response.functionCalls() ?? []).map((fc, i) => ({
					id: `${fc.name}-${i}`,
					name: fc.name,
					args: (fc.args ?? {}) as Record<string, unknown>,
				}));

				// text() throws when the candidate is pure function calls.
				let text = "";
				try {
					text = response.text();
				} catch {
					text = "";
				}

				return {
					text,
					toolCalls,
					tokensIn: response.usageMetadata?.promptTokenCount,
					tokensOut: response.usageMetadata?.candidatesTokenCount,
				};
			}));
		},
	};
}
