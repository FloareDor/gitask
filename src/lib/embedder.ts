/**
 * WebGPU Embedding Pipeline using Transformers.js
 *
 * Runs a quantized embedding model on the user's GPU via WebGPU,
 * with automatic fallback to WASM if WebGPU is unavailable.
 */

import type { CodeChunk } from "./chunker";
import { detectWebGPUAvailability } from "./webgpu";

export interface EmbeddedChunk extends CodeChunk {
	embedding: number[];
}

// Lazy-loaded pipeline
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedPipeline: any = null;
let pipelinePromise: Promise<void> | null = null;

/**
 * Initialize the embedding model.
 * Call once; subsequent calls are no-ops.
 */
export async function initEmbedder(
	onProgress?: (msg: string) => void
): Promise<void> {
	if (embedPipeline) return;
	if (pipelinePromise) return pipelinePromise;

	pipelinePromise = (async () => {
		onProgress?.("Loading embedding model...");

		// Dynamic import so this does not break SSR
		const { pipeline, env } = await import("@huggingface/transformers");

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

		embedPipeline = await pipeline(
			"feature-extraction",
			"Xenova/all-MiniLM-L6-v2",
			{
				device: device as any,
				session_options: {
					log_severity_level: 3,
				},
			} as any
		);

		onProgress?.("Embedding model ready");
	})();

	return pipelinePromise;
}

/**
 * Embed a single text string. Returns the mean-pooled, normalized vector.
 */
export async function embedText(text: string): Promise<number[]> {
	if (!embedPipeline) {
		await initEmbedder();
	}

	const output = await embedPipeline(text, {
		pooling: "mean",
		normalize: true,
	});

	return Array.from(output.data as Float32Array);
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

	return results;
}

/**
 * Check if the embedder is ready.
 */
export function isEmbedderReady(): boolean {
	return embedPipeline != null;
}
