/**
 * LLM wrapper — provides a unified interface to WebLLM and Gemini.
 *
 * Supports switching between local WebGPU inference (MLC) and cloud inference (Gemini).
 * BYOK Gemini keys are stored encrypted via byok-vault, not in config.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiVault } from "./gemini-vault";

export type LLMStatus = "idle" | "loading" | "ready" | "generating" | "error";

export type LLMProvider = "mlc" | "gemini";

export interface LLMConfig {
	provider: LLMProvider;
	/** @deprecated For legacy migration only; BYOK keys now in vault */
	apiKey?: string;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

function normalizeGeminiError(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();

	if (
		lower.includes("api key not valid") ||
		lower.includes("invalid api key") ||
		lower.includes("api_key_invalid") ||
		lower.includes("authentication") ||
		lower.includes("unauthorized")
	) {
		return new Error(
			"Gemini API key is invalid or rejected. Open LLM Settings and update your key."
		);
	}

	if (lower.includes("permission") || lower.includes("forbidden")) {
		return new Error(
			"Gemini request was denied. Check your API key permissions in LLM Settings."
		);
	}

	return new Error(message);
}

async function extractErrorText(response: Response): Promise<string> {
	try {
		const data = await response.json();
		if (data && typeof data.error === "string" && data.error.trim().length > 0) {
			return data.error;
		}
		if (data && typeof data.message === "string" && data.message.trim().length > 0) {
			return data.message;
		}
	} catch {
		// Fall through to text/status.
	}
	try {
		const text = await response.text();
		if (text.trim().length > 0) return text;
	} catch {
		// Ignore text read failures.
	}
	return response.statusText || `HTTP ${response.status}`;
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
	// NOW: we check boolean flag, since key is hidden
	if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_HAS_GEMINI_KEY) {
		return { provider: "gemini" };
	}

	return { provider: "mlc" };
}

/**
 * Check if there is a legacy plain-text apiKey in config (for migration).
 */
export function hasLegacyApiKey(config: LLMConfig): boolean {
	return config.provider === "gemini" && !!config.apiKey;
}

export function setLLMConfig(config: LLMConfig) {
	if (typeof window === "undefined") return;
	// Never persist apiKey — BYOK keys live in vault
	const { apiKey: _omit, ...safe } = config;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
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

type BYOKVaultRef = import("byok-vault").BYOKVault;

class GeminiEngineWrapper implements LLMEngine {
	private vault: BYOKVaultRef | null;
	private useProxy: boolean;

	constructor(vaultOrProxy: { vault: BYOKVaultRef } | { useProxy: true }) {
		if ("vault" in vaultOrProxy) {
			this.vault = vaultOrProxy.vault;
			this.useProxy = false;
		} else {
			this.vault = null;
			this.useProxy = true;
		}
	}

	private toGeminiContent(messages: ChatMessage[]) {
		const systemMsg = messages.find((m) => m.role === "system");
		const history = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({
				role: m.role === "assistant" ? "model" : "user",
				parts: [{ text: m.content }],
			}));

		// Fold system instruction into first user message (some models don't support systemInstruction)
		const systemPrefix = systemMsg?.content
			? `${systemMsg.content}\n\n---\n\n`
			: "";
		if (systemPrefix) {
			const firstUser = history.find((h) => h.role === "user");
			if (firstUser) {
				firstUser.parts[0].text = systemPrefix + firstUser.parts[0].text;
			}
			// else: lastMsg (popped below) is the first user message; we'll prepend there
		}

		return { history, systemPrefix };
	}

	private async collectGeminiStream(
		messages: ChatMessage[],
		apiKey: string
	): Promise<string[]> {
		const { history, systemPrefix } = this.toGeminiContent(messages);
		const lastMsg = history.pop();
		if (lastMsg && systemPrefix) {
			// First user message was lastMsg (single-turn)
			lastMsg.parts[0].text = systemPrefix + lastMsg.parts[0].text;
		}
		if (!lastMsg) return [];

		const genAI = new GoogleGenerativeAI(apiKey);
		const model = genAI.getGenerativeModel({
			model: "gemini-2.5-flash",
		});
		const chat = model.startChat({ history });

		try {
			const result = await chat.sendMessageStream(lastMsg.parts[0].text);
			const out: string[] = [];
			for await (const chunk of result.stream) {
				const text = chunk.text();
				if (text) out.push(text);
			}
			return out;
		} catch (err) {
			throw normalizeGeminiError(err);
		}
	}

	async *generateStream(
		messages: ChatMessage[]
	): AsyncGenerator<string, void, undefined> {
		if (this.useProxy) {
			// Proxy via server
			const response = await fetch("/api/gemini", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messages }),
			});

			if (!response.ok) {
				const details = await extractErrorText(response);
				throw normalizeGeminiError(
					new Error(`Gemini API request failed (${response.status}): ${details}`)
				);
			}
			if (!response.body) throw new Error("No response body");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					yield decoder.decode(value, { stream: true });
				}
			} catch (err) {
				throw normalizeGeminiError(err);
			}
			return;
		}

		// BYOK: run inside vault scope, collect chunks then yield
		if (!this.vault) throw new Error("Vault not configured");
		const runWithKey = (apiKey: string) => this.collectGeminiStream(messages, apiKey);
		const chunks = await this.vault.withKeyScope(async () =>
			this.vault!.withKey(runWithKey)
		);

		for (const chunk of chunks) {
			yield chunk;
		}
	}

	async generateFull(messages: ChatMessage[]): Promise<string> {
		let fullText = "";
		for await (const chunk of this.generateStream(messages)) {
			fullText += chunk;
		}
		return fullText;
	}

	async dispose(): Promise<void> {
		this.vault = null;
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
				const vault = getGeminiVault();
				const hasDefault = process.env.NEXT_PUBLIC_HAS_GEMINI_KEY;
				const canUseVault = vault?.canCall();

				if (canUseVault && vault) {
					onProgress?.("Initializing Gemini (Custom Key)...");
					activeEngine = new GeminiEngineWrapper({ vault });
				} else if (hasDefault) {
					onProgress?.("Initializing Gemini (Proxy)...");
					activeEngine = new GeminiEngineWrapper({ useProxy: true });
				} else {
					const state = vault?.getState();
					throw new Error(
						state === "locked"
							? "Please unlock your API key in Settings."
							: "Add an API key in Settings or use the default key."
					);
				}
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
