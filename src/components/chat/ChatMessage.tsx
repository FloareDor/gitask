"use client";

import { memo, useMemo, useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { Message } from "@/app/[owner]/[repo]/types";
import { encodeGitHubPath, injectInlineFileLinks } from "@/lib/chatUtils";
import { InlineDiagram } from "@/components/diagram/InlineDiagram";
import { generateMessageDiagram } from "@/lib/diagramGenerator";
import type { MessageDiagram } from "@/app/[owner]/[repo]/types";
import type { VectorStore } from "@/lib/vectorStore";

const markdownComponents: Components = {
	a: ({ href, children, ...props }) => (
		<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
			{children}
		</a>
	),
};

interface ChatMessageProps {
	msg: Message;
	isGenerating: boolean;
	isLast: boolean;
	owner: string;
	repo: string;
	commitRef: string;
	contextPaths?: string[];
	store: VectorStore;
	onToggleSources: (id: string) => void;
	onEditSubmit?: (messageId: string, newText: string) => void;
	onVizComplete?: (messageId: string, diagram: MessageDiagram) => void;
}

export const ChatMessage = memo(function ChatMessage({
	msg,
	isGenerating,
	isLast,
	owner,
	repo,
	commitRef,
	contextPaths,
	store,
	onToggleSources,
	onEditSubmit,
	onVizComplete,
}: ChatMessageProps) {
	const sourcesExpanded = Boolean(msg.ui?.sourcesExpanded);
	const sourcesPanelId = `sources-${msg.id}`;
	const isUser = msg.role === "user";
	const isStreaming = isGenerating && isLast && !isUser;

	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const seenVariantsRef = useRef<Set<string>>(new Set());
	const [isEditing, setIsEditing] = useState(false);
	const [editText, setEditText] = useState(msg.content);

	const [vizStatus, setVizStatus] = useState<"idle" | "loading" | "error">("idle");
	const [copied, setCopied] = useState(false);
	const editRef = useRef<HTMLTextAreaElement>(null);

	// Focus, set caret, and size the textarea when entering edit mode.
	useEffect(() => {
		if (isEditing && editRef.current) {
			const el = editRef.current;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, [isEditing]);

	const handleTextareaInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const el = e.target;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
		setEditText(el.value);
	}, []);

	const handleEditStart = useCallback(() => {
		setEditText(msg.content);
		setIsEditing(true);
	}, [msg.content]);

	const handleEditCancel = useCallback(() => {
		setIsEditing(false);
		setEditText(msg.content);
	}, [msg.content]);

	const handleEditSave = useCallback(() => {
		const trimmed = editText.trim();
		if (!trimmed || !onEditSubmit) return;
		setIsEditing(false);
		onEditSubmit(msg.id, trimmed);
	}, [editText, msg.id, onEditSubmit]);

	const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleEditSave();
		}
		if (e.key === "Escape") {
			handleEditCancel();
		}
	}, [handleEditSave, handleEditCancel]);

	const handleCopy = useCallback(() => {
		void navigator.clipboard.writeText(msg.content).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [msg.content]);

	const handleViz = useCallback(async () => {
		if (vizStatus === "loading") return;
		setVizStatus("loading");
		try {
			const result = await generateMessageDiagram(msg.content);
			if (result) {
				setVizStatus("idle");
				onVizComplete?.(msg.id, result);
			} else {
				setVizStatus("error");
			}
		} catch {
			setVizStatus("error");
		}
	}, [msg.content, msg.id, vizStatus, onVizComplete]);

	// Memoize inline file link injection — avoids rebuilding regex on every render.
	const renderedContent = useMemo(() => {
		if (isUser || isStreaming) return msg.content;
		const knownPaths = [
			...(msg.citations?.map((c) => c.filePath) ?? []),
			...(contextPaths ?? []),
		];
		if (knownPaths.length === 0) return msg.content;
		return injectInlineFileLinks(msg.content, knownPaths, owner, repo, commitRef);
	}, [msg.content, msg.citations, contextPaths, owner, repo, commitRef, isUser, isStreaming]);

	// Stable random word for the "no phase yet" gap (LLM queued but not streaming).
	const idleWordRef = useRef(
		["cooking", "brewing", "thinking", "generating", "working on it", "writing", "penning down my thoughts", "hol' up", "let me cook", "let me cook"][
			Math.floor(Math.random() * 5)
		]
	);

	// Thinking block: visible whenever streaming with no content yet.
	const showThinking = isStreaming && !msg.content;
	const thinkingPhase = msg.retrieval?.loadingPhase ?? idleWordRef.current;
	const thinkingVariants = msg.retrieval?.variants ?? [];
	const completedCount = msg.retrieval?.completedCount ?? 0;

	// Accumulate variants as they arrive across phase changes — never replace.
	// Mutating a ref during render is safe; the component re-renders anyway during streaming.
	thinkingVariants.forEach((v) => seenVariantsRef.current.add(v));
	const seenVariants = [...seenVariantsRef.current];

	return (
		<>
		<div className={`chat-message chat-message--${isUser ? "user" : "assistant"}`}>
			{/* Role label */}
			<div className={`chat-role-label ${isUser ? "chat-role-label--user" : "chat-role-label--assistant"}`}>
				{isUser ? (
					<span>you</span>
				) : (
					<>
						{isStreaming && !showThinking && <span className="chat-live-dot" aria-hidden="true" />}
						<span>✦ gitask</span>
					</>
				)}
			</div>

			{msg.safety?.blocked && (
				<div className="chat-safety-block">
					⚠ {msg.safety.reason ?? "Message blocked for safety"}
				</div>
			)}

			{!msg.safety?.blocked && isUser && (
				<div className="chat-user-row">
					<div className={`chat-bubble chat-bubble--user${isEditing ? " chat-bubble--editing" : ""}`}>
						{onEditSubmit && !isGenerating && !isEditing && (
							<button
								type="button"
								onClick={handleEditStart}
								title="Edit & resend"
								className="chat-edit-btn"
							>
								<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
									<path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Z" fill="currentColor"/>
								</svg>
							</button>
						)}
						{isEditing ? (
							<div className="chat-edit-inline">
								<textarea
									ref={editRef}
									className="chat-edit-textarea"
									value={editText}
									onChange={handleTextareaInput}
									onKeyDown={handleEditKeyDown}
								/>
								<div className="chat-edit-actions">
									<span className="chat-edit-hint">↵ send &nbsp;·&nbsp; esc cancel</span>
									<div className="chat-edit-actions-btns">
										<button type="button" className="chat-edit-cancel" onClick={handleEditCancel}>
											Cancel
										</button>
										<button type="button" className="chat-edit-save" onClick={handleEditSave}>
											Send
										</button>
									</div>
								</div>
							</div>
						) : (
							<p className="chat-user-text">{msg.content}</p>
						)}
					</div>
				</div>
			)}

							{/* Retrieval thinking block — shown during loading before first token */}
			{showThinking && (
				<div className="chat-thinking">
					<span
						className={`chat-thinking-phase${seenVariants.length > 0 ? " chat-thinking-phase--clickable" : ""}`}
						onClick={() => seenVariants.length > 0 && setThinkingExpanded((v) => !v)}
					>
						<span className="chat-thinking-phase-label">{thinkingPhase}</span>
						<span className="chat-thinking-dots" aria-hidden="true">
							<span className="chat-thinking-dot chat-thinking-dot--1" />
							<span className="chat-thinking-dot chat-thinking-dot--2" />
							<span className="chat-thinking-dot chat-thinking-dot--3" />
						</span>
					</span>
					{thinkingExpanded && seenVariants.length > 0 && (
						<div className="chat-thinking-rows">
							{seenVariants.map((v, i) => (
								<div key={i} className={`thinking-row ${i === 0 ? "thinking-row--original" : "thinking-row--variant"} ${i < completedCount && !isStreaming ? "thinking-row--done" : "thinking-row--loading"}`}>
									<span className="thinking-row-tag">{i === 0 ? "·" : "+"}</span>
									<span className="thinking-row-text">{v}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{!msg.safety?.blocked && !isUser && (!isStreaming || msg.content) && (
				<div className={`chat-bubble chat-bubble--assistant`}>
					{isStreaming ? (
						<div className="chat-markdown chat-streaming">
							{msg.content}
							<span className="chat-cursor" aria-hidden="true">▋</span>
						</div>
					) : (
						<div className="chat-markdown">
							<ReactMarkdown components={markdownComponents}>{renderedContent}</ReactMarkdown>
						</div>
					)}
				</div>
			)}

			{!msg.safety?.blocked && !isUser && !isStreaming && (
				<div className="chat-msg-actions">
					<button className="chat-msg-action-btn" onClick={handleCopy} title="Copy message">
						{copied ? "copied" : "copy"}
					</button>
					<span className="chat-msg-action-sep">·</span>
					<button
						className="chat-msg-action-btn"
						onClick={() => { void handleViz(); }}
						title="Visualize as diagram"
						disabled={vizStatus === "loading"}
					>
						{vizStatus === "loading" ? "viz..." : "viz"}
					</button>
				</div>
			)}

			{/* Diagram status */}
		{!isUser && msg.diagramStatus === "loading" && (
			<div className="diagram-status">
				<div className="diagram-status-spinner" />
				<span className="diagram-status-text">generating diagram...</span>
			</div>
		)}
		{!isUser && msg.diagramStatus === "error" && (
			<div className="diagram-error-status">diagram generation failed</div>
		)}

		{msg.citations && msg.citations.length > 0 && (
				<div className="chat-sources">
					<button
						type="button"
						onClick={() => onToggleSources(msg.id)}
						aria-expanded={sourcesExpanded}
						aria-controls={sourcesPanelId}
						className="chat-sources-toggle"
					>
						<span
							className="chat-sources-chevron"
							style={{ transform: sourcesExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
							aria-hidden="true"
						>▸</span>
						{sourcesExpanded ? "hide sources" : `${msg.citations.length} source${msg.citations.length !== 1 ? "s" : ""}`}
					</button>
					{sourcesExpanded && (
						<div id={sourcesPanelId} className="chat-sources-list">
							{msg.citations.map((citation) => {
								const lineLabel = citation.startLine === citation.endLine
									? `L${citation.startLine}`
									: `L${citation.startLine}-L${citation.endLine}`;
								const githubUrl = `https://github.com/${owner}/${repo}/blob/${commitRef}/${encodeGitHubPath(citation.filePath)}#L${citation.startLine}`;
								const extraChunks = citation.chunkCount - 1;
								const extraChunkLabel = extraChunks > 0 ? ` +${extraChunks}` : "";
								return (
									<a
										key={`${citation.filePath}:${citation.startLine}:${citation.endLine}`}
										href={githubUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="citation-link"
										title={`${citation.filePath} (${lineLabel})`}
									>
										<span className="citation-path">{citation.filePath}</span>
										<span className="citation-lines">{lineLabel}{extraChunkLabel}</span>
									</a>
								);
							})}
						</div>
					)}
				</div>
			)}
		</div>
		{!isUser && msg.diagramStatus === "ready" && msg.diagram && (
			<InlineDiagram data={msg.diagram} />
		)}
		{!isUser && vizStatus === "error" && (
			<div className="diagram-error-status">could not extract a diagram from this message</div>
		)}
		</>
	);
});
