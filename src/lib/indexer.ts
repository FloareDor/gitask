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
import { chunkCode, type CodeChunk } from "./chunker";
import { embedChunks, initEmbedder } from "./embedder";
import { VectorStore } from "./vectorStore";

export type IndexProgress = {
	phase: "fetching" | "chunking" | "embedding" | "persisting" | "done" | "cached";
	message: string;
	current: number;
	total: number;
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

	// 4. Fetch + chunk files
	const allChunks: CodeChunk[] = [];

	for (let i = 0; i < indexableFiles.length; i++) {
		const file = indexableFiles[i];
		try {
			const content = await fetchFileContent(owner, repo, file.path, token);
			const chunks = chunkCode(file.path, content);
			allChunks.push(...chunks);
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
			});
		}
	}

	// 5. Embed chunks
	onProgress?.({
		phase: "embedding",
		message: `Embedding ${allChunks.length} chunks…`,
		current: 0,
		total: allChunks.length,
	});

	await initEmbedder((msg) =>
		onProgress?.({
			phase: "embedding",
			message: msg,
			current: 0,
			total: allChunks.length,
		})
	);

	const embedded = await embedChunks(allChunks, (done, total) =>
		onProgress?.({
			phase: "embedding",
			message: `Embedded ${done}/${total} chunks`,
			current: done,
			total,
		})
	);

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
