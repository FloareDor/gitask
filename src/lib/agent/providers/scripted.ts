/**
 * A provider that replays canned replies instead of calling a model.
 *
 * Lets the loop's hard rules — step cap, duplicate detection, context budget,
 * forced answer, citation retry — be tested deterministically and without a key.
 */

import type {
	AgentMessage,
	CallOptions,
	ProviderReply,
	ToolCall,
	ToolProvider,
} from "../provider";

export interface ScriptedTurn {
	text?: string;
	toolCalls?: ToolCall[];
	tokensIn?: number;
	tokensOut?: number;
}

export interface ScriptedProvider extends ToolProvider {
	/** Every call the loop made, for assertions about what it sent. */
	readonly calls: Array<{ messages: AgentMessage[]; options: CallOptions }>;
}

/** Shorthand for a tool call in a script. */
export function call(name: string, args: Record<string, unknown> = {}): ToolCall {
	return { id: `${name}-${JSON.stringify(args)}`, name, args };
}

/**
 * `turns` are replayed in order. A function turn can branch on what the loop
 * sent, which is how "keep calling the same tool forever" is scripted.
 */
export function scriptedProvider(
	turns: Array<ScriptedTurn | ((messages: AgentMessage[], options: CallOptions) => ScriptedTurn)>
): ScriptedProvider {
	const calls: Array<{ messages: AgentMessage[]; options: CallOptions }> = [];
	let index = 0;

	return {
		id: "scripted",
		calls,
		async callWithTools(messages, options): Promise<ProviderReply> {
			calls.push({ messages: [...messages], options });

			// The last turn repeats, so a script doesn't have to spell out every
			// step of a loop-detection test.
			const turn = turns[Math.min(index, turns.length - 1)];
			index++;
			if (!turn) throw new Error("scriptedProvider was given no turns.");

			const resolved = typeof turn === "function" ? turn(messages, options) : turn;
			return {
				text: resolved.text ?? "",
				toolCalls: resolved.toolCalls ?? [],
				tokensIn: resolved.tokensIn,
				tokensOut: resolved.tokensOut,
			};
		},
	};
}
