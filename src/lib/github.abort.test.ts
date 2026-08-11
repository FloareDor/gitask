import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchFileContent, isAbortError } from "./github";

describe("isAbortError", () => {
	it("detects DOMException AbortError", () => {
		expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
	});

	it("detects Error with AbortError name", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(isAbortError(err)).toBe(true);
	});

	it("ignores unrelated errors", () => {
		expect(isAbortError(new Error("boom"))).toBe(false);
		expect(isAbortError("abort")).toBe(false);
		expect(isAbortError(null)).toBe(false);
	});
});

describe("fetchFileContent abort signal", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("propagates AbortError when the external signal aborts", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("missing signal"));
						return;
					}
					if (signal.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					signal.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			})
		);

		const pending = fetchFileContent(
			"owner",
			"repo",
			"src/index.ts",
			undefined,
			"HEAD",
			controller.signal
		);
		controller.abort();
		await expect(pending).rejects.toSatisfy(isAbortError);
	});
});
