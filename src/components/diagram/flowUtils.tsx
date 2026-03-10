"use client";

import { Handle, Position, type NodeTypes } from "@xyflow/react";
import type { MessageDiagram } from "@/app/[owner]/[repo]/types";

// ─── Category colours ─────────────────────────────────────────────────────────

export const CATEGORY_COLORS: Record<string, string> = {
	service:   "#2563eb",
	database:  "#16a34a",
	queue:     "#d97706",
	external:  "#6b7280",
	component: "#7c3aed",
	function:  "#0891b2",
};

// ─── Custom node ──────────────────────────────────────────────────────────────

export type FlowNodeData = { label: string; sublabel?: string; category: string };

export function DiagramNodeComponent({ data }: { data: FlowNodeData }) {
	const color = CATEGORY_COLORS[data.category] ?? "#6b7280";
	return (
		<div style={{
			padding: "10px 14px",
			background: "#161616",
			border: "1px solid #2a2a2a",
			borderLeft: `3px solid ${color}`,
			minWidth: 150,
			maxWidth: 210,
			fontFamily: "var(--font-sans, sans-serif)",
			borderRadius: 2,
		}}>
			<Handle type="target" position={Position.Left} style={{ background: color, border: "none", width: 8, height: 8 }} />
			<div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.3 }}>{data.label}</div>
			{data.sublabel && (
				<div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{data.sublabel}</div>
			)}
			<Handle type="source" position={Position.Right} style={{ background: color, border: "none", width: 8, height: 8 }} />
		</div>
	);
}

// Must be module-level (stable reference) to avoid React Flow re-mount
export const diagramNodeTypes: NodeTypes = { diagram: DiagramNodeComponent };

// ─── BFS layered auto-layout (left → right) ───────────────────────────────────

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

	const LAYER_GAP = 260;
	const NODE_GAP = 110;
	const positions: Record<string, { x: number; y: number }> = {};

	layers.forEach((layer, li) => {
		const totalH = (layer.length - 1) * NODE_GAP;
		layer.forEach((id, ni) => {
			positions[id] = { x: li * LAYER_GAP, y: ni * NODE_GAP - totalH / 2 };
		});
	});

	return positions;
}

// ─── Data transform helpers ───────────────────────────────────────────────────

import type { Node, Edge } from "@xyflow/react";

export function toFlowNodes(data: MessageDiagram): Node<FlowNodeData>[] {
	const positions = computeLayout(data.nodes, data.edges);
	return data.nodes.map((n) => ({
		id: n.id,
		type: "diagram",
		position: positions[n.id] ?? { x: 0, y: 0 },
		data: { label: n.label, sublabel: n.sublabel, category: n.category },
	}));
}

export function toFlowEdges(data: MessageDiagram): Edge[] {
	return data.edges.map((e, i) => ({
		id: `e${i}-${e.source}-${e.target}`,
		source: e.source,
		target: e.target,
		label: e.label,
		animated: true,
		style: { stroke: "#334155", strokeWidth: 1.5 },
		labelStyle: { fill: "#64748b", fontSize: 11 },
		labelBgStyle: { fill: "#161616" },
	}));
}

// ─── Legend ───────────────────────────────────────────────────────────────────

export function DiagramLegend() {
	return (
		<div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
			{Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
				<div key={cat} style={{ display: "flex", alignItems: "center", gap: 5 }}>
					<div style={{ width: 7, height: 7, background: color, borderRadius: 1 }} />
					<span style={{ fontSize: 10, color: "#475569", fontFamily: "var(--font-mono, monospace)" }}>
						{cat}
					</span>
				</div>
			))}
		</div>
	);
}
