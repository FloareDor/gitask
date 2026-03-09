import { describe, expect, it } from "vitest";

import {
	buildChatRequestMessages,
	getChatHistoryLimit,
	normalizeGeminiHistory,
	prepareGeminiChat,
} from "./chatHistory";

describe("buildChatRequestMessages", () => {
	it("includes previous chat turns instead of only the latest prompt", () => {
		const messages = buildChatRequestMessages({
			provider: "gemini",
			systemPrompt: "system rules",
			priorMessages: [
				{ role: "user", content: "first question" },
				{ role: "assistant", content: "first answer" },
				{ role: "user", content: "follow-up" },
				{ role: "assistant", content: "follow-up answer" },
			],
			userMessage: "latest question",
		});

		expect(messages).toEqual([
			{ role: "system", content: "system rules" },
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "follow-up" },
			{ role: "assistant", content: "follow-up answer" },
			{ role: "user", content: "latest question" },
		]);
	});

	it("caps the forwarded history window by provider", () => {
		const priorMessages = Array.from({ length: 20 }, (_, index) => ({
			role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `msg-${index + 1}`,
		}));

		const mlcMessages = buildChatRequestMessages({
			provider: "mlc",
			systemPrompt: "system rules",
			priorMessages,
			userMessage: "latest question",
		});
		const geminiMessages = buildChatRequestMessages({
			provider: "gemini",
			systemPrompt: "system rules",
			priorMessages,
			userMessage: "latest question",
		});

		expect(getChatHistoryLimit("mlc")).toBe(6);
		expect(getChatHistoryLimit("gemini")).toBe(10);
		expect(mlcMessages.slice(1, -1).map((message) => message.content)).toEqual([
			"msg-15",
			"msg-16",
			"msg-17",
			"msg-18",
			"msg-19",
			"msg-20",
		]);
		expect(geminiMessages.slice(1, -1).map((message) => message.content)).toEqual([
			"msg-11",
			"msg-12",
			"msg-13",
			"msg-14",
			"msg-15",
			"msg-16",
			"msg-17",
			"msg-18",
			"msg-19",
			"msg-20",
		]);
	});
});

describe("normalizeGeminiHistory", () => {
	it("merges consecutive turns and removes invalid leading and trailing model turns", () => {
		const normalized = normalizeGeminiHistory([
			{ role: "model", parts: [{ text: "preface" }] },
			{ role: "user", parts: [{ text: "question one" }] },
			{ role: "user", parts: [{ text: "question two" }] },
			{ role: "model", parts: [{ text: "answer one" }] },
			{ role: "model", parts: [{ text: "answer two" }] },
		]);

		expect(normalized).toEqual([
			{ role: "user", parts: [{ text: "question one\n\nquestion two" }] },
		]);
	});
});

describe("prepareGeminiChat", () => {
	it("preserves prior turns as Gemini chat history and uses the latest user turn as the prompt", () => {
		const prepared = prepareGeminiChat([
			{ role: "system", content: "system rules" },
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "latest question" },
		]);

		expect(prepared.history).toEqual([
			{
				role: "user",
				parts: [{ text: "system rules\n\n---\n\nfirst question" }],
			},
			{
				role: "model",
				parts: [{ text: "first answer" }],
			},
		]);
		expect(prepared.prompt).toBe("latest question");
	});
});
