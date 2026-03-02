/**
 * PageIndex Tree Builder
 *
 * Builds a 3-level in-memory hierarchy (root → dir → file) from VectorStore
 * data that already exists. Zero additional indexing cost — runs in ~1ms.
 *
 * Used by pageIndexSearch.ts for LLM-navigated (or keyword-scored) retrieval.
 */

import type { VectorStore } from "./vectorStore";

export interface PageIndexNode {
	id: string;
	level: 0 | 1 | 2; // 0=root, 1=dir, 2=file
	path: string;
	summary: string; // shown to LLM (≤600 chars)
	childIds: string[]; // child dir/file node IDs
	chunkIds: string[]; // all leaf chunk IDs under this node
}

export interface PageIndexTree {
	rootId: string;
	nodes: Record<string, PageIndexNode>;
}

/** Derive directory path from a file path (e.g. "src/lib/llm.ts" → "src/lib/"). */
function dirOf(filePath: string): string {
	const slash = filePath.lastIndexOf("/");
	return slash === -1 ? "" : filePath.slice(0, slash + 1);
}

const MAX_FILE_SUMMARY = 600;
const MAX_DIR_SUMMARY = 600;
const MAX_ROOT_SUMMARY = 800;
const MAX_FALLBACK_FIRST_CHUNK = 500;
const MAX_DIR_FALLBACK_CHARS = 400;

/**
 * Build a PageIndexTree from the VectorStore.
 * Returns a tree with nodes keyed by id.
 */
export function buildPageIndexTree(store: VectorStore): PageIndexTree {
	const allChunks = store.getAll();

	// ── Separate summary chunks from regular chunks ──────────────────────────
	const fileSummaryMap: Map<string, string> = new Map(); // filePath → summary text
	const dirSummaryMap: Map<string, string> = new Map(); // dirPath → summary text
	const regularByFile: Map<string, string[]> = new Map(); // filePath → chunk ids

	for (const chunk of allChunks) {
		if (chunk.nodeType === "file_summary") {
			const existing = fileSummaryMap.get(chunk.filePath) ?? "";
			if (chunk.code.length > existing.length) {
				fileSummaryMap.set(chunk.filePath, chunk.code.slice(0, MAX_FILE_SUMMARY));
			}
			continue;
		}

		if (chunk.nodeType === "directory_summary") {
			// filePath for dir summaries is "<dirPath>/[directory_summary]"
			// id is "<dirPath>::directory_summary"
			const dirPath = dirOf(chunk.filePath) || chunk.filePath.replace("/[directory_summary]", "").replace("[directory_summary]", "");
			const existing = dirSummaryMap.get(dirPath) ?? "";
			if (chunk.code.length > existing.length) {
				dirSummaryMap.set(dirPath, chunk.code.slice(0, MAX_DIR_SUMMARY));
			}
			continue;
		}

		// Regular chunk
		const ids = regularByFile.get(chunk.filePath) ?? [];
		ids.push(chunk.id);
		regularByFile.set(chunk.filePath, ids);
	}

	// ── Build L2 (file) nodes ────────────────────────────────────────────────
	const nodes: Record<string, PageIndexNode> = {};
	const fileToNodeId: Map<string, string> = new Map();
	const dirToFileNodes: Map<string, string[]> = new Map(); // dirPath → file node IDs

	for (const [filePath, chunkIds] of regularByFile) {
		const nodeId = `file:${filePath}`;
		let summary = fileSummaryMap.get(filePath) ?? "";

		if (!summary) {
			// Fallback: first regular chunk truncated to 500 chars
			const firstChunkId = chunkIds[0];
			const firstChunk = allChunks.find((c) => c.id === firstChunkId);
			summary = firstChunk ? firstChunk.code.slice(0, MAX_FALLBACK_FIRST_CHUNK) : filePath;
		}

		nodes[nodeId] = {
			id: nodeId,
			level: 2,
			path: filePath,
			summary,
			childIds: [],
			chunkIds,
		};
		fileToNodeId.set(filePath, nodeId);

		const dir = dirOf(filePath);
		const dirFiles = dirToFileNodes.get(dir) ?? [];
		dirFiles.push(nodeId);
		dirToFileNodes.set(dir, dirFiles);
	}

	// ── Build L1 (dir) nodes ─────────────────────────────────────────────────
	const dirNodeIds: string[] = [];

	for (const [dirPath, fileNodeIds] of dirToFileNodes) {
		const nodeId = `dir:${dirPath}`;
		let summary = dirSummaryMap.get(dirPath) ?? "";

		if (!summary) {
			// Fallback: "Contains: file1.ts, file2.ts, ..."
			const fileNames = fileNodeIds
				.map((fnId) => nodes[fnId]?.path.split("/").pop() ?? fnId)
				.join(", ");
			summary = `Contains: ${fileNames}`.slice(0, MAX_DIR_FALLBACK_CHARS);
		}

		// Collect all chunk IDs under this dir
		const allDirChunkIds = fileNodeIds.flatMap((fnId) => nodes[fnId]?.chunkIds ?? []);

		nodes[nodeId] = {
			id: nodeId,
			level: 1,
			path: dirPath,
			summary,
			childIds: fileNodeIds,
			chunkIds: allDirChunkIds,
		};
		dirNodeIds.push(nodeId);
	}

	// ── Build L0 (root) node ─────────────────────────────────────────────────
	const rootId = "root";
	const rootSummaryParts = dirNodeIds
		.slice(0, 15)
		.map((dnId) => `${nodes[dnId].path}: ${nodes[dnId].summary.slice(0, 60)}`);
	const rootSummary = rootSummaryParts.join("\n").slice(0, MAX_ROOT_SUMMARY);

	const allRootChunkIds = dirNodeIds.flatMap((dnId) => nodes[dnId]?.chunkIds ?? []);

	nodes[rootId] = {
		id: rootId,
		level: 0,
		path: "",
		summary: rootSummary,
		childIds: dirNodeIds,
		chunkIds: allRootChunkIds,
	};

	return { rootId, nodes };
}
