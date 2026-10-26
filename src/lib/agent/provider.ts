/**
 * Provider adapter — the only thing the agent loop knows about an LLM.
 *
 * The loop speaks this shape; `providers/gemini.ts` translates it to Gemini
 * function calling and `providers/scripted.ts` fakes it for tests. Swapping in
 * a local model later is a new file here, not a change to the loop.
 */

export interface ToolSchema {
	name: string;
	description: string;
	/** JSON Schema for the arguments object. */
	parameters: Record<string, unknown>;
}

export interface ToolCall {
	/** Correlates a call with its result. Providers that don't supply one get a synthetic id. */
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export type AgentMessage =
	| { role: "user"; text: string }
	| { role: "model"; text?: string; toolCalls?: ToolCall[] }
	| { role: "tool"; callId: string; name: string; text: string };

export interface ProviderReply {
	text: string;
	toolCalls: ToolCall[];
	tokensIn?: number;
	tokensOut?: number;
}

export interface CallOptions {
	system: string;
	/** Empty means "answer now" — this is how the loop forces a final answer. */
	tools: ToolSchema[];
	signal?: AbortSignal;
}

export interface ToolProvider {
	/** Shows up in traces and metrics. */
	readonly id: string;
	callWithTools(messages: AgentMessage[], options: CallOptions): Promise<ProviderReply>;
}
