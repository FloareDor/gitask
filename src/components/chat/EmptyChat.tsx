"use client";

const STARTER_SUGGESTIONS = [
	"What does this project do?",
	"Walk me through the main data flow",
	"What are the key entry points?",
	"How is error handling structured?",
];

interface EmptyChatProps {
	owner: string;
	repo: string;
	onSelectSuggestion: (text: string) => void;
}

export function EmptyChat({ owner, repo, onSelectSuggestion }: EmptyChatProps) {
	return (
		<div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 24, textAlign: "center" }}>
			<div>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-on-dark-muted)", display: "block", marginBottom: 12 }}>
					{owner}/{repo}
				</span>
				<h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "clamp(1.3rem, 3vw, 2rem)", color: "var(--text-on-dark)", letterSpacing: "-0.02em", margin: 0 }}>
					What do you want to know?
				</h2>
			</div>
			<div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", maxWidth: 560 }}>
				{STARTER_SUGGESTIONS.map(suggestion => (
					<button
						key={suggestion}
						onClick={() => onSelectSuggestion(suggestion)}
						style={{ padding: "10px 16px", border: "2px solid var(--border-dark)", background: "var(--bg-card-dark)", color: "var(--text-on-dark-secondary)", cursor: "pointer", fontSize: "13px", fontFamily: "var(--font-sans)" }}
					>
						{suggestion}
					</button>
				))}
			</div>
		</div>
	);
}
