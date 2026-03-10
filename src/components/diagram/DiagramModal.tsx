"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ReactFlow, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { generateRepoDiagram } from "@/lib/diagramGenerator";
import { diagramNodeTypes, toFlowNodes, toFlowEdges, DiagramLegend, useIsDark } from "./flowUtils";
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

	const isDark = useIsDark();

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
	const flowEdges = useMemo(() => (data ? toFlowEdges(data, isDark) : []), [data, isDark]);

	if (!isOpen) return null;

	return (
		<div
			className="diagram-modal-backdrop"
			onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			<div className="diagram-modal-container">

				{/* Header */}
				<div className="diagram-modal-header">
					<div className="diagram-modal-title-group">
						<span className="diagram-modal-repo">{owner}/{repo}</span>
						{data && <span className="diagram-modal-title">— {data.title}</span>}
					</div>
					<div className="diagram-modal-actions">
						{status === "ready" && !initialData && (
							<button
								className="diagram-modal-regen"
								onClick={() => { setData(null); setStatus("idle"); void generate(); }}
							>
								regenerate
							</button>
						)}
						<button className="diagram-modal-close" onClick={onClose} aria-label="Close">×</button>
					</div>
				</div>

				{/* Canvas */}
				<div className="diagram-modal-canvas">
					{status === "loading" && (
						<div className="diagram-modal-loading">
							<div className="diagram-modal-spinner" />
							<span className="diagram-modal-loading-text">analyzing {owner}/{repo}...</span>
						</div>
					)}
					{status === "error" && (
						<div className="diagram-modal-error">
							<span className="diagram-modal-error-msg">{error}</span>
							<button className="btn-outline-dark btn-sm" onClick={generate}>try again</button>
						</div>
					)}
					{status === "ready" && data && mounted && (
						<ReactFlow
							nodes={flowNodes}
							edges={flowEdges}
							nodeTypes={diagramNodeTypes}
							fitView
							fitViewOptions={{ padding: 0.25 }}
							colorMode={isDark ? "dark" : "light"}
							style={{ background: "transparent" }}
							proOptions={{ hideAttribution: true }}
						>
							<Controls />
						</ReactFlow>
					)}
				</div>

				{/* Legend */}
				{status === "ready" && data && (
					<div className="diagram-modal-footer">
						<DiagramLegend data={data} />
					</div>
				)}
			</div>
		</div>
	);
}
