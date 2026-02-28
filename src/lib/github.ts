/**
 * GitHub API client for fetching repository contents.
 *
 * Uses the Git Trees API to get the full file list in one request,
 * then fetches individual file contents on demand.
 */

const API_BASE = "https://api.github.com";

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
	return `Repository "${owner}/${repo}" was not found. It may be private. Add a GitHub Personal Access Token in "GH Token" (with repository read access) and try again, or verify the owner/repo name.`;
}

function headers(token?: string): HeadersInit {
	const h: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

/**
 * Fetch the full recursive file tree for a repository.
 * Returns the default branch commit SHA + all blob entries for that commit tree.
 */
export async function fetchRepoTree(
	owner: string,
	repo: string,
	token?: string
): Promise<TreeResponse> {
	// 1. Get default branch SHA
	const repoRes = await fetch(`${API_BASE}/repos/${owner}/${repo}`, {
		headers: headers(token),
	});
	if (!repoRes.ok) {
		const details = await readGitHubErrorMessage(repoRes);
		if (repoRes.status === 404) {
			throw new Error(privateRepoGuidance(owner, repo));
		}
		if (repoRes.status === 401) {
			throw new Error(
				`GitHub token was rejected (401). Update your token in "GH Token" and try again.`
			);
		}
		if (repoRes.status === 403) {
			throw new Error(
				`GitHub API access was denied or rate-limited (403). Add a personal token in "GH Token" and try again.`
			);
		}
		throw new Error(`GitHub API error (${repoRes.status}): ${details}`);
	}
	const repoData = await repoRes.json();
	const defaultBranch: string = repoData.default_branch;

	// 2. Resolve the default branch HEAD commit for a stable snapshot.
	const commitRes = await fetch(
		`${API_BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}`,
		{ headers: headers(token) }
	);
	if (!commitRes.ok) {
		const details = await readGitHubErrorMessage(commitRes);
		if (commitRes.status === 404) {
			throw new Error(privateRepoGuidance(owner, repo));
		}
		if (commitRes.status === 401) {
			throw new Error(
				`GitHub token was rejected while reading repository commit (401). Update your token in "GH Token" and try again.`
			);
		}
		if (commitRes.status === 403) {
			throw new Error(
				`GitHub blocked commit access (403), often due to rate limits or missing permissions. Add a personal token in "GH Token" and try again.`
			);
		}
		throw new Error(`GitHub Commit API error (${commitRes.status}): ${details}`);
	}
	const commitData = await commitRes.json();
	const commitSha =
		typeof commitData?.sha === "string" && commitData.sha.length > 0
			? (commitData.sha as string)
			: defaultBranch;
	const treeSha =
		typeof commitData?.commit?.tree?.sha === "string" &&
		commitData.commit.tree.sha.length > 0
			? (commitData.commit.tree.sha as string)
			: commitSha;

	// 3. Get the tree recursively for that exact commit tree.
	const treeRes = await fetch(
		`${API_BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
		{ headers: headers(token) }
	);
	if (!treeRes.ok) {
		const details = await readGitHubErrorMessage(treeRes);
		if (treeRes.status === 404) {
			throw new Error(privateRepoGuidance(owner, repo));
		}
		if (treeRes.status === 401) {
			throw new Error(
				`GitHub token was rejected while reading repository tree (401). Update your token in "GH Token" and try again.`
			);
		}
		if (treeRes.status === 403) {
			throw new Error(
				`GitHub blocked tree access (403), often due to rate limits or missing permissions. Add a personal token in "GH Token" and try again.`
			);
		}
		throw new Error(`GitHub Tree API error (${treeRes.status}): ${details}`);
	}
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
	ref: string = "HEAD"
): Promise<string> {
	const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
	const res = await fetch(url, { headers: headers(token) });
	if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
	return res.text();
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
