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

function headers(token?: string): HeadersInit {
	const h: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

/**
 * Fetch the full recursive file tree for a repository.
 * Returns the default branch SHA + all blob entries.
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
	if (!repoRes.ok) throw new Error(`GitHub API error: ${repoRes.status} ${repoRes.statusText}`);
	const repoData = await repoRes.json();
	const defaultBranch: string = repoData.default_branch;

	// 2. Get the tree recursively
	const treeRes = await fetch(
		`${API_BASE}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
		{ headers: headers(token) }
	);
	if (!treeRes.ok) throw new Error(`GitHub Tree API error: ${treeRes.status}`);
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
		sha: repoData.sha || defaultBranch,
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
	token?: string
): Promise<string> {
	const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
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
