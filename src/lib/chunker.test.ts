/**
 * Tests for the code chunker — verifies AST fallback (text chunking)
 * and language detection.
 */

import { describe, it, expect } from "vitest";
import { CHUNKING_LIMITS, chunkByText, chunkCode, detectLanguage } from "./chunker";

describe("detectLanguage", () => {
	it("detects JavaScript", () => {
		expect(detectLanguage("app.js")).toBe("javascript");
		expect(detectLanguage("app.jsx")).toBe("javascript");
		expect(detectLanguage("utils.mjs")).toBe("javascript");
	});

	it("detects TypeScript", () => {
		expect(detectLanguage("index.ts")).toBe("typescript");
	});

	it("detects Python", () => {
		expect(detectLanguage("main.py")).toBe("python");
	});

	it("returns null for unknown extensions", () => {
		expect(detectLanguage("readme.md")).toBeNull();
		expect(detectLanguage("data.csv")).toBeNull();
	});
});

describe("chunkByText", () => {
	it("creates chunks from paragraphs", () => {
		const code = `First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.`;
		const chunks = chunkByText("test.md", code);

		// All paragraphs should fit in one chunk (under 2048 chars)
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		expect(chunks[0].filePath).toBe("test.md");
		expect(chunks[0].language).toBe("text");
		expect(chunks[0].code).toContain("First paragraph");
	});

	it("splits long content into multiple chunks", () => {
		// Create content that exceeds 2048 chars
		const para = "x".repeat(1500);
		const code = `${para}\n\n${para}`;
		const chunks = chunkByText("big.txt", code);

		expect(chunks.length).toBe(2);
	});

	it("handles empty input", () => {
		const chunks = chunkByText("empty.txt", "");
		expect(chunks.length).toBe(0);
	});

	it("never emits oversized chunks for huge single-line text", () => {
		const huge = "x".repeat(CHUNKING_LIMITS.MAX_CHUNK_CHARS * 2 + 123);
		const chunks = chunkByText("huge.txt", huge);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.code.length).toBeLessThanOrEqual(CHUNKING_LIMITS.MAX_CHUNK_CHARS);
		}
	});
});

describe("chunkCode", () => {
	it("uses text chunking for markdown files", () => {
		const code = "# Hello\n\nSome content\n\nMore content";
		const chunks = chunkCode("readme.md", code);
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		expect(chunks[0].nodeType).toBe("text_chunk");
	});

	it("preserves file paths and generates unique IDs", () => {
		const code = "const x = 1;\n\nconst y = 2;";
		const chunks = chunkCode("src/utils.js", code);

		for (const chunk of chunks) {
			expect(chunk.filePath).toBe("src/utils.js");
			expect(chunk.id).toContain("src/utils.js");
		}

		// IDs should be unique
		const ids = new Set(chunks.map((c) => c.id));
		expect(ids.size).toBe(chunks.length);
	});

	it("summarizes oversized json files with bounded samples", () => {
		const vocab = Array.from({ length: 5_000 }, (_, i) => `tok_${i}`);
		const json = JSON.stringify(vocab);
		const chunks = chunkCode("assets/vocab.json", json);

		expect(chunks.length).toBe(1);
		expect(chunks[0].nodeType).toBe("file_summary");
		expect(chunks[0].code).toContain("[LARGE_FILE_SUMMARY]");
		expect(chunks[0].code).toContain("known:");
		expect(chunks[0].code).toContain("inferred:");
		expect(chunks[0].code).toContain("unknown:");
		expect(chunks[0].code).toContain("evidence:");
		expect(chunks[0].code).toContain("\"head\"");
		expect(chunks[0].code.length).toBeLessThanOrEqual(CHUNKING_LIMITS.MAX_CHUNK_CHARS);
	});
});
