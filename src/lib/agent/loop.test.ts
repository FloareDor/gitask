/**
 * Tests for the agent loop. Every guard rail is driven through the scripted
 * provider, so none of this needs a key or a network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorStore } from "../vectorStore";
import type { EmbeddedChunk } from "../embedder";
import { runAgent, type AgentEvent } from "./loop";
import { call, scriptedProvider } from "./providers/scripted";

vi.mock("../embedder", () => ({
	embedText: vi.fn(() => Promise.resolve(new Array(384).fill(0.5))),
}));

vi.mock("../metrics", () => ({ recordAgent: vi.fn() }));

const AUTH = "export function signToken(user) {\n\treturn hash(user.id);\n}\n";

function makeStore(): VectorStore {
	const store = new VectorStore();
	const chunk: EmbeddedChunk = {
		id: "a",
		filePath: "src/auth.ts",
		language: "typescript",
		nodeType: "function_declaration",
		name: "signToken",
		code: AUTH,
		startLine: 1,
		endLine: 3,
		embedding: new Array(384).fill(0.5),
	};
	store.insert([chunk]);
	store.setFiles({ "src/auth.ts": AUTH });
	store.setGraph({ "src/auth.ts": { imports: [], definitions: ["signToken"] } });
	return store;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of gen) events.push(event);
	return events;
}

function answerOf(events: AgentEvent[]) {
	const answer = events.find((e) => e.type === "answer");
	if (!answer || answer.type !== "answer") throw new Error("no answer event");
	return answer;
}

let store: VectorStore;

beforeEach(() => {
	store = makeStore();
});

describe("runAgent", () => {
	it("runs a tool, feeds the result back, and emits a cited answer", async () => {
		const provider = scriptedProvider([
			{ text: "Looking it up.", toolCalls: [call("find_definition", { symbol: "signToken" })] },
			{ text: "Tokens are signed in src/auth.ts:1-3.", tokensIn: 100, tokensOut: 20 },
		]);

		const events = await collect(runAgent("where are tokens signed?", store, { provider }));
		const types = events.map((e) => e.type);
		expect(types).toEqual(["thinking", "tool_call", "tool_result", "answer"]);

		const result = events[2];
		expect(result.type === "tool_result" && result.text).toContain("src/auth.ts");

		const answer = answerOf(events);
		expect(answer.stopReason).toBe("answered");
		expect(answer.steps).toBe(1);
		expect(answer.citations).toEqual([{ path: "src/auth.ts", startLine: 1, endLine: 3 }]);
		expect(answer.toolBytes).toBeGreaterThan(0);

		// The tool result must reach the model, otherwise it is answering blind.
		const second = provider.calls[1].messages;
		expect(second.at(-1)).toMatchObject({ role: "tool", name: "find_definition" });
	});

	it("suppresses a repeated call instead of re-running it", async () => {
		const repeated = () => ({ toolCalls: [call("find_definition", { symbol: "signToken" })] });
		const provider = scriptedProvider([repeated, repeated, { text: "Done. src/auth.ts:1-3" }]);

		const events = await collect(runAgent("q", store, { provider, maxSteps: 5 }));
		const results = events.filter((e) => e.type === "tool_result");

		expect(results).toHaveLength(2);
		expect(results[0].type === "tool_result" && results[0].duplicate).toBe(false);
		expect(results[1].type === "tool_result" && results[1].duplicate).toBe(true);
		expect(results[1].type === "tool_result" && results[1].text).toContain("already ran this");
		// A suppressed call costs no context.
		expect(results[1].type === "tool_result" && results[1].bytes).toBe(0);
	});

	it("ignores argument order when detecting duplicates", async () => {
		const provider = scriptedProvider([
			{ toolCalls: [{ id: "1", name: "grep", args: { pattern: "hash", glob: "src/*.ts" } }] },
			{ toolCalls: [{ id: "2", name: "grep", args: { glob: "src/*.ts", pattern: "hash" } }] },
			{ text: "src/auth.ts:2-2" },
		]);

		const events = await collect(runAgent("q", store, { provider, maxSteps: 5 }));
		const results = events.filter((e) => e.type === "tool_result");
		expect(results[1].type === "tool_result" && results[1].duplicate).toBe(true);
	});

	it("stops at the step cap and forces an answer", async () => {
		let n = 0;
		const provider = scriptedProvider([
			() => ({ toolCalls: [call("grep", { pattern: `p${n++}` })] }),
		]);

		const events = await collect(runAgent("q", store, { provider, maxSteps: 3 }));
		const answer = answerOf(events);

		expect(answer.stopReason).toBe("step_cap");
		expect(answer.steps).toBe(3);
		expect(events.filter((e) => e.type === "tool_call")).toHaveLength(3);

		// The forced turn must offer no tools, or the model just keeps going.
		const forced = provider.calls.at(-1);
		expect(forced?.options.tools).toEqual([]);
		expect(forced?.messages.at(-1)).toMatchObject({ role: "user" });
	});

	it("takes the tools away once the context budget is spent", async () => {
		const provider = scriptedProvider([
			{ toolCalls: [call("read_file", { path: "src/auth.ts" })] },
			{ text: "src/auth.ts:1-3" },
		]);

		const events = await collect(
			runAgent("q", store, { provider, maxSteps: 8, maxContextBytes: 1 })
		);
		const answer = answerOf(events);

		expect(answer.stopReason).toBe("context_budget");
		expect(provider.calls[0].options.tools.length).toBeGreaterThan(0);
		expect(provider.calls[1].options.tools).toEqual([]);
	});

	it("asks once for citations when the answer has none", async () => {
		const provider = scriptedProvider([
			{ text: "Tokens are signed somewhere." },
			{ text: "Tokens are signed in src/auth.ts:1-3." },
		]);

		const events = await collect(runAgent("q", store, { provider }));
		const answer = answerOf(events);

		expect(answer.text).toContain("src/auth.ts:1-3");
		expect(answer.citations).toHaveLength(1);
		expect(provider.calls[1].messages.at(-1)).toMatchObject({
			role: "user",
			text: expect.stringContaining("no citations"),
		});
	});

	it("gives up after one citation retry rather than looping", async () => {
		const provider = scriptedProvider([{ text: "No idea, sorry." }]);

		const events = await collect(runAgent("q", store, { provider }));
		const answer = answerOf(events);

		expect(answer.citations).toEqual([]);
		expect(answer.text).toBe("No idea, sorry.");
		expect(provider.calls).toHaveLength(2);
	});

	it("hands a tool error back to the model instead of ending the run", async () => {
		const provider = scriptedProvider([
			{ toolCalls: [call("read_file", { path: "auth.ts" })] },
			{ text: "Found it at src/auth.ts:1-3." },
		]);

		const events = await collect(runAgent("q", store, { provider }));
		const result = events.find((e) => e.type === "tool_result");

		expect(result?.type === "tool_result" && result.isError).toBe(true);
		expect(result?.type === "tool_result" && result.text).toContain("Did you mean");
		expect(answerOf(events).stopReason).toBe("answered");
	});

	it("reports an unknown tool name as a recoverable error", async () => {
		const provider = scriptedProvider([
			{ toolCalls: [call("list_files")] },
			{ text: "src/auth.ts:1-3" },
		]);

		const events = await collect(runAgent("q", store, { provider }));
		const result = events.find((e) => e.type === "tool_result");
		expect(result?.type === "tool_result" && result.text).toContain('Unknown tool "list_files"');
	});

	it("emits an error event when the provider fails", async () => {
		const provider = {
			id: "broken",
			callWithTools: () => Promise.reject(new Error("429 rate limited")),
		};

		const events = await collect(runAgent("q", store, { provider }));
		expect(events).toEqual([{ type: "error", message: "429 rate limited" }]);
	});

	it("stops when the signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = scriptedProvider([{ text: "src/auth.ts:1-3" }]);

		const events = await collect(
			runAgent("q", store, { provider, signal: controller.signal })
		);
		expect(events).toEqual([{ type: "error", message: "Agent run cancelled." }]);
		expect(provider.calls).toHaveLength(0);
	});

	it("sums tokens across every provider call", async () => {
		const provider = scriptedProvider([
			{ toolCalls: [call("find_definition", { symbol: "signToken" })], tokensIn: 100, tokensOut: 10 },
			{ text: "src/auth.ts:1-3", tokensIn: 300, tokensOut: 50 },
		]);

		const answer = answerOf(await collect(runAgent("q", store, { provider })));
		expect(answer.tokensIn).toBe(400);
		expect(answer.tokensOut).toBe(60);
	});
});
