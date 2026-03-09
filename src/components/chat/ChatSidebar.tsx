"use client";

import AstTreeView from "@/components/AstTreeView";
import type { ChatSession } from "@/app/[owner]/[repo]/types";
import type { IndexProgress, AstNode } from "@/lib/indexer";

interface ChatSidebarProps {
	isIndexed: boolean;
	isIndexing: boolean;
	indexingFailed: boolean;
	indexProgress: IndexProgress | null;
	progressPercent: number;
	timeRemaining: string | null;
	notificationPermission: NotificationPermission | null;
	chunkCount: number;
	orderedChatSessions: ChatSession[];
	activeChatId: string | null;
	astNodes: AstNode[];
	textChunkCounts: Record<string, number>;
	sidebarCollapsed: boolean;
	onSelectChat: (id: string) => void;
	onCreateChat: () => void;
	onCollapse: () => void;
	onRequestNotification: () => void;
}

export function ChatSidebar({
	isIndexed,
	isIndexing,
	indexingFailed,
	indexProgress,
	progressPercent,
	timeRemaining,
	notificationPermission,
	chunkCount,
	orderedChatSessions,
	activeChatId,
	astNodes,
	textChunkCounts,
	sidebarCollapsed,
	onSelectChat,
	onCreateChat,
	onCollapse,
	onRequestNotification,
}: ChatSidebarProps) {
	return (
		<aside style={{
			width: sidebarCollapsed ? 0 : 220,
			minWidth: sidebarCollapsed ? 0 : 220,
			background: "var(--bg-app)",
			borderRight: "2px solid var(--border-dark)",
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			transition: "width 0.2s ease, min-width 0.2s ease",
			flexShrink: 0,
		}}>
			<div style={{ padding: "16px", overflowY: "auto", flex: 1 }}>
				{/* Index status */}
				<div style={{ marginBottom: 16 }}>
					<p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-on-dark-muted)", marginBottom: 8, margin: "0 0 8px 0" }}>Status</p>
					{!isIndexed && !indexProgress && <span style={{ fontSize: "12px", color: "var(--text-on-dark-muted)" }}>Not indexed</span>}
					{isIndexing && (
						<div>
							<span style={{ fontSize: "12px", color: "#d97706", display: "block", marginBottom: 6 }}>● Indexing...</span>
							<div style={{ height: 4, background: "var(--bg-glass)", marginBottom: 6 }}>
								<div style={{ height: "100%", background: "#16a34a", width: `${progressPercent}%`, transition: "width 0.3s" }} />
							</div>
							<span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-on-dark-muted)" }}>
								{indexProgress?.message ?? ""}
							</span>
							{timeRemaining && (
								<span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-on-dark-muted)", display: "block", marginTop: 4 }}>
									{timeRemaining} remaining
								</span>
							)}
							{typeof Notification !== "undefined" && notificationPermission === "default" && (
								<button
									type="button"
									style={{ marginTop: 8, fontSize: "10px", padding: "2px 6px", background: "transparent", border: "1px solid var(--border-dark)", color: "var(--text-on-dark-muted)", cursor: "pointer", fontFamily: "var(--font-mono)" }}
									onClick={onRequestNotification}
									title="Get a system notification when indexing completes"
								>
									Notify when ready
								</button>
							)}
						</div>
					)}
					{isIndexed && <span style={{ fontSize: "12px", color: "#16a34a" }}>● Indexed</span>}
					{indexingFailed && <span style={{ fontSize: "12px", color: "#dc2626" }}>● Error</span>}
				</div>

				{/* Stats */}
				{isIndexed && (
					<div style={{ marginBottom: 16 }}>
						<p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-on-dark-muted)", marginBottom: 8, margin: "0 0 8px 0" }}>Index</p>
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<div style={{ display: "flex", justifyContent: "space-between" }}>
								<span style={{ fontSize: "11px", color: "var(--text-on-dark-muted)" }}>Chunks</span>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-on-dark-secondary)" }}>{chunkCount}</span>
							</div>
						</div>
					</div>
				)}

				{/* Chat sessions list */}
				{orderedChatSessions.length > 0 && (
					<div>
						<p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-on-dark-muted)", marginBottom: 8, margin: "0 0 8px 0" }}>Chats</p>
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							{orderedChatSessions.map(session => (
								<button
									key={session.chat_id}
									onClick={() => onSelectChat(session.chat_id)}
									style={{
										textAlign: "left", background: activeChatId === session.chat_id ? "var(--bg-glass)" : "transparent",
										border: activeChatId === session.chat_id ? "1px solid var(--border-dark)" : "1px solid transparent",
										padding: "6px 8px", cursor: "pointer", color: activeChatId === session.chat_id ? "var(--text-on-dark)" : "var(--text-on-dark-muted)",
										fontSize: "11px", fontFamily: "var(--font-mono)",
										overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
									}}
								>
									{session.title}
								</button>
							))}
							<button
								onClick={onCreateChat}
								style={{ textAlign: "left", background: "transparent", border: "1px solid var(--border-dark)", padding: "6px 8px", cursor: "pointer", color: "var(--text-on-dark-muted)", fontSize: "11px", fontFamily: "var(--font-mono)" }}
							>
								+ New chat
							</button>
						</div>
					</div>
				)}

				{/* AST tree during indexing */}
				{isIndexing && astNodes.length > 0 && (
					<div style={{ marginTop: 16 }}>
						<p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-on-dark-muted)", marginBottom: 8, margin: "0 0 8px 0" }}>Files</p>
						<AstTreeView astNodes={astNodes} textChunkCounts={textChunkCounts} />
					</div>
				)}
			</div>

			<button
				onClick={onCollapse}
				style={{ padding: "10px", background: "transparent", color: "var(--text-on-dark-muted)", cursor: "pointer", fontSize: "12px", textAlign: "center", border: "none", borderTop: "1px solid var(--border-dark)" }}
			>
				←
			</button>
		</aside>
	);
}
