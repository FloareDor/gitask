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
				pooled[j] = Number(features[rowBase + j] ?? 0);
			}
			output.push(l2Normalize(pooled));
			continue;
		}

		let tokenCount = 0;
		for (let t = 0; t < seq; t++) {
			const tokenActive = hasMask
				? Number(
						attentionMaskData![
							b * (attentionMaskDims![1] ?? 0) + t
						] ?? 0
				  ) > 0
				: true;
			if (!tokenActive) continue;
			const tokenBase = b * seq * width + t * width;
			for (let j = 0; j < width; j++) {
				pooled[j] += Number(features[tokenBase + j] ?? 0);
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

async function embedTexts(texts: string[]): Promise<number[][]> {
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
