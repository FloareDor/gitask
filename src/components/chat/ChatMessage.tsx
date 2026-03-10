"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { Message } from "@/app/[owner]/[repo]/types";
import { encodeGitHubPath, injectInlineFileLinks } from "@/lib/chatUtils";

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
	onToggleSources: (id: string) => void;
}

export function ChatMessage({
	msg,
	isGenerating,
	isLast,
	owner,
	repo,
	commitRef,
	contextPaths,
	onToggleSources,
}: ChatMessageProps) {
	const sourcesExpanded = Boolean(msg.ui?.sourcesExpanded);
	const sourcesPanelId = `sources-${msg.id}`;
	const isUser = msg.role === "user";
	const isStreaming = isGenerating && isLast && !isUser;

	// Build the set of known file paths from citations + context chunks.
	const knownPaths = [
		...(msg.citations?.map((c) => c.filePath) ?? []),
		...(contextPaths ?? []),
	];

	// For completed assistant messages, inject inline GitHub links for file paths.
	const renderedContent =
		!isUser && !isStreaming && knownPaths.length > 0
			? injectInlineFileLinks(msg.content, knownPaths, owner, repo, commitRef)
			: msg.content;

	return (
		<div className={`chat-message chat-message--${isUser ? "user" : "assistant"}`}>
			{/* Role label */}
			<div className={`chat-role-label ${isUser ? "chat-role-label--user" : "chat-role-label--assistant"}`}>
				{isUser ? (
					<span>you</span>
				) : (
					<>
						{isStreaming && <span className="chat-live-dot" aria-hidden="true" />}
						<span>✦ gitask</span>
					</>
				)}
			</div>

			{msg.safety?.blocked && (
				<div className="chat-safety-block">
					⚠ {msg.safety.reason ?? "Message blocked for safety"}
				</div>
			)}

			{!msg.safety?.blocked && (
				<div className={`chat-bubble ${isUser ? "chat-bubble--user" : "chat-bubble--assistant"}`}>
					{isUser ? (
						<p className="chat-user-text">{msg.content}</p>
					) : isStreaming ? (
						<div className="chat-markdown chat-streaming">
							{msg.content || ""}
							<span className="chat-cursor" aria-hidden="true">▋</span>
						</div>
					) : (
						<div className="chat-markdown">
							<ReactMarkdown components={markdownComponents}>{renderedContent}</ReactMarkdown>
						</div>
					)}
				</div>
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
	);
}
