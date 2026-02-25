"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { indexRepository, IndexAbortError, type IndexProgress, type AstNode } from "@/lib/indexer";
import { VectorStore } from "@/lib/vectorStore";
import { hybridSearch, type SearchOptions } from "@/lib/search";
import { embedText } from "@/lib/embedder";
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
	const chatStorageKey = owner && repo ? `gitask-chat-${owner}/${repo}` : null;
	const [input, setInput] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [contextChunks, setContextChunks] = useState<ContextChunk[]>([]);
	const [contextMeta, setContextMeta] = useState<{ truncated: boolean; totalChars: number; maxChars: number } | null>(null);
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
	const completedWhileHiddenRef = useRef(false);
	const indexStartTimeRef = useRef<number | null>(null);
	const overflowRef = useRef<HTMLDivElement>(null);

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

	// Listen to LLM status
	useEffect(() => {
		return onStatusChange(setLlmStatus);
	}, []);

	// Load chat history from localStorage
	useEffect(() => {
		if (!chatStorageKey) return;
		try {
			const saved = localStorage.getItem(chatStorageKey);
			if (saved) {
				const parsed = JSON.parse(saved) as Message[];
				if (Array.isArray(parsed) && parsed.length > 0) {
					setMessages(parsed);
				}
			}
		} catch {
			// Ignore corrupted data
		}
	}, [chatStorageKey]);

	// Save chat history to localStorage (capped at 50 messages)
	useEffect(() => {
		if (!chatStorageKey || messages.length === 0) return;
		try {
			const toSave = messages.slice(-50);
			localStorage.setItem(chatStorageKey, JSON.stringify(toSave));
		} catch {
			// Storage full or unavailable — silently skip
		}
	}, [messages, chatStorageKey]);

	// Auto-scroll chat
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

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
				await indexRepository(
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
					// Browser notification if permission granted
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

				// Start loading LLM in background
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
				safeSetState(setIndexProgress, {
					phase: "done",
					message: `Error: ${err instanceof Error ? err.message : String(err)}`,
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

	const handleRequestNotificationPermission = useCallback(async () => {
		if (typeof Notification === "undefined") return;
		const perm = await Notification.requestPermission();
		setNotificationPermission(perm);
	}, []);

	const handleClearChat = useCallback(() => {
		setMessages([]);
		if (chatStorageKey) {
			try { localStorage.removeItem(chatStorageKey); } catch { }
		}
	}, [chatStorageKey]);

	const handleClearCacheAndReindex = useCallback(async () => {
		if (!owner || !repo) return;
		try {
			await storeRef.current.clearCache(owner, repo);
			storeRef.current.clear();
			setIsIndexed(false);
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
			router.push("/");
		} catch (err) {
			console.error("Failed to delete embeddings:", err);
			setToastMessage("Failed to delete embeddings.");
		}
	}, [owner, repo, router]);

	const handleSend = useCallback(async (overrideText?: string) => {
		const userMessage = (overrideText ?? input).trim();
		if (!userMessage || isGenerating || !isIndexed) return;

		setInput("");
		setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
		setIsGenerating(true);

		try {
			// 1. Embed query and search
			const queryEmbedding = await embedText(userMessage);
			const results = hybridSearch(storeRef.current, queryEmbedding, userMessage, { limit: 5 });

			setContextChunks(
				results.map((r) => ({
					filePath: r.chunk.filePath,
					code: r.chunk.code,
					score: r.score,
				}))
			);

			// 2. Build context (Gemini Flash has huge context, no truncation; MLC needs a limit)
			const config = getLLMConfig();
			const MAX_CONTEXT_CHARS = config.provider === "gemini" ? Infinity : 24_000; // MLC ~8K tokens
			const rawContext = results
				.map((r) => `### ${r.chunk.filePath} (score: ${r.score.toFixed(3)})\n\`\`\`\n${r.chunk.code}\n\`\`\``)
				.join("\n\n");
			const contextTruncated = rawContext.length > MAX_CONTEXT_CHARS;
			const context = contextTruncated
				? rawContext.slice(0, MAX_CONTEXT_CHARS) + "\n...(truncated)"
				: rawContext;
			setContextMeta({ truncated: contextTruncated, totalChars: rawContext.length, maxChars: MAX_CONTEXT_CHARS });

			const personality = config.provider === "gemini"
				? "Answer like a senior engineer: direct, human, simple English. Use correct technical terms but no fluff or filler phrases. Cite file paths naturally. If the context does not cover the question, say so plainly."
				: "Be concise. Cite file paths when relevant. Say if the context does not cover the question.";

			const systemPrompt = `You are GitAsk, a code assistant for the ${owner}/${repo} repository. ${personality}

Code context:
${context}`;

			// 3. Check if LLM is ready
			if (getLLMStatus() !== "ready" && getLLMStatus() !== "generating") {
				// LLM not ready yet — give a retrieval-only answer
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

			// 4. Stream response (cap history to stay within token budget; Gemini has a large context, MLC does not)
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

			// 5. CoVe (optional, runs in background for refinement)
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
		} catch (err) {
			setMessages((prev) => [
				...prev,
				{ role: "assistant", content: `Error: ${err instanceof Error ? err.message : String(err)}` },
			]);
		} finally {
			setIsGenerating(false);
		}
	}, [input, isGenerating, isIndexed, messages, owner, repo, llmStatus]);

	const progressPercent =
		indexProgress && indexProgress.total > 0
			? Math.round((indexProgress.current / indexProgress.total) * 100)
			: 0;

	// Approx time remaining (only when we have meaningful progress)
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

	return (
		<div style={styles.layout}>
			{/* Toast for return-to-tab notification */}
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
						border: "1px solid var(--border)",
						borderRadius: "8px",
						boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
						fontSize: "14px",
						zIndex: 1000,
						animation: "toast-in 0.2s ease-out",
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
					<div
						style={getStatusDotStyle(llmStatus)}
						className={llmStatus === "loading" ? "pulse" : undefined}
						title={`LLM: ${llmStatus}`}
					/>
					{!isMobile && <span style={styles.statusText}>{llmStatus}</span>}
					{!isMobile && (
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "6px 12px" }}
							onClick={() => setShowTokenInput(!showTokenInput)}
							title="GitHub Personal Access Token for higher rate limits"
						>
							GH Token
						</button>
					)}
					<button
						className="btn btn-ghost"
						style={{ fontSize: "12px", padding: "6px 12px" }}
						onClick={() => setShowContext(!showContext)}
						title="Retrieved context from last query"
					>
						📋 Context
					</button>
					{isIndexed && (
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "6px 12px" }}
							onClick={() => setShowBrowse(!showBrowse)}
							title="Browse all indexed content"
						>
							📂 Browse
						</button>
					)}
					<div ref={overflowRef} style={{ position: "relative" }}>
						<button
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "6px 10px" }}
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
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-sm)",
								padding: "4px",
								display: "flex",
								flexDirection: "column",
								gap: "2px",
								zIndex: 20,
								minWidth: "168px",
								boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
							}}>
								{owner && repo && (
									<button
										className="btn btn-ghost"
										style={{ fontSize: "12px", padding: "6px 12px", color: "var(--text-muted)", justifyContent: "flex-start", width: "100%", border: "none" }}
										onClick={() => { handleDeleteEmbeddings(); setShowOverflow(false); }}
									>
										🗑 Delete embeddings
									</button>
								)}
								{isIndexed && (
									<button
										className="btn btn-ghost"
										style={{ fontSize: "12px", padding: "6px 12px", justifyContent: "flex-start", width: "100%", border: "none" }}
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
							style={{ fontSize: "12px", padding: "6px 12px" }}
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
									background:
										msg.role === "user"
											? "var(--accent)"
											: "var(--bg-card)",
									maxWidth: msg.role === "user" ? "70%" : "90%",
									boxShadow: msg.role === "user" ? "0 2px 8px rgba(99, 102, 241, 0.2)" : "0 1px 3px rgba(0,0,0,0.15)",
								}}
								className={msg.role === "assistant" ? "glass chat-message" : "chat-message"}
							>
								{msg.role === "assistant" ? (
								<div style={{ ...styles.messageContent, whiteSpace: "normal" }} className="chat-markdown">
									<ReactMarkdown>{msg.content || (isGenerating && i === messages.length - 1 ? "Thinking…" : "")}</ReactMarkdown>
								</div>
							) : (
								<pre style={styles.messageContent}>{msg.content}</pre>
							)}
							</div>
						))}
						<div ref={chatEndRef} />
					</div>

					{/* Input */}
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

				{/* Browse drawer - all indexed content */}
				{showBrowse && isIndexed && (
					<aside style={{
						...styles.browseDrawer,
						...(isMobile && { position: "fixed" as const, inset: 0, width: "100%", minWidth: "unset", zIndex: 100, borderLeft: "none" }),
					}} className="glass">
						<IndexBrowser
							chunks={storeRef.current.getAll()}
							onClose={() => setShowBrowse(false)}
						/>
					</aside>
				)}

				{/* Context drawer - retrieved context from last query */}
				{showContext && contextChunks.length > 0 && (
					<aside style={{
						...styles.contextDrawer,
						...(isMobile && { position: "fixed" as const, inset: 0, width: "100%", minWidth: "unset", zIndex: 100, borderLeft: "none" }),
					}} className="glass">
						<h3 style={styles.drawerTitle}>
							Retrieved Context ({contextChunks.length} chunks)
						</h3>
						<p style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "8px" }}>
							Top results from hybrid search. Full code shown below.
						</p>
						{contextMeta?.truncated && (
							<div style={{ fontSize: "11px", color: "var(--warning)", background: "rgba(245,158,11,0.1)", padding: "8px", borderRadius: "6px", marginBottom: "8px" }}>
								⚠ LLM context was truncated: {contextMeta.totalChars} chars → {contextMeta.maxChars.toLocaleString()} max. Model may not have seen all chunks.
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
									<span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
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
		gap: "16px",
		padding: "12px 24px",
		borderBottom: "1px solid var(--border)",
		background: "var(--bg-secondary)",
		position: "relative" as const,
		zIndex: 10,
	},
	logo: {
		fontWeight: 700,
		fontSize: "16px",
		color: "var(--accent)",
		textDecoration: "none",
	},
	repoName: {
		display: "flex",
		alignItems: "center",
		gap: "4px",
		flex: 1,
		textDecoration: "none",
		color: "inherit",
		transition: "opacity 0.2s ease",
		cursor: "pointer",
	},
	headerDivider: {
		width: "1px",
		height: "20px",
		background: "var(--border)",
		margin: "0 12px",
	},
	ownerText: { color: "var(--text-secondary)", fontSize: "14px" },
	slash: { color: "var(--text-muted)", fontSize: "14px" },
	repoText: { fontWeight: 600, fontSize: "14px" },
	headerActions: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
	},
	statusText: {
		fontSize: "12px",
		color: "var(--text-secondary)",
		minWidth: "60px",
	},
	tokenBar: {
		padding: "8px 24px",
		borderBottom: "1px solid var(--border)",
		display: "flex",
		gap: "8px",
	},
	progressContainer: {
		padding: "14px 24px",
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		background: "var(--bg-secondary)",
	},
	progressBar: {
		height: "6px",
		borderRadius: "3px",
	},
	progressText: {
		fontSize: "12px",
		color: "var(--text-secondary)",
	},
	content: {
		display: "flex",
		flex: 1,
		overflow: "hidden",
	},
	astPanel: {
		flex: 1,
		overflow: "auto",
		padding: "16px 24px",
	},
	chatPanel: {
		flex: 1,
		display: "flex",
		flexDirection: "column",
		overflow: "hidden",
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
		opacity: 0.6,
		lineHeight: 1,
	},
	emptyStateTitle: {
		fontWeight: 600,
		fontSize: "18px",
		color: "var(--text-primary)",
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
		borderRadius: "9999px",
		whiteSpace: "nowrap" as const,
	},
	message: {
		padding: "14px 18px",
		borderRadius: "var(--radius)",
		fontSize: "14px",
		lineHeight: 1.65,
		transition: "box-shadow 0.2s ease",
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
		padding: "16px 24px",
		borderTop: "1px solid var(--border)",
		background: "var(--bg-secondary)",
		flexShrink: 0,
		maxWidth: "900px",
		margin: "0 auto",
		width: "100%",
	},
	chatInput: { flex: 1 },
	sendBtn: { flexShrink: 0 },
	browseDrawer: {
		width: "480px",
		minWidth: "400px",
		overflow: "hidden",
		padding: "20px",
		borderLeft: "1px solid var(--border)",
		display: "flex",
		flexDirection: "column",
	},
	contextDrawer: {
		width: "360px",
		minWidth: "280px",
		overflow: "auto",
		padding: "20px",
		borderLeft: "1px solid var(--border)",
		display: "flex",
		flexDirection: "column",
		gap: "16px",
	},
	drawerTitle: {
		fontSize: "13px",
		fontWeight: 600,
		color: "var(--text-muted)",
		textTransform: "uppercase" as const,
		letterSpacing: "0.05em",
	},
	contextItem: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		padding: "12px",
		background: "var(--bg-glass)",
		borderRadius: "var(--radius-sm)",
		border: "1px solid var(--border)",
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
	},
	score: {
		fontSize: "11px",
		color: "var(--text-muted)",
	},
};
