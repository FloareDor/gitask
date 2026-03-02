export interface GraphResolveFileData {
	allFiles: string[];
	normalizedFiles: string[];
	exactIndex: Map<string, number>;
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

function buildResolveFileData(allFiles: string[]): GraphResolveFileData {
	const normalizedFiles = allFiles.map(normalizePath);
	const exactIndex = new Map<string, number>();
	for (let i = 0; i < normalizedFiles.length; i++) {
		exactIndex.set(normalizedFiles[i], i);
	}
	return {
		allFiles,
		normalizedFiles,
		exactIndex,
	};
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
	const requested = normalizePath(importPath);
	const { allFiles, normalizedFiles, exactIndex } = fileData;

	const hasExt = /\.[^/.]+$/.test(requested);
	const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
	const candidatePaths = new Set<string>();

	const addModuleCandidates = (base: string) => {
		const clean = base.replace(/\/+$/, "");
		candidatePaths.add(clean);
		if (!hasExt) {
			for (const ext of extensions) candidatePaths.add(`${clean}${ext}`);
			for (const ext of extensions) candidatePaths.add(`${clean}/index${ext}`);
		}
	};

	// 1. Relative imports: resolve against current file directory.
	if (requested.startsWith(".")) {
		const parts = current.split("/");
		parts.pop();
		for (const segment of requested.split("/")) {
			if (!segment || segment === ".") continue;
			if (segment === "..") parts.pop();
			else parts.push(segment);
		}
		addModuleCandidates(parts.join("/"));
	}

	// 2. Workspace absolute-like imports (e.g. src/lib/utils) and package-like suffixes.
	addModuleCandidates(requested);

	for (const candidate of candidatePaths) {
		const idx = exactIndex.get(candidate);
		if (idx != null) return allFiles[idx];
	}

	// 3. Fallback suffix match (for aliases) with longest match preference.
	const suffixMatches = normalizedFiles
		.map((f, idx) => ({ f, idx }))
		.filter(({ f }) => {
			const noExt = f.replace(/\.[^/.]+$/, "");
			return noExt.endsWith(requested);
		})
		.sort((a, b) => b.f.length - a.f.length);
	if (suffixMatches.length > 0) {
		return allFiles[suffixMatches[0].idx];
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
	const fileData =
		typeof store.getResolveFileData === "function"
			? store.getResolveFileData()
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
