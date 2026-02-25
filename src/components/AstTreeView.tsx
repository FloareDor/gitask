"use client";

import { useMemo } from "react";
import type { AstNode } from "@/lib/indexer";

interface AstTreeViewProps {
	astNodes: AstNode[];
	textChunkCounts: Record<string, number>;
}

/* ── Kind icons ── */
const KIND_ICONS: Record<string, string> = {
	function: "fn",
	method: "fn",
	class: "cls",
	interface: "ifc",
	struct: "str",
	enum: "enm",
	impl: "imp",
	type: "typ",
	constant: "cst",
};

/* ── Tree-building helpers ── */

interface DirNode {
	name: string;
	fullPath: string;
	children: DirNode[];
	files: FileNode[];
}

interface FileNode {
	name: string;
	fullPath: string;
	symbols: AstNode[];
	chunkCount: number;
}

function buildTree(
	astNodes: AstNode[],
	textChunkCounts: Record<string, number>,
): DirNode {
	const root: DirNode = { name: "", fullPath: "", children: [], files: [] };

	// Group symbols by file
	const fileSymbols = new Map<string, AstNode[]>();
	for (const node of astNodes) {
		const list = fileSymbols.get(node.filePath) || [];
		list.push(node);
		fileSymbols.set(node.filePath, list);
	}

	// Also include files that have chunks but no symbols
	const allFilePaths = new Set([
		...fileSymbols.keys(),
		...Object.keys(textChunkCounts),
	]);

	for (const filePath of allFilePaths) {
		const parts = filePath.split("/");
		const fileName = parts.pop()!;

		// Navigate/create directory structure
		let current = root;
		for (const part of parts) {
			let child = current.children.find((c) => c.name === part);
			if (!child) {
				const parentPath = current.fullPath ? current.fullPath + "/" : "";
				child = { name: part, fullPath: parentPath + part, children: [], files: [] };
				current.children.push(child);
			}
			current = child;
		}

		current.files.push({
			name: fileName,
			fullPath: filePath,
			symbols: fileSymbols.get(filePath) || [],
			chunkCount: textChunkCounts[filePath] || 0,
		});
	}

	// Sort: directories first, then files, both alphabetically
	function sortTree(node: DirNode) {
		node.children.sort((a, b) => a.name.localeCompare(b.name));
		node.files.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of node.children) sortTree(child);
	}
	sortTree(root);

	// Collapse single-child directories
	function collapse(node: DirNode): DirNode {
		while (node.children.length === 1 && node.files.length === 0) {
			const child = node.children[0];
			node = {
				name: node.name ? `${node.name}/${child.name}` : child.name,
				fullPath: child.fullPath,
				children: child.children,
				files: child.files,
			};
		}
		node.children = node.children.map(collapse);
		return node;
	}

	return collapse(root);
}

/* ── Status styling ── */

function getStatusClass(status: AstNode["status"]): string {
	switch (status) {
		case "pending": return "ast-node-pending";
		case "parsed": return "ast-node-parsed";
		case "embedding": return "ast-node-embedding";
		case "done": return "ast-node-done";
	}
}

function getStatusIndicator(status: AstNode["status"]): string {
	switch (status) {
		case "pending": return "○";
		case "parsed": return "◎";
		case "embedding": return "◉";
		case "done": return "✓";
	}
}

function getFileStatus(symbols: AstNode[]): AstNode["status"] {
	if (symbols.length === 0) return "parsed";
	if (symbols.every((s) => s.status === "done")) return "done";
	if (symbols.some((s) => s.status === "embedding")) return "embedding";
	if (symbols.some((s) => s.status === "parsed")) return "parsed";
	return "pending";
}

/* ── Sub-components ── */

function AstDirNode({ node, depth }: { node: DirNode; depth: number }) {
	if (!node.name && node.children.length === 0 && node.files.length === 0) {
		return null;
	}

	return (
		<div className="ast-tree-node fade-in">
			{node.name && (
				<div className="ast-tree-dir" style={{ paddingLeft: `${depth * 16}px` }}>
					<span className="ast-tree-icon">📁</span>
					<span className="ast-tree-dir-name">{node.name}/</span>
				</div>
			)}
			{node.children.map((child) => (
				<AstDirNode key={child.fullPath} node={child} depth={node.name ? depth + 1 : depth} />
			))}
			{node.files.map((file) => (
				<AstFileNode key={file.fullPath} file={file} depth={node.name ? depth + 1 : depth} />
			))}
		</div>
	);
}

function AstFileNode({ file, depth }: { file: FileNode; depth: number }) {
	const status = getFileStatus(file.symbols);

	return (
		<div className="ast-tree-node fade-in">
			<div
				className={`ast-tree-file ${getStatusClass(status)}`}
				style={{ paddingLeft: `${depth * 16}px` }}
			>
				<span className="ast-tree-connector">├── </span>
				<span className="ast-tree-file-name">{file.name}</span>
				{file.symbols.length > 0 && (
					<span className="ast-tree-badge">{file.symbols.length}</span>
				)}
			</div>
			{file.symbols.map((sym, i) => (
				<div
					key={`${sym.name}-${i}`}
					className={`ast-tree-symbol ${getStatusClass(sym.status)} fade-in`}
					style={{
						paddingLeft: `${(depth + 1) * 16}px`,
						animationDelay: `${i * 30}ms`,
					}}
				>
					<span className="ast-tree-connector">
						{i === file.symbols.length - 1 ? "└── " : "├── "}
					</span>
					<span className={`ast-status-dot ${getStatusClass(sym.status)}`}>
						{getStatusIndicator(sym.status)}
					</span>
					<span className="ast-kind-badge">
						{KIND_ICONS[sym.kind] || sym.kind}
					</span>
					<span className="ast-symbol-name">{sym.name}</span>
				</div>
			))}
		</div>
	);
}

/* ── Main component ── */

export default function AstTreeView({ astNodes, textChunkCounts }: AstTreeViewProps) {
	const tree = useMemo(
		() => buildTree(astNodes, textChunkCounts),
		[astNodes, textChunkCounts],
	);

	const totalSymbols = astNodes.length;
	const doneSymbols = astNodes.filter((n) => n.status === "done").length;
	const embeddingSymbols = astNodes.filter((n) => n.status === "embedding").length;

	return (
		<div className="ast-tree-container ast-tree-single fade-in">
			<div className="ast-column">
				<div className="ast-column-header">
					<h3>Code Structure (AST)</h3>
					<span className="ast-column-subtitle">
						{totalSymbols} symbols detected
						{doneSymbols > 0 && ` · ${doneSymbols} embedded`}
						{embeddingSymbols > 0 && ` · ${embeddingSymbols} embedding`}
					</span>
				</div>
				<div className="ast-column-body">
					<AstDirNode node={tree} depth={0} />
				</div>
			</div>
		</div>
	);
}
