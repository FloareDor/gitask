/**
 * WebLLM Web Worker — runs LLM inference off the main thread.
 *
 * This file is used as a Web Worker entry point.
 */

import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg: MessageEvent) => {
	handler.onmessage(msg);
};
