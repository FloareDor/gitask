"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { indexRepository, IndexAbortError, type IndexProgress, type AstNode } from "@/lib/indexer";
import { VectorStore } from "@/lib/vectorStore";
import { multiPathHybridSearch } from "@/lib/search";
import { expandQuery } from "@/lib/queryExpansion";
import { buildScopedContext, defaultLimitsForProvider } from "@/lib/contextAssembly";
import { fetchRepoTree } from "@/lib/github";
import { initLLM, generate, getLLMStatus, getLLMConfig, onStatusChange, type LLMStatus, type ChatMessage } from "@/lib/llm";
import { verifyAndRefine } from "@/lib/cove";
import AstTreeView from "@/components/AstTreeView";
import IndexBrowser from "@/components/IndexBrowser";
import { ModelSettings } from "@/components/ModelSettings";
import ReactMarkdown from "react-markdown";

interface Message {
	role: "user" | "assistant";
	content: string;
}

interface ContextChunk {
	filePath: string;
	code: string;
	score: number;
	nodeType: string;
}

interface ChatSession {
	chat_id: string;
	title: string;
	messages: Message[];
	updatedAt: number;
}

function makeChatId(): string {
	return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeNewChat(label = "New Chat"): ChatSession {
	return {
		chat_id: makeChatId(),
		title: label,
		messages: [],
		updatedAt: Date.now(),
	};
}

function areMessagesEqual(a: Message[], b: Message[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].role !== b[i].role || a[i].content !== b[i].content) return false;
	}
	return true;
}

function deriveChatTitle(messages: Message[], fallback: string): string {
	const firstUserMessage = messages.find(
		(msg) => msg.role === "user" && msg.content.trim().length > 0
	);
	if (!firstUserMessage) return fallback;
	const compact = firstUserMessage.content.trim().replace(/\s+/g, " ");
	return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact;
}

function shouldSuggestGitHubToken(errorMessage: string): boolean {
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

function shouldPromptForLLMSettings(errorMessage: string): boolean {
	const message = errorMessage.toLowerCase();
	return (
		message.includes("gemini") ||
		message.includes("api key") ||
		message.includes("authentication") ||
		message.includes("unauthorized") ||
		message.includes("invalid") ||
		message.includes("rejected") ||
		message.includes("permission") ||
		message.includes("forbidden") ||
		message.includes("unlock")
	);
}

export default function RepoPage({
	params,
}: {
	params: Promise<{ owner: string; repo: string }>;
}) {
	const router = useRouter();
	const [owner, setOwner] = useState("");
	const [repo, setRepo] = useState("");

	const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
	const [isIndexed, setIsIndexed] = useState(false);
	const [llmStatus, setLlmStatus] = useState<LLMStatus>("idle");
	const [messages, setMessages] = useState<Message[]>([]);
	const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const chatStorageKey = owner && repo ? `gitask-chat-${owner}/${repo}` : null;
	const [input, setInput] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [contextChunks, setContextChunks] = useState<ContextChunk[]>([]);
	const [contextMeta, setContextMeta] = useState<{
		truncated: boolean;
		totalChars: number;
		maxChars: number;
		estimatedTokens: number;
		maxTokens: number;
		compactionStage: "none" | "file" | "directory" | "repo" | "truncated";
	} | null>(null);
	const [showContext, setShowContext] = useState(false);
	const [showBrowse, setShowBrowse] = useState(false);
	const [token, setToken] = useState("");
	const [showTokenInput, setShowTokenInput] = useState(false);
	const [astNodes, setAstNodes] = useState<AstNode[]>([]);
	const [textChunkCounts, setTextChunkCounts] = useState<Record<string, number>>({});
	const [reindexKey, setReindexKey] = useState(0);
	const [toastMessage, setToastMessage] = useState<string | null>(null);
	const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | null>(null);
	const [showOverflow, setShowOverflow] = useState(false);
	const [isMobile, setIsMobile] = useState(false);
	const [coveEnabled, setCoveEnabled] = useState(false);
	const [indexedSha, setIndexedSha] = useState<string | null>(null);
	const [repoStale, setRepoStale] = useState(false);
	const projectRepoUrl = "https://github.com/FloareDor/gitask";
	const completedWhileHiddenRef = useRef(false);
	const indexStartTimeRef = useRef<number | null>(null);
	const overflowRef = useRef<HTMLDivElement>(null);
	const chatLoadedRef = useRef(false);
	const pendingChatSwitchRef = useRef<string | null>(null);
	const staleNoticeShownRef = useRef(false);

	const storeRef = useRef(new VectorStore());
	const chatEndRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const check = () => setIsMobile(window.innerWidth < 640);
		check();
		window.addEventListener("resize", check);
		return () => window.removeEventListener("resize", check);
	}, []);

	// Resolve params
	useEffect(() => {
		params.then((p) => {
			setOwner(p.owner);
			setRepo(p.repo);
		});
	}, [params]);

	useEffect(() => {
		setIndexedSha(null);
		setRepoStale(false);
		staleNoticeShownRef.current = false;
	}, [owner, repo]);

	// Listen to LLM status
	useEffect(() => {
		return onStatusChange(setLlmStatus);
	}, []);

	// Load CoVE preference (default OFF)
	useEffect(() => {
		try {
			const saved = localStorage.getItem("gitask-cove-enabled");
			if (saved === "true") setCoveEnabled(true);
		} catch {
			// Ignore storage failures
		}
	}, []);

	// Persist CoVE preference
	useEffect(() => {
		try {
			localStorage.setItem("gitask-cove-enabled", coveEnabled ? "true" : "false");
		} catch {
			// Ignore storage failures
		}
	}, [coveEnabled]);

	// Load per-repo chat sessions from localStorage.
	// Supports migration from legacy Message[] format.
	useEffect(() => {
		chatLoadedRef.current = false;
		setMessages([]);
		setChatSessions([]);
		setActiveChatId(null);

		if (!chatStorageKey) return;

		try {
			const saved = localStorage.getItem(chatStorageKey);
			if (saved) {
				const parsed = JSON.parse(saved) as
					| Message[]
					| { sessions?: ChatSession[]; activeChatId?: string };

				// Legacy format: plain Message[] for one chat.
				if (Array.isArray(parsed)) {
					const legacyMessages = parsed.slice(-50);
					const migrated = makeNewChat("Chat 1");
					migrated.messages = legacyMessages;
					migrated.title = deriveChatTitle(legacyMessages, "Chat 1");
					setChatSessions([migrated]);
					pendingChatSwitchRef.current = migrated.chat_id;
					setActiveChatId(migrated.chat_id);
					setMessages(legacyMessages);
					chatLoadedRef.current = true;
					return;
				}

				// New format: { sessions, activeChatId }
				if (parsed && Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
					const sessions = parsed.sessions
						.filter((session) => session && typeof session.chat_id === "string")
						.map((session, index) => {
							const safeMessages = Array.isArray(session.messages)
								? session.messages.slice(-50)
								: [];
							const fallbackTitle = `Chat ${index + 1}`;
							return {
								chat_id: session.chat_id,
								title: typeof session.title === "string"
									? session.title
									: deriveChatTitle(safeMessages, fallbackTitle),
								messages: safeMessages,
								updatedAt: typeof session.updatedAt === "number"
									? session.updatedAt
									: Date.now(),
							};
						});

					if (sessions.length > 0) {
						const selectedId = sessions.some((session) => session.chat_id === parsed.activeChatId)
							? (parsed.activeChatId as string)
							: sessions[0].chat_id;
						const selected = sessions.find((session) => session.chat_id === selectedId);
						setChatSessions(sessions);
						pendingChatSwitchRef.current = selectedId;
						setActiveChatId(selectedId);
						setMessages(selected?.messages ?? []);
						chatLoadedRef.current = true;
						return;
					}
				}
			}
		} catch {
			// Ignore corrupted data
		}

		const fresh = makeNewChat("Chat 1");
		setChatSessions([fresh]);
		pendingChatSwitchRef.current = fresh.chat_id;
		setActiveChatId(fresh.chat_id);
		setMessages([]);
		chatLoadedRef.current = true;
	}, [chatStorageKey]);

	// Keep visible messages aligned with active chat.
	useEffect(() => {
		if (!chatLoadedRef.current || !activeChatId) return;
		const active = chatSessions.find((session) => session.chat_id === activeChatId);
		const nextMessages = active?.messages ?? [];
		setMessages((prev) => (areMessagesEqual(prev, nextMessages) ? prev : nextMessages));
	}, [chatSessions, activeChatId]);

	// Persist visible messages to the active chat.
	useEffect(() => {
		// Avoid per-token session rewrites while streaming; persist once generation settles.
		if (!chatLoadedRef.current || !activeChatId || isGenerating) return;

		// Skip one persist cycle when switching chats so we never write stale messages into the target chat.
		if (pendingChatSwitchRef.current === activeChatId) {
			const active = chatSessions.find((session) => session.chat_id === activeChatId);
			const activeMessages = active?.messages ?? [];
			if (areMessagesEqual(messages, activeMessages)) {
				pendingChatSwitchRef.current = null;
			}
			return;
		}

		const trimmed = messages.slice(-50);
		setChatSessions((prev) => {
			let changed = false;
			const next = prev.map((session) => {
				if (session.chat_id !== activeChatId) return session;
				const nextTitle = deriveChatTitle(trimmed, session.title || "New Chat");
				if (areMessagesEqual(session.messages, trimmed) && session.title === nextTitle) {
					return session;
				}
				changed = true;
				return {
					...session,
					title: nextTitle,
					messages: trimmed,
					updatedAt: Date.now(),
				};
			});
			return changed ? next : prev;
		});
	}, [messages, activeChatId, isGenerating, chatSessions]);

	// Persist all chats for this repo.
	useEffect(() => {
		if (!chatStorageKey || !chatLoadedRef.current || chatSessions.length === 0) return;
		try {
			localStorage.setItem(
				chatStorageKey,
				JSON.stringify({
					activeChatId,
					sessions: chatSessions,
				})
			);
		} catch {
			// Storage full or unavailable — silently skip
		}
	}, [chatStorageKey, chatSessions, activeChatId]);

	// Auto-scroll chat
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: isGenerating ? "auto" : "smooth" });
	}, [messages, isGenerating]);

	// Listen for visibility change — show toast when user returns after indexing completed in background
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible" && completedWhileHiddenRef.current) {
				completedWhileHiddenRef.current = false;
				setToastMessage("Indexing complete. You can ask questions now.");
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, []);

	// Auto-dismiss toast after 4 seconds
	useEffect(() => {
		if (!toastMessage) return;
		const timer = setTimeout(() => setToastMessage(null), 4000);
		return () => clearTimeout(timer);
	}, [toastMessage]);

	// Close overflow menu on outside click
	useEffect(() => {
		if (!showOverflow) return;
		const handleClick = (e: MouseEvent) => {
			if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
				setShowOverflow(false);
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [showOverflow]);

	// Sync notification permission when indexing starts
	useEffect(() => {
		if (typeof Notification === "undefined") return;
		setNotificationPermission(Notification.permission);
	}, [owner, repo, reindexKey]);

	// Start indexing when owner/repo are ready
	useEffect(() => {
		if (!owner || !repo) return;
		completedWhileHiddenRef.current = false;
		indexStartTimeRef.current = Date.now();
		const controller = new AbortController();
		const signal = controller.signal;
		let aborted = false;

		const safeSetState = <T,>(setter: (value: T) => void, value: T) => {
			if (!aborted) setter(value);
		};

		(async () => {
			try {
				const result = await indexRepository(
					owner,
					repo,
					storeRef.current,
					(progress) => {
						if (aborted) return;
						safeSetState(setIndexProgress, progress);
						if (progress.astNodes) safeSetState(setAstNodes, progress.astNodes);
						if (progress.textChunkCounts) safeSetState(setTextChunkCounts, progress.textChunkCounts);
					},
					token || undefined,
					signal,
				);
				if (aborted) return;
				if (typeof document !== "undefined" && document.hidden) {
					completedWhileHiddenRef.current = true;
					if (typeof Notification !== "undefined" && Notification.permission === "granted") {
						try {
							new Notification("GitAsk", {
								body: `Indexing complete for ${owner}/${repo}. You can ask questions now.`,
							});
						} catch {
							// Ignore notification errors
						}
					}
				}
				safeSetState(setIsIndexed, true);
				safeSetState(setIndexedSha, result.sha);
				safeSetState(setRepoStale, false);
				staleNoticeShownRef.current = false;

				initLLM((msg) => {
					if (aborted) return;
					setIndexProgress((prev) => ({
						phase: "done",
						message: msg,
						current: prev?.current ?? 0,
						total: prev?.total ?? 0,
					}));
				}).catch(console.error);
			} catch (err) {
				if (err instanceof IndexAbortError || aborted) return;
				const errorMessage = err instanceof Error ? err.message : String(err);
				if (shouldSuggestGitHubToken(errorMessage)) {
					safeSetState(setShowTokenInput, true);
				}
				safeSetState(setIndexProgress, {
					phase: "done",
					message: `Error: ${errorMessage}`,
					current: 0,
					total: 0,
				});
			}
		})();

		return () => {
			aborted = true;
			controller.abort();
		};
	}, [owner, repo, token, reindexKey]);

	// Detect upstream repo changes and flag stale context.
	useEffect(() => {
		if (!owner || !repo || !isIndexed || !indexedSha) return;
		let cancelled = false;

		const checkForStaleContext = async () => {
			try {
				const latest = await fetchRepoTree(owner, repo, token || undefined);
				if (cancelled) return;
				const isStale = latest.sha !== indexedSha;
				setRepoStale(isStale);
				if (isStale && !staleNoticeShownRef.current) {
					staleNoticeShownRef.current = true;
					setToastMessage("Repository changed on GitHub. Re-index for fresh context.");
				}
				if (!isStale) {
					staleNoticeShownRef.current = false;
				}
			} catch {
				// Ignore transient network/rate-limit errors while stale polling.
			}
		};

		void checkForStaleContext();
		const intervalId = window.setInterval(() => {
			void checkForStaleContext();
		}, 120_000);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [owner, repo, isIndexed, indexedSha, token]);

	const handleRequestNotificationPermission = useCallback(async () => {
		if (typeof Notification === "undefined") return;
		const perm = await Notification.requestPermission();
		setNotificationPermission(perm);
	}, []);

	const handleClearChat = useCallback(() => {
		if (!activeChatId) return;
		setMessages([]);
		setChatSessions((prev) =>
			prev.map((session) =>
				session.chat_id === activeChatId
					? {
						...session,
						messages: [],
						title: "Chat 1",
						updatedAt: Date.now(),
					}
					: session
			)
		);
		setContextChunks([]);
		setContextMeta(null);
		setToastMessage("Chat cleared.");
	}, [activeChatId]);

	const handleCreateChat = useCallback(() => {
		const fresh = makeNewChat(`Chat ${chatSessions.length + 1}`);
		setChatSessions((prev) => [fresh, ...prev]);
		pendingChatSwitchRef.current = fresh.chat_id;
		setActiveChatId(fresh.chat_id);
		setMessages([]);
		setInput("");
		setContextChunks([]);
		setContextMeta(null);
	}, [chatSessions.length]);

	const handleSelectChat = useCallback((chatId: string) => {
		if (!chatId || chatId === activeChatId) return;
		const target = chatSessions.find((session) => session.chat_id === chatId);
		pendingChatSwitchRef.current = chatId;
		setActiveChatId(chatId);
		setMessages(target?.messages ?? []);
		setInput("");
		setContextChunks([]);
		setContextMeta(null);
	}, [activeChatId, chatSessions]);

	const handleDeleteActiveChat = useCallback(async () => {
		if (!activeChatId) return;
		const current = chatSessions.find((session) => session.chat_id === activeChatId);
		const isLastChat = chatSessions.length <= 1;
		const confirmMessage = isLastChat
			? `Delete "${current?.title ?? "this chat"}"? This is the last chat for ${owner}/${repo}, so indexed files will also be removed.`
			: `Delete "${current?.title ?? "this chat"}"?`;
		const confirmed = typeof window === "undefined" || window.confirm(confirmMessage);
		if (!confirmed) return;

		if (isLastChat) {
			try {
				if (chatStorageKey) {
					try {
						localStorage.removeItem(chatStorageKey);
					} catch {
						// Ignore localStorage failures.
					}
				}
				if (owner && repo) {
					await storeRef.current.clearCache(owner, repo);
					storeRef.current.clear();
				}
			} catch (err) {
				console.error("Failed to clear indexed files for last chat deletion:", err);
			}
			setChatSessions([]);
			setActiveChatId(null);
			setMessages([]);
			setContextChunks([]);
			setContextMeta(null);
			setInput("");
			router.push("/");
			return;
		}

		const currentIndex = chatSessions.findIndex((session) => session.chat_id === activeChatId);
		const nextSessions = chatSessions.filter((session) => session.chat_id !== activeChatId);
		const fallback = nextSessions[Math.max(0, currentIndex - 1)] ?? nextSessions[0] ?? null;

		setChatSessions(nextSessions);
		setActiveChatId(fallback?.chat_id ?? null);
		setMessages(fallback?.messages ?? []);
		setInput("");
		setContextChunks([]);
		setContextMeta(null);
		router.push("/");
	}, [activeChatId, chatSessions, chatStorageKey, owner, repo, router]);

	const handleClearCacheAndReindex = useCallback(async () => {
		if (!owner || !repo) return;
		try {
			await storeRef.current.clearCache(owner, repo);
			storeRef.current.clear();
			setIsIndexed(false);
			setIndexedSha(null);
			setRepoStale(false);
			staleNoticeShownRef.current = false;
			setIndexProgress(null);
			setAstNodes([]);
			setTextChunkCounts({});
			setReindexKey((k) => k + 1);
		} catch (err) {
			console.error("Failed to clear cache:", err);
		}
	}, [owner, repo]);

	const handleDeleteEmbeddings = useCallback(async () => {
		if (!owner || !repo) return;
		const confirmed = typeof window !== "undefined" && window.confirm(
			`Delete stored embeddings for ${owner}/${repo}? You will be returned to the home page.`
		);
		if (!confirmed) return;
		try {
			await storeRef.current.clearCache(owner, repo);
			storeRef.current.clear();
			setIndexedSha(null);
			setRepoStale(false);
			staleNoticeShownRef.current = false;
			if (chatStorageKey) {
				try { localStorage.removeItem(chatStorageKey); } catch { }
			}
			router.push("/");
		} catch (err) {
			console.error("Failed to delete embeddings:", err);
			setToastMessage("Failed to delete embeddings.");
		}
	}, [owner, repo, router, chatStorageKey]);

	const handleSend = useCallback(async (overrideText?: string) => {
		const userMessage = (overrideText ?? input).trim();
		if (!userMessage || isGenerating || !isIndexed) return;

		setInput("");
		setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
		setIsGenerating(true);

		try {
			const queryVariants = expandQuery(userMessage);
			const results = await multiPathHybridSearch(storeRef.current, queryVariants, { limit: 5 });

			setContextChunks(
				results.map((r) => ({
					filePath: r.chunk.filePath,
					code: r.chunk.code,
					score: r.score,
					nodeType: r.chunk.nodeType,
				}))
			);

			const config = getLLMConfig();
			const limits = defaultLimitsForProvider(config.provider);
			const assembled = buildScopedContext(
				results.map((r) => ({ chunk: r.chunk, score: r.score })),
				limits
			);
			const context = assembled.context;
			setContextMeta(assembled.meta);

			const personality = config.provider === "gemini"
				? "Answer as a direct, helpful code assistant: direct, human, simple English. Use correct technical terms but no fluff or filler phrases. Cite file paths naturally. If the context does not cover the question, say so plainly."
				: "Be concise. Cite file paths when relevant. Say if the context does not cover the question.";

			const systemPrompt = `You are GitAsk, a code assistant for the ${owner}/${repo} repository. ${personality}

Epistemic contract:
- Only put facts in "Known" when explicitly supported by context.
- Put plausible interpretations in "Inferred".
- Put missing coverage or uncertainty in "Unknown".
- If the context is sampled or summarized, do not imply full-file coverage.
- Include evidence pointers as file paths and line ranges or sample labels when possible.

Code context:
${context}`;

			if (getLLMStatus() !== "ready" && getLLMStatus() !== "generating") {
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: `**LLM is still loading (${llmStatus}). Here are the most relevant code sections:**\n\n${context}`,
					},
				]);
				setIsGenerating(false);
				return;
			}

			const historyLimit = config.provider === "gemini" ? 10 : 6;
			const recentHistory = messages.slice(-historyLimit);
			const chatMessages: ChatMessage[] = [
				{ role: "system", content: systemPrompt },
				...recentHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
				{ role: "user" as const, content: userMessage },
			];

			let fullResponse = "";
			setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

			for await (const token of generate(chatMessages)) {
				fullResponse += token;
				setMessages((prev) => {
					const updated = [...prev];
					updated[updated.length - 1] = { role: "assistant", content: fullResponse };
					return updated;
				});
			}

			if (coveEnabled) {
				try {
					const refined = await verifyAndRefine(fullResponse, userMessage, storeRef.current);
					if (refined && refined !== fullResponse && refined.length > 20) {
						setMessages((prev) => {
							const updated = [...prev];
							updated[updated.length - 1] = { role: "assistant", content: refined };
							return updated;
						});
					}
				} catch {
					// CoVe is optional, don't break on failure
				}
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			if (shouldPromptForLLMSettings(errorMessage)) {
				setToastMessage("LLM authentication failed. Open LLM Settings to update your Gemini key.");
				if (typeof window !== "undefined") {
					window.dispatchEvent(new Event("gitask-open-llm-settings"));
				}
			}
			setMessages((prev) => {
				// Replace pending assistant placeholder when generation fails mid-stream.
				const next = [...prev];
				if (
					next.length > 0 &&
					next[next.length - 1].role === "assistant" &&
					next[next.length - 1].content === ""
				) {
					next[next.length - 1] = { role: "assistant", content: `Error: ${errorMessage}` };
					return next;
				}
				return [...next, { role: "assistant", content: `Error: ${errorMessage}` }];
			});
		} finally {
			setIsGenerating(false);
		}
	}, [input, isGenerating, isIndexed, messages, owner, repo, llmStatus, coveEnabled]);

	const progressPercent =
		indexProgress && indexProgress.total > 0
			? Math.round((indexProgress.current / indexProgress.total) * 100)
			: 0;

	const timeRemaining =
		indexProgress &&
		indexProgress.total > 0 &&
		indexProgress.current > 0 &&
		indexProgress.current < indexProgress.total &&
		indexStartTimeRef.current != null &&
		!["cached", "done", "persisting"].includes(indexProgress.phase)
			? (() => {
					const elapsed = Date.now() - indexStartTimeRef.current!;
					const rate = indexProgress.current / elapsed;
					const remainingMs = ((indexProgress.total - indexProgress.current) / rate);
					return formatTimeRemaining(remainingMs);
				})()
			: null;

	const orderedChatSessions = [...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt);

	return (
		<div style={styles.layout}>
			{/* Toast */}
			{toastMessage && (
				<div
					role="status"
					aria-live="polite"
					style={{
						position: "fixed",
						bottom: "24px",
						left: "50%",
						transform: "translate(-50%, 0)",
						padding: "12px 20px",
						background: "var(--bg-card)",
						border: "2px solid var(--border-accent)",
						borderRadius: "var(--radius)",
						boxShadow: "4px 4px 0 var(--accent)",
						fontSize: "14px",
						fontWeight: 600,
						zIndex: 1000,
						animation: "toast-in 0.2s ease-out",
						fontFamily: "var(--font-display)",
					}}
				>
					{toastMessage}
				</div>
			)}

			{/* Header */}
			<header style={styles.header}>
				<a href="/" style={styles.logo}>
					GitAsk
				</a>
				<a
					href={`https://github.com/${owner}/${repo}`}
					target="_blank"
					rel="noopener noreferrer"
					style={styles.repoName}
					title={`Open ${owner}/${repo} on GitHub`}
					className="repo-link"
				>
					<span style={styles.ownerText}>{owner}</span>
					<span style={styles.slash}>/</span>
					<span style={styles.repoText}>{repo}</span>
				</a>
				<div style={styles.headerActions}>
					<a
						href={projectRepoUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="btn btn-ghost star-link"
						style={{ fontSize: "12px", padding: "5px 10px", textDecoration: "none" }}
						title="Star GitAsk on GitHub"
						aria-label="Star GitAsk on GitHub"
					>
						★ Star
					</a>
					{/* LLM status indicator */}
					<div style={styles.statusPill}>
						<div
							style={getStatusDotStyle(llmStatus)}
							className={llmStatus === "loading" ? "pulse" : undefined}
							title={`LLM: ${llmStatus}`}
						/>
						{!isMobile && <span style={styles.statusText}>{llmStatus}</span>}
					</div>
					{!isMobile && (
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "5px 10px" }}
							onClick={() => setShowTokenInput(!showTokenInput)}
							title="GitHub Personal Access Token for higher rate limits"
						>
							GH Token
						</button>
					)}
					<button
						className="btn btn-ghost"
						style={{ fontSize: "12px", padding: "5px 10px" }}
						onClick={() => setShowContext(!showContext)}
						title="Retrieved context from last query"
					>
						📋 Context
					</button>
					<button
						className="btn btn-ghost"
						style={{
							fontSize: "12px",
							padding: "5px 10px",
							color: coveEnabled ? "var(--success)" : "var(--text-muted)",
							borderColor: coveEnabled ? "rgba(34,197,94,0.5)" : undefined,
						}}
						onClick={() => setCoveEnabled((v) => !v)}
						title="Enable CoVe verification (adds ~2-4s latency)"
					>
						CoVE {coveEnabled ? "on" : "off"}
					</button>
					{isIndexed && (
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "5px 10px" }}
							onClick={() => setShowBrowse(!showBrowse)}
							title="Browse all indexed content"
						>
							📂 Browse
						</button>
					)}
					{isIndexed && (
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "5px 10px" }}
							onClick={() => { void handleClearCacheAndReindex(); }}
							title="Rebuild repository index from latest GitHub state"
						>
							↻ Re-index
						</button>
					)}
					<div ref={overflowRef} style={{ position: "relative" }}>
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "5px 10px" }}
							onClick={() => setShowOverflow((v) => !v)}
							title="More options"
						>
							•••
						</button>
						{showOverflow && (
							<div style={{
								position: "absolute",
								top: "calc(100% + 6px)",
								right: 0,
								background: "var(--bg-card)",
								border: "2px solid var(--border)",
								borderRadius: "var(--radius)",
								boxShadow: "3px 3px 0 var(--accent)",
								padding: "4px",
								display: "flex",
								flexDirection: "column",
								gap: "2px",
								zIndex: 20,
								minWidth: "168px",
							}}>
								{owner && repo && (
									<button
										className="btn btn-ghost"
										style={{ fontSize: "12px", padding: "6px 12px", color: "var(--text-muted)", justifyContent: "flex-start", width: "100%", border: "none", boxShadow: "none" }}
										onClick={() => { handleDeleteEmbeddings(); setShowOverflow(false); }}
									>
										🗑 Delete embeddings
									</button>
								)}
								{isIndexed && (
									<button
										className="btn btn-ghost"
										style={{ fontSize: "12px", padding: "6px 12px", justifyContent: "flex-start", width: "100%", border: "none", boxShadow: "none" }}
										onClick={() => { handleClearCacheAndReindex(); setShowOverflow(false); }}
									>
										🔄 Re-index
									</button>
								)}
							</div>
						)}
					</div>
					{messages.length > 0 && (
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "5px 10px" }}
							onClick={handleClearChat}
						>
							🗑 Clear
						</button>
					)}
					<div style={styles.headerDivider} />
					<ModelSettings />
				</div>
			</header>

			{/* Token input */}
			{showTokenInput && (
				<div style={styles.tokenBar}>
					<input
						className="input"
						type="password"
						placeholder="GitHub Personal Access Token (optional, for higher rate limits)"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						style={{ flex: 1, fontSize: "13px" }}
					/>
				</div>
			)}

			{isIndexed && repoStale && (
				<div style={styles.staleBanner}>
					<span style={styles.staleBannerText}>
						This repository has new commits on GitHub. Current context may be stale.
					</span>
					<button
						type="button"
						className="btn btn-primary"
						style={styles.staleBannerBtn}
						onClick={() => { void handleClearCacheAndReindex(); }}
					>
						Re-index Now
					</button>
				</div>
			)}

			{/* Progress bar */}
			{!isIndexed && indexProgress && (
				<div style={styles.progressContainer}>
					<div className="progress-bar" style={styles.progressBar}>
						<div
							className="progress-bar-fill"
							style={{ width: `${progressPercent}%` }}
						/>
					</div>
					<span style={styles.progressText}>
						{indexProgress.message}
						{indexProgress.estimatedSizeBytes != null && indexProgress.estimatedSizeBytes > 0 && (
							<span style={{ color: "var(--text-muted)", marginLeft: "8px" }}>
								(~{formatBytes(indexProgress.estimatedSizeBytes)})
							</span>
						)}
						{timeRemaining && (
							<span style={{ color: "var(--text-muted)", marginLeft: "8px" }}>
								{timeRemaining} remaining
							</span>
						)}
						{typeof Notification !== "undefined" && notificationPermission === "default" && (
							<button
								type="button"
								className="btn btn-ghost"
								style={{
									marginLeft: "12px",
									fontSize: "12px",
									padding: "2px 8px",
									color: "var(--text-muted)",
								}}
								onClick={handleRequestNotificationPermission}
								title="Get a system notification when indexing completes (optional)"
							>
								Notify when ready (optional)
							</button>
						)}
					</span>
				</div>
			)}

			{/* Main content */}
			<div style={styles.content}>
				{/* AST Tree visualization during indexing */}
				{!isIndexed && astNodes.length > 0 && (
					<div style={styles.astPanel}>
						<AstTreeView
							astNodes={astNodes}
							textChunkCounts={textChunkCounts}
						/>
					</div>
				)}

				{/* Chat panel */}
				<div style={{
					...styles.chatPanel,
					display: !isIndexed && astNodes.length > 0 ? "none" : "flex",
				}}>
					<div style={styles.chatToolbar}>
						<select
							value={activeChatId ?? ""}
							onChange={(e) => handleSelectChat(e.target.value)}
							style={styles.chatSelect}
							aria-label="Select chat session"
						>
							{orderedChatSessions.map((session) => (
								<option key={session.chat_id} value={session.chat_id}>
									{session.title}
								</option>
							))}
						</select>
						<button
							className="btn btn-ghost"
							style={styles.chatToolbarBtn}
							onClick={handleCreateChat}
							type="button"
						>
							+ New Chat
						</button>
						<button
							className="btn btn-ghost"
							style={styles.chatToolbarBtn}
							onClick={handleDeleteActiveChat}
							type="button"
							title={chatSessions.length <= 1 ? "Delete messages in current chat" : "Delete current chat"}
						>
							🗑 Delete Chat
						</button>
					</div>
					<div style={styles.messageList}>
						{messages.length === 0 && isIndexed && (
							<div style={styles.emptyState}>
								<div style={styles.emptyStateIcon}>💬</div>
								<p style={styles.emptyStateTitle}>Ask about this repo</p>
								<p style={styles.emptyStateHint}>Try one of these to get started</p>
								<div style={styles.chipRow}>
									{[
										"What does this project do?",
										"Walk me through the main data flow",
										"What are the key entry points?",
										"How is error handling structured?",
									].map((q) => (
										<button
											key={q}
											className="btn btn-ghost"
											style={styles.chip}
											onClick={() => handleSend(q)}
											disabled={isGenerating}
										>
											{q}
										</button>
									))}
								</div>
							</div>
						)}

						{messages.map((msg, i) => (
							<div
								key={i}
								style={{
									...styles.message,
									alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
									background: msg.role === "user" ? "var(--accent)" : "var(--bg-card)",
									maxWidth: msg.role === "user" ? "70%" : "90%",
									border: msg.role === "user"
										? "2px solid var(--accent)"
										: "2px solid var(--border)",
									boxShadow: msg.role === "user"
										? "3px 3px 0 rgba(0,0,0,0.5)"
										: "3px 3px 0 var(--bg-secondary)",
								}}
								className="chat-message"
							>
								{msg.role === "assistant" ? (
									isGenerating && i === messages.length - 1 ? (
										<pre style={styles.messageContent}>{msg.content || "Thinking..."}</pre>
									) : (
										<div style={{ ...styles.messageContent, whiteSpace: "normal" }} className="chat-markdown">
											<ReactMarkdown>{msg.content}</ReactMarkdown>
										</div>
									)
								) : (
									<pre style={styles.messageContent}>{msg.content}</pre>
								)}
							</div>
						))}
						<div ref={chatEndRef} />
					</div>

					{/* Input bar */}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSend();
						}}
						style={styles.inputBar}
					>
						<input
							className="input"
							type="text"
							placeholder={isIndexed ? "Ask a question…" : "Indexing repository…"}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							disabled={!isIndexed || isGenerating}
							id="chat-input"
							style={styles.chatInput}
						/>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={!isIndexed || isGenerating || !input.trim()}
							id="send-btn"
							style={styles.sendBtn}
						>
							{isGenerating ? "…" : "Send"}
						</button>
					</form>
				</div>

				{/* Browse drawer */}
				{showBrowse && isIndexed && (
					<aside style={{
						...styles.browseDrawer,
						...(isMobile && { position: "fixed" as const, inset: 0, width: "100%", minWidth: "unset", zIndex: 100, borderLeft: "none" }),
					}}>
						<IndexBrowser
							chunks={storeRef.current.getAll()}
							onClose={() => setShowBrowse(false)}
						/>
					</aside>
				)}

				{/* Context drawer */}
				{showContext && contextChunks.length > 0 && (
					<aside style={{
						...styles.contextDrawer,
						...(isMobile && { position: "fixed" as const, inset: 0, width: "100%", minWidth: "unset", zIndex: 100, borderLeft: "none" }),
					}}>
						<h3 style={styles.drawerTitle}>
							Retrieved Context ({contextChunks.length} chunks)
						</h3>
						<p style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "8px", fontFamily: "var(--font-mono)" }}>
							Top results from hybrid search
						</p>
						{contextMeta && contextMeta.compactionStage !== "none" && (
							<div style={{ fontSize: "11px", color: "var(--warning)", background: "rgba(245,158,11,0.08)", padding: "8px 10px", border: "2px solid rgba(245,158,11,0.3)", borderRadius: "var(--radius-sm)", marginBottom: "8px" }}>
								⚠ LLM context compacted ({contextMeta.compactionStage}): {contextMeta.totalChars} chars / ~{contextMeta.estimatedTokens.toLocaleString()} tokens → {contextMeta.maxChars.toLocaleString()} chars / {contextMeta.maxTokens.toLocaleString()} token budget
							</div>
						)}
						{contextChunks.map((chunk, i) => (
							<div key={i} style={styles.contextItem}>
								<div style={styles.contextMeta}>
									<span style={styles.filePath}>{chunk.filePath}</span>
									<span style={styles.score}>
										{(chunk.score * 100).toFixed(1)}%
									</span>
								</div>
								<pre className="code" style={{ fontSize: "11px", maxHeight: "300px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
									{chunk.code}
								</pre>
								{chunk.code.length > 500 && (
									<span style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
										{chunk.code.length} chars
									</span>
								)}
							</div>
						))}
					</aside>
				)}
			</div>
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeRemaining(ms: number): string {
	if (ms < 60_000) return `~${Math.round(ms / 1000)} sec`;
	if (ms < 3600_000) return `~${Math.round(ms / 60_000)} min`;
	return `~${(ms / 3600_000).toFixed(1)} hr`;
}

function getStatusDotStyle(status: LLMStatus): React.CSSProperties {
	return {
		width: "8px",
		height: "8px",
		borderRadius: "50%",
		flexShrink: 0,
		background:
			status === "ready"
				? "var(--success)"
				: status === "generating"
					? "var(--warning)"
					: status === "loading"
						? "var(--accent)"
						: "var(--text-muted)",
	};
}

const styles: Record<string, React.CSSProperties> = {
	layout: {
		display: "flex",
		flexDirection: "column",
		height: "100vh",
		overflow: "hidden",
	},
	header: {
		display: "flex",
		alignItems: "center",
		gap: "12px",
		padding: "10px 20px",
		borderBottom: "2px solid var(--border)",
		background: "var(--bg-secondary)",
		position: "relative" as const,
		zIndex: 10,
	},
	logo: {
		fontWeight: 800,
		fontSize: "16px",
		color: "var(--accent)",
		textDecoration: "none",
		letterSpacing: "-0.02em",
		fontFamily: "var(--font-display)",
	},
	repoName: {
		display: "flex",
		alignItems: "center",
		gap: "4px",
		flex: 1,
		textDecoration: "none",
		color: "inherit",
		transition: "opacity 0.15s ease",
		cursor: "pointer",
	},
	headerDivider: {
		width: "2px",
		height: "20px",
		background: "var(--border)",
		margin: "0 4px",
	},
	ownerText: { color: "var(--text-secondary)", fontSize: "14px", fontWeight: 500 },
	slash: { color: "var(--text-muted)", fontSize: "14px" },
	repoText: { fontWeight: 700, fontSize: "14px" },
	headerActions: {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		flexWrap: "wrap" as const,
	},
	statusPill: {
		display: "inline-flex",
		alignItems: "center",
		gap: "6px",
		padding: "4px 10px",
		border: "2px solid var(--border)",
		borderRadius: "var(--radius-sm)",
		background: "var(--bg-card)",
	},
	statusText: {
		fontSize: "12px",
		color: "var(--text-secondary)",
		minWidth: "56px",
		fontFamily: "var(--font-mono)",
	},
	tokenBar: {
		padding: "8px 20px",
		borderBottom: "2px solid var(--border)",
		display: "flex",
		gap: "8px",
		background: "var(--bg-secondary)",
	},
	staleBanner: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: "12px",
		padding: "10px 20px",
		background: "rgba(245,158,11,0.08)",
		borderBottom: "2px solid rgba(245,158,11,0.35)",
	},
	staleBannerText: {
		fontSize: "12px",
		color: "var(--warning)",
		fontFamily: "var(--font-mono)",
	},
	staleBannerBtn: {
		fontSize: "12px",
		padding: "5px 10px",
		flexShrink: 0,
	},
	progressContainer: {
		padding: "12px 20px",
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		background: "var(--bg-secondary)",
		borderBottom: "2px solid var(--border)",
	},
	progressBar: {
		height: "8px",
	},
	progressText: {
		fontSize: "12px",
		color: "var(--text-secondary)",
		fontFamily: "var(--font-mono)",
	},
	content: {
		display: "flex",
		flex: 1,
		overflow: "hidden",
	},
	astPanel: {
		flex: 1,
		overflow: "auto",
		padding: "16px 20px",
	},
	chatPanel: {
		flex: 1,
		display: "flex",
		flexDirection: "column",
		overflow: "hidden",
	},
	chatToolbar: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		padding: "10px 20px",
		borderBottom: "2px solid var(--border)",
		background: "var(--bg-secondary)",
		maxWidth: "900px",
		margin: "0 auto",
		width: "100%",
	},
	chatSelect: {
		flex: 1,
		minWidth: "160px",
		maxWidth: "360px",
		padding: "8px 10px",
		borderRadius: "var(--radius-sm)",
		border: "2px solid var(--border)",
		background: "var(--bg-card)",
		color: "var(--text-primary)",
		fontSize: "12px",
		fontFamily: "var(--font-mono)",
	},
	chatToolbarBtn: {
		fontSize: "12px",
		padding: "6px 10px",
	},
	messageList: {
		flex: 1,
		overflow: "auto",
		padding: "24px",
		display: "flex",
		flexDirection: "column",
		gap: "16px",
		maxWidth: "900px",
		margin: "0 auto",
		width: "100%",
	},
	emptyState: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: "12px",
		flex: 1,
		color: "var(--text-secondary)",
		padding: "48px 24px",
	},
	emptyStateIcon: {
		fontSize: "40px",
		opacity: 0.7,
		lineHeight: 1,
	},
	emptyStateTitle: {
		fontWeight: 800,
		fontSize: "20px",
		color: "var(--text-primary)",
		fontFamily: "var(--font-display)",
	},
	emptyStateHint: {
		color: "var(--text-muted)",
		fontSize: "13px",
		lineHeight: 1.5,
		textAlign: "center",
		maxWidth: "320px",
	},
	chipRow: {
		display: "flex",
		flexWrap: "wrap" as const,
		gap: "8px",
		justifyContent: "center",
		maxWidth: "520px",
		marginTop: "4px",
	},
	chip: {
		fontSize: "12px",
		padding: "6px 14px",
		borderRadius: "var(--radius-sm)",
		whiteSpace: "nowrap" as const,
		fontWeight: 500,
	},
	message: {
		padding: "14px 18px",
		borderRadius: "var(--radius)",
		fontSize: "14px",
		lineHeight: 1.65,
	},
	messageContent: {
		fontFamily: "var(--font-sans)",
		fontSize: "14px",
		lineHeight: 1.6,
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		margin: 0,
	},
	inputBar: {
		display: "flex",
		gap: "12px",
		padding: "14px 20px",
		borderTop: "2px solid var(--border)",
		background: "var(--bg-secondary)",
		flexShrink: 0,
		maxWidth: "900px",
		margin: "0 auto",
		width: "100%",
	},
	chatInput: { flex: 1 },
	sendBtn: {
		flexShrink: 0,
		fontFamily: "var(--font-display)",
		fontWeight: 700,
	},
	browseDrawer: {
		width: "480px",
		minWidth: "400px",
		overflow: "hidden",
		padding: "20px",
		borderLeft: "2px solid var(--border)",
		display: "flex",
		flexDirection: "column",
		background: "var(--bg-card)",
	},
	contextDrawer: {
		width: "360px",
		minWidth: "280px",
		overflow: "auto",
		padding: "20px",
		borderLeft: "2px solid var(--border)",
		display: "flex",
		flexDirection: "column",
		gap: "14px",
		background: "var(--bg-card)",
	},
	drawerTitle: {
		fontSize: "12px",
		fontWeight: 700,
		color: "var(--text-muted)",
		textTransform: "uppercase" as const,
		letterSpacing: "0.08em",
		fontFamily: "var(--font-display)",
	},
	contextItem: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		padding: "12px",
		background: "var(--bg-secondary)",
		border: "2px solid var(--border)",
		borderRadius: "var(--radius)",
	},
	contextMeta: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
	},
	filePath: {
		fontSize: "12px",
		fontFamily: "var(--font-mono)",
		color: "var(--accent)",
		fontWeight: 500,
	},
	score: {
		fontSize: "11px",
		color: "var(--text-muted)",
		fontFamily: "var(--font-mono)",
	},
};
