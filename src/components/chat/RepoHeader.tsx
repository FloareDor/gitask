"use client";

import { useRef, useState, useEffect } from "react";
import { ModelSettings } from "@/components/ModelSettings";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { LLMStatus } from "@/lib/llm";
import type { Message } from "@/app/[owner]/[repo]/types";

const PROJECT_REPO_URL = "https://github.com/FloareDor/gitask";

const overflowItemStyle: React.CSSProperties = {
	fontSize: "13px",
	padding: "8px 14px",
	justifyContent: "flex-start",
	width: "100%",
	border: "none",
	boxShadow: "none",
	background: "transparent",
	cursor: "pointer",
	color: "var(--text-on-dark-secondary)",
	textAlign: "left",
};

interface RepoHeaderProps {
	owner: string;
	repo: string;
	isIndexed: boolean;
	repoStale: boolean;
	llmStatus: LLMStatus;
	sidebarCollapsed: boolean;
	showContext: boolean;
	coveEnabled: boolean;
	queryExpansionEnabled: boolean;
	isLocalProvider: boolean;
	isGenerating: boolean;
	messages: Message[];
	fileBrowserOpen: boolean;
	onExpandSidebar: () => void;
	onReindex: () => void;
	onToggleTokenInput: () => void;
	onToggleContext: () => void;
	onToggleCove: () => void;
	onToggleQueryExpansion: () => void;
	onClearChat: () => void;
	onDeleteEmbeddings: () => void;
	onToggleFileBrowser: () => void;
}

export function RepoHeader({
	owner,
	repo,
	isIndexed,
	repoStale,
	llmStatus,
	sidebarCollapsed,
	showContext,
	coveEnabled,
	queryExpansionEnabled,
	isLocalProvider,
	isGenerating,
	messages,
	fileBrowserOpen,
	onExpandSidebar,
	onReindex,
	onToggleTokenInput,
	onToggleContext,
	onToggleCove,
	onToggleQueryExpansion,
	onClearChat,
	onDeleteEmbeddings,
	onToggleFileBrowser,
}: RepoHeaderProps) {
	const overflowRef = useRef<HTMLDivElement>(null);
	const [showOverflow, setShowOverflow] = useState(false);

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

	return (
		<nav style={{
			display: "flex", alignItems: "center", justifyContent: "space-between",
			padding: "0 20px", height: 52,
			background: "var(--bg-app)", borderBottom: "2px solid var(--border-dark)",
			flexShrink: 0, zIndex: 30,
		}}>
			<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
				{sidebarCollapsed && (
					<button
						onClick={onExpandSidebar}
						style={{ background: "transparent", border: "none", color: "var(--text-on-dark-muted)", cursor: "pointer", fontSize: "14px", padding: "4px 6px" }}
						title="Expand sidebar"
					>
						→
					</button>
				)}
				<a href="/" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "0.95rem", color: "var(--text-on-dark)", textDecoration: "none" }}>
					gitask
				</a>
				<span style={{ color: "var(--text-on-dark-muted)", fontSize: "0.9rem" }}>/</span>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--text-on-dark-secondary)", padding: "2px 8px", border: "1px solid var(--border-dark)", background: "var(--bg-card-dark)" }}>
					{owner}/{repo}
				</span>
				{isIndexed && repoStale && (
					<span
						style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "#d97706", padding: "2px 8px", border: "1px solid #d97706", background: "rgba(217,119,6,0.08)", cursor: "pointer" }}
						onClick={onReindex}
						title="Repository changed on GitHub. Click to re-index."
					>
						stale — re-index
					</span>
				)}
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<div style={{
					width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
					background: llmStatus === "ready" ? "#16a34a" : llmStatus === "generating" ? "#d97706" : llmStatus === "loading" ? "#3b82f6" : "var(--text-on-dark-muted)",
				}} className={llmStatus === "loading" ? "pulse" : undefined} title={`LLM: ${llmStatus}`} />
				<ModelSettings />
				<ThemeToggle />
				<div ref={overflowRef} style={{ position: "relative" }}>
					<button
						style={{ fontSize: "16px", padding: "4px 10px", lineHeight: 1, background: "transparent", border: "1px solid var(--border-dark)", color: "var(--text-on-dark-secondary)", cursor: "pointer" }}
						onClick={() => setShowOverflow(v => !v)}
						title="More options"
						aria-label="More options"
					>
						⋯
					</button>
					{showOverflow && (
						<div style={{
							position: "absolute", top: "calc(100% + 6px)", right: 0,
							background: "var(--bg-card-dark)", border: "2px solid var(--border-dark)",
							boxShadow: "var(--shadow-card-dark)", padding: "6px",
							display: "flex", flexDirection: "column", gap: "2px",
							zIndex: 30, minWidth: "200px",
						}}>
							<button style={overflowItemStyle} onClick={() => { onToggleTokenInput(); setShowOverflow(false); }}>
								GH Token
							</button>
							{isIndexed && (
								<button style={overflowItemStyle} onClick={() => { onToggleContext(); setShowOverflow(false); }}>
									{showContext ? "Hide context" : "View context"}
								</button>
							)}
							<button
								style={{ ...overflowItemStyle, color: coveEnabled ? "#16a34a" : "var(--text-on-dark)" }}
								onClick={onToggleCove}
								title="Chain-of-Verification (adds ~2-4s latency)"
							>
								CoVE {coveEnabled ? "on" : "off"}
							</button>
							<button
								style={{
									...overflowItemStyle,
									color: isLocalProvider ? "var(--text-on-dark-muted)" : queryExpansionEnabled ? "#16a34a" : "var(--text-on-dark)",
									opacity: isLocalProvider ? 0.45 : 1,
									cursor: isLocalProvider ? "default" : "pointer",
								}}
								onClick={isLocalProvider ? undefined : onToggleQueryExpansion}
								title={isLocalProvider ? "not available with local model" : "expand each query into multiple variants for broader retrieval"}
							>
								multi-query {isLocalProvider ? "—" : queryExpansionEnabled ? "on" : "off"}
							</button>
							{isIndexed && (
								<button style={overflowItemStyle} onClick={() => { onReindex(); setShowOverflow(false); }}>
									Re-index
								</button>
							)}
							{messages.length > 0 && (
								<button style={overflowItemStyle} onClick={() => { onClearChat(); setShowOverflow(false); }} disabled={isGenerating}>
									Clear chat
								</button>
							)}
							<div style={{ height: "1px", background: "var(--border-dark)", margin: "4px 0" }} />
							{owner && repo && (
								<button style={{ ...overflowItemStyle, color: "#dc2626" }} onClick={() => { onDeleteEmbeddings(); setShowOverflow(false); }}>
									Delete embeddings
								</button>
							)}
							<div style={{ height: "1px", background: "var(--border-dark)", margin: "4px 0" }} />
							<a href="/metrics" style={{ ...overflowItemStyle, textDecoration: "none", color: "var(--text-on-dark-secondary)", display: "flex" }}>
								Metrics
							</a>
							<a href={PROJECT_REPO_URL} target="_blank" rel="noopener noreferrer" style={{ ...overflowItemStyle, textDecoration: "none", color: "var(--text-on-dark-secondary)", display: "flex" }}>
								Star on GitHub
							</a>
						</div>
					)}
				</div>
				{isIndexed && (
					<button
						onClick={onToggleFileBrowser}
						style={{ padding: "6px 12px", border: "2px solid var(--border-dark)", background: "transparent", color: "var(--text-on-dark-secondary)", cursor: "pointer", fontSize: "12px", fontFamily: "var(--font-mono)" }}
					>
						{fileBrowserOpen ? "Hide files" : "Browse files"}
					</button>
				)}
			</div>
		</nav>
	);
}
