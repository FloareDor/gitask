/// <reference lib="webworker" />

import { buildBM25Index, scoreBM25Index, type BM25Doc, type BM25Index } from "../lib/bm25-core";

interface BM25ScoreRequest {
	type: "score";
	requestId: number;
	signature: string;
	query: string;
	limit?: number;
	k1?: number;
	b?: number;
	docs?: BM25Doc[];
}

interface BM25ScoreResult {
	type: "result";
	requestId: number;
	entries: Array<[string, number]>;
	error?: string;
}

let cachedSignature: string | null = null;
let cachedIndex: BM25Index | null = null;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<BM25ScoreRequest>) => {
	const message = event.data;
	if (!message || message.type !== "score") return;

	try {
		const needsRebuild = !cachedIndex || cachedSignature !== message.signature;
		if (needsRebuild) {
			if (!message.docs || message.docs.length === 0) {
				throw new Error("BM25 worker requires document payload for a new repository signature.");
			}
			cachedIndex = buildBM25Index(message.docs);
			cachedSignature = message.signature;
		}

		const entries = cachedIndex
			? scoreBM25Index(cachedIndex, message.query, {
				limit: message.limit,
				k1: message.k1,
				b: message.b,
			})
			: [];

		const response: BM25ScoreResult = {
			type: "result",
			requestId: message.requestId,
			entries,
		};
		workerScope.postMessage(response);
	} catch (error) {
		const response: BM25ScoreResult = {
			type: "result",
			requestId: message.requestId,
			entries: [],
			error: error instanceof Error ? error.message : String(error),
		};
		workerScope.postMessage(response);
	}
};

export { };
