"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { generateRepoDiagram } from "@/lib/diagramGenerator";
import { diagramNodeTypes, toFlowNodes, toFlowEdges, DiagramLegend } from "./flowUtils";
import type { VectorStore } from "@/lib/vectorStore";
import type { MessageDiagram } from "@/app/[owner]/[repo]/types";

interface DiagramModalProps {
	isOpen: boolean;
	owner: string;
	repo: string;
	store: VectorStore;
	onClose: () => void;
	/** If provided, skip generation and show this data directly */
	initialData?: MessageDiagram;
}

export function DiagramModal({ isOpen, owner, repo, store, onClose, initialData }: DiagramModalProps) {
	const [mounted, setMounted] = useState(false);
	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [data, setData] = useState<MessageDiagram | null>(initialData ?? null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => { setMounted(true); }, []);

	const generate = useCallback(async () => {
		setStatus("loading");
		setError(null);
		try {
			const result = await generateRepoDiagram(owner, repo, store);
			setData(result);
			setStatus("ready");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		}
	}, [owner, repo, store]);

	useEffect(() => {
		if (!isOpen) { setStatus("idle"); setData(initialData ?? null); setError(null); return; }
		if (initialData) { setData(initialData); setStatus("ready"); return; }
		if (status === "idle") void generate();
	}, [isOpen, initialData, status, generate]);

	const flowNodes = useMemo(() => (data ? toFlowNodes(data) : []), [data]);
	const flowEdges = useMemo(() => (data ? toFlowEdges(data) : []), [data]);

	if (!isOpen) return null;

	return (
		<div
			style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}
			onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			<div style={{ background: "#0d0d0d", border: "2px solid #1e2a3a", width: "min(92vw, 1100px)", height: "min(88vh, 760px)", display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 2 }}>

				{/* Header */}
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid #1e2a3a", flexShrink: 0 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11, color: "#475569" }}>{owner}/{repo}</span>
						{data && <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>— {data.title}</span>}
					</div>
					<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
						{status === "ready" && !initialData && (
							<button onClick={() => { setData(null); setStatus("idle"); void generate(); }} style={{ fontSize: 11, padding: "3px 10px", background: "transparent", border: "1px solid #1e2a3a", color: "#64748b", cursor: "pointer", fontFamily: "var(--font-mono, monospace)" }}>
								regenerate
							</button>
						)}
						<button onClick={onClose} style={{ fontSize: 18, lineHeight: 1, padding: "2px 8px", background: "transparent", border: "none", color: "#475569", cursor: "pointer" }} aria-label="Close">×</button>
					</div>
				</div>

				{/* Canvas */}
				<div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
					{status === "loading" && (
						<div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
							<div style={{ width: 28, height: 28, border: "2px solid #1e2a3a", borderTop: "2px solid #2563eb", borderRadius: "50%", animation: "diag-spin 0.7s linear infinite" }} />
							<span style={{ fontSize: 12, color: "#475569", fontFamily: "var(--font-mono, monospace)" }}>analyzing {owner}/{repo}...</span>
						</div>
					)}
					{status === "error" && (
						<div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 32 }}>
							<span style={{ color: "#dc2626", fontSize: 13, textAlign: "center", maxWidth: 400 }}>{error}</span>
							<button onClick={generate} style={{ padding: "6px 16px", background: "transparent", border: "1px solid #1e2a3a", color: "#94a3b8", cursor: "pointer", fontSize: 12 }}>Try again</button>
						</div>
					)}
					{status === "ready" && data && mounted && (
						<ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={diagramNodeTypes} fitView fitViewOptions={{ padding: 0.25 }} colorMode="dark" style={{ background: "#080808" }}>
							<Background color="#1e293b" gap={28} size={1} />
							<Controls />
						</ReactFlow>
					)}
				</div>

				{/* Legend */}
				{status === "ready" && (
					<div style={{ padding: "8px 18px", borderTop: "1px solid #1e2a3a", flexShrink: 0 }}>
						<DiagramLegend />
					</div>
				)}
			</div>
			<style>{`@keyframes diag-spin { to { transform: rotate(360deg); } }`}</style>
		</div>
	);
}
