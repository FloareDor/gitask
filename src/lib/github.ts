/**
 * GitHub API client for fetching repository contents.
 *
 * Uses the Git Trees API to get the full file list in one request,
 * then fetches individual file contents on demand.
 */

const API_BASE = "https://api.github.com";
const RAW_FILE_FETCH_TIMEOUT_MS = 20_000;

export interface RepoFile {
	path: string;
	size: number;
	sha: string;
	url: string;
}

export interface TreeResponse {
	sha: string;
	files: RepoFile[];
	truncated: boolean;
}

/** File change entry from GitHub Compare API (base...head). */
export interface CompareFileEntry {
	filename: string;
	status: "added" | "removed" | "modified" | "renamed";
	previous_filename?: string;
}

/** Result of comparing two commits. Note: API returns at most 300 files on first page. */
export interface CompareCommitsResult {
	files: CompareFileEntry[];
}

async function readGitHubErrorMessage(res: Response): Promise<string> {
	try {
		const data = await res.json();
		if (data && typeof data.message === "string" && data.message.trim().length > 0) {
			return data.message;
		}
	} catch {
		// Ignore JSON parsing failures and fall back to status text.
	}
	return res.statusText || "Unknown GitHub API error";
}

function privateRepoGuidance(owner: string, repo: string): string {
	return `repo not found. is it private? add a GitHub token to access it.`;
}

function headers(token?: string): HeadersInit {
	const h: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

/** True when a fetch/DOM abort was caused by an AbortSignal. */
export function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

/**
 * Combine an optional external AbortSignal with a timeout controller.
 * Returns the signal to pass to fetch and a cleanup function.
 */
function combineAbortSignals(
	external: AbortSignal | undefined,
	timeoutController: AbortController
): { signal: AbortSignal; cleanup: () => void } {
	if (!external) {
		return { signal: timeoutController.signal, cleanup: () => undefined };
	}
	if (typeof AbortSignal.any === "function") {
		return {
			signal: AbortSignal.any([external, timeoutController.signal]),
			cleanup: () => undefined,
		};
	}
	const combined = new AbortController();
	const onAbort = () => {
		if (!combined.signal.aborted) combined.abort();
	};
	if (external.aborted || timeoutController.signal.aborted) {
		combined.abort();
		return { signal: combined.signal, cleanup: () => undefined };
	}
	external.addEventListener("abort", onAbort);
	timeoutController.signal.addEventListener("abort", onAbort);
	return {
		signal: combined.signal,
		cleanup: () => {
			external.removeEventListener("abort", onAbort);
			timeoutController.signal.removeEventListener("abort", onAbort);
		},
	};
}

/** Translate a failed GitHub response into a user-facing error. */
async function throwGitHubError(res: Response, owner: string, repo: string): Promise<never> {
	const details = await readGitHubErrorMessage(res);
	if (res.status === 404) {
		throw new Error(privateRepoGuidance(owner, repo));
	}
	if (res.status === 401) {
		throw new Error(`GitHub token was rejected. Update it in "GH Token" and try again.`);
	}
	if (res.status === 403) {
		throw new Error(`GitHub access denied. You may be rate-limited. Add a token in "GH Token" and try again.`);
	}
	throw new Error(`GitHub error (${res.status}): ${details}`);
}

async function fetchDefaultBranch(
	owner: string,
	repo: string,
	token?: string,
	signal?: AbortSignal
): Promise<string> {
	const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, {
		headers: headers(token),
		signal,
	});
	if (!res.ok) await throwGitHubError(res, owner, repo);
	const data = await res.json();
	return data.default_branch as string;
}

/**
 * Fetch the full recursive file tree for a repository.
 *
 * `ref` may be a branch, tag, or commit SHA. When omitted the default branch
 * HEAD is used. The returned `sha` is always the resolved commit SHA so the
 * snapshot is stable even when `ref` is a moving branch.
 */
export async function fetchRepoTree(
	owner: string,
	repo: string,
	token?: string,
	signal?: AbortSignal,
	ref?: string
): Promise<TreeResponse> {
	const target = ref || (await fetchDefaultBranch(owner, repo, token, signal));

	// 1. Resolve the ref to a commit so we index an exact snapshot.
	const commitRes = await fetch(
		`${API_BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(target)}`,
		{ headers: headers(token), signal }
	);
	if (!commitRes.ok) await throwGitHubError(commitRes, owner, repo);
	const commitData = await commitRes.json();
	const commitSha =
		typeof commitData?.sha === "string" && commitData.sha.length > 0
			? (commitData.sha as string)
			: target;
	const treeSha =
		typeof commitData?.commit?.tree?.sha === "string" &&
		commitData.commit.tree.sha.length > 0
			? (commitData.commit.tree.sha as string)
			: commitSha;

	// 2. Get the tree recursively for that exact commit tree.
	const treeRes = await fetch(
		`${API_BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
		{ headers: headers(token), signal }
	);
	if (!treeRes.ok) await throwGitHubError(treeRes, owner, repo);
	const treeData = await treeRes.json();

	const files: RepoFile[] = (treeData.tree as any[])
		.filter((item) => item.type === "blob")
		.map((item) => ({
			path: item.path as string,
			size: (item.size ?? 0) as number,
			sha: item.sha as string,
			url: item.url as string,
		}));

	return {
		// Commit SHA pins the exact snapshot used for indexing/cache identity.
		sha: commitSha,
		files,
		truncated: treeData.truncated ?? false,
	};
}

/**
 * Compare two commits to get the list of changed files.
 * Uses GET /repos/:owner/:repo/compare/:base...:head.
 * Returns at most 300 files; for larger diffs the caller should fall back to full re-index.
 */
export async function compareCommits(
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
	token?: string,
	signal?: AbortSignal
): Promise<CompareCommitsResult> {
	const res = await fetch(
		`${API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
		{ headers: headers(token), signal }
	);
	if (!res.ok) {
		const details = await readGitHubErrorMessage(res);
		if (res.status === 404) {
			throw new Error(`Couldn't compare commits. One of the SHAs may be invalid.`);
		}
		if (res.status === 401) {
			throw new Error(`GitHub token was rejected. Update it in "GH Token" and try again.`);
		}
		if (res.status === 403) {
			throw new Error(`GitHub access denied. You may be rate-limited. Add a token in "GH Token" and try again.`);
		}
		throw new Error(`GitHub error (${res.status}): ${details}`);
	}
	const data = (await res.json()) as { files?: Array<{ filename?: string; status?: string; previous_filename?: string }> };
	const rawFiles = data?.files ?? [];
	const files: CompareFileEntry[] = rawFiles
		.filter((f) => f?.filename && f?.status)
		.map((f) => ({
			filename: f.filename as string,
			status: f.status as CompareFileEntry["status"],
			...(f.previous_filename && { previous_filename: f.previous_filename }),
		}));
	return { files };
}

/** File extensions we want to index (code + docs). */
const INDEXABLE_EXTENSIONS = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs",
	"py", "rs", "go", "java", "c", "cpp", "h", "hpp",
	"md", "mdx", "txt", "json", "yaml", "yml", "toml",
	"css", "scss", "html", "vue", "svelte",
]);

/** Check if a file path is worth indexing. */
export function isIndexable(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	// Skip common non-code dirs
	if (
		path.startsWith("node_modules/") ||
		path.startsWith(".git/") ||
		path.startsWith("dist/") ||
		path.startsWith("build/") ||
		path.includes("__pycache__/")
	) {
		return false;
	}
	return INDEXABLE_EXTENSIONS.has(ext);
}

/**
 * Fetch raw file content from GitHub.
 * Uses the raw content URL for efficiency.
 */
export async function fetchFileContent(
	owner: string,
	repo: string,
	path: string,
	token?: string,
	ref: string = "HEAD",
	signal?: AbortSignal
): Promise<string> {
	const encodedPath = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${encodedPath}`;
	const timeoutController = new AbortController();
	const timeoutId = setTimeout(() => timeoutController.abort(), RAW_FILE_FETCH_TIMEOUT_MS);
	const { signal: fetchSignal, cleanup } = combineAbortSignals(signal, timeoutController);
	try {
		const res = await fetch(url, {
			headers: headers(token),
			signal: fetchSignal,
		});
		if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
		return res.text();
	} catch (e) {
		if (isAbortError(e)) {
			// External cancel should propagate as AbortError so callers can stop indexing.
			if (signal?.aborted) throw e;
			throw new Error(
				`Timed out fetching ${path}. Check your connection and try again.`
			);
		}
		throw e;
	} finally {
		clearTimeout(timeoutId);
		cleanup();
	}
}

/**
 * Prioritise files for lazy-loading: README first, then src/, then rest.
 */
export function prioritiseFiles(files: RepoFile[]): RepoFile[] {
	const readme: RepoFile[] = [];
	const src: RepoFile[] = [];
	const rest: RepoFile[] = [];

	for (const f of files) {
		const lower = f.path.toLowerCase();
		if (lower === "readme.md" || lower === "readme") {
			readme.push(f);
		} else if (lower.startsWith("src/") || lower.startsWith("lib/")) {
			src.push(f);
		} else {
			rest.push(f);
		}
	}

	return [...readme, ...src, ...rest];
}
