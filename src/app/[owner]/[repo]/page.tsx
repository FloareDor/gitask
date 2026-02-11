"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { indexRepository, type IndexProgress } from "@/lib/indexer";
import { VectorStore } from "@/lib/vectorStore";
import { hybridSearch, type SearchOptions } from "@/lib/search";
import { embedText } from "@/lib/embedder";
import { initLLM, generate, getLLMStatus, onStatusChange, type LLMStatus, type ChatMessage } from "@/lib/llm";
import { verifyAndRefine } from "@/lib/cove";

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
	const [owner, setOwner] = useState("");
	const [repo, setRepo] = useState("");

	const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
	const [isIndexed, setIsIndexed] = useState(false);
	const [llmStatus, setLlmStatus] = useState<LLMStatus>("idle");
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [contextChunks, setContextChunks] = useState<ContextChunk[]>([]);
	const [showContext, setShowContext] = useState(false);
	const [token, setToken] = useState("");
	const [showTokenInput, setShowTokenInput] = useState(false);

	const storeRef = useRef(new VectorStore());
	const chatEndRef = useRef<HTMLDivElement>(null);

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

	// Auto-scroll chat
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// Start indexing when owner/repo are ready
	useEffect(() => {
		if (!owner || !repo) return;
		(async () => {
			try {
				await indexRepository(owner, repo, storeRef.current, setIndexProgress, token || undefined);
				setIsIndexed(true);

				// Start loading LLM in background
				initLLM((msg) => {
					setIndexProgress((prev) => ({
						phase: "done",
						message: msg,
						current: prev?.current ?? 0,
						total: prev?.total ?? 0,
					}));
				}).catch(console.error);
			} catch (err) {
				setIndexProgress({
					phase: "done",
					message: `Error: ${err instanceof Error ? err.message : String(err)}`,
					current: 0,
					total: 0,
				});
			}
		})();
	}, [owner, repo, token]);

	const handleSend = useCallback(async () => {
		if (!input.trim() || isGenerating || !isIndexed) return;

		const userMessage = input.trim();
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

			// 2. Build context
			const context = results
				.map((r) => `### ${r.chunk.filePath} (score: ${r.score.toFixed(3)})\n\`\`\`\n${r.chunk.code}\n\`\`\``)
				.join("\n\n");

			const systemPrompt = `You are GitAsk, an AI assistant that answers questions about the ${owner}/${repo} GitHub repository. Use the following code context to answer the user's question. Be concise and cite file paths when relevant.\n\n${context}`;

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

			// 4. Stream response
			const chatMessages: ChatMessage[] = [
				{ role: "system", content: systemPrompt },
				...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
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

	return (
		<div style={styles.layout}>
			{/* Header */}
			<header style={styles.header}>
				<a href="/" style={styles.logo}>
					GitAsk
				</a>
				<div style={styles.repoName}>
					<span style={styles.ownerText}>{owner}</span>
					<span style={styles.slash}>/</span>
					<span style={styles.repoText}>{repo}</span>
				</div>
				<div style={styles.headerActions}>
					<div style={getStatusDotStyle(llmStatus)} title={`LLM: ${llmStatus}`} />
					<span style={styles.statusText}>{llmStatus}</span>
					<button
						className="btn btn-ghost"
						style={{ fontSize: "12px", padding: "6px 12px" }}
						onClick={() => setShowTokenInput(!showTokenInput)}
					>
						🔑 Token
					</button>
					<button
						className="btn btn-ghost"
						style={{ fontSize: "12px", padding: "6px 12px" }}
						onClick={() => setShowContext(!showContext)}
					>
						📋 Context
					</button>
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
					<div className="progress-bar">
						<div
							className="progress-bar-fill"
							style={{ width: `${progressPercent}%` }}
						/>
					</div>
					<span style={styles.progressText}>{indexProgress.message}</span>
				</div>
			)}

			{/* Main content */}
			<div style={styles.content}>
				{/* Chat panel */}
				<div style={styles.chatPanel}>
					<div style={styles.messageList}>
						{messages.length === 0 && isIndexed && (
							<div style={styles.emptyState}>
								<p style={{ fontSize: "28px" }}>💬</p>
								<p style={{ fontWeight: 600 }}>Ask anything about this repo</p>
								<p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
									Try: &quot;What does this project do?&quot; or &quot;How is the main function structured?&quot;
								</p>
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
								}}
								className={msg.role === "assistant" ? "glass" : ""}
							>
								<pre style={styles.messageContent}>{msg.content || (isGenerating && i === messages.length - 1 ? "Thinking…" : "")}</pre>
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
							style={{ flex: 1 }}
						/>
						<button
							type="submit"
							className="btn btn-primary"
							disabled={!isIndexed || isGenerating || !input.trim()}
							id="send-btn"
						>
							{isGenerating ? "…" : "Send"}
						</button>
					</form>
				</div>

				{/* Context drawer */}
				{showContext && contextChunks.length > 0 && (
					<aside style={styles.contextDrawer} className="glass">
						<h3 style={styles.drawerTitle}>Retrieved Context</h3>
						{contextChunks.map((chunk, i) => (
							<div key={i} style={styles.contextItem}>
								<div style={styles.contextMeta}>
									<span style={styles.filePath}>{chunk.filePath}</span>
									<span style={styles.score}>
										{(chunk.score * 100).toFixed(1)}%
									</span>
								</div>
								<pre className="code" style={{ fontSize: "11px", maxHeight: "150px", overflow: "auto" }}>
									{chunk.code.slice(0, 500)}
								</pre>
							</div>
						))}
					</aside>
				)}
			</div>
		</div>
	);
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
		padding: "12px 24px",
		display: "flex",
		flexDirection: "column",
		gap: "6px",
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
		gap: "12px",
	},
	emptyState: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: "8px",
		flex: 1,
		color: "var(--text-secondary)",
	},
	message: {
		padding: "12px 16px",
		borderRadius: "var(--radius)",
		fontSize: "14px",
		lineHeight: 1.6,
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
		gap: "8px",
		padding: "16px 24px",
		borderTop: "1px solid var(--border)",
		background: "var(--bg-secondary)",
	},
	contextDrawer: {
		width: "360px",
		overflow: "auto",
		padding: "16px",
		borderLeft: "1px solid var(--border)",
		display: "flex",
		flexDirection: "column",
		gap: "12px",
	},
	drawerTitle: {
		fontSize: "14px",
		fontWeight: 600,
		color: "var(--text-secondary)",
	},
	contextItem: {
		display: "flex",
		flexDirection: "column",
		gap: "6px",
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
