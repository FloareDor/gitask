"use client";

import type { ContextChunk } from "@/app/[owner]/[repo]/types";

interface ContextMeta {
	truncated: boolean;
	totalChars: number;
	maxChars: number;
	estimatedTokens: number;
	maxTokens: number;
	compactionStage: "none" | "file" | "directory" | "repo" | "truncated";
}

interface ContextDrawerProps {
	contextChunks: ContextChunk[];
	contextMeta: ContextMeta | null;
	isMobile: boolean;
	onClose: () => void;
}

export function ContextDrawer({ contextChunks, contextMeta, isMobile, onClose }: ContextDrawerProps) {
	return (
		<div style={{
			maxHeight: 320, overflow: "auto", borderTop: "2px solid var(--border-dark)", background: "var(--bg-app)", padding: "16px 24px", flexShrink: 0,
			...(isMobile ? { position: "fixed" as const, inset: 0, maxHeight: "100%", zIndex: 100 } : {}),
		}}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
				<h3 style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-on-dark-muted)", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-display)", margin: 0 }}>
					Retrieved Context ({contextChunks.length} chunks)
				</h3>
				<button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-on-dark-muted)", cursor: "pointer", fontSize: "16px" }}>✕</button>
			</div>
			{contextMeta && contextMeta.compactionStage !== "none" && (
				<div style={{ fontSize: "11px", color: "#d97706", background: "rgba(217,119,6,0.08)", padding: "8px 10px", border: "2px solid rgba(217,119,6,0.3)", marginBottom: "8px" }}>
					⚠ LLM context compacted ({contextMeta.compactionStage}): {contextMeta.totalChars} chars / ~{contextMeta.estimatedTokens.toLocaleString()} tokens → {contextMeta.maxChars.toLocaleString()} chars / {contextMeta.maxTokens.toLocaleString()} token budget
				</div>
			)}
			{contextChunks.map((chunk, i) => (
				<div key={i} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px", background: "var(--bg-card-dark)", border: "2px solid var(--border-dark)", marginBottom: 10 }}>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
						<span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "#16a34a", fontWeight: 500 }}>{chunk.filePath}</span>
						<span style={{ fontSize: "11px", color: "var(--text-on-dark-muted)", fontFamily: "var(--font-mono)" }}>{(chunk.score * 100).toFixed(1)}%</span>
					</div>
					<pre style={{ fontSize: "11px", maxHeight: "300px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, fontFamily: "var(--font-mono)", color: "var(--text-on-dark)", background: "transparent" }}>
						{chunk.code}
					</pre>
				</div>
			))}
		</div>
	);
}
