/**
 * Vector Store — wraps EntityDB for indexing and searching code embeddings.
 *
 * Handles insert, search, persistence to IndexedDB, and cache invalidation.
 */

import type { EmbeddedChunk } from "./embedder";
import type { CodeChunk } from "./chunker";

/** AST node for partial progress (matches indexer AstNode shape) */
export interface PartialAstNode {
	filePath: string;
	name: string;
	kind: string;
	status: string;
}

/** Partial progress for tab-close resilience (chunking or embedding phase) */
export interface PartialProgress {
	sha: string;
	timestamp: number;
	phase: "chunking" | "embedding";
	indexablePaths?: string[];
	allChunks?: CodeChunk[];
	astNodes?: PartialAstNode[];
	textChunkCounts?: Record<string, number>;
	fileChunkRanges?: [string, { start: number; end: number }][];
	dependencyGraph?: Record<string, { imports: string[]; definitions: string[] }>;
	directoryStats?: Record<string, {
		fileCount: number;
		totalChars: number;
		files: Array<{
			path: string;
			charCount: number;
			chunkCount: number;
			hasLargeFileSummary: boolean;
		}>;
	}>;
	lastProcessedFileIndex?: number;
	embeddedSoFar?: EmbeddedChunk[];
}

export interface SearchResult {
	chunk: CodeChunk;
	score: number;
	embedding?: number[];
}

/**
 * In-memory vector store backed by simple arrays.
 * We use entity-db for persistence but manage search ourselves
 * to support binary quantisation + Hamming distance.
 */
export class VectorStore {
	private chunks: EmbeddedChunk[] = [];
	private chunksByFile: Map<string, EmbeddedChunk[]> = new Map();
	private graph: Record<string, { imports: string[]; definitions: string[] }> = {};
	private repoKey: string = "";

	constructor() { }

	/**
	 * Insert embedded chunks into the store.
	 */
	insert(chunks: EmbeddedChunk[]): void {
		this.chunks.push(...chunks);
		for (const chunk of chunks) {
			const fileChunks = this.chunksByFile.get(chunk.filePath) || [];
			fileChunks.push(chunk);
			this.chunksByFile.set(chunk.filePath, fileChunks);
		}
	}

	/**
	 * Set the dependency graph.
	 */
	setGraph(graph: Record<string, { imports: string[]; definitions: string[] }>): void {
		this.graph = graph;
	}

	/**
	 * Get the dependency graph.
	 */
	getGraph(): Record<string, { imports: string[]; definitions: string[] }> {
		return this.graph;
	}

	/**
	 * Get all stored chunks.
	 */
	getAll(): EmbeddedChunk[] {
		return this.chunks;
	}

	getChunksByFile(filePath: string): EmbeddedChunk[] {
		return this.chunksByFile.get(filePath) || [];
	}

	/**
	 * Get the number of chunks stored.
	 */
	get size(): number {
		return this.chunks.length;
	}

	/**
	 * Clear the store.
	 */
	clear(): void {
		this.chunks = [];
		this.chunksByFile.clear();
		this.graph = {};
	}

	/**
	 * Persist the store to IndexedDB keyed by owner/repo.
	 */
	async persist(owner: string, repo: string, sha: string): Promise<void> {
		this.repoKey = `${owner}/${repo}`;
		const data = {
			sha,
			timestamp: Date.now(),
			chunks: this.chunks,
			graph: this.graph,
		};

		return new Promise((resolve, reject) => {
			const request = indexedDB.open("gitask-cache", 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains("repos")) {
					db.createObjectStore("repos");
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("repos", "readwrite");
				tx.objectStore("repos").put(data, this.repoKey);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Clear the IndexedDB cache and partial progress for a repo. Does not clear in-memory store.
	 */
	async clearCache(owner: string, repo: string): Promise<void> {
		const key = `${owner}/${repo}`;
		const partialKey = `${owner}/${repo}-partial`;
		return new Promise((resolve, reject) => {
			const request = indexedDB.open("gitask-cache", 1);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("repos", "readwrite");
				const store = tx.objectStore("repos");
				store.delete(key);
				store.delete(partialKey);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Save partial indexing progress for tab-close resilience.
	 */
	async savePartialProgress(
		owner: string,
		repo: string,
		data: PartialProgress
	): Promise<void> {
		const key = `${owner}/${repo}-partial`;
		const payload = { ...data, timestamp: Date.now() };
		return new Promise((resolve, reject) => {
			const request = indexedDB.open("gitask-cache", 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains("repos")) {
					db.createObjectStore("repos");
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("repos", "readwrite");
				tx.objectStore("repos").put(payload, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Load partial progress if it exists and SHA matches.
	 * Returns null if not found or sha mismatch.
	 */
	async loadPartialProgress(
		owner: string,
		repo: string,
		currentSha: string
	): Promise<PartialProgress | null> {
		const key = `${owner}/${repo}-partial`;
		return new Promise((resolve) => {
			const request = indexedDB.open("gitask-cache", 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains("repos")) {
					db.createObjectStore("repos");
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("repos", "readonly");
				const getReq = tx.objectStore("repos").get(key);
				getReq.onsuccess = () => {
					const data = getReq.result as PartialProgress | undefined;
					if (data && data.sha === currentSha) {
						resolve(data);
					} else {
						resolve(null);
					}
				};
				getReq.onerror = () => resolve(null);
			};
			request.onerror = () => resolve(null);
		});
	}

	/**
	 * Clear partial progress for a repo.
	 */
	async clearPartialProgress(owner: string, repo: string): Promise<void> {
		const key = `${owner}/${repo}-partial`;
		return new Promise((resolve, reject) => {
			const request = indexedDB.open("gitask-cache", 1);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("repos", "readwrite");
				tx.objectStore("repos").delete(key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Load from IndexedDB cache if SHA matches.
	 * Returns true if cache was loaded, false if stale/missing.
	 */
	async loadFromCache(
		owner: string,
		repo: string,
		currentSha: string
	): Promise<boolean> {
		this.repoKey = `${owner}/${repo}`;

		return new Promise((resolve) => {
			const request = indexedDB.open("gitask-cache", 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains("repos")) {
					db.createObjectStore("repos");
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("repos", "readonly");
				const getReq = tx.objectStore("repos").get(this.repoKey);
				getReq.onsuccess = () => {
					const data = getReq.result;
					if (data && data.sha === currentSha) {
						this.chunks = data.chunks;
						this.graph = data.graph || {};
						// Rebuild index
						this.chunksByFile.clear();
						for (const chunk of this.chunks) {
							const fileChunks = this.chunksByFile.get(chunk.filePath) || [];
							fileChunks.push(chunk);
							this.chunksByFile.set(chunk.filePath, fileChunks);
						}
						resolve(true);
					} else {
						resolve(false);
					}
				};
				getReq.onerror = () => resolve(false);
			};
			request.onerror = () => resolve(false);
		});
	}
}
