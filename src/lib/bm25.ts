import type { EmbeddedChunk } from "./embedder";
import {
	buildBM25Index,
	scoreBM25Index,
	type BM25Doc,
	type BM25Index,
	type BM25ScoreOptions,
} from "./bm25-core";

interface BM25WorkerScoreRequest {
	type: "score";
	requestId: number;
	signature: string;
	query: string;
	limit?: number;
	k1?: number;
	b?: number;
	docs?: BM25Doc[];
}

interface BM25WorkerScoreResult {
	type: "result";
	requestId: number;
	entries: Array<[string, number]>;
	error?: string;
}

interface PendingWorkerRequest {
	resolve: (entries: Array<[string, number]>) => void;
	reject: (error: unknown) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

const WORKER_TIMEOUT_MS = 12000;

let bm25Worker: Worker | null = null;
let bm25WorkerSignature: string | null = null;
let bm25WorkerUnavailable = false;
let nextWorkerRequestId = 1;
const pendingWorkerRequests = new Map<number, PendingWorkerRequest>();
interface CachedSignature {
	length: number;
	lastId: string;
	signature: string;
}
const chunkSignatureCache = new WeakMap<EmbeddedChunk[], CachedSignature>();

interface CachedSyncIndex {
	signature: string;
	index: BM25Index;
}

const syncIndexCache = new WeakMap<EmbeddedChunk[], CachedSyncIndex>();

function buildChunkSignature(chunks: EmbeddedChunk[]): string {
	if (chunks.length === 0) return "0:empty:empty";
	const lastId = chunks[chunks.length - 1].id;
	const cached = chunkSignatureCache.get(chunks);
	if (cached && cached.length === chunks.length && cached.lastId === lastId) {
		return cached.signature;
	}

	// FNV-1a style hash over chunk IDs for stable, cheap cache keys.
	let hash = 0x811c9dc5;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.id.length; i++) {
			hash ^= chunk.id.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
	}

	const signature = `${chunks.length}:${(hash >>> 0).toString(16)}`;
	chunkSignatureCache.set(chunks, {
		length: chunks.length,
		lastId,
		signature,
	});
	return signature;
}

function chunksToDocs(chunks: EmbeddedChunk[]): BM25Doc[] {
	return chunks.map((chunk) => ({
		id: chunk.id,
		text: chunk.code,
	}));
}

function rejectPendingWorkerRequests(error: Error): void {
	for (const [requestId, pending] of pendingWorkerRequests.entries()) {
		clearTimeout(pending.timeoutId);
		pending.reject(error);
		pendingWorkerRequests.delete(requestId);
	}
}

function disposeBM25Worker(errorMessage?: string): void {
	if (bm25Worker) {
		bm25Worker.terminate();
	}
	bm25Worker = null;
	bm25WorkerSignature = null;
	if (errorMessage) {
		rejectPendingWorkerRequests(new Error(errorMessage));
	}
}

function canUseWorker(): boolean {
	return typeof window !== "undefined" && typeof Worker !== "undefined";
}

function getOrCreateWorker(): Worker | null {
	if (bm25WorkerUnavailable || !canUseWorker()) return null;
	if (bm25Worker) return bm25Worker;

	try {
		const worker = new Worker(
			new URL("../workers/bm25-worker.ts", import.meta.url),
			{ type: "module" }
		);

		worker.onmessage = (event: MessageEvent<BM25WorkerScoreResult>) => {
			const payload = event.data;
			if (!payload || payload.type !== "result") return;

			const pending = pendingWorkerRequests.get(payload.requestId);
			if (!pending) return;
			pendingWorkerRequests.delete(payload.requestId);
			clearTimeout(pending.timeoutId);

			if (payload.error) {
				pending.reject(new Error(payload.error));
				return;
			}
			pending.resolve(payload.entries);
		};

		worker.onerror = () => {
			disposeBM25Worker("BM25 worker crashed; falling back to synchronous sparse retrieval.");
		};

		bm25Worker = worker;
		return worker;
	} catch (error) {
		bm25WorkerUnavailable = true;
		console.warn("BM25 worker unavailable; using synchronous sparse retrieval.", error);
		return null;
	}
}

function scoreSync(chunks: EmbeddedChunk[], query: string, options: BM25ScoreOptions): Map<string, number> {
	if (chunks.length === 0) return new Map();

	const signature = buildChunkSignature(chunks);
	const cached = syncIndexCache.get(chunks);
	let index: BM25Index;

	if (cached && cached.signature === signature) {
		index = cached.index;
	} else {
		index = buildBM25Index(chunksToDocs(chunks));
		syncIndexCache.set(chunks, { signature, index });
	}

	return new Map(scoreBM25Index(index, query, options));
}

function scoreWithWorker(
	worker: Worker,
	chunks: EmbeddedChunk[],
	query: string,
	options: BM25ScoreOptions
): Promise<Map<string, number>> {
	return new Promise<Map<string, number>>((resolve, reject) => {
		const requestId = nextWorkerRequestId++;
		const signature = buildChunkSignature(chunks);
		const sendDocs = bm25WorkerSignature !== signature;
		const payload: BM25WorkerScoreRequest = {
			type: "score",
			requestId,
			signature,
			query,
			limit: options.limit,
			k1: options.k1,
			b: options.b,
			docs: sendDocs ? chunksToDocs(chunks) : undefined,
		};

		const timeoutId = setTimeout(() => {
			const pending = pendingWorkerRequests.get(requestId);
			if (!pending) return;
			pendingWorkerRequests.delete(requestId);
			disposeBM25Worker("BM25 worker timed out; restarting worker.");
			reject(new Error("BM25 worker request timed out."));
		}, WORKER_TIMEOUT_MS);

		pendingWorkerRequests.set(requestId, {
			resolve: (entries) => resolve(new Map(entries)),
			reject,
			timeoutId,
		});

		try {
			worker.postMessage(payload);
			bm25WorkerSignature = signature;
		} catch (error) {
			pendingWorkerRequests.delete(requestId);
			clearTimeout(timeoutId);
			reject(error);
		}
	});
}

/**
 * BM25 sparse retrieval with worker offload when available.
 * Falls back to synchronous scoring in environments without Worker support.
 */
export async function bm25Search(
	chunks: EmbeddedChunk[],
	query: string,
	options: BM25ScoreOptions = {}
): Promise<Map<string, number>> {
	if (chunks.length === 0) return new Map();

	const worker = getOrCreateWorker();
	if (!worker) {
		return scoreSync(chunks, query, options);
	}

	try {
		return await scoreWithWorker(worker, chunks, query, options);
	} catch (error) {
		console.warn("BM25 worker search failed; falling back to synchronous scoring.", error);
		return scoreSync(chunks, query, options);
	}
}
