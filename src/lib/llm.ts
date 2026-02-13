/**
 * LLM wrapper — provides a unified interface to WebLLM and Gemini.
 *
 * Supports switching between local WebGPU inference (MLC) and cloud inference (Gemini).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

export type LLMStatus = "idle" | "loading" | "ready" | "generating" | "error";

export type LLMProvider = "mlc" | "gemini";

export interface LLMConfig {
	provider: LLMProvider;
	apiKey?: string; // For Gemini
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

// ─── Internal Engine Interface ──────────────────────────────────────────────

interface LLMEngine {
	generateStream(
		messages: ChatMessage[]
	): AsyncGenerator<string, void, undefined>;
	generateFull(messages: ChatMessage[]): Promise<string>;
	dispose(): Promise<void>;
}

// ─── State ──────────────────────────────────────────────────────────────────

let activeEngine: LLMEngine | null = null;
let initPromise: Promise<void> | null = null;

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

// ─── Configuration ──────────────────────────────────────────────────────────

const STORAGE_KEY = "gitask_llm_config";

export function getLLMConfig(): LLMConfig {
	// 1. Try to load from localStorage
	if (typeof window !== "undefined") {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const config = JSON.parse(stored);
				// If provider is gemini but no key, and we have an env key, use it.
				// However, usually we want to respect the user's choice.
				// If the user explicitly saved "gemini" with empty key, they might be expecting the env key.
				return config;
			}
		} catch (e) {
			console.warn("Failed to parse LLM config", e);
		}
	}

	// 2. Default if nothing saved
	// If we have an env key, default to Gemini as requested ("use gemini shit by default")
	if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
		return { provider: "gemini" };
	}

	return { provider: "mlc" };
}

export function getEffectiveApiKey(config: LLMConfig): string | undefined {
	if (config.provider !== "gemini") return undefined;
	return config.apiKey || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
}

export function setLLMConfig(config: LLMConfig) {
	if (typeof window === "undefined") return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ─── MLC Implementation ─────────────────────────────────────────────────────

const MLC_MODEL_ID = "Qwen2-0.5B-Instruct-q4f16_1-MLC";

class MLCEngineWrapper implements LLMEngine {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private rawEngine: any;

	constructor(rawEngine: any) {
		this.rawEngine = rawEngine;
	}

	async *generateStream(
		messages: ChatMessage[]
	): AsyncGenerator<string, void, undefined> {
		const chunks = await this.rawEngine.chat.completions.create({
			messages,
			temperature: 0.3,
			max_tokens: 1024,
			stream: true,
		});

		for await (const chunk of chunks) {
			const delta = chunk.choices?.[0]?.delta?.content;
			if (delta) yield delta;
		}
	}

	async generateFull(messages: ChatMessage[]): Promise<string> {
		const reply = await this.rawEngine.chat.completions.create({
			messages,
			temperature: 0.2,
			max_tokens: 512,
		});
		return reply.choices?.[0]?.message?.content ?? "";
	}

	async dispose(): Promise<void> {
		// WebWorkerMLCEngine doesn't have a specific dispose method exposed cleanly in this version,
		// but dereferencing it is usually enough for the worker wrapper.
		this.rawEngine = null;
	}
}

// ─── Gemini Implementation ──────────────────────────────────────────────────

class GeminiEngineWrapper implements LLMEngine {
	private model: any;

	constructor(apiKey: string) {
		const genAI = new GoogleGenerativeAI(apiKey);
		// specific model for now
		this.model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
	}

	private toGeminiContent(messages: ChatMessage[]) {
		// Gemini expects specific history format.
		// System prompt is separate in Gemini but we can prepend or use systemInstruction if available.
		// For simplicity/compatibility, we'll map system to user or use systemInstruction.
		// 1.5 Flash supports systemInstruction.

		const systemMsg = messages.find((m) => m.role === "system");
		const history = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({
				role: m.role === "assistant" ? "model" : "user",
				parts: [{ text: m.content }],
			}));

		return { systemInstruction: systemMsg?.content, history };
	}

	async *generateStream(
		messages: ChatMessage[]
	): AsyncGenerator<string, void, undefined> {
		const { systemInstruction, history } = this.toGeminiContent(messages);
		// The last message should be the prompt, previous are history.
		// However, standard chat structure puts all in history-like list.
		// Gemini `startChat` takes history (excl last) and then `sendMessage(last)`.

		const lastMsg = history.pop();
		if (!lastMsg) return;

		const chat = this.model.startChat({
			systemInstruction,
			history,
		});

		const result = await chat.sendMessageStream(lastMsg.parts[0].text);
		for await (const chunk of result.stream) {
			const text = chunk.text();
			if (text) yield text;
		}
	}

	async generateFull(messages: ChatMessage[]): Promise<string> {
		const { systemInstruction, history } = this.toGeminiContent(messages);
		const lastMsg = history.pop();
		if (!lastMsg) return "";

		const chat = this.model.startChat({
			systemInstruction,
			history,
		});

		const result = await chat.sendMessage(lastMsg.parts[0].text);
		return result.response.text();
	}

	async dispose(): Promise<void> {
		this.model = null;
	}
}

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialise the LLM Engine based on current config.
 */
export async function initLLM(
	onProgress?: (msg: string) => void
): Promise<void> {
	if (activeEngine) return;
	if (initPromise) return initPromise;

	const config = getLLMConfig();
	setStatus("loading");

	initPromise = (async () => {
		try {
			if (config.provider === "gemini") {
				const paramKey = getEffectiveApiKey(config);
				if (!paramKey) {
					throw new Error("Gemini API Key is missing. Please check settings.");
				}
				onProgress?.("Initializing Gemini...");
				activeEngine = new GeminiEngineWrapper(paramKey);
				onProgress?.("Gemini Ready");
			} else {
				// Default to MLC
				onProgress?.("Loading WebLLM Engine...");
				const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");
				const worker = new Worker(
					new URL("../workers/llm-worker.ts", import.meta.url),
					{ type: "module" }
				);

				const rawEngine = await CreateWebWorkerMLCEngine(worker, MLC_MODEL_ID, {
					initProgressCallback: (progress) => {
						onProgress?.(`LLM: ${progress.text}`);
					},
					appConfig: {
						model_list: [
							{
								model:
									"https://huggingface.co/mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC",
								model_id: MLC_MODEL_ID,
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
				activeEngine = new MLCEngineWrapper(rawEngine);
				onProgress?.("Local LLM Ready");
			}
			setStatus("ready");
		} catch (err) {
			console.error("LLM Init Error", err);
			setStatus("error");
			throw err;
		}
	})();

	return initPromise;
}

/**
 * Force reload the LLM (e.g. after config change).
 */
export async function reloadLLM(onProgress?: (msg: string) => void) {
	await disposeLLM();
	return initLLM(onProgress);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function* generate(
	messages: ChatMessage[]
): AsyncGenerator<string, void, undefined> {
	if (!activeEngine)
		throw new Error("LLM not initialised. Call initLLM() first.");

	setStatus("generating");
	try {
		const stream = activeEngine.generateStream(messages);
		for await (const chunk of stream) {
			yield chunk;
		}
	} finally {
		setStatus("ready");
	}
}

export async function generateFull(messages: ChatMessage[]): Promise<string> {
	if (!activeEngine)
		throw new Error("LLM not initialised. Call initLLM() first.");

	setStatus("generating");
	try {
		return await activeEngine.generateFull(messages);
	} finally {
		setStatus("ready");
	}
}

export async function disposeLLM(): Promise<void> {
	if (activeEngine) {
		await activeEngine.dispose();
		activeEngine = null;
	}
	initPromise = null;
	setStatus("idle");
}

