import { describe, it, expect } from "vitest";
import { billedOutputTokens, withThinkingLevel } from "./geminiModel";

describe("billedOutputTokens", () => {
	it("adds reasoning tokens to the visible ones", () => {
		expect(billedOutputTokens({ candidatesTokenCount: 24, thoughtsTokenCount: 44 })).toBe(68);
	});

	it("handles a response that did no thinking", () => {
		expect(billedOutputTokens({ candidatesTokenCount: 24 })).toBe(24);
	});

	it("treats missing usage as zero rather than NaN", () => {
		expect(billedOutputTokens(undefined)).toBe(0);
		expect(billedOutputTokens({})).toBe(0);
	});
});

describe("withThinkingLevel", () => {
	it("keeps the caller's config", () => {
		const config = withThinkingLevel({ temperature: 0, responseMimeType: "application/json" });
		expect(config.temperature).toBe(0);
		expect(config.responseMimeType).toBe("application/json");
	});

	it("pins a level the Flash models accept", () => {
		// "minimal" is rejected by 3.8 Flash, so the floor is "low".
		const thinking = (withThinkingLevel() as { thinkingConfig?: { thinkingLevel?: string } }).thinkingConfig;
		expect(thinking?.thinkingLevel).toBe("low");
	});
});
