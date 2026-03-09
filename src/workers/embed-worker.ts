/// <reference lib="webworker" />

/**
 * Embedding Web Worker
 *
 * Runs an isolated embedding model instance (WASM/INT8) for parallel CPU embedding.
 * Created by embedder.ts when workerCount > 1 on WASM devices.
 */

import { initEmbedder, embedTexts } from "../lib/embedder";

interface EmbedRequest {
	type: "embed";
	requestId: number;
	texts: string[];
	batchSize: number;
}

type EmbedWorkerOutput =
	| { type: "batch_result"; requestId: number; batchEmbeddings: number[][]; done: number; total: number }
	| { type: "result"; requestId: number; embeddings: number[][]; error?: string };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
	if (!initPromise) {
		// Workers cannot use WebGPU — force WASM with INT8 quantization
		initPromise = initEmbedder(undefined, "wasm");
	}
	return initPromise;
}

workerScope.onmessage = async (event: MessageEvent<EmbedRequest>) => {
	const msg = event.data;
	if (!msg || msg.type !== "embed") return;

	const { requestId, texts, batchSize } = msg;

	try {
		await ensureInit();
		const allEmbeddings: number[][] = [];

		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);
			const batchEmbeddings = await embedTexts(batch);
			allEmbeddings.push(...batchEmbeddings);

			const done = Math.min(i + batchSize, texts.length);
			workerScope.postMessage({
				type: "batch_result",
				requestId,
				batchEmbeddings,
				done,
				total: texts.length,
			} as EmbedWorkerOutput);
		}

		workerScope.postMessage({
			type: "result",
			requestId,
			embeddings: allEmbeddings,
		} as EmbedWorkerOutput);
	} catch (err) {
		workerScope.postMessage({
			type: "result",
			requestId,
			embeddings: [],
			error: err instanceof Error ? err.message : String(err),
		} as EmbedWorkerOutput);
	}
};

export {};
