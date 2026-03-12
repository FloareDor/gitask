"use client";

interface TokenInputProps {
	tokenDraft: string;
	tokenChanged: boolean;
	onChange: (val: string) => void;
	onApply: () => void;
}

export function TokenInput({ tokenDraft, tokenChanged, onChange, onApply }: TokenInputProps) {
	return (
		<div style={{ padding: "8px 20px 10px", borderBottom: "2px solid var(--border-dark)", background: "var(--bg-app)", flexShrink: 0 }}>
			<div style={{ display: "flex", gap: "8px" }}>
				<input
					className="input"
					type="password"
					placeholder="GitHub Personal Access Token (required for private repos)"
					value={tokenDraft}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							onApply();
						}
					}}
					style={{ flex: 1, fontSize: "13px", background: "var(--bg-card-dark)", border: "2px solid var(--border-dark)", color: "var(--text-on-dark)", padding: "8px 12px", outline: "none" }}
				/>
				<button
					type="button"
					style={{ fontSize: "12px", padding: "5px 10px", background: "transparent", border: "1px solid var(--border-dark)", color: "var(--text-on-dark-secondary)", cursor: "pointer" }}
					onClick={onApply}
					disabled={!tokenChanged}
				>
					Apply
				</button>
			</div>
			<div style={{ marginTop: "5px", fontSize: "11px", color: "var(--text-on-dark-secondary)" }}>
				Don't have one?{" "}
				<a
					href="https://github.com/settings/tokens/new?scopes=repo&description=GitAsk"
					target="_blank"
					rel="noopener noreferrer"
					style={{ color: "var(--text-on-dark-secondary)", textDecoration: "underline", textUnderlineOffset: "2px" }}
				>
					Get a GitHub token
				</a>
			</div>
		</div>
	);
}
