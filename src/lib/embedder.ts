/**
 * WebGPU Embedding Pipeline using Transformers.js
 *
 * Runs local embeddings on the user's device.
 * Uses Xenova/all-MiniLM-L6-v2 (mean pooled token embeddings),
 * with WebGPU preferred and WASM fallback.
 *
 * Performance optimizations:
 * - INT8 quantization on WASM (~2-4x faster, ~95% quality)
 * - Adaptive batch size based on device (WebGPU: 16-32, WASM: 2-8)
 * - Parallel workers on WASM + multi-core devices (2x throughput)
 */

import type { CodeChunk } from "./chunker";
import { detectWebGPUAvailability } from "./webgpu";
import { recordEmbedding } from "./metrics";

export interface EmbeddedChunk extends CodeChunk {
	embedding: number[];
}

export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type EmbeddingRuntime = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tokenizer: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	model: any;
};

// Lazy-loaded runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedRuntime: EmbeddingRuntime | null = null;
let pipelinePromise: Promise<void> | null = null;
let activeDevice: "webgpu" | "wasm" | null = null;

const EMBEDDER_INIT_TIMEOUT_MS = 90_000;

/** Returns the device the embedder is actually running on, or null if not yet initialized. */
export function getEmbedderDevice(): "webgpu" | "wasm" | null {
	return activeDevice;
}

/**
 * Compute adaptive embedding config based on the active device and CPU count.
 *
 * Scales with device capability while staying conservative on weaker machines.
 * - WebGPU: larger batches are viable with the lighter L6 model
 * - WASM: scale batches with CPU/RAM, parallel workers only on beefy desktops
 */
export function resolveEmbedConfig(device: "webgpu" | "wasm"): {
	batchSize: number;
	workerCount: number;
} {
	const cores =
		typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
			? navigator.hardwareConcurrency
			: 4;

	const memoryGB =
		typeof navigator !== "undefined"
			? (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0
			: 0;

	if (device === "webgpu") {
		// L6 is light enough to push larger GPU batches without going straight to max.
		if (cores >= 16 || memoryGB >= 16) return { batchSize: 32, workerCount: 1 };
		if (cores >= 8 || memoryGB >= 8) return { batchSize: 24, workerCount: 1 };
		return { batchSize: 16, workerCount: 1 };
	}

	// WASM runs on CPU — scale up, but keep weaker devices responsive.
	// Parallel workers each load a full model copy, so require strong CPU + RAM.
	const useParallel = cores >= 12 && memoryGB >= 8;

	if (useParallel) return { batchSize: 8, workerCount: 2 };
	if (cores >= 8 || memoryGB >= 8) return { batchSize: 6, workerCount: 1 };
	if (cores >= 4 || memoryGB >= 4) return { batchSize: 4, workerCount: 1 };
	return { batchSize: 2, workerCount: 1 };
}

/**
 * Initialize the embedding model.
 * Call once; subsequent calls are no-ops.
 * Rejects with a user-visible error if the model takes longer than 90 s to load.
 *
 * @param deviceOverride - Force a specific device (used by embed workers which can't use WebGPU)
 */
export async function initEmbedder(
	onProgress?: (msg: string) => void,
	deviceOverride?: "webgpu" | "wasm"
): Promise<void> {
	if (embedRuntime) return;
	if (pipelinePromise) return pipelinePromise;

	pipelinePromise = new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			pipelinePromise = null;
			embedRuntime = null;
			reject(
				new Error(
					"Embedding model failed to load within 90 s. Check your network connection and reload the page."
				)
			);
		}, EMBEDDER_INIT_TIMEOUT_MS);

		(async () => {
			try {
				onProgress?.("Loading embedding model...");

				// Dynamic import so this does not break SSR
				const { AutoTokenizer, AutoModel, env } = await import("@huggingface/transformers");

				// Disable local model check (we always download from HF)
				env.allowLocalModels = false;

				// Suppress ONNX Runtime warnings about execution provider node assignments.
				// logSeverityLevel: 0=verbose, 1=info, 2=warning, 3=error, 4=fatal
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const onnxEnv = (env as any).backends?.onnx;
				if (onnxEnv) {
					onnxEnv.logSeverityLevel = 3;
					onnxEnv.logLevel = "error";
				}

				// Resolve device: use override (e.g. from embed worker) or detect
				let device: "webgpu" | "wasm";
				if (deviceOverride) {
					device = deviceOverride;
				} else {
					const availability = await detectWebGPUAvailability();
					device = availability.supported ? "webgpu" : "wasm";
					if (!availability.supported) {
						console.info(`WebGPU fallback reason: ${availability.reason}`);
					}
				}
				activeDevice = device;
				console.info(`Embedder using device: ${device.toUpperCase()}`);
				onProgress?.(`Using device: ${device}`);

				const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL_ID);

				// On WASM, load INT8 quantized model (~2-4x faster, ~95% quality retained).
				// On WebGPU, use fp32 — GPU handles it fast without quality tradeoff.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const modelOptions: Record<string, any> = {
					device,
					session_options: { log_severity_level: 3 },
				};
				if (device === "wasm") {
					modelOptions.dtype = "q8";
				}

				let model;
				try {
					model = await AutoModel.from_pretrained(EMBEDDING_MODEL_ID, modelOptions);
					if (device === "wasm") {
						console.info("Embedder loaded INT8 quantized model (q8)");
						onProgress?.("Loaded INT8 model (faster)");
					}
				} catch {
					// INT8 not available for this model variant — fall back to fp32
					console.warn("INT8 model unavailable, falling back to fp32");
					delete modelOptions.dtype;
					model = await AutoModel.from_pretrained(EMBEDDING_MODEL_ID, modelOptions);
				}

				embedRuntime = { tokenizer, model };

				clearTimeout(timeoutId);
				onProgress?.(`Embedding model ready (${EMBEDDING_MODEL_ID})`);
				resolve();
			} catch (err) {
				clearTimeout(timeoutId);
				pipelinePromise = null;
				embedRuntime = null;
				reject(err);
			}
		})();
	});

	return pipelinePromise;
}

function l2Normalize(values: Float32Array): number[] {
	let norm = 0;
	for (let i = 0; i < values.length; i++) {
		norm += values[i] * values[i];
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < values.length; i++) {
			values[i] /= norm;
		}
	}
	return Array.from(values);
}

function meanPoolAndNormalizeBatch(
	features: ArrayLike<number>,
	dims: number[],
	attentionMaskData?: ArrayLike<number>,
	attentionMaskDims?: number[]
): number[][] {
	let batch = 0;
	let seq = 0;
	let width = 0;
	let isAlreadyPooledBatch = false;

	if (dims.length === 3) {
		batch = dims[0] ?? 0;
		seq = dims[1] ?? 0;
		width = dims[2] ?? 0;
	} else if (dims.length === 2) {
		const maybeBatch = dims[0] ?? 0;
		const maybeWidth = dims[1] ?? 0;
		if (
			attentionMaskDims &&
			attentionMaskDims.length === 2 &&
			(attentionMaskDims[0] ?? 0) === maybeBatch
		) {
			// Some models return [batch, width] directly.
			batch = maybeBatch;
			width = maybeWidth;
			seq = 1;
			isAlreadyPooledBatch = true;
		} else {
			// Single sequence [seq, width].
			batch = 1;
			seq = maybeBatch;
			width = maybeWidth;
		}
	} else {
		throw new Error(`Unsupported embedding tensor dims: [${dims.join(", ")}]`);
	}

	if (batch <= 0 || seq <= 0 || width <= 0) {
		throw new Error(`Invalid embedding tensor dims: [${dims.join(", ")}]`);
	}

	const hasMask =
		!isAlreadyPooledBatch &&
		!!attentionMaskData &&
		!!attentionMaskDims &&
		attentionMaskDims.length === 2 &&
		(attentionMaskDims[0] ?? 0) === batch &&
		(attentionMaskDims[1] ?? 0) === seq;

	const output: number[][] = [];
	for (let b = 0; b < batch; b++) {
		const pooled = new Float32Array(width);

		if (isAlreadyPooledBatch) {
			const rowBase = b * width;
			for (let j = 0; j < width; j++) {
				pooled[j] = (features[rowBase + j] ?? 0) as number;
			}
			output.push(l2Normalize(pooled));
			continue;
		}

		let tokenCount = 0;
		for (let t = 0; t < seq; t++) {
			const tokenActive = hasMask
				? (attentionMaskData![b * (attentionMaskDims![1] ?? 0) + t] ?? 0) > 0
				: true;
			if (!tokenActive) continue;
			const tokenBase = b * seq * width + t * width;
			for (let j = 0; j < width; j++) {
				pooled[j] += (features[tokenBase + j] ?? 0) as number;
			}
			tokenCount += 1;
		}

		const divisor = tokenCount > 0 ? tokenCount : seq;
		for (let j = 0; j < width; j++) {
			pooled[j] /= divisor;
		}
		output.push(l2Normalize(pooled));
	}

	return output;
}

/**
 * Embed a batch of text strings. Exported for use by embed workers.
 * Returns mean-pooled, L2-normalized vectors.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
	if (!embedRuntime) {
		await initEmbedder();
	}
	if (!embedRuntime) {
		throw new Error("Embedding runtime failed to initialize.");
	}
	if (texts.length === 0) return [];

	const inputs = embedRuntime.tokenizer(texts, {
		truncation: true,
		padding: true,
	});
	const output = await embedRuntime.model(inputs);
	const hidden = output?.last_hidden_state ?? output?.output;
	if (!hidden?.data || !Array.isArray(hidden?.dims)) {
		throw new Error(
			`Embedding model "${EMBEDDING_MODEL_ID}" returned an unexpected output shape.`
		);
	}

	return meanPoolAndNormalizeBatch(
		hidden.data as ArrayLike<number>,
		hidden.dims as number[],
		inputs?.attention_mask?.data as ArrayLike<number> | undefined,
		inputs?.attention_mask?.dims as number[] | undefined
	);
}

/**
 * Embed a single text string. Returns the mean-pooled, normalized vector.
 */
export async function embedText(text: string): Promise<number[]> {
	const vectors = await embedTexts([text]);
	if (vectors.length !== 1) {
		throw new Error(`Embedding model "${EMBEDDING_MODEL_ID}" returned ${vectors.length} vectors for a single input.`);
	}
	return vectors[0];
}

type EmbedWorkerOutput =
	| { type: "batch_result"; requestId: number; batchEmbeddings: number[][]; done: number; total: number }
	| { type: "result"; requestId: number; embeddings: number[][]; error?: string };

/**
 * Embed chunks in parallel across N Web Workers (WASM only).
 * Each worker loads its own INT8 model instance.
 *
 * Note: onBatchComplete is not called incrementally during parallel processing
 * (workers process non-overlapping partitions, so there's no safe sequential prefix
 * until the final merge). A single onBatchComplete call fires at the end.
 */
async function embedChunksParallel(
	chunks: CodeChunk[],
	onProgress: ((done: number, total: number) => void) | undefined,
	batchSize: number,
	signal: AbortSignal | undefined,
	onBatchComplete: ((embeddedSoFar: EmbeddedChunk[]) => void) | undefined,
	workerCount: number
): Promise<EmbeddedChunk[]> {
	const partitionSize = Math.ceil(chunks.length / workerCount);
	const partitions: CodeChunk[][] = [];
	for (let i = 0; i < workerCount; i++) {
		partitions.push(chunks.slice(i * partitionSize, (i + 1) * partitionSize));
	}

	// Track per-partition completed chunks for merged progress
	const partitionDone = new Array(workerCount).fill(0);
	const partitionResults: EmbeddedChunk[][] = partitions.map(() => []);

	await Promise.all(
		partitions.map((partition, workerIdx) =>
			new Promise<void>((resolve, reject) => {
				if (partition.length === 0) {
					resolve();
					return;
				}

				const worker = new Worker(
					new URL("../workers/embed-worker.ts", import.meta.url),
					{ type: "module" }
				);

				worker.onmessage = (e: MessageEvent<EmbedWorkerOutput>) => {
					const msg = e.data;

					if (msg.type === "batch_result") {
						const { batchEmbeddings, done } = msg;
						const batchStart = done - batchEmbeddings.length;
						for (let j = 0; j < batchEmbeddings.length; j++) {
							const chunk = partition[batchStart + j];
							if (chunk) {
								partitionResults[workerIdx].push({ ...chunk, embedding: batchEmbeddings[j] });
							}
						}
						partitionDone[workerIdx] = done;

						const totalDone = partitionDone.reduce((a, b) => a + b, 0);
						onProgress?.(totalDone, chunks.length);

						if (signal?.aborted) {
							worker.terminate();
							reject(new DOMException("Aborted", "AbortError"));
						}
					} else if (msg.type === "result") {
						worker.terminate();
						if (msg.error) {
							reject(new Error(msg.error));
						} else {
							resolve();
						}
					}
				};

				worker.onerror = (e) => {
					worker.terminate();
					reject(new Error(e.message ?? "Embed worker error"));
				};

				worker.postMessage({
					type: "embed",
					requestId: workerIdx,
					texts: partition.map((c) => c.code),
					batchSize,
				});
			})
		)
	);

	// Merge partition results in original chunk order
	const allEmbedded = partitionResults.flat();
	onBatchComplete?.(allEmbedded);
	return allEmbedded;
}

/**
 * Embed an array of code chunks in batches.
 * Supports cancellation via optional AbortSignal (checked between batches).
 * Optional onBatchComplete called after each batch for incremental persistence.
 *
 * When workerCount > 1 (WASM + multi-core), delegates to parallel workers for ~2x throughput.
 * In parallel mode, onBatchComplete fires once at the end rather than incrementally.
 */
export async function embedChunks(
	chunks: CodeChunk[],
	onProgress?: (done: number, total: number) => void,
	batchSize: number = 8,
	signal?: AbortSignal,
	onBatchComplete?: (embeddedSoFar: EmbeddedChunk[]) => void,
	workerCount: number = 1
): Promise<EmbeddedChunk[]> {
	if (
		workerCount > 1 &&
		chunks.length > workerCount &&
		typeof Worker !== "undefined"
	) {
		const startTime = performance.now();
		const result = await embedChunksParallel(
			chunks, onProgress, batchSize, signal, onBatchComplete, workerCount
		);
		recordEmbedding(chunks.length, performance.now() - startTime);
		return result;
	}

	// Single-thread path
	await initEmbedder();

	const results: EmbeddedChunk[] = [];
	const startTime = performance.now();

	for (let i = 0; i < chunks.length; i += batchSize) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const batch = chunks.slice(i, i + batchSize);
		const embeddings = await embedTexts(batch.map((chunk) => chunk.code));
		if (embeddings.length !== batch.length) {
			throw new Error(
				`Embedding batch size mismatch: expected ${batch.length}, got ${embeddings.length}.`
			);
		}
		for (let j = 0; j < batch.length; j++) {
			results.push({ ...batch[j], embedding: embeddings[j] });
		}

		const done = Math.min(i + batchSize, chunks.length);
		onProgress?.(done, chunks.length);
		onBatchComplete?.(results);
	}

	recordEmbedding(chunks.length, performance.now() - startTime);

	return results;
}

/**
 * Check if the embedder is ready.
 */
export function isEmbedderReady(): boolean {
	return embedRuntime != null;
}
