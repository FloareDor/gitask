"use client";

import { useState, useEffect, useMemo } from "react";
import { ReactFlow, Background } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { diagramNodeTypes, toFlowNodes, toFlowEdges, DiagramLegend } from "./flowUtils";
import { DiagramModal } from "./DiagramModal";
import type { MessageDiagram } from "@/app/[owner]/[repo]/types";
import type { VectorStore } from "@/lib/vectorStore";

interface InlineDiagramProps {
	data: MessageDiagram;
	owner: string;
	repo: string;
	store: VectorStore;
}

export function InlineDiagram({ data, owner, repo, store }: InlineDiagramProps) {
	const [mounted, setMounted] = useState(false);
	const [expanded, setExpanded] = useState(false);

	useEffect(() => { setMounted(true); }, []);

	const flowNodes = useMemo(() => toFlowNodes(data), [data]);
	const flowEdges = useMemo(() => toFlowEdges(data), [data]);

	return (
		<>
			<div style={{
				marginTop: 12,
				border: "1px solid #1e2a3a",
				background: "#080808",
				borderRadius: 2,
				overflow: "hidden",
			}}>
				{/* Diagram header */}
				<div style={{
					display: "flex", alignItems: "center", justifyContent: "space-between",
					padding: "8px 12px",
					borderBottom: "1px solid #1e2a3a",
				}}>
					<span style={{ fontSize: 11, color: "#475569", fontFamily: "var(--font-mono, monospace)" }}>
						{data.title}
					</span>
					<button
						onClick={() => setExpanded(true)}
						style={{
							fontSize: 11, padding: "2px 8px",
							background: "transparent", border: "1px solid #1e2a3a",
							color: "#64748b", cursor: "pointer",
							fontFamily: "var(--font-mono, monospace)",
						}}
						title="Expand diagram"
					>
						expand ↗
					</button>
				</div>

				{/* Compact canvas */}
				<div style={{ height: 300, position: "relative" }}>
					{mounted && (
						<ReactFlow
							nodes={flowNodes}
							edges={flowEdges}
							nodeTypes={diagramNodeTypes}
							fitView
							fitViewOptions={{ padding: 0.2 }}
							colorMode="dark"
							style={{ background: "#080808" }}
							nodesDraggable={false}
							nodesConnectable={false}
							elementsSelectable={false}
							zoomOnScroll={false}
							panOnDrag={true}
						>
							<Background color="#1e293b" gap={28} size={1} />
						</ReactFlow>
					)}
				</div>

				{/* Legend */}
				<div style={{ padding: "6px 12px", borderTop: "1px solid #1e2a3a" }}>
					<DiagramLegend />
				</div>
			</div>

			{/* Fullscreen expand */}
			<DiagramModal
				isOpen={expanded}
				owner={owner}
				repo={repo}
				store={store}
				onClose={() => setExpanded(false)}
				initialData={data}
			/>
		</>
	);
}
