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
import { chunkCode, chunkWithTreeSitter, type CodeChunk } from "./chunker";
import { detectLanguage } from "./chunker";
import { embedChunks, initEmbedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { extractSymbols } from "./symbols";

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
};

/**
 * Index an entire repository.
 * Emits progress events via the callback.
 */
export async function indexRepository(
	owner: string,
	repo: string,
	store: VectorStore,
	onProgress?: (progress: IndexProgress) => void,
	token?: string
): Promise<void> {
	// 1. Fetch tree
	onProgress?.({
		phase: "fetching",
		message: "Fetching repository structure…",
		current: 0,
		total: 1,
	});

	const tree = await fetchRepoTree(owner, repo, token);

	// 1.5 Init Tree-Sitter (dynamic import to avoid bundling fs/promises)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let Parser: any = null;
	try {
		const mod = await import("web-tree-sitter");
		Parser = mod.default;
		await Parser.init({
			locateFile(scriptName: string) {
				return "/" + scriptName;
			},
		});
	} catch (e) {
		console.warn("Failed to init tree-sitter:", e);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const parsers: Record<string, any> = {};

	// 2. Check cache
	const cached = await store.loadFromCache(owner, repo, tree.sha);
	if (cached) {
		onProgress?.({
			phase: "cached",
			message: `Loaded ${store.size} chunks from cache`,
			current: store.size,
			total: store.size,
		});
		return;
	}

	store.clear();

	// 3. Filter and prioritise files
	const indexableFiles = prioritiseFiles(
		tree.files.filter((f) => isIndexable(f.path))
	);

	const totalFiles = indexableFiles.length;

	onProgress?.({
		phase: "fetching",
		message: `Fetching ${totalFiles} files…`,
		current: 0,
		total: totalFiles,
	});

	// 4. Fetch + chunk files, collecting AST data
	const allChunks: CodeChunk[] = [];
	const astNodes: AstNode[] = [];
	const textChunkCounts: Record<string, number> = {};
	const fileChunkRanges = new Map<string, { start: number; end: number }>();

	for (let i = 0; i < indexableFiles.length; i++) {
		const file = indexableFiles[i];
		try {
			const content = await fetchFileContent(owner, repo, file.path, token);
			const lang = detectLanguage(file.path);

			// Extract symbols for AST visualization
			const symbols = extractSymbols(content, lang);
			for (const sym of symbols) {
				astNodes.push({
					filePath: file.path,
					name: sym.name,
					kind: sym.kind,
					status: "parsed",
				});
			}

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

					chunks = chunkWithTreeSitter(file.path, content, parsers[lang], lang);
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
		} catch {
			// Skip files that fail to fetch
			console.warn(`Skipped ${file.path}`);
		}

		if (i % 5 === 0 || i === indexableFiles.length - 1) {
			onProgress?.({
				phase: "chunking",
				message: `Chunked ${i + 1}/${totalFiles} files (${allChunks.length} chunks)`,
				current: i + 1,
				total: totalFiles,
				astNodes: [...astNodes],
				textChunkCounts: { ...textChunkCounts },
			});
		}
	}

	// 5. Embed chunks
	onProgress?.({
		phase: "embedding",
		message: `Embedding ${allChunks.length} chunks…`,
		current: 0,
		total: allChunks.length,
		astNodes: [...astNodes],
		textChunkCounts: { ...textChunkCounts },
	});

	await initEmbedder((msg) =>
		onProgress?.({
			phase: "embedding",
			message: msg,
			current: 0,
			total: allChunks.length,
			astNodes: [...astNodes],
			textChunkCounts: { ...textChunkCounts },
		})
	);

	const embedded = await embedChunks(allChunks, (done, total) => {
		// Update per-file AST node statuses based on embedding progress
		const updatedNodes = astNodes.map((node) => {
			const range = fileChunkRanges.get(node.filePath);
			if (!range) return node;

			let status: AstNode["status"];
			if (done >= range.end) {
				status = "done";
			} else if (done > range.start) {
				status = "embedding";
			} else {
				status = "parsed";
			}
			return { ...node, status };
		});

		onProgress?.({
			phase: "embedding",
			message: `Embedded ${done}/${total} chunks`,
			current: done,
			total,
			astNodes: updatedNodes,
			textChunkCounts: { ...textChunkCounts },
		});
	});

	// 6. Store
	store.insert(embedded);

	// 7. Persist to IndexedDB
	onProgress?.({
		phase: "persisting",
		message: "Saving to cache…",
		current: 0,
		total: 1,
	});

	await store.persist(owner, repo, tree.sha);

	onProgress?.({
		phase: "done",
		message: `Indexed ${embedded.length} chunks from ${totalFiles} files`,
		current: embedded.length,
		total: embedded.length,
	});
}
