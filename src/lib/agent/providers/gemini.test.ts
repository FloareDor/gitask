import { describe, it, expect } from "vitest";
import { toContents } from "./gemini";
import type { AgentMessage } from "../provider";

const call = { id: "call_123", name: "grep", args: { pattern: "redirect" } };

const exchange: AgentMessage[] = [
	{ role: "user", text: "how are redirects handled?" },
	{ role: "model", toolCalls: [call] },
	{ role: "tool", callId: "call_123", name: "grep", text: '{"hits":[]}' },
];

/** What the part types look like on the wire, minus the SDK's older typings. */
type WirePart = {
	text?: string;
	functionCall?: { name: string; args?: unknown; id?: string };
	functionResponse?: { id?: string; name: string };
	thoughtSignature?: string;
};
const partsOf = (content: { parts: unknown[] }) => content.parts as WirePart[];

describe("toContents", () => {
	it("sends tool results on a user turn — Gemini 3 dropped the function role", () => {
		const contents = toContents(exchange, new Map());
		const result = contents[2];
		expect(result.role).toBe("user");
		expect(partsOf(result)[0].functionResponse?.name).toBe("grep");
	});

	it("never emits a function role for any message", () => {
		const roles = toContents(exchange, new Map()).map((c) => c.role);
		expect(roles).not.toContain("function");
	});

	it("echoes the thought signature back with the call that earned it", () => {
		const contents = toContents(exchange, new Map([["call_123", "sig-abc"]]));
		const part = partsOf(contents[1])[0];
		expect(part.thoughtSignature).toBe("sig-abc");
		// The id has to ride along too, or the response can't be matched to it.
		expect(part.functionCall?.id).toBe("call_123");
	});

	it("omits the signature when there isn't one, rather than sending undefined", () => {
		const part = partsOf(toContents(exchange, new Map())[1])[0];
		expect("thoughtSignature" in part).toBe(false);
	});

	it("still gives a model turn with no text or calls a part to hold", () => {
		const contents = toContents([{ role: "model" }], new Map());
		expect(partsOf(contents[0])).toHaveLength(1);
	});
});
