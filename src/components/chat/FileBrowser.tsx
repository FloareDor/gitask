"use client";

import { useState, useRef, useCallback } from "react";
import AstTreeView from "@/components/AstTreeView";
import IndexBrowser from "@/components/IndexBrowser";
import type { AstNode } from "@/lib/indexer";
import type { VectorStore } from "@/lib/vectorStore";

interface FileBrowserProps {
	isMobile: boolean;
	fileBrowserTab: "tree" | "chunks";
	astNodes: AstNode[];
	textChunkCounts: Record<string, number>;
	store: VectorStore;
	onTabChange: (tab: "tree" | "chunks") => void;
	onClose: () => void;
}

export function FileBrowser({
	isMobile,
	fileBrowserTab,
	astNodes,
	textChunkCounts,
	store,
	onTabChange,
	onClose,
}: FileBrowserProps) {
	const [width, setWidth] = useState(400);
	const isDragging = useRef(false);
	const startX = useRef(0);
	const startWidth = useRef(0);

	const handleDragStart = useCallback((e: React.MouseEvent) => {
		isDragging.current = true;
		startX.current = e.clientX;
		startWidth.current = width;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		const onMove = (ev: MouseEvent) => {
			if (!isDragging.current) return;
			const delta = startX.current - ev.clientX;
			setWidth(Math.max(280, Math.min(900, startWidth.current + delta)));
		};
		const onUp = () => {
			isDragging.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [width]);

	return (
		<div style={{
			width: isMobile ? "100%" : width,
			flexShrink: 0,
			background: "var(--bg-app)", borderLeft: "2px solid var(--border-dark)",
			display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
			...(isMobile ? { position: "fixed" as const, inset: 0, width: "100%", zIndex: 100 } : {}),
		}}>
			{/* Drag handle */}
			{!isMobile && (
				<div
					onMouseDown={handleDragStart}
					style={{
						position: "absolute", left: 0, top: 0, bottom: 0, width: 5,
						cursor: "col-resize", zIndex: 10,
						background: "transparent",
					}}
					title="Drag to resize"
				/>
			)}

			<div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-dark)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						onClick={() => onTabChange("tree")}
						style={{ fontSize: "11px", fontFamily: "var(--font-mono)", background: "transparent", border: "none", cursor: "pointer", color: fileBrowserTab === "tree" ? "#16a34a" : "var(--text-on-dark-muted)", borderBottom: fileBrowserTab === "tree" ? "2px solid #16a34a" : "2px solid transparent", padding: "4px 0" }}
					>
						File Tree
					</button>
					<button
						onClick={() => onTabChange("chunks")}
						style={{ fontSize: "11px", fontFamily: "var(--font-mono)", background: "transparent", border: "none", cursor: "pointer", color: fileBrowserTab === "chunks" ? "#16a34a" : "var(--text-on-dark-muted)", borderBottom: fileBrowserTab === "chunks" ? "2px solid #16a34a" : "2px solid transparent", padding: "4px 0" }}
					>
						Index
					</button>
				</div>
				<button
					type="button"
					className="btn btn-ghost"
					style={{ fontSize: "12px", padding: "4px 8px" }}
					onClick={onClose}
				>
					✕
				</button>
			</div>
			<div style={{ flex: 1, overflow: "hidden", padding: "12px" }}>
				{fileBrowserTab === "tree" && (
					<AstTreeView astNodes={astNodes} textChunkCounts={textChunkCounts} />
				)}
				{fileBrowserTab === "chunks" && (
					<IndexBrowser chunks={store.getAll()} />
				)}
			</div>
		</div>
	);
}
