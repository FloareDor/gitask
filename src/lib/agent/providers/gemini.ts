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
import { GEMINI_MODEL, billedOutputTokens, withThinkingLevel } from "../../geminiModel";

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

/**
 * Two fields the pinned SDK's types predate.
 *
 * Gemini 3 puts an `id` on every function call and an opaque `thoughtSignature`
 * on the part that carries it. Both have to be echoed back exactly as they
 * arrived — replay a call without its signature and the next request is a 400
 * ("Function call is missing a thought_signature in functionCall parts").
 */
type ToolCallPart = Part & {
	functionCall: { name: string; args?: Record<string, unknown>; id?: string };
	thoughtSignature?: string;
};

function toolCallPart(toolCall: ToolCall, signature: string | undefined): Part {
	const part: ToolCallPart = {
		functionCall: { name: toolCall.name, args: toolCall.args, id: toolCall.id },
	};
	if (signature) part.thoughtSignature = signature;
	return part;
}

function toolResultPart(callId: string, name: string, text: string): Part {
	return {
		functionResponse: { id: callId, name, response: { result: text } },
	} as Part;
}

/**
 * Exported for tests: this is the translation most likely to break on a model
 * upgrade, and when it breaks it does so at runtime with a 400, not at compile
 * time. `signatures` maps a call id to the thought signature Gemini issued with
 * it.
 */
export function toContents(messages: AgentMessage[], signatures: Map<string, string>): Content[] {
	return messages.map((message): Content => {
		if (message.role === "user") {
			return { role: "user", parts: [{ text: message.text }] };
		}
		if (message.role === "tool") {
			// Gemini 3 dropped the `function` role ("Role 'function' is not
			// supported"), so results ride back on a user turn. They stay
			// functionResponse parts rather than text, which is what keeps the
			// model treating them as evidence instead of instructions.
			return {
				role: "user",
				parts: [toolResultPart(message.callId, message.name, message.text)],
			};
		}

		const parts: Part[] = [];
		if (message.text) parts.push({ text: message.text });
		for (const toolCall of message.toolCalls ?? []) {
			parts.push(toolCallPart(toolCall, signatures.get(toolCall.id)));
		}
		// Gemini rejects an empty parts array.
		if (parts.length === 0) parts.push({ text: "" });
		return { role: "model", parts };
	});
}

export function geminiProvider({ withKey, model = GEMINI_MODEL }: GeminiProviderOptions): ToolProvider {
	// Keyed by the id Gemini assigns each call, and only needed for the length of
	// one investigation — a provider is built per run.
	const signatures = new Map<string, string>();

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
					generationConfig: withThinkingLevel(),
				});

				// The SDK has no AbortSignal hook, so cancellation lands between calls,
				// not mid-flight. The loop checks the signal before every call.
				const { response } = await generativeModel.generateContent({
					contents: toContents(messages, signatures),
				});

				// Read the parts directly rather than via functionCalls(): the
				// signature lives on the part, not on the call, so this is the only
				// place both are in hand at once.
				const toolCalls: ToolCall[] = [];
				const parts = response.candidates?.[0]?.content?.parts ?? [];
				parts.forEach((rawPart, i) => {
					const part = rawPart as ToolCallPart;
					if (!part.functionCall) return;
					// Gemini 3 supplies an id; older models didn't, hence the fallback.
					const id = part.functionCall.id ?? `${part.functionCall.name}-${i}`;
					if (part.thoughtSignature) signatures.set(id, part.thoughtSignature);
					toolCalls.push({
						id,
						name: part.functionCall.name,
						args: (part.functionCall.args ?? {}) as Record<string, unknown>,
					});
				});

				// text() throws when the candidate is pure function calls.
				let text = "";
				try {
					text = response.text();
				} catch {
					text = "";
				}

				const usage = response.usageMetadata;
				return {
					text,
					toolCalls,
					tokensIn: usage?.promptTokenCount,
					tokensOut: billedOutputTokens(usage),
				};
			}));
		},
	};
}
