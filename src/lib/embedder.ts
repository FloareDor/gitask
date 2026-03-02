/**
 * WebGPU Embedding Pipeline using Transformers.js
 *
 * Runs local embeddings on the user's device.
 * Uses Xenova/all-MiniLM-L12-v2 (mean pooled token embeddings),
 * with WebGPU preferred and WASM fallback.
 */

import type { CodeChunk } from "./chunker";
import { detectWebGPUAvailability } from "./webgpu";
import { recordEmbedding } from "./metrics";

export interface EmbeddedChunk extends CodeChunk {
	embedding: number[];
}

const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L12-v2";
const EMBEDDING_MODEL_FILE: string | undefined = undefined;

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

const EMBEDDER_INIT_TIMEOUT_MS = 90_000;

/**
 * Initialize the embedding model.
 * Call once; subsequent calls are no-ops.
 * Rejects with a user-visible error if the model takes longer than 90 s to load.
 */
export async function initEmbedder(
	onProgress?: (msg: string) => void
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

				// Detect WebGPU, fall back to WASM
				const availability = await detectWebGPUAvailability();
				const device = availability.supported ? "webgpu" : "wasm";
				console.info(`Embedder using device: ${device.toUpperCase()}`);
				if (!availability.supported) {
					console.info(`WebGPU fallback reason: ${availability.reason}`);
				}
				onProgress?.(`Using device: ${device}`);

				const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL_ID);
				const modelOptions: Record<string, unknown> = {
					device: device as any,
					session_options: {
						log_severity_level: 3,
					},
				};
				if (EMBEDDING_MODEL_FILE) {
					modelOptions.subfolder = "";
					modelOptions.model_file_name = EMBEDDING_MODEL_FILE;
				}
				const model = await AutoModel.from_pretrained(EMBEDDING_MODEL_ID, modelOptions as any);
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

function meanPoolAndNormalize(
	features: ArrayLike<number>,
	dims: number[]
): number[] {
	let seq = 0;
	let width = 0;
	let offset = 0;

	if (dims.length === 3) {
		const batch = dims[0] ?? 0;
		seq = dims[1] ?? 0;
		width = dims[2] ?? 0;
		if (batch < 1) throw new Error(`Invalid embedding batch size: ${batch}`);
		// Use the first (and only) sequence in the batch.
		offset = 0;
	} else if (dims.length === 2) {
		seq = dims[0] ?? 0;
		width = dims[1] ?? 0;
		offset = 0;
	} else {
		throw new Error(`Unsupported embedding tensor dims: [${dims.join(", ")}]`);
	}

	if (seq <= 0 || width <= 0) {
		throw new Error(`Invalid embedding tensor dims: [${dims.join(", ")}]`);
	}

	const pooled = new Float32Array(width);
	for (let t = 0; t < seq; t++) {
		const base = offset + t * width;
		for (let j = 0; j < width; j++) {
			pooled[j] += Number(features[base + j] ?? 0);
		}
	}

	for (let j = 0; j < width; j++) {
		pooled[j] /= seq;
	}

	let norm = 0;
	for (let j = 0; j < width; j++) {
		norm += pooled[j] * pooled[j];
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let j = 0; j < width; j++) {
			pooled[j] /= norm;
		}
	}

	return Array.from(pooled);
}

/**
 * Embed a single text string. Returns the mean-pooled, normalized vector.
 */
export async function embedText(text: string): Promise<number[]> {
	if (!embedRuntime) {
		await initEmbedder();
	}

	if (!embedRuntime) {
		throw new Error("Embedding runtime failed to initialize.");
	}

	const inputs = embedRuntime.tokenizer(text, {
		truncation: true,
		padding: false,
	});
	const output = await embedRuntime.model(inputs);
	const hidden = output?.last_hidden_state ?? output?.output;
	if (!hidden?.data || !Array.isArray(hidden?.dims)) {
		throw new Error(
			`Embedding model "${EMBEDDING_MODEL_ID}" returned an unexpected output shape.`
		);
	}

	return meanPoolAndNormalize(hidden.data as ArrayLike<number>, hidden.dims as number[]);
}

/**
 * Embed an array of code chunks in batches.
 * Supports cancellation via optional AbortSignal (checked between batches).
 * Optional onBatchComplete called after each batch for incremental persistence.
 */
export async function embedChunks(
	chunks: CodeChunk[],
	onProgress?: (done: number, total: number) => void,
	batchSize: number = 8,
	signal?: AbortSignal,
	onBatchComplete?: (embeddedSoFar: EmbeddedChunk[]) => void
): Promise<EmbeddedChunk[]> {
	await initEmbedder();

	const results: EmbeddedChunk[] = [];
	const startTime = performance.now();

	for (let i = 0; i < chunks.length; i += batchSize) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const batch = chunks.slice(i, i + batchSize);

		// Process batch sequentially (transformers.js does not support true batching in browser)
		for (const chunk of batch) {
			const embedding = await embedText(chunk.code);
			results.push({ ...chunk, embedding });
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
