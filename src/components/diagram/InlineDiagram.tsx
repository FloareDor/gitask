"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ReactFlow, useNodesState, useEdgesState, useReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng } from "html-to-image";
import { diagramNodeTypes, toFlowNodes, toFlowEdges, DiagramLegend, computeLayout, NODE_H, useIsDark } from "./flowUtils";
import type { MessageDiagram } from "@/app/[owner]/[repo]/types";

const PADDING = 32;

function computeCanvasHeight(data: MessageDiagram): number {
	const positions = computeLayout(data.nodes, data.edges);
	const ys = Object.values(positions).map((p) => p.y);
	if (!ys.length) return 300;
	const span = Math.max(...ys) - Math.min(...ys) + NODE_H * 1.5;
	return Math.max(240, Math.min(480, span + PADDING * 2));
}

interface InlineDiagramProps {
	data: MessageDiagram;
}

/** Inner component — must live inside ReactFlowProvider to use useReactFlow */
function InlineDiagramInner({ data }: InlineDiagramProps) {
	const [mounted, setMounted] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [saved, setSaved] = useState(false);
	useEffect(() => { setMounted(true); }, []);

	const isDark = useIsDark();
	useReactFlow(); // keep provider context active
	const canvasRef = useRef<HTMLDivElement>(null);

	const initialNodes = useMemo(() => toFlowNodes(data), [data]);
	const initialEdges = useMemo(() => toFlowEdges(data, isDark), [data, isDark]);

	const [nodes, , onNodesChange] = useNodesState(initialNodes);
	const [edges, setEdges] = useEdgesState(initialEdges);

	useEffect(() => { setEdges(toFlowEdges(data, isDark)); }, [isDark, data, setEdges]);

	const canvasHeight = useMemo(() => computeCanvasHeight(data), [data]);

	const handleSavePng = useCallback(async () => {
		if (!canvasRef.current) return;
		setSaved(true);
		try {
			const dataUrl = await toPng(canvasRef.current, {
				backgroundColor: isDark ? "#080a14" : "#f8fafc",
				pixelRatio: 2,
			});
			const a = document.createElement("a");
			a.href = dataUrl;
			a.download = `${data.title.replace(/\s+/g, "-").toLowerCase()}.png`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			setTimeout(() => setSaved(false), 1500);
		}
	}, [data.title, isDark]);

	return (
		<div className="diagram-inline">
			{/* Header */}
			<div className="diagram-inline-header">
				<span className="diagram-inline-label">diagram</span>
				<span className="diagram-inline-sep">·</span>
				<span className="diagram-inline-title">{data.title}</span>
				<span className="diagram-inline-stats">{data.nodes.length}n · {data.edges.length}e</span>
				{!collapsed && <span className="diagram-inline-hint">drag · scroll to pan</span>}
				<div className="diagram-inline-actions">
					<button
						className="diagram-inline-action-btn"
						onClick={() => { void handleSavePng(); }}
						title="Save as PNG"
						disabled={saved}
					>
						{saved ? "saving..." : "save png"}
					</button>
					<span className="diagram-inline-action-sep">·</span>
					<button
						className="diagram-inline-action-btn"
						onClick={() => setCollapsed((c) => !c)}
						title={collapsed ? "Expand diagram" : "Collapse diagram"}
					>
						{collapsed ? "expand" : "collapse"}
					</button>
				</div>
			</div>

			{/* Canvas */}
			{!collapsed && (
				<div className="diagram-inline-canvas" style={{ height: canvasHeight }} ref={canvasRef}>
					{mounted && (
						<ReactFlow
							nodes={nodes}
							edges={edges}
							nodeTypes={diagramNodeTypes}
							onNodesChange={onNodesChange}
							fitView
							fitViewOptions={{ padding: 0.2 }}
							colorMode={isDark ? "dark" : "light"}
							style={{ background: "transparent" }}
							nodesDraggable={true}
							nodesConnectable={false}
							elementsSelectable={true}
							zoomOnScroll={false}
							zoomOnPinch={true}
							panOnDrag={true}
							panOnScroll={true}
							panOnScrollMode={"free" as never}
							proOptions={{ hideAttribution: true }}
						/>
					)}
				</div>
			)}

			{/* Legend */}
			{!collapsed && (
				<div className="diagram-inline-legend">
					<DiagramLegend data={data} />
				</div>
			)}
		</div>
	);
}

export function InlineDiagram({ data }: InlineDiagramProps) {
	return (
		<ReactFlowProvider>
			<InlineDiagramInner data={data} />
		</ReactFlowProvider>
	);
}
