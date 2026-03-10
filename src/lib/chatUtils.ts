import type { Message, MessageCitation, MessageUIState, MessageSafetyState, ChatSession } from "@/app/[owner]/[repo]/types";
import type { SearchResult } from "@/lib/vectorStore";

export function makeChatId(): string {
	return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeMessageId(): string {
	return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeNewChat(label = "New Chat"): ChatSession {
	return {
		chat_id: makeChatId(),
		title: label,
		messages: [],
		updatedAt: Date.now(),
	};
}

export function areMessagesEqual(a: Message[], b: Message[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (
			a[i].id !== b[i].id ||
			a[i].role !== b[i].role ||
			a[i].content !== b[i].content
		) {
			return false;
		}
		if (!areCitationsEqual(a[i].citations, b[i].citations)) return false;
		if (!areMessageUiEqual(a[i].ui, b[i].ui)) return false;
		if (!areMessageSafetyEqual(a[i].safety, b[i].safety)) return false;
	}
	return true;
}

export function areMessageUiEqual(a?: MessageUIState, b?: MessageUIState): boolean {
	return Boolean(a?.sourcesExpanded) === Boolean(b?.sourcesExpanded);
}

export function areMessageSafetyEqual(
	a?: MessageSafetyState,
	b?: MessageSafetyState
): boolean {
	if (Boolean(a?.blocked) !== Boolean(b?.blocked)) return false;
	if ((a?.reason ?? "") !== (b?.reason ?? "")) return false;
	const aSignals = a?.signals ?? [];
	const bSignals = b?.signals ?? [];
	if (aSignals.length !== bSignals.length) return false;
	for (let i = 0; i < aSignals.length; i++) {
		if (aSignals[i] !== bSignals[i]) return false;
	}
	return true;
}

export function areCitationsEqual(
	a?: MessageCitation[],
	b?: MessageCitation[]
): boolean {
	if (!a?.length && !b?.length) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (
			a[i].filePath !== b[i].filePath ||
			a[i].startLine !== b[i].startLine ||
			a[i].endLine !== b[i].endLine ||
			a[i].score !== b[i].score ||
			a[i].chunkCount !== b[i].chunkCount
		) {
			return false;
		}
	}
	return true;
}

export function normalizeMessage(raw: unknown): Message | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as {
		id?: unknown;
		role?: unknown;
		content?: unknown;
		citations?: unknown;
		ui?: unknown;
		safety?: unknown;
	};
	const role =
		value.role === "user" || value.role === "assistant"
			? value.role
			: null;
	if (!role || typeof value.content !== "string") return null;

	const id = typeof value.id === "string" && value.id.trim().length > 0
		? value.id
		: makeMessageId();
	const citations = normalizeCitations(value.citations);
	const ui = normalizeMessageUi(value.ui);
	const safety = normalizeMessageSafety(value.safety);
	const normalized: Message = { id, role, content: value.content };
	if (citations?.length) normalized.citations = citations;
	if (ui) normalized.ui = ui;
	if (safety) normalized.safety = safety;
	return normalized;
}

export function normalizeMessageUi(raw: unknown): MessageUIState | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as { sourcesExpanded?: unknown };
	if (typeof value.sourcesExpanded !== "boolean") return undefined;
	return { sourcesExpanded: value.sourcesExpanded };
}

export function normalizeMessageSafety(raw: unknown): MessageSafetyState | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as {
		blocked?: unknown;
		reason?: unknown;
		signals?: unknown;
	};
	const normalized: MessageSafetyState = {};
	if (typeof value.blocked === "boolean") normalized.blocked = value.blocked;
	if (typeof value.reason === "string" && value.reason.length > 0) normalized.reason = value.reason;
	if (Array.isArray(value.signals)) {
		const safeSignals = value.signals
			.filter((signal): signal is string => typeof signal === "string" && signal.length > 0)
			.slice(0, 8);
		if (safeSignals.length > 0) normalized.signals = safeSignals;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeCitations(raw: unknown): MessageCitation[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const safe: MessageCitation[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const value = item as {
			filePath?: unknown;
			startLine?: unknown;
			endLine?: unknown;
			score?: unknown;
			chunkCount?: unknown;
		};
		if (typeof value.filePath !== "string" || value.filePath.length === 0) continue;
		if (
			typeof value.startLine !== "number" ||
			typeof value.endLine !== "number" ||
			typeof value.score !== "number" ||
			typeof value.chunkCount !== "number"
		) {
			continue;
		}
		safe.push({
			filePath: value.filePath,
			startLine: Math.max(1, Math.floor(value.startLine)),
			endLine: Math.max(1, Math.floor(value.endLine)),
			score: value.score,
			chunkCount: Math.max(1, Math.floor(value.chunkCount)),
		});
	}
	return safe.length > 0 ? safe : undefined;
}

export function buildMessageCitations(results: SearchResult[], limit: number = 6): MessageCitation[] {
	const byFile = new Map<string, MessageCitation>();
	for (const result of results) {
		const filePath = result.chunk.filePath;
		const startLine = Math.max(1, Math.floor(result.chunk.startLine ?? 1));
		const endLine = Math.max(startLine, Math.floor(result.chunk.endLine ?? startLine));
		const existing = byFile.get(filePath);
		if (!existing) {
			byFile.set(filePath, {
				filePath,
				startLine,
				endLine,
				score: result.score,
				chunkCount: 1,
			});
			continue;
		}
		existing.startLine = Math.min(existing.startLine, startLine);
		existing.endLine = Math.max(existing.endLine, endLine);
		existing.score = Math.max(existing.score, result.score);
		existing.chunkCount += 1;
	}
	return [...byFile.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

export function encodeGitHubPath(filePath: string): string {
	return filePath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

export function deriveChatTitle(messages: Message[], fallback: string): string {
	const firstUserMessage = messages.find(
		(msg) => msg.role === "user" && msg.content.trim().length > 0
	);
	if (!firstUserMessage) return fallback;
	const compact = firstUserMessage.content.trim().replace(/\s+/g, " ");
	return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact;
}

export function shouldSuggestGitHubToken(errorMessage: string): boolean {
	const message = errorMessage.toLowerCase();
	return (
		message.includes("private") ||
		message.includes("not found") ||
		message.includes("token") ||
		message.includes("rate limit") ||
		message.includes("denied") ||
		message.includes("permission") ||
		message.includes("403") ||
		message.includes("401")
	);
}

/**
 * Post-process assistant markdown to replace file-path mentions with inline
 * GitHub links.  Fenced code blocks and existing markdown links are skipped.
 */
export function injectInlineFileLinks(
	content: string,
	knownPaths: string[],
	owner: string,
	repo: string,
	commitRef: string,
): string {
	if (!commitRef || !owner || !repo || knownPaths.length === 0) return content;

	const pathSet = new Set(knownPaths);
	// Longest paths first — regex alternation is left-biased so longest wins.
	const sorted = [...pathSet].sort((a, b) => b.length - a.length);

	// Build one combined regex: each path optionally wrapped in backticks.
	const alt = sorted
		.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.flatMap((e) => [`\`${e}\``, e]);
	const pathRe = new RegExp(alt.join("|"), "g");

	// Collect regions to skip: fenced code blocks + existing markdown links.
	const skipRegions: [number, number][] = [];

	const fenceRe = /```[\s\S]*?```/g;
	let m: RegExpExecArray | null;
	while ((m = fenceRe.exec(content)) !== null) {
		skipRegions.push([m.index, m.index + m[0].length]);
	}
	const linkRe = /\[[^\]]*\]\([^)]*\)/g;
	while ((m = linkRe.exec(content)) !== null) {
		skipRegions.push([m.index, m.index + m[0].length]);
	}

	function inSkipRegion(start: number, end: number): boolean {
		return skipRegions.some(([s, e]) => start >= s && end <= e);
	}

	// Find all path matches outside skip regions, then replace end-to-start
	// so string indices stay valid.
	const hits: { index: number; length: number; path: string; tick: string }[] = [];
	while ((m = pathRe.exec(content)) !== null) {
		const raw = m[0];
		const hasTick = raw.startsWith("`") && raw.endsWith("`");
		const path = hasTick ? raw.slice(1, -1) : raw;
		if (!pathSet.has(path)) continue;

		const start = m.index;
		const end = start + raw.length;
		if (inSkipRegion(start, end)) continue;

		hits.push({ index: start, length: raw.length, path, tick: hasTick ? "`" : "" });
		// Mark as skip so overlapping shorter paths won't match inside this hit.
		skipRegions.push([start, end]);
	}

	let result = content;
	for (let i = hits.length - 1; i >= 0; i--) {
		const { index, length, path, tick } = hits[i];
		const encoded = encodeGitHubPath(path);
		const url = `https://github.com/${owner}/${repo}/blob/${commitRef}/${encoded}`;
		const replacement = `[${tick}${path}${tick}](${url})`;
		result = result.slice(0, index) + replacement + result.slice(index + length);
	}
	return result;
}

export function shouldPromptForLLMSettings(errorMessage: string): boolean {
	const message = errorMessage.toLowerCase();
	return (
		message.includes("gemini") ||
		message.includes("groq") ||
		message.includes("api key") ||
		message.includes("authentication") ||
		message.includes("unauthorized") ||
		message.includes("invalid") ||
		message.includes("rejected") ||
		message.includes("permission") ||
		message.includes("forbidden") ||
		message.includes("webgpu") ||
		message.includes("web-llm") ||
		message.includes("local web") ||
		message.includes("switch to gemini") ||
		message.includes("switch to groq") ||
		message.includes("unlock")
	);
}
