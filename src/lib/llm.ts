/**
 * LLM wrapper — provides a unified interface to WebLLM, Gemini, and Groq.
 *
 * Supports switching between local WebGPU inference (MLC) and cloud inference.
 * Cloud BYOK keys can be stored encrypted (vault) or plain local (fallback).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGeminiVault } from "./gemini-vault";
import { getGroqVault } from "./groq-vault";
import { detectWebGPUAvailability } from "./webgpu";
import { recordLLM } from "./metrics";
import { prepareGeminiChat } from "./chatHistory";

export type LLMStatus = "idle" | "loading" | "ready" | "generating" | "error";

export type LLMProvider = "mlc" | "gemini" | "groq";
export type CloudStorageMode = "vault" | "local";
export type GeminiStorageMode = CloudStorageMode;

export interface LLMConfig {
	provider: LLMProvider;
	cloudStorage?: CloudStorageMode;
	/** @deprecated For legacy migration; replaced by cloudStorage */
	geminiStorage?: CloudStorageMode;
	/** @deprecated For legacy migration only; BYOK keys now in vault */
	apiKey?: string;
	/** Selected local model ID (mlc provider only) */
	mlcModelId?: string;
}

export interface MLCModelInfo {
	id: string;
	label: string;
	size: string;
	vram: string;
}

export const MLC_MODELS: MLCModelInfo[] = [
	{ id: "Qwen2-0.5B-Instruct-q4f16_1-MLC",    label: "Qwen2 0.5B",    size: "0.5B", vram: "~380MB" },
	{ id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",  label: "Llama 3.2 1B",  size: "1B",   vram: "~700MB" },
	{ id: "Llama-3.2-3B-Instruct-q4f32_1-MLC",  label: "Llama 3.2 3B",  size: "3B",   vram: "~1.8GB" },
	{ id: "Phi-3.5-mini-instruct-q4f16_1-MLC",  label: "Phi 3.5 mini",  size: "3.8B", vram: "~2.2GB" },
	{ id: "Llama-3.1-8B-Instruct-q4f16_1-MLC",  label: "Llama 3.1 8B",  size: "8B",   vram: "~4.9GB" },
];

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

function normalizeGroqError(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();

	if (
		lower.includes("invalid api key") ||
		lower.includes("authentication") ||
		lower.includes("unauthorized") ||
		lower.includes("invalid_api_key")
	) {
		return new Error(
			"Groq API key is invalid or rejected. Open LLM Settings and update your key."
		);
	}

	if (
		lower.includes("quota") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests")
	) {
		return new Error(
			"Groq API rate limit or quota exceeded. Wait a moment and try again."
		);
	}

	if (lower.includes("permission") || lower.includes("forbidden")) {
		return new Error(
			"Groq request was denied. Check your API key permissions in LLM Settings."
		);
	}

	return new Error(message);
}

function normalizeMLCInitError(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	if (
		lower.includes("webgpu") ||
		lower.includes("navigator.gpu") ||
		lower.includes("secure context") ||
		lower.includes("adapter")
	) {
		return new Error(
			"Local Web-LLM is unavailable in this browser. Open LLM Settings, switch to Gemini or Groq, and add your API key."
		);
	}
	return new Error(
		`Failed to initialize local Web-LLM: ${message}. Switch to Gemini or Groq in LLM Settings if this continues.`
	);
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
let mlcWorker: Worker | null = null;

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
const GEMINI_LOCAL_KEY_STORAGE = "gitask_gemini_api_key_local";
const GROQ_LOCAL_KEY_STORAGE = "gitask_groq_api_key_local";

function normalizeCloudStorageMode(value: unknown): CloudStorageMode {
	// Explicit "vault" stays vault; anything else (including undefined) defaults to "local"
	// so that keys persist across browser sessions without requiring vault unlock.
	return value === "vault" ? "vault" : "local";
}

function getLocalKeyStorage(provider: "gemini" | "groq"): string {
	return provider === "gemini"
		? GEMINI_LOCAL_KEY_STORAGE
		: GROQ_LOCAL_KEY_STORAGE;
}

function getLocalApiKey(provider: "gemini" | "groq"): string | null {
	if (typeof window === "undefined") return null;
	let key: string | null = null;
	try {
		key = localStorage.getItem(getLocalKeyStorage(provider));
	} catch {
		return null;
	}
	if (!key) return null;
	return key.trim().length > 0 ? key : null;
}

export function getGeminiLocalApiKey(): string | null {
	return getLocalApiKey("gemini");
}

export function hasGeminiLocalApiKey(): boolean {
	return !!getGeminiLocalApiKey();
}

export function setGeminiLocalApiKey(apiKey: string | null): void {
	setCloudLocalApiKey("gemini", apiKey);
}

export function getGroqLocalApiKey(): string | null {
	return getLocalApiKey("groq");
}

export function hasGroqLocalApiKey(): boolean {
	return !!getGroqLocalApiKey();
}

export function setGroqLocalApiKey(apiKey: string | null): void {
	setCloudLocalApiKey("groq", apiKey);
}

function setCloudLocalApiKey(
	provider: "gemini" | "groq",
	apiKey: string | null
): void {
	if (typeof window === "undefined") return;
	const next = apiKey?.trim() ?? "";
	try {
		if (!next) {
			localStorage.removeItem(getLocalKeyStorage(provider));
			return;
		}
		localStorage.setItem(getLocalKeyStorage(provider), next);
	} catch {
		// Ignore localStorage failures in restricted browser modes.
	}
}

export function getLLMConfig(): LLMConfig {
	// 1. Try to load from localStorage
	if (typeof window !== "undefined") {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored) as Partial<LLMConfig>;
				const provider: LLMProvider =
					parsed.provider === "gemini" || parsed.provider === "groq"
						? parsed.provider
						: "mlc";
				const baseConfig: LLMConfig = { provider };
				if (provider === "gemini" || provider === "groq") {
					baseConfig.cloudStorage = normalizeCloudStorageMode(
						parsed.cloudStorage ?? parsed.geminiStorage
					);
				}
				if (typeof parsed.apiKey === "string" && parsed.apiKey.trim().length > 0) {
					baseConfig.apiKey = parsed.apiKey;
				}
				return baseConfig;
			}
		} catch (e) {
			console.warn("Failed to parse LLM config", e);
		}
	}

	// 2. Default if nothing saved
	// Use "local" storage so keys persist across sessions without requiring vault unlock.
	if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_HAS_GEMINI_KEY) {
		return { provider: "gemini", cloudStorage: "local" };
	}
	if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_HAS_GROQ_KEY) {
		return { provider: "groq", cloudStorage: "local" };
	}

	return { provider: "mlc" };
}

/**
 * Check if there is a legacy plain-text apiKey in config (for migration).
 */
export function hasLegacyApiKey(config: LLMConfig): boolean {
	return (config.provider === "gemini" || config.provider === "groq") && !!config.apiKey;
}

export function setLLMConfig(config: LLMConfig) {
	if (typeof window === "undefined") return;
	const safeConfig: LLMConfig = {
		provider:
			config.provider === "gemini" || config.provider === "groq"
				? config.provider
				: "mlc",
	};
	if (safeConfig.provider === "gemini" || safeConfig.provider === "groq") {
		safeConfig.cloudStorage = normalizeCloudStorageMode(
			config.cloudStorage ?? config.geminiStorage
		);
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(safeConfig));
	} catch {
		// Ignore localStorage failures in restricted browser modes.
	}
}

// ─── MLC Implementation ─────────────────────────────────────────────────────

const DEFAULT_MLC_MODEL_ID = MLC_MODELS[0].id;

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
	private apiKey: string | null;
	/** Stash actual token counts from last BYOK call (set after stream drains) */
	lastUsage: { tokensIn?: number; tokensOut?: number } | null = null;

	constructor(
		vaultOrProxy: { vault: BYOKVaultRef } | { useProxy: true } | { apiKey: string }
	) {
		if ("vault" in vaultOrProxy) {
			this.vault = vaultOrProxy.vault;
			this.useProxy = false;
			this.apiKey = null;
		} else if ("apiKey" in vaultOrProxy) {
			this.vault = null;
			this.useProxy = false;
			this.apiKey = vaultOrProxy.apiKey;
		} else {
			this.vault = null;
			this.useProxy = true;
			this.apiKey = null;
		}
	}

	private async collectGeminiStream(
		messages: ChatMessage[],
		apiKey: string
	): Promise<{ chunks: string[]; tokensIn?: number; tokensOut?: number }> {
		let history;
		let prompt;
		try {
			const prepared = prepareGeminiChat(messages);
			history = prepared.history;
			prompt = prepared.prompt;
		} catch (err) {
			throw normalizeGeminiError(err);
		}

		const genAI = new GoogleGenerativeAI(apiKey);
		const model = genAI.getGenerativeModel({
			model: "gemini-2.5-flash",
		});
		const chat = model.startChat({ history });

		try {
			const result = await chat.sendMessageStream(prompt);
			const out: string[] = [];
			for await (const chunk of result.stream) {
				const text = chunk.text();
				if (text) out.push(text);
			}
			// usageMetadata is available after stream drains
			const usage = (await result.response).usageMetadata;
			return {
				chunks: out,
				tokensIn: usage?.promptTokenCount,
				tokensOut: usage?.candidatesTokenCount,
			};
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
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

			try {
				if (contentType.includes("application/x-ndjson")) {
					let buffer = "";
					const parseFrameLine = (line: string): { token?: string; error?: Error } => {
						const frame = JSON.parse(line) as {
							type?: string;
							text?: string;
							code?: string;
							message?: string;
						};
						if (frame.type === "chunk") {
							if (typeof frame.text === "string" && frame.text.length > 0) {
								return { token: frame.text };
							}
							return {};
						}
						if (frame.type === "error") {
							const msg = typeof frame.message === "string"
								? frame.message
								: "Gemini stream failed.";
							const code = typeof frame.code === "string" ? frame.code : "UNKNOWN_ERROR";
							return { error: new Error(`${msg} (${code})`) };
						}
						return {};
					};
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							buffer += decoder.decode();
							break;
						}
						buffer += decoder.decode(value, { stream: true });

						let newline = buffer.indexOf("\n");
						while (newline !== -1) {
							const line = buffer.slice(0, newline).trim();
							buffer = buffer.slice(newline + 1);
							if (line) {
								const parsed = parseFrameLine(line);
								if (parsed.error) throw parsed.error;
								if (parsed.token) yield parsed.token;
							}
							newline = buffer.indexOf("\n");
						}
					}

					const tailLines = buffer.split("\n");
					for (const rawLine of tailLines) {
						const line = rawLine.trim();
						if (!line) continue;
						const parsed = parseFrameLine(line);
						if (parsed.error) throw parsed.error;
						if (parsed.token) {
							yield parsed.token;
						}
					}
				} else {
					// Backward compatibility for older proxy/plain-text responses.
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						yield decoder.decode(value, { stream: true });
					}
				}
			} catch (err) {
				throw normalizeGeminiError(err);
			}
			return;
		}

		if (this.apiKey) {
			this.lastUsage = null;
			const result = await this.collectGeminiStream(messages, this.apiKey);
			this.lastUsage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut };
			for (const chunk of result.chunks) {
				yield chunk;
			}
			return;
		}

		// BYOK: run inside vault scope, collect chunks then yield
		if (!this.vault) throw new Error("Vault not configured");
		this.lastUsage = null;
		const runWithKey = (apiKey: string) => this.collectGeminiStream(messages, apiKey);
		const result = await this.vault.withKeyScope(async () =>
			this.vault!.withKey(runWithKey)
		);
		this.lastUsage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut };

		for (const chunk of result.chunks) {
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
		this.apiKey = null;
	}
}

// ─── Groq Implementation ────────────────────────────────────────────────────

class GroqEngineWrapper implements LLMEngine {
	private vault: BYOKVaultRef | null;
	private useProxy: boolean;
	private apiKey: string | null;
	lastUsage: { tokensIn?: number; tokensOut?: number } | null = null;

	constructor(
		vaultOrProxy: { vault: BYOKVaultRef } | { useProxy: true } | { apiKey: string }
	) {
		if ("vault" in vaultOrProxy) {
			this.vault = vaultOrProxy.vault;
			this.useProxy = false;
			this.apiKey = null;
		} else if ("apiKey" in vaultOrProxy) {
			this.vault = null;
			this.useProxy = false;
			this.apiKey = vaultOrProxy.apiKey;
		} else {
			this.vault = null;
			this.useProxy = true;
			this.apiKey = null;
		}
	}

	private toOpenAIChatMessages(messages: ChatMessage[]) {
		return messages.map((m) => ({ role: m.role, content: m.content }));
	}

	private async collectGroqStream(
		messages: ChatMessage[],
		apiKey: string
	): Promise<{ chunks: string[]; tokensIn?: number; tokensOut?: number }> {
		try {
			const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: "llama-3.3-70b-versatile",
					messages: this.toOpenAIChatMessages(messages),
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0.2,
				}),
			});

			if (!response.ok) {
				const details = await extractErrorText(response);
				throw new Error(`Groq API request failed (${response.status}): ${details}`);
			}
			if (!response.body) throw new Error("No response body");

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			const out: string[] = [];
			let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					buffer += decoder.decode();
					break;
				}
				buffer += decoder.decode(value, { stream: true });

				const frames = buffer.split("\n\n");
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					for (const rawLine of frame.split("\n")) {
						const line = rawLine.trim();
						if (!line.startsWith("data:")) continue;
						const payload = line.slice(5).trim();
						if (!payload || payload === "[DONE]") continue;
						const json = JSON.parse(payload) as {
							choices?: Array<{ delta?: { content?: string } }>;
							usage?: { prompt_tokens?: number; completion_tokens?: number };
							error?: { message?: string };
						};
						if (json.error?.message) {
							throw new Error(json.error.message);
						}
						if (json.usage) usage = json.usage;
						const text = json.choices?.[0]?.delta?.content;
						if (text) out.push(text);
					}
				}
			}

			const trailing = buffer.trim();
			if (trailing.length > 0) {
				for (const rawLine of trailing.split("\n")) {
					const line = rawLine.trim();
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;
					const json = JSON.parse(payload) as {
						choices?: Array<{ delta?: { content?: string } }>;
						usage?: { prompt_tokens?: number; completion_tokens?: number };
					};
					if (json.usage) usage = json.usage;
					const text = json.choices?.[0]?.delta?.content;
					if (text) out.push(text);
				}
			}

			return {
				chunks: out,
				tokensIn: usage?.prompt_tokens,
				tokensOut: usage?.completion_tokens,
			};
		} catch (err) {
			throw normalizeGroqError(err);
		}
	}

	async *generateStream(
		messages: ChatMessage[]
	): AsyncGenerator<string, void, undefined> {
		if (this.useProxy) {
			const response = await fetch("/api/groq", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messages }),
			});

			if (!response.ok) {
				const details = await extractErrorText(response);
				throw normalizeGroqError(
					new Error(`Groq API request failed (${response.status}): ${details}`)
				);
			}
			if (!response.body) throw new Error("No response body");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

			try {
				if (contentType.includes("application/x-ndjson")) {
					let buffer = "";
					const parseFrameLine = (line: string): { token?: string; error?: Error } => {
						const frame = JSON.parse(line) as {
							type?: string;
							text?: string;
							code?: string;
							message?: string;
						};
						if (frame.type === "chunk") {
							if (typeof frame.text === "string" && frame.text.length > 0) {
								return { token: frame.text };
							}
							return {};
						}
						if (frame.type === "error") {
							const msg = typeof frame.message === "string"
								? frame.message
								: "Groq stream failed.";
							const code = typeof frame.code === "string" ? frame.code : "UNKNOWN_ERROR";
							return { error: new Error(`${msg} (${code})`) };
						}
						return {};
					};
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							buffer += decoder.decode();
							break;
						}
						buffer += decoder.decode(value, { stream: true });

						let newline = buffer.indexOf("\n");
						while (newline !== -1) {
							const line = buffer.slice(0, newline).trim();
							buffer = buffer.slice(newline + 1);
							if (line) {
								const parsed = parseFrameLine(line);
								if (parsed.error) throw parsed.error;
								if (parsed.token) yield parsed.token;
							}
							newline = buffer.indexOf("\n");
						}
					}

					const tailLines = buffer.split("\n");
					for (const rawLine of tailLines) {
						const line = rawLine.trim();
						if (!line) continue;
						const parsed = parseFrameLine(line);
						if (parsed.error) throw parsed.error;
						if (parsed.token) yield parsed.token;
					}
				} else {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						yield decoder.decode(value, { stream: true });
					}
				}
			} catch (err) {
				throw normalizeGroqError(err);
			}
			return;
		}

		if (this.apiKey) {
			this.lastUsage = null;
			const result = await this.collectGroqStream(messages, this.apiKey);
			this.lastUsage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut };
			for (const chunk of result.chunks) {
				yield chunk;
			}
			return;
		}

		if (!this.vault) throw new Error("Vault not configured");
		this.lastUsage = null;
		const runWithKey = (apiKey: string) => this.collectGroqStream(messages, apiKey);
		const result = await this.vault.withKeyScope(async () =>
			this.vault!.withKey(runWithKey)
		);
		this.lastUsage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut };
		for (const chunk of result.chunks) {
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
		this.apiKey = null;
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
			if (config.provider === "gemini" || config.provider === "groq") {
				const provider = config.provider;
				const vault = provider === "gemini" ? getGeminiVault() : getGroqVault();
				const hasDefault =
					provider === "gemini"
						? process.env.NEXT_PUBLIC_HAS_GEMINI_KEY
						: process.env.NEXT_PUBLIC_HAS_GROQ_KEY;
				const storageMode = normalizeCloudStorageMode(
					config.cloudStorage ?? config.geminiStorage
				);
				const localKey =
					storageMode === "local"
						? provider === "gemini"
							? getGeminiLocalApiKey()
							: getGroqLocalApiKey()
						: null;
				const canUseVault = vault?.canCall();
				const providerLabel = provider === "gemini" ? "Gemini" : "Groq";

				if (localKey) {
					onProgress?.(`Initializing ${providerLabel} (Local Key)...`);
					activeEngine =
						provider === "gemini"
							? new GeminiEngineWrapper({ apiKey: localKey })
							: new GroqEngineWrapper({ apiKey: localKey });
				} else if (canUseVault && vault) {
					onProgress?.(`Initializing ${providerLabel} (Custom Key)...`);
					activeEngine =
						provider === "gemini"
							? new GeminiEngineWrapper({ vault })
							: new GroqEngineWrapper({ vault });
				} else if (hasDefault) {
					onProgress?.(`Initializing ${providerLabel} (Proxy)...`);
					activeEngine =
						provider === "gemini"
							? new GeminiEngineWrapper({ useProxy: true })
							: new GroqEngineWrapper({ useProxy: true });
				} else {
					const state = vault?.getState();
					throw new Error(
						storageMode === "local"
							? `Add your ${providerLabel} API key in LLM Settings.`
							: state === "locked"
							? "Please unlock your API key in Settings."
							: "Add an API key in Settings or use the default key."
					);
				}
				onProgress?.(`${providerLabel} Ready`);
			} else {
				// Default to MLC
				try {
					const availability = await detectWebGPUAvailability();
					if (!availability.supported) {
						throw new Error(
							`WebGPU unavailable (${availability.reason}).`
						);
					}

					onProgress?.("Loading WebLLM Engine...");
					const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import("@mlc-ai/web-llm");
					const worker = new Worker(
						new URL("../workers/llm-worker.ts", import.meta.url),
						{ type: "module" }
					);
					mlcWorker = worker;

					const selectedModelId = config.mlcModelId ?? DEFAULT_MLC_MODEL_ID;
					const rawEngine = await CreateWebWorkerMLCEngine(worker, selectedModelId, {
						initProgressCallback: (progress) => {
							onProgress?.(`LLM: ${progress.text}`);
						},
						appConfig: prebuiltAppConfig,
					});
					mlcWorker = null;
					activeEngine = new MLCEngineWrapper(rawEngine);
					onProgress?.("Local LLM Ready");
				} catch (err) {
					throw normalizeMLCInitError(err);
				}
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

	const config = getLLMConfig();
	const provider: LLMProvider =
		config.provider === "gemini" || config.provider === "groq"
			? config.provider
			: "mlc";

	// Estimate input tokens from message content (chars / 4)
	const totalInputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
	const estimatedTokensIn = Math.round(totalInputChars / 4);

	let outputChars = 0;
	const startTime = performance.now();

	setStatus("generating");
	try {
		const stream = activeEngine.generateStream(messages);
		for await (const chunk of stream) {
			outputChars += chunk.length;
			yield chunk;
		}
	} finally {
		const durationMs = performance.now() - startTime;
		setStatus("ready");

		// Check if the cloud engine stashed actual token counts.
		const cloudEngine =
			activeEngine instanceof GeminiEngineWrapper ||
			activeEngine instanceof GroqEngineWrapper
				? activeEngine
				: null;
		const actualUsage = cloudEngine?.lastUsage;

		if (actualUsage?.tokensIn != null || actualUsage?.tokensOut != null) {
			recordLLM(
				provider,
				durationMs,
				actualUsage.tokensIn ?? estimatedTokensIn,
				actualUsage.tokensOut ?? Math.round(outputChars / 4),
				"actual"
			);
		} else {
			recordLLM(
				provider,
				durationMs,
				estimatedTokensIn,
				Math.round(outputChars / 4),
				"estimated"
			);
		}
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
	if (mlcWorker) {
		mlcWorker.terminate();
		mlcWorker = null;
	}
	if (activeEngine) {
		await activeEngine.dispose();
		activeEngine = null;
	}
	initPromise = null;
	setStatus("idle");
}

/**
 * Cancel an in-progress MLC model download and clear any partial cache.
 */
export async function cancelMLCInit(): Promise<void> {
	await disposeLLM();
	try {
		const cacheNames = await caches.keys();
		for (const name of cacheNames) {
			if (name.includes("webllm") || name.includes("mlc")) {
				await caches.delete(name);
			}
		}
	} catch {
		// Cache API unavailable, no-op
	}
}

/**
 * List MLC model cache entries (model IDs that have been downloaded).
 */
export async function getDownloadedMLCModels(): Promise<string[]> {
	try {
		const downloaded: string[] = [];
		const cacheNames = await caches.keys();
		for (const name of cacheNames) {
			if (name.includes("webllm") || name.includes("mlc")) {
				const cache = await caches.open(name);
				const keys = await cache.keys();
				for (const req of keys) {
					const url = req.url;
					for (const m of MLC_MODELS) {
						if (url.includes(m.id) && !downloaded.includes(m.id)) {
							downloaded.push(m.id);
						}
					}
				}
			}
		}
		return downloaded;
	} catch {
		return [];
	}
}

/**
 * Delete all cached data for a specific MLC model.
 */
export async function deleteMLCModel(modelId: string): Promise<void> {
	try {
		const cacheNames = await caches.keys();
		for (const name of cacheNames) {
			if (name.includes("webllm") || name.includes("mlc")) {
				const cache = await caches.open(name);
				const keys = await cache.keys();
				for (const req of keys) {
					if (req.url.includes(modelId)) {
						await cache.delete(req);
					}
				}
			}
		}
	} catch {
		// Cache API unavailable, no-op
	}
}
