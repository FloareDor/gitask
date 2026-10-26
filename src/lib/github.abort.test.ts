import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchFileContent, fetchRepoTree, isAbortError } from "./github";

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

describe("fetchRepoTree ref resolution", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubGitHub() {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url);
				const json = (body: unknown) =>
					new Response(JSON.stringify(body), { status: 200 });
				if (url.endsWith("/repos/o/r")) return json({ default_branch: "main" });
				if (url.includes("/commits/")) {
					return json({ sha: "commit123", commit: { tree: { sha: "tree456" } } });
				}
				if (url.includes("/git/trees/")) {
					return json({ tree: [{ type: "blob", path: "a.ts", size: 1, sha: "s", url: "u" }], truncated: false });
				}
				return new Response("not found", { status: 404 });
			})
		);
		return calls;
	}

	it("resolves the default branch when no ref is given", async () => {
		const calls = stubGitHub();
		const tree = await fetchRepoTree("o", "r");
		expect(tree.sha).toBe("commit123");
		expect(calls[0]).toMatch(/\/repos\/o\/r$/);
		expect(calls[1]).toContain("/commits/main");
		expect(calls[2]).toContain("/git/trees/tree456");
	});

	it("skips the default branch lookup when a ref is pinned", async () => {
		const calls = stubGitHub();
		const tree = await fetchRepoTree("o", "r", undefined, undefined, "abc123");
		expect(tree.sha).toBe("commit123");
		expect(tree.files.map((f) => f.path)).toEqual(["a.ts"]);
		expect(calls[0]).toContain("/commits/abc123");
		expect(calls.some((u) => u.endsWith("/repos/o/r"))).toBe(false);
	});
});
