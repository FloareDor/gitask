/**
 * Indexing Orchestrator — ties the full RAG pipeline together.
 *
 * indexRepository() → fetch tree → chunk (AST) → embed (WebGPU)
 * → store in VectorStore → persist to IndexedDB.
 */

import {
	fetchRepoTree,
	fetchFileContent,
	isIndexable,
	prioritiseFiles,
} from "./github";
import { chunkCode, chunkFromTree, type CodeChunk } from "./chunker";
import { CHUNKING_LIMITS, detectLanguage } from "./chunker";
import { embedChunks, initEmbedder, type EmbeddedChunk } from "./embedder";
import { VectorStore } from "./vectorStore";
import { extractDependencies, extractSymbolsFromTree } from "./graph";
import {
	createDirectorySummaryChunks,
	updateDirectoryStats,
	type DirectoryStatsMap,
} from "./directorySummary";

export interface AstNode {
	filePath: string;
	name: string;
	kind: string;
	status: "pending" | "parsed" | "embedding" | "done";
}

export type IndexProgress = {
	phase: "fetching" | "chunking" | "embedding" | "persisting" | "done" | "cached";
	message: string;
	current: number;
	total: number;
	astNodes?: AstNode[];
	textChunkCounts?: Record<string, number>;
	/** Approx storage size in bytes (IndexedDB) */
	estimatedSizeBytes?: number;
};

export interface IndexResult {
	sha: string;
	fromCache: boolean;
	treeTruncated: boolean;
	indexedFiles: number;
}

/** Estimate IndexedDB storage: 384-dim embeddings + metadata per chunk */
function estimateStorageBytes(chunkCount: number): number {
	const EMBEDDING_DIM = 384;
	const BYTES_PER_FLOAT = 8;
	const METADATA_PER_CHUNK = 1500;
	return chunkCount * (EMBEDDING_DIM * BYTES_PER_FLOAT + METADATA_PER_CHUNK);
}

/** Thrown when indexing is aborted via AbortSignal */
export class IndexAbortError extends Error {
	constructor() {
		super("Indexing aborted");
		this.name = "IndexAbortError";
	}
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new IndexAbortError();
}

const DIRECTORY_SUMMARY_LIMITS = {
	maxFilesPerDir: 120,
	maxCharsPerDir: 400_000,
	maxSummaryChars: CHUNKING_LIMITS.MAX_CHUNK_CHARS,
} as const;

/**
 * Index an entire repository.
 * Emits progress events via the callback.
 * Supports cancellation via optional AbortSignal.
 */
export async function indexRepository(
	owner: string,
	repo: string,
	store: VectorStore,
	onProgress?: (progress: IndexProgress) => void,
	token?: string,
	signal?: AbortSignal
): Promise<IndexResult> {
	checkAborted(signal);

	// 1. Fetch tree
	onProgress?.({
		phase: "fetching",
		message: "Fetching repository structure…",
		current: 0,
		total: 1,
	});

	const tree = await fetchRepoTree(owner, repo, token);
	checkAborted(signal);

	// Fail fast on truncated trees to avoid stale/partial context from incomplete repository views.
	if (tree.truncated) {
		throw new Error(
			"Repository tree is truncated by GitHub API. Indexing stopped to avoid partial context. Add a GitHub token with repo read access and retry."
		);
	}

	// 1.5 Init Tree-Sitter (dynamic import to avoid bundling fs/promises)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let Parser: any = null;
	try {
		const mod = await import("web-tree-sitter");
		Parser = mod.Parser ?? mod.default;
		if (Parser?.init) {
			await Parser.init({
				locateFile(scriptName: string) {
					return "/" + scriptName;
				},
			});
		}
	} catch (e) {
		console.warn("Failed to init tree-sitter:", e);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const parsers: Record<string, any> = {};

	checkAborted(signal);

	// 2. Check cache
	const cached = await store.loadFromCache(owner, repo, tree.sha);
	if (cached) {
		onProgress?.({
			phase: "cached",
			message: `Loaded ${store.size} chunks from cache`,
			current: store.size,
			total: store.size,
		});
		return {
			sha: tree.sha,
			fromCache: true,
			treeTruncated: tree.truncated,
			indexedFiles: tree.files.length,
		};
	}

	store.clear();

	// 3. Filter and prioritise files
	const indexableFiles = prioritiseFiles(
		tree.files.filter((f) => isIndexable(f.path))
	);
	const indexablePaths = indexableFiles.map((f) => f.path);
	const totalFiles = indexableFiles.length;

	// 4. Check for partial progress (tab-close resume)
	const partial = await store.loadPartialProgress(owner, repo, tree.sha);
	let allChunks: CodeChunk[];
	let astNodes: AstNode[];
	let textChunkCounts: Record<string, number>;
	let fileChunkRanges: Map<string, { start: number; end: number }>;
	let dependencyGraph: Record<string, { imports: string[]; definitions: string[] }>;
	let directoryStats: DirectoryStatsMap;
	let startFileIndex: number;

	if (partial?.phase === "embedding" && partial.allChunks && partial.embeddedSoFar != null) {
		// Resume embedding
		allChunks = partial.allChunks;
		astNodes = (partial.astNodes ?? []) as AstNode[];
		textChunkCounts = partial.textChunkCounts ?? {};
		fileChunkRanges = new Map(partial.fileChunkRanges ?? []);
		dependencyGraph = partial.dependencyGraph ?? {};
		directoryStats = partial.directoryStats ?? {};
		startFileIndex = totalFiles; // Skip chunking
	} else if (partial?.phase === "chunking" && partial.allChunks && partial.indexablePaths && partial.lastProcessedFileIndex != null) {
		// Resume chunking
		allChunks = partial.allChunks;
		astNodes = (partial.astNodes ?? []) as AstNode[];
		textChunkCounts = partial.textChunkCounts ?? {};
		fileChunkRanges = new Map(partial.fileChunkRanges ?? []);
		dependencyGraph = partial.dependencyGraph ?? {};
		directoryStats = partial.directoryStats ?? {};
		startFileIndex = partial.lastProcessedFileIndex + 1;
	} else {
		// Fresh start
		allChunks = [];
		astNodes = [];
		textChunkCounts = {};
		fileChunkRanges = new Map();
		dependencyGraph = {};
		directoryStats = {};
		startFileIndex = 0;
	}

	if (startFileIndex < totalFiles) {
		onProgress?.({
			phase: "fetching",
			message: `Fetching ${totalFiles} files…`,
			current: startFileIndex,
			total: totalFiles,
		});
	}

	// 5. Fetch + chunk files (or resume from startFileIndex)
	for (let i = startFileIndex; i < indexableFiles.length; i++) {
		const file = indexableFiles[i];
		try {
			// Fetch each file from the exact commit snapshot resolved during tree fetch.
			const content = await fetchFileContent(owner, repo, file.path, token, tree.sha);
			const lang = detectLanguage(file.path);



			// Chunk the file and track ranges
			const chunkStart = allChunks.length;

			let chunks: CodeChunk[] = [];

			// Attempt to use AST chunking if possible
			if (Parser && lang && ["javascript", "typescript", "tsx", "python", "rust", "go", "java", "c", "cpp"].includes(lang)) {
				try {
					if (!parsers[lang]) {
						// Load the language WASM if not already loaded
						const wasmPath = `/wasms/tree-sitter-${lang}.wasm`;
						const language = await Parser.Language.load(wasmPath);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const parser = new (Parser as any)();
						parser.setLanguage(language);
						parsers[lang] = parser;
					}

					const tree = parsers[lang].parse(content);
					try {
						// Extract dependencies (imports/exports)
						const deps = extractDependencies(tree, lang);
						dependencyGraph[file.path] = deps;

						// Extract symbols for AST visualization
						const treeSymbols = extractSymbolsFromTree(tree, lang);
						for (const sym of treeSymbols) {
							astNodes.push({
								filePath: file.path,
								name: sym.name,
								kind: sym.kind,
								status: "parsed",
							});
						}

						// Chunk code using the same tree
						chunks = chunkFromTree(file.path, content, tree, lang);
					} finally {
						tree.delete();
					}
				} catch (e) {
					console.warn(`Failed to AST chunk ${file.path}, falling back to text:`, e);
					chunks = chunkCode(file.path, content);
				}
			} else {
				chunks = chunkCode(file.path, content);
			}

			allChunks.push(...chunks);
			const chunkEnd = allChunks.length;

			fileChunkRanges.set(file.path, { start: chunkStart, end: chunkEnd });
			textChunkCounts[file.path] = chunks.length;
			updateDirectoryStats(
				directoryStats,
				file.path,
				content.length,
				chunks.length,
				chunks.some((chunk) => chunk.nodeType === "file_summary")
			);
		} catch {
			// Skip files that fail to fetch
			console.warn(`Skipped ${file.path}`);
		}

		// Report progress every file so AST visualization updates promptly
		onProgress?.({
			phase: "chunking",
			message: `Chunked ${i + 1}/${totalFiles} files (${allChunks.length} chunks)`,
			current: i + 1,
			total: totalFiles,
			astNodes: [...astNodes],
			textChunkCounts: { ...textChunkCounts },
		});

		// Persist partial progress after each file for tab-close resilience
		checkAborted(signal);
		await store.savePartialProgress(owner, repo, {
			sha: tree.sha,
			timestamp: Date.now(),
			phase: "chunking",
			indexablePaths,
			allChunks: [...allChunks],
			astNodes: [...astNodes],
			textChunkCounts: { ...textChunkCounts },
			fileChunkRanges: [...fileChunkRanges.entries()],
			dependencyGraph: { ...dependencyGraph },
			directoryStats: { ...directoryStats },
			lastProcessedFileIndex: i,
		});
	}

	checkAborted(signal);

	const directorySummaryChunks = createDirectorySummaryChunks(
		directoryStats,
		DIRECTORY_SUMMARY_LIMITS
	);
	if (directorySummaryChunks.length > 0) {
		allChunks.push(...directorySummaryChunks);
	}

	// 6. Embed chunks (or resume from embeddedSoFar)
	const embeddedSoFar: EmbeddedChunk[] = partial?.phase === "embedding" && partial.embeddedSoFar
		? partial.embeddedSoFar
		: [];
	const chunksToEmbed = allChunks.slice(embeddedSoFar.length);
	const estimatedBytes = estimateStorageBytes(allChunks.length);

	// Save embedding-phase partial before starting (for tab-close during embed)
	await store.savePartialProgress(owner, repo, {
		sha: tree.sha,
		timestamp: Date.now(),
		phase: "embedding",
		allChunks: [...allChunks],
		astNodes: [...astNodes],
		textChunkCounts: { ...textChunkCounts },
		fileChunkRanges: [...fileChunkRanges.entries()],
		dependencyGraph: { ...dependencyGraph },
		directoryStats: { ...directoryStats },
		embeddedSoFar: [...embeddedSoFar],
	});

	onProgress?.({
		phase: "embedding",
		message: chunksToEmbed.length > 0 ? `Embedding ${allChunks.length} chunks…` : `Resuming embedding…`,
		current: embeddedSoFar.length,
		total: allChunks.length,
		astNodes: [...astNodes],
		textChunkCounts: { ...textChunkCounts },
		estimatedSizeBytes: estimatedBytes,
	});

	await initEmbedder((msg) =>
		onProgress?.({
			phase: "embedding",
			message: msg,
			current: embeddedSoFar.length,
			total: allChunks.length,
			astNodes: [...astNodes],
			textChunkCounts: { ...textChunkCounts },
			estimatedSizeBytes: estimatedBytes,
		})
	);

	let embedded: EmbeddedChunk[];
	if (chunksToEmbed.length === 0) {
		embedded = embeddedSoFar;
	} else {
		const newlyEmbedded = await embedChunks(
			chunksToEmbed,
			(done, total) => {
				checkAborted(signal);
				const overallDone = embeddedSoFar.length + done;
				// Update per-file AST node statuses based on embedding progress
				const updatedNodes = astNodes.map((node) => {
					const range = fileChunkRanges.get(node.filePath);
					if (!range) return node;

					let status: AstNode["status"];
					if (overallDone >= range.end) {
						status = "done";
					} else if (overallDone > range.start) {
						status = "embedding";
					} else {
						status = "parsed";
					}
					return { ...node, status };
				});

				onProgress?.({
					phase: "embedding",
					message: `Embedded ${overallDone}/${allChunks.length} chunks`,
					current: overallDone,
					total: allChunks.length,
					astNodes: updatedNodes,
					textChunkCounts: { ...textChunkCounts },
					estimatedSizeBytes: estimatedBytes,
				});
			},
			8,
			signal,
			(batchResults) => {
				const soFar = [...embeddedSoFar, ...batchResults];
				store.savePartialProgress(owner, repo, {
					sha: tree.sha,
					timestamp: Date.now(),
					phase: "embedding",
					allChunks: [...allChunks],
					astNodes: [...astNodes],
					textChunkCounts: { ...textChunkCounts },
					fileChunkRanges: [...fileChunkRanges.entries()],
					dependencyGraph: { ...dependencyGraph },
					directoryStats: { ...directoryStats },
					embeddedSoFar: soFar,
				}).catch(console.warn);
			}
		);
		embedded = [...embeddedSoFar, ...newlyEmbedded];
	}

	// 7. Store
	store.insert(embedded);
	store.setGraph(dependencyGraph);

	checkAborted(signal);

	// 7. Persist to IndexedDB
	onProgress?.({
		phase: "persisting",
		message: "Saving to cache…",
		current: 0,
		total: 1,
		estimatedSizeBytes: estimatedBytes,
	});

	await store.persist(owner, repo, tree.sha);
	await store.clearPartialProgress(owner, repo);

	onProgress?.({
		phase: "done",
		message: `Indexed ${embedded.length} chunks from ${totalFiles} files`,
		current: embedded.length,
		total: embedded.length,
		estimatedSizeBytes: estimatedBytes,
	});

	return {
		sha: tree.sha,
		fromCache: false,
		treeTruncated: tree.truncated,
		indexedFiles: totalFiles,
	};
}
