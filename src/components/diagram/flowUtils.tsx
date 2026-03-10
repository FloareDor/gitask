"use client";

import { useEffect, useState } from "react";
import { Handle, Position, MarkerType, type NodeTypes, type Node, type Edge } from "@xyflow/react";
import type { MessageDiagram } from "@/app/[owner]/[repo]/types";

// ─── Layout constants ─────────────────────────────────────────────────────────

export const NODE_W = 180;
export const NODE_H = 54;
export const LAYER_GAP = 290;
export const NODE_GAP = 118;

// ─── Category palette ─────────────────────────────────────────────────────────

export const CATEGORY_COLORS: Record<string, string> = {
	service:   "#38bdf8",   // sky
	database:  "#34d399",   // emerald
	queue:     "#fbbf24",   // amber
	external:  "#a78bfa",   // violet
	component: "#f472b6",   // pink
	function:  "#22d3ee",   // cyan
};

const CATEGORY_GLOW: Record<string, string> = {
	service:   "rgba(56,189,248,0.18)",
	database:  "rgba(52,211,153,0.18)",
	queue:     "rgba(251,191,36,0.18)",
	external:  "rgba(167,139,250,0.18)",
	component: "rgba(244,114,182,0.18)",
	function:  "rgba(34,211,238,0.18)",
};

// ─── Theme hook ───────────────────────────────────────────────────────────────

export function useIsDark(): boolean {
	const [isDark, setIsDark] = useState(true);
	useEffect(() => {
		const check = () =>
			setIsDark(document.documentElement.getAttribute("data-theme") !== "light");
		check();
		const observer = new MutationObserver(check);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return isDark;
}

// ─── Custom node ──────────────────────────────────────────────────────────────

export type FlowNodeData = { label: string; sublabel?: string; category: string };

export function DiagramNodeComponent({ data }: { data: FlowNodeData }) {
	const color = CATEGORY_COLORS[data.category] ?? "#94a3b8";
	const glow  = CATEGORY_GLOW[data.category]  ?? "transparent";
	return (
		<div
			className="diagram-node"
			style={{ "--node-color": color, "--node-glow": glow, width: NODE_W } as React.CSSProperties}
		>
			<Handle
				type="target"
				position={Position.Left}
				style={{ background: color, border: "2px solid rgba(0,0,0,0.2)", width: 9, height: 9, left: -5 }}
			/>
			<div className="diagram-node-accent" />
			<div className="diagram-node-body">
				<div className="diagram-node-label">{data.label}</div>
				{data.sublabel && <div className="diagram-node-sublabel">{data.sublabel}</div>}
			</div>
			<Handle
				type="source"
				position={Position.Right}
				style={{ background: color, border: "2px solid rgba(0,0,0,0.2)", width: 9, height: 9, right: -5 }}
			/>
		</div>
	);
}

export const diagramNodeTypes: NodeTypes = { diagram: DiagramNodeComponent };

// ─── BFS layered layout ───────────────────────────────────────────────────────

export function computeLayout(
	nodes: MessageDiagram["nodes"],
	edges: MessageDiagram["edges"],
): Record<string, { x: number; y: number }> {
	const incoming = new Map<string, Set<string>>();
	nodes.forEach((n) => incoming.set(n.id, new Set()));
	edges.forEach((e) => incoming.get(e.target)?.add(e.source));

	const roots = nodes.filter((n) => incoming.get(n.id)!.size === 0).map((n) => n.id);
	const layers: string[][] = [];
	const visited = new Set<string>();
	let current = roots.length > 0 ? roots : [nodes[0]?.id].filter(Boolean) as string[];

	while (current.length > 0) {
		const layer = [...new Set(current.filter((id) => !visited.has(id)))];
		if (!layer.length) break;
		layers.push(layer);
		layer.forEach((id) => visited.add(id));
		const next: string[] = [];
		layer.forEach((id) =>
			edges.filter((e) => e.source === id && !visited.has(e.target)).forEach((e) => next.push(e.target))
		);
		current = next;
	}

	const unvisited = nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
	if (unvisited.length) layers.push(unvisited);

	const positions: Record<string, { x: number; y: number }> = {};
	layers.forEach((layer, li) => {
		const totalH = (layer.length - 1) * NODE_GAP;
		layer.forEach((id, ni) => {
			positions[id] = { x: li * LAYER_GAP, y: ni * NODE_GAP - totalH / 2 };
		});
	});
	return positions;
}

// ─── ReactFlow data transforms ────────────────────────────────────────────────

export function toFlowNodes(data: MessageDiagram): Node<FlowNodeData>[] {
	const positions = computeLayout(data.nodes, data.edges);
	return data.nodes.map((n) => ({
		id: n.id,
		type: "diagram",
		position: positions[n.id] ?? { x: 0, y: 0 },
		data: { label: n.label, sublabel: n.sublabel, category: n.category },
	}));
}

export function toFlowEdges(data: MessageDiagram, isDark: boolean): Edge[] {
	const nodeColorMap = new Map(
		data.nodes.map((n) => [n.id, CATEGORY_COLORS[n.category] ?? "#94a3b8"])
	);

	const labelText   = isDark ? "#94a3b8"              : "#475569";
	const labelBg     = isDark ? "rgba(8,10,20,0.88)"   : "rgba(255,255,255,0.95)";
	const labelStroke = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.09)";

	return data.edges.map((e, i) => {
		const color = nodeColorMap.get(e.source) ?? "#94a3b8";
		return {
			id: `e${i}-${e.source}-${e.target}`,
			source: e.source,
			target: e.target,
			label: e.label,
			animated: true,
			style: { stroke: color, strokeWidth: 1.5, strokeOpacity: 0.65 },
			markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
			labelStyle: {
				fill: labelText,
				fontSize: 9,
				fontFamily: "var(--font-mono, monospace)",
				fontWeight: "500",
				letterSpacing: "0.04em",
			},
			labelBgStyle: { fill: labelBg, fillOpacity: 1, stroke: labelStroke, strokeWidth: 0.5 },
			labelBgPadding: [5, 4] as [number, number],
			labelBgBorderRadius: 4,
		};
	});
}

// ─── Legend ───────────────────────────────────────────────────────────────────

export function DiagramLegend({ data }: { data: MessageDiagram }) {
	const usedCategories = [...new Set(data.nodes.map((n) => n.category))];
	return (
		<>
			{usedCategories.map((cat) => {
				const color = CATEGORY_COLORS[cat] ?? "#94a3b8";
				return (
					<div key={cat} className="diagram-legend-item">
						<div className="diagram-legend-dot" style={{ background: color }} />
						<span className="diagram-legend-label">{cat}</span>
					</div>
				);
			})}
		</>
	);
}
