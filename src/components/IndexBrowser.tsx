"use client";

import { useMemo, useState } from "react";
import type { EmbeddedChunk } from "@/lib/embedder";

interface IndexBrowserProps {
	chunks: EmbeddedChunk[];
	onClose?: () => void;
}

interface FileGroup {
	filePath: string;
	chunks: EmbeddedChunk[];
}

function buildFileTree(chunks: EmbeddedChunk[]): FileGroup[] {
	const byFile = new Map<string, EmbeddedChunk[]>();
	for (const chunk of chunks) {
		const list = byFile.get(chunk.filePath) || [];
		list.push(chunk);
		byFile.set(chunk.filePath, list);
	}
	// Sort chunks within each file by startLine
	for (const list of byFile.values()) {
		list.sort((a, b) => a.startLine - b.startLine);
	}
	return Array.from(byFile.entries())
		.map(([filePath, chunks]) => ({ filePath, chunks }))
		.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

const NODE_TYPE_LABELS: Record<string, string> = {
	function_declaration: "fn",
	function: "fn",
	arrow_function: "fn",
	method_definition: "method",
	class_declaration: "class",
	export_statement: "export",
	lexical_declaration: "const",
	variable_declaration: "var",
	function_definition: "def",
	class_definition: "class",
	function_item: "fn",
	impl_item: "impl",
	struct_item: "struct",
	enum_item: "enum",
	method_declaration: "method",
	type_declaration: "type",
	constructor_declaration: "ctor",
	interface_declaration: "iface",
	text_chunk: "chunk",
};

export default function IndexBrowser({ chunks, onClose }: IndexBrowserProps) {
	const fileGroups = useMemo(() => buildFileTree(chunks), [chunks]);
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => {
		// Expand first 5 files by default for quick browsing
		return new Set(fileGroups.slice(0, 5).map((f) => f.filePath));
	});
	const [selectedChunk, setSelectedChunk] = useState<EmbeddedChunk | null>(null);

	const toggleFile = (filePath: string) => {
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filePath)) next.delete(filePath);
			else next.add(filePath);
			return next;
		});
	};

	const expandAll = () =>
		setExpandedFiles(new Set(fileGroups.map((f) => f.filePath)));
	const collapseAll = () => setExpandedFiles(new Set());

	const totalFiles = fileGroups.length;
	const totalChunks = chunks.length;

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "12px",
					flexShrink: 0,
				}}
			>
				<div>
					<h3
						style={{
							fontSize: "13px",
							fontWeight: 600,
							color: "var(--text-muted)",
							textTransform: "uppercase" as const,
							letterSpacing: "0.05em",
							margin: 0,
						}}
					>
						Indexed Content
					</h3>
					<p
						style={{
							fontSize: "11px",
							color: "var(--text-muted)",
							margin: "4px 0 0 0",
						}}
					>
						{totalFiles} files · {totalChunks} chunks
					</p>
				</div>
				<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
					<button
						type="button"
						className="btn btn-ghost"
						style={{ fontSize: "11px", padding: "2px 6px" }}
						onClick={expandAll}
					>
						Expand all
					</button>
					<button
						type="button"
						className="btn btn-ghost"
						style={{ fontSize: "11px", padding: "2px 6px" }}
						onClick={collapseAll}
					>
						Collapse
					</button>
					{onClose && (
						<button
							type="button"
							className="btn btn-ghost"
							style={{ fontSize: "12px", padding: "4px 8px" }}
							onClick={onClose}
						>
							✕
						</button>
					)}
				</div>
			</div>

			<div
				style={{
					flex: 1,
					display: "flex",
					gap: "12px",
					overflow: "hidden",
					minHeight: 0,
				}}
			>
				{/* File tree */}
				<div
					style={{
						flex: "0 0 220px",
						overflow: "auto",
						borderRight: "1px solid var(--border)",
						paddingRight: "12px",
					}}
				>
					{fileGroups.map(({ filePath, chunks: fileChunks }) => {
						const isExpanded = expandedFiles.has(filePath);
						const fileName = filePath.split("/").pop() ?? filePath;
						return (
							<div key={filePath} style={{ marginBottom: "4px" }}>
								<button
									type="button"
									className="btn btn-ghost"
									style={{
										width: "100%",
										justifyContent: "flex-start",
										fontSize: "12px",
										padding: "6px 8px",
										textAlign: "left",
										fontFamily: "var(--font-mono)",
									}}
									onClick={() => toggleFile(filePath)}
								>
									<span style={{ marginRight: "6px" }}>
										{isExpanded ? "▾" : "▸"}
									</span>
									<span style={{ color: "var(--accent)" }}>{fileName}</span>
									<span
										style={{
											marginLeft: "6px",
											color: "var(--text-muted)",
											fontSize: "11px",
										}}
									>
										{fileChunks.length}
									</span>
								</button>
								{isExpanded && (
									<div style={{ paddingLeft: "20px", marginTop: "2px" }}>
										{fileChunks.map((chunk) => (
											<button
												key={chunk.id}
												type="button"
												className="btn btn-ghost"
												style={{
													width: "100%",
													justifyContent: "flex-start",
													fontSize: "11px",
													padding: "4px 8px",
													textAlign: "left",
													background:
														selectedChunk?.id === chunk.id
															? "var(--bg-glass)"
															: undefined,
												}}
												onClick={() => setSelectedChunk(chunk)}
											>
												<span
													style={{
														display: "inline-block",
														width: "32px",
														color: "var(--text-muted)",
														fontSize: "10px",
													}}
												>
													{NODE_TYPE_LABELS[chunk.nodeType] ?? chunk.nodeType}
												</span>
												<span
													style={{
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
												>
													{chunk.name}
												</span>
											</button>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>

				{/* Code preview */}
				<div
					style={{
						flex: 1,
						overflow: "auto",
						minWidth: 0,
						background: "var(--bg-glass)",
						borderRadius: "var(--radius-sm)",
						padding: "12px",
						border: "1px solid var(--border)",
					}}
				>
					{selectedChunk ? (
						<>
							<div
								style={{
									fontSize: "12px",
									fontFamily: "var(--font-mono)",
									color: "var(--accent)",
									marginBottom: "8px",
								}}
							>
								{selectedChunk.filePath}
								<span
									style={{
										color: "var(--text-muted)",
										marginLeft: "8px",
										fontWeight: 400,
									}}
								>
									L{selectedChunk.startLine}–{selectedChunk.endLine}
								</span>
							</div>
							<pre
								className="code"
								style={{
									fontSize: "11px",
									whiteSpace: "pre-wrap",
									wordBreak: "break-all",
									margin: 0,
									lineHeight: 1.5,
								}}
							>
								{selectedChunk.code}
							</pre>
						</>
					) : (
						<div
							style={{
								color: "var(--text-muted)",
								fontSize: "12px",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								height: "100%",
								minHeight: "120px",
							}}
						>
							Select a chunk to view code
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
