/**
 * LLM wrapper — provides a unified interface to WebLLM.
 *
 * Uses Qwen2-0.5B-Instruct (q4f16_1) via a dedicated Web Worker
 * so inference never blocks the UI thread.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: any = null;
let initPromise: Promise<void> | null = null;

export type LLMStatus = "idle" | "loading" | "ready" | "generating";

let currentStatus: LLMStatus = "idle";
const statusListeners: Set<(status: LLMStatus) => void> = new Set();

function setStatus(s: LLMStatus) {
	currentStatus = s;
	statusListeners.forEach((fn) => fn(s));
}

export function onStatusChange(fn: (status: LLMStatus) => void): () => void {
	statusListeners.add(fn);
	return () => statusListeners.delete(fn);
}

export function getLLMStatus(): LLMStatus {
	return currentStatus;
}

const MODEL_ID = "Qwen2-0.5B-Instruct-q4f16_1-MLC";

/**
 * Initialise WebLLM with a Web Worker backend.
 */
export async function initLLM(
	onProgress?: (msg: string) => void
): Promise<void> {
	if (engine) return;
	if (initPromise) return initPromise;

	setStatus("loading");

	initPromise = (async () => {
		// Dynamic import to avoid SSR issues
		const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");

		const worker = new Worker(
			new URL("../workers/llm-worker.ts", import.meta.url),
			{ type: "module" }
		);

		engine = await CreateWebWorkerMLCEngine(worker, MODEL_ID, {
			initProgressCallback: (progress) => {
				onProgress?.(`LLM: ${progress.text}`);
			},
			appConfig: {
				model_list: [
					{
						model: "https://huggingface.co/mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC",
						model_id: MODEL_ID,
						model_lib:
							"https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/" +
							"v0_2_80" +
							"/Qwen2-0.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm",
						low_resource_required: true,
						overrides: {
							context_window_size: 8192,
						},
					},
				],
			},
		});

		setStatus("ready");
		onProgress?.("LLM ready");
	})();

	return initPromise;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * Generate a streaming chat completion.
 * Yields token-by-token for the UI.
 */
export async function* generate(
	messages: ChatMessage[]
): AsyncGenerator<string, void, undefined> {
	if (!engine) throw new Error("LLM not initialised. Call initLLM() first.");

	setStatus("generating");

	try {
		const chunks = await engine.chat.completions.create({
			messages,
			temperature: 0.3,
			max_tokens: 1024,
			stream: true,
		});

		for await (const chunk of chunks) {
			const delta = chunk.choices?.[0]?.delta?.content;
			if (delta) yield delta;
		}
	} finally {
		setStatus("ready");
	}
}

/**
 * Generate a non-streaming completion (for CoVe).
 */
export async function generateFull(messages: ChatMessage[]): Promise<string> {
	if (!engine) throw new Error("LLM not initialised. Call initLLM() first.");

	setStatus("generating");

	try {
		const reply = await engine.chat.completions.create({
			messages,
			temperature: 0.2,
			max_tokens: 512,
		});
		return reply.choices?.[0]?.message?.content ?? "";
	} finally {
		setStatus("ready");
	}
}

/**
 * Tear down the engine.
 */
export async function disposeLLM(): Promise<void> {
	if (engine) {
		// WebWorkerMLCEngine doesn't have a dispose, but we can nullify
		engine = null;
		initPromise = null;
		setStatus("idle");
	}
}
