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
import { recordIndex } from "./metrics";
import { chunkCode, chunkFromTree, type CodeChunk } from "./chunker";
import { CHUNKING_LIMITS, detectLanguage } from "./chunker";
import { embedChunks, initEmbedder, type EmbeddedChunk } from "./embedder";
import { VectorStore } from "./vectorStore";
import { collectGraphMetadataFromNode } from "./graph";
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

const AST_CHUNK_LANGUAGES = new Set([
	"javascript",
	"typescript",
	"tsx",
	"python",
	"rust",
	"go",
	"java",
	"c",
	"cpp",
]);

function resolveChunkWorkerCount(totalPendingFiles: number, hasToken: boolean): number {
	if (totalPendingFiles <= 1) return 1;
	const cores =
		typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
			? navigator.hardwareConcurrency
			: 4;
	const target = Math.max(2, Math.floor(cores / 2));
	const cap = hasToken ? 8 : 4;
	return Math.max(1, Math.min(totalPendingFiles, Math.min(target, cap)));
}

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

	const indexStartTime = performance.now();

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
		onProgress?.({
			phase: "fetching",
			message: "AST parsing unavailable — falling back to text chunking. Search quality may be reduced.",
			current: 0,
			total: 1,
		});
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

	const pendingChunkFiles = Math.max(0, totalFiles - startFileIndex);
	const chunkWorkerCount = resolveChunkWorkerCount(pendingChunkFiles, Boolean(token));
	const chunkCheckpointInterval = Math.max(4, chunkWorkerCount * 2);
	if (startFileIndex < totalFiles) {
		onProgress?.({
			phase: "fetching",
			message: `Fetching ${totalFiles} files… (chunk workers: ${chunkWorkerCount})`,
			current: startFileIndex,
			total: totalFiles,
		});
		console.info(
			`Index chunk workers: ${chunkWorkerCount} (pending files: ${pendingChunkFiles}, cores: ${typeof navigator !== "undefined" ? navigator.hardwareConcurrency : "n/a"})`
		);
	}

	const skippedFiles: string[] = [];

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const parserLoaders: Record<string, Promise<any>> = {};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const getParserForLanguage = async (lang: string): Promise<any> => {
		if (parsers[lang]) return parsers[lang];
		if (!Parser) return null;
		if (!parserLoaders[lang]) {
			parserLoaders[lang] = (async () => {
				const wasmPath = `/wasms/tree-sitter-${lang}.wasm`;
				const language = await Parser.Language.load(wasmPath);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const parser = new (Parser as any)();
				parser.setLanguage(language);
				return parser;
			})();
		}
		parsers[lang] = await parserLoaders[lang];
		return parsers[lang];
	};

	type ChunkingResult = {
		fileIndex: number;
		filePath: string;
		contentLength: number;
		chunks: CodeChunk[];
		deps?: { imports: string[]; definitions: string[] };
		symbolNodes: AstNode[];
		error?: unknown;
	};

	const processFileForChunking = async (
		file: { path: string },
		fileIndex: number
	): Promise<ChunkingResult> => {
		checkAborted(signal);
		try {
			// Fetch each file from the exact commit snapshot resolved during tree fetch.
			const content = await fetchFileContent(owner, repo, file.path, token, tree.sha);
			checkAborted(signal);
			const lang = detectLanguage(file.path);
			let chunks: CodeChunk[] = [];
			let deps: { imports: string[]; definitions: string[] } | undefined;
			let symbolNodes: AstNode[] = [];

			// Attempt to use AST chunking if possible.
			if (Parser && lang && AST_CHUNK_LANGUAGES.has(lang)) {
				try {
					const parser = await getParserForLanguage(lang);
					const astTree = parser.parse(content);
					try {
						const imports = new Set<string>();
						const definitions = new Set<string>();
						const symbols: Array<{ name: string; kind: string; line: number }> = [];
						chunks = chunkFromTree(file.path, content, astTree, lang, (node) => {
							collectGraphMetadataFromNode(
								node,
								lang,
								imports,
								definitions,
								symbols
							);
						});
						deps = {
							imports: Array.from(imports),
							definitions: Array.from(definitions),
						};
						symbolNodes = symbols.map((sym) => ({
							filePath: file.path,
							name: sym.name,
							kind: sym.kind,
							status: "parsed",
						}));
					} finally {
						astTree.delete();
					}
				} catch (e) {
					console.warn(`Failed to AST chunk ${file.path}, falling back to text:`, e);
					chunks = chunkCode(file.path, content);
				}
			} else {
				chunks = chunkCode(file.path, content);
			}

			return {
				fileIndex,
				filePath: file.path,
				contentLength: content.length,
				chunks,
				deps,
				symbolNodes,
			};
		} catch (e) {
			if (e instanceof IndexAbortError) throw e;
			return {
				fileIndex,
				filePath: file.path,
				contentLength: 0,
				chunks: [],
				symbolNodes: [],
				error: e,
			};
		}
	};

	// 5. Fetch + chunk files (or resume from startFileIndex) with bounded concurrency.
	for (let batchStart = startFileIndex; batchStart < indexableFiles.length; batchStart += chunkWorkerCount) {
		checkAborted(signal);
		const batch = indexableFiles.slice(batchStart, batchStart + chunkWorkerCount);
		const batchResults = await Promise.all(
			batch.map((file, offset) => processFileForChunking(file, batchStart + offset))
		);

		for (const result of batchResults) {
			const i = result.fileIndex;
			if (result.error) {
				console.warn(`Skipped ${result.filePath}:`, result.error);
				skippedFiles.push(result.filePath);
			} else {
				const chunkStart = allChunks.length;
				allChunks.push(...result.chunks);
				const chunkEnd = allChunks.length;

				fileChunkRanges.set(result.filePath, { start: chunkStart, end: chunkEnd });
				textChunkCounts[result.filePath] = result.chunks.length;
				if (result.deps) {
					dependencyGraph[result.filePath] = result.deps;
				}
				if (result.symbolNodes.length > 0) {
					astNodes.push(...result.symbolNodes);
				}
				updateDirectoryStats(
					directoryStats,
					result.filePath,
					result.contentLength,
					result.chunks.length,
					result.chunks.some((chunk) => chunk.nodeType === "file_summary")
				);
			}

			onProgress?.({
				phase: "chunking",
				message: `Chunked ${i + 1}/${totalFiles} files (${allChunks.length} chunks, ${chunkWorkerCount} workers)`,
				current: i + 1,
				total: totalFiles,
				astNodes: [...astNodes],
				textChunkCounts: { ...textChunkCounts },
			});
		}

		const lastProcessedFileIndex = batchStart + batch.length - 1;
		const processedSinceResume = lastProcessedFileIndex - startFileIndex + 1;
		const shouldCheckpoint =
			lastProcessedFileIndex >= indexableFiles.length - 1 ||
			processedSinceResume % chunkCheckpointInterval === 0;
		if (shouldCheckpoint) {
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
				lastProcessedFileIndex,
			});
		}
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
				}).catch((e) => {
					console.warn("Failed to save partial embedding progress:", e);
					onProgress?.({
						phase: "embedding",
						message: "Warning: could not save progress checkpoint — if you close this tab, indexing will restart from scratch.",
						current: soFar.length,
						total: allChunks.length,
						estimatedSizeBytes: estimatedBytes,
					});
				});
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

	const skippedNote =
		skippedFiles.length > 0
			? ` — ${skippedFiles.length} file${skippedFiles.length > 1 ? "s" : ""} could not be fetched`
			: "";
	onProgress?.({
		phase: "done",
		message: `Indexed ${embedded.length} chunks from ${totalFiles - skippedFiles.length} files${skippedNote}`,
		current: embedded.length,
		total: embedded.length,
		estimatedSizeBytes: estimatedBytes,
	});

	recordIndex(
		totalFiles - skippedFiles.length,
		embedded.length,
		performance.now() - indexStartTime,
		`${owner}/${repo}`
	);

	return {
		sha: tree.sha,
		fromCache: false,
		treeTruncated: tree.truncated,
		indexedFiles: totalFiles,
	};
}
