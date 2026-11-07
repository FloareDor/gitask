/**
 * Graph expansion: pull in the chunks a retrieved file depends on.
 *
 * The hard part is resolving an import string to a file in the index, and the
 * resolver used to assume JavaScript. It appended `.ts`/`.js` extensions and
 * split module paths on `/`. A Python import arrives as `utils.helpers`, a
 * Rust one as `crate::utils::helpers`, a Go one as the full module path
 * `github.com/org/repo/utils/helpers` — none of which resolved, so expansion
 * returned its input unchanged on any non-JavaScript repository.
 *
 * The resolver below is language-aware in the two places it has to be:
 *
 * 1. **Separators.** Which character joins module segments depends on the
 *    *importing* file's language, which we always know. Python uses `.`,
 *    Rust `::`, everything else `/`.
 * 2. **Relative roots.** `./x` and `../x` in JS, leading dots in Python,
 *    `self::`/`super::` in Rust all mean "near me", with different arithmetic.
 *
 * Everything after that is language-agnostic, because files are indexed by
 * their *extension-less* path. Matching `src/utils/helpers` against
 * `src/utils/helpers.py` needs no table of extensions, which is what kept the
 * old version pinned to the six JavaScript ones.
 */

export interface GraphResolveFileData {
	allFiles: string[];
	normalizedFiles: string[];
	exactIndex: Map<string, number>;
	/**
	 * Extension-less path → indexes into `allFiles`.
	 *
	 * This is what makes the resolver work for languages nobody enumerated: the
	 * key for `src/utils/helpers.py` is `src/utils/helpers`, the same key a
	 * `.ts` or `.go` file of that name would get. A package's entry file is
	 * indexed under its directory too, so `utils.helpers` finds
	 * `src/utils/helpers/__init__.py`.
	 *
	 * Values are arrays because `a/b.ts` and `a/b.js` collide; first wins.
	 */
	moduleIndex: Map<string, number[]>;
}

export interface GraphExpansionStore {
	getAll(): Array<{ id: string; filePath: string }>;
	getGraph(): Record<string, { imports: string[]; definitions: string[] }>;
	getChunksByFile(filePath: string): Array<{ id: string }>;
	getResolveFileData?(): GraphResolveFileData;
}

export interface GraphExpansionOptions {
	seedCount?: number;
	expansionWeight?: number;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

/** The final extension of a path's basename, lowercased, without the dot. */
function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function stripExtension(path: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash + 1 ? path.slice(0, dot) : path;
}

/**
 * The file that speaks for its whole directory, per language.
 *
 * Keyed by extension rather than kept in one set because `lib` and `mod` only
 * mean "this package" in Rust — treating `src/foo/lib.ts` as `src/foo` would
 * hijack imports that `index.ts` should answer.
 */
const PACKAGE_ENTRY_BASENAMES: Record<string, readonly string[]> = {
	py: ["__init__"],
	rs: ["mod", "lib"],
	ts: ["index"],
	tsx: ["index"],
	js: ["index"],
	jsx: ["index"],
	mjs: ["index"],
	cjs: ["index"],
};

/**
 * Extensions a module path may carry that should also be tried without it.
 *
 * TypeScript sources import each other as `./x.js` under NodeNext, so the
 * request's extension and the file's extension genuinely differ.
 */
const STRIPPABLE_REQUEST_EXTENSIONS = new Set([
	"js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "go", "rs",
]);

export function buildResolveFileData(allFiles: string[]): GraphResolveFileData {
	const normalizedFiles = allFiles.map(normalizePath);
	const exactIndex = new Map<string, number>();
	const moduleIndex = new Map<string, number[]>();

	const addModuleKey = (key: string, index: number) => {
		if (!key) return;
		const existing = moduleIndex.get(key);
		if (existing) existing.push(index);
		else moduleIndex.set(key, [index]);
	};

	// A directory is a module in its own right — a Go package is exactly its
	// directory, and `pkg/__init__.py`, `mod.rs` and `index.ts` all stand in for
	// theirs. Collected separately so the entry file can be sorted to the front
	// of its directory's bucket before the keys are merged in.
	const directories = new Map<string, Array<{ index: number; isEntry: boolean; path: string }>>();

	for (let i = 0; i < normalizedFiles.length; i++) {
		const normalized = normalizedFiles[i];
		exactIndex.set(normalized, i);

		const withoutExtension = stripExtension(normalized);
		addModuleKey(withoutExtension, i);

		const slash = withoutExtension.lastIndexOf("/");
		if (slash <= 0) continue;
		const directory = withoutExtension.slice(0, slash);
		const basename = withoutExtension.slice(slash + 1);
		const entryNames = PACKAGE_ENTRY_BASENAMES[extensionOf(normalized)];

		const bucket = directories.get(directory);
		const member = { index: i, isEntry: entryNames?.includes(basename) ?? false, path: normalized };
		if (bucket) bucket.push(member);
		else directories.set(directory, [member]);
	}

	for (const [directory, members] of directories) {
		// Entry file first, then alphabetically — the resolver takes the first
		// hit, so the order has to be the same on every machine.
		members.sort((a, b) =>
			a.isEntry === b.isEntry ? a.path.localeCompare(b.path) : a.isEntry ? -1 : 1
		);
		// Appended, never prepended: a real file named `src/lib.ts` outranks the
		// contents of a sibling directory called `src/lib`.
		for (const member of members) addModuleKey(directory, member.index);
	}

	return { allFiles, normalizedFiles, exactIndex, moduleIndex };
}

interface ParsedModulePath {
	/** Path segments, already converted to a `/` world. */
	segments: string[];
	/**
	 * Directories to climb from the importing file's own directory, or `null`
	 * when the import is not relative at all.
	 */
	upLevels: number | null;
}

/**
 * Split an import string into segments, in the importing language's dialect.
 *
 * `language` here is the *importing* file's extension, which is the only
 * language signal available at this point — and the right one, since the
 * import string was written in that file.
 */
function parseModulePath(requested: string, language: string): ParsedModulePath {
	// Rust's extractor hands over raw `use` text, which can carry a brace group
	// (`use a::{b, c}`) or a glob. Everything after the first brace or star
	// names siblings under the same path, so the prefix is what we resolve.
	const cleaned = requested.split(/[{*]/)[0].replace(/::\s*$/, "").trim();

	// Dot-separated module paths: Python, and Java's package paths.
	//
	// Java has no relative imports, so the leading-dot arithmetic below is dead
	// code for it rather than wrong — a Java import cannot start with a dot.
	if (language === "py" || language === "java") {
		// Leading dots are the relative marker: one dot means "this package",
		// so the climb is one less than the number of dots.
		const dots = cleaned.length - cleaned.replace(/^\.+/, "").length;
		const rest = cleaned.slice(dots);
		const segments = rest.split(".").filter(Boolean);
		return { segments, upLevels: dots > 0 ? dots - 1 : null };
	}

	if (language === "rs") {
		const parts = cleaned.split("::").map((part) => part.trim()).filter(Boolean);
		if (parts[0] === "crate") {
			// Crate-absolute: anchored at the crate root, which we do not know,
			// so it resolves through the tail search below like any other.
			return { segments: parts.slice(1), upLevels: null };
		}
		if (parts[0] === "self" || parts[0] === "super") {
			let upLevels = 0;
			let i = 0;
			for (; i < parts.length; i++) {
				if (parts[i] === "super") upLevels++;
				else if (parts[i] !== "self") break;
			}
			return { segments: parts.slice(i), upLevels };
		}
		return { segments: parts, upLevels: null };
	}

	// Slash-separated: JavaScript, TypeScript, Go, and anything unrecognised.
	const parts = cleaned.split("/").filter((part) => part.length > 0 && part !== ".");
	if (!cleaned.startsWith(".")) return { segments: parts, upLevels: null };

	let upLevels = 0;
	let i = 0;
	for (; i < parts.length && parts[i] === ".."; i++) upLevels++;
	return { segments: parts.slice(i), upLevels };
}

/** True when `path` ends with `suffix` on a path-segment boundary. */
function endsWithSegments(path: string, suffix: string): boolean {
	return path === suffix || path.endsWith(`/${suffix}`);
}

/**
 * Simple import resolver heuristic.
 * Tries to match `importPath` to a file in `allFiles`.
 */
function resolveImport(
	currentFile: string,
	importPath: string,
	fileData: GraphResolveFileData
): string | null {
	const current = normalizePath(currentFile);
	const requested = normalizePath(importPath).trim();
	if (!requested) return null;

	const { allFiles, normalizedFiles, exactIndex, moduleIndex } = fileData;
	const { segments, upLevels } = parseModulePath(requested, extensionOf(current));
	if (segments.length === 0 && upLevels === null) return null;

	const lookup = (candidate: string): string | null => {
		if (!candidate) return null;
		const exact = exactIndex.get(candidate);
		if (exact != null) return allFiles[exact];
		const module = moduleIndex.get(candidate);
		if (module && module.length > 0) return allFiles[module[0]];
		return null;
	};

	/** Try the path as written, then with a source extension peeled off. */
	const tryCandidate = (candidate: string): string | null => {
		const direct = lookup(candidate);
		if (direct) return direct;
		const extension = extensionOf(candidate);
		if (extension && STRIPPABLE_REQUEST_EXTENSIONS.has(extension)) {
			return lookup(stripExtension(candidate));
		}
		return null;
	};

	// 1. Relative imports resolve against the importing file's directory.
	if (upLevels !== null) {
		const directory = current.split("/").slice(0, -1);
		const base = upLevels > 0 ? directory.slice(0, Math.max(0, directory.length - upLevels)) : directory;
		const resolved = tryCandidate([...base, ...segments].join("/"));
		if (resolved) return resolved;
		// A relative import that does not resolve is a dead link, not a hint to
		// go looking elsewhere in the repository.
		return null;
	}

	const full = segments.join("/");

	// 2. Repository-rooted paths, e.g. a TS alias or `src/lib/utils`.
	const absolute = tryCandidate(full);
	if (absolute) return absolute;

	// 3. Tail search, longest tail first.
	//
	// This is what makes Go and Rust work. A Go import is the full module path
	// (`github.com/org/repo/internal/auth`) and a crate-absolute Rust path is
	// anchored at a crate root we cannot see; in both cases only some suffix of
	// it exists as a path in the index. Matching is anchored to segment
	// boundaries so `./utils` cannot match `src/myutils.ts`.
	for (let start = 1; start < segments.length; start++) {
		const tail = segments.slice(start).join("/");
		const hit = tryCandidate(tail);
		if (hit) return hit;
	}

	// 4. Any module key ending with the request on a segment boundary.
	//
	// Scanning moduleIndex rather than the file list is what lets a bare
	// `crate::graph` reach `src/graph/mod.rs` — the package entry is only
	// reachable under its directory's key, which is not a real path. It is also
	// what resolves a Java package under its build directories: `com.example.auth`
	// is a suffix of `src/main/java/com/example/auth`, never the whole of it.
	// Longest file path wins among equals, as it always has.
	const findBySuffix = (needle: string): string | null => {
		if (!needle) return null;
		let best: { file: string; keyLength: number; pathLength: number } | null = null;
		for (const [key, indexes] of moduleIndex) {
			if (!endsWithSegments(key, needle)) continue;
			// Only the bucket's first entry: its order already encodes which file
			// speaks for the key, and a directory's entry file must not lose to a
			// sibling that happens to have a longer name.
			const index = indexes[0];
			const pathLength = normalizedFiles[index].length;
			if (
				!best
				|| key.length > best.keyLength
				|| (key.length === best.keyLength && pathLength > best.pathLength)
			) {
				best = { file: allFiles[index], keyLength: key.length, pathLength };
			}
		}
		return best?.file ?? null;
	};

	const bySuffix = findBySuffix(full);
	if (bySuffix) return bySuffix;

	// 5. Java only: an import that names a member, not a file.
	//
	// `import static com.example.Arrays.asList` and `import a.b.Outer.Inner`
	// both end in something living *inside* a file, so the file is one segment
	// shorter than the import. Tried last, because the full path is the more
	// specific match whenever it exists. Java-specific because only there does
	// an import routinely address a member by its full path — a Python
	// `from x import y` arrives as `x` alone, already trimmed by the extractor.
	if (extensionOf(current) === "java" && segments.length > 1) {
		return findBySuffix(segments.slice(0, -1).join("/"));
	}

	return null;
}

/**
 * Expand retrieval candidates with dependency-neighbor chunks using the repo graph.
 * Returns a new array containing the original candidates and any expanded neighbors.
 */
export function expandCandidatesWithGraph(
	store: GraphExpansionStore,
	candidates: Array<[string, number]>,
	options: GraphExpansionOptions = {}
): Array<[string, number]> {
	if (candidates.length === 0) return candidates;

	const {
		seedCount = 20,
		expansionWeight = 0.5,
	} = options;

	const chunks = store.getAll();
	if (chunks.length === 0) return candidates;

	const graph = store.getGraph();
	const cached =
		typeof store.getResolveFileData === "function" ? store.getResolveFileData() : null;
	// A store built against the older shape has no moduleIndex. Rebuilding is
	// cheap and beats resolving nothing, which is the bug this replaced.
	const fileData =
		cached && cached.moduleIndex
			? cached
			: buildResolveFileData([...new Set(chunks.map((c) => c.filePath))]);
	const chunkMap = new Map(chunks.map((c) => [c.id, c]));
	const expanded = [...candidates];
	const seenIds = new Set(expanded.map(([id]) => id));
	const seeds = expanded.slice(0, seedCount);

	for (const [seedId, seedScore] of seeds) {
		const chunk = chunkMap.get(seedId);
		if (!chunk) continue;
		const deps = graph[chunk.filePath];
		if (!deps?.imports) continue;

		for (const importPath of deps.imports) {
			const targetFile = resolveImport(chunk.filePath, importPath, fileData);
			if (!targetFile) continue;
			const neighborChunks = store.getChunksByFile(targetFile);
			for (const neighbor of neighborChunks) {
				if (seenIds.has(neighbor.id)) continue;
				expanded.push([neighbor.id, seedScore * expansionWeight]);
				seenIds.add(neighbor.id);
			}
		}
	}

	return expanded;
}
