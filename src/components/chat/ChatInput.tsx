"use client";

interface ChatInputProps {
	input: string;
	isIndexed: boolean;
	isGenerating: boolean;
	owner: string;
	repo: string;
	onChange: (val: string) => void;
	onSend: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ChatInput({
	input,
	isIndexed,
	isGenerating,
	owner,
	repo,
	onChange,
	onSend,
	onKeyDown,
}: ChatInputProps) {
	return (
		<form
			onSubmit={(e) => { e.preventDefault(); onSend(); }}
			style={{ padding: "16px 24px", borderTop: "2px solid var(--border-dark)", background: "var(--bg-app)", display: "flex", gap: 12, alignItems: "flex-end", flexShrink: 0 }}
		>
			<textarea
				value={input}
				onChange={e => onChange(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder={isIndexed ? `Ask about ${owner}/${repo}...` : "Index the repo first..."}
				disabled={!isIndexed || isGenerating}
				rows={1}
				id="chat-input"
				style={{
					flex: 1, padding: "12px 16px",
					background: "var(--bg-card-dark)", color: "var(--text-on-dark)",
					border: "2px solid var(--border-dark)", outline: "none",
					fontFamily: "var(--font-sans)", fontSize: "14px",
					resize: "none", lineHeight: 1.5,
					minHeight: 46, maxHeight: 200,
					overflowY: "auto",
				}}
				onFocus={e => { e.target.style.borderColor = "#16a34a"; }}
				onBlur={e => { e.target.style.borderColor = "var(--border-dark)"; }}
			/>
			<button
				type="submit"
				disabled={!input.trim() || isGenerating || !isIndexed}
				id="send-btn"
				style={{
					padding: "12px 20px", background: "#f5f5f0", color: "#0a0a0a",
					border: "2px solid #f5f5f0", cursor: "pointer", fontWeight: 700,
					fontSize: "16px", flexShrink: 0, height: 46,
					opacity: (!input.trim() || isGenerating || !isIndexed) ? 0.4 : 1,
				}}
			>
				↑
			</button>
		</form>
	);
}
