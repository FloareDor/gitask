"use client";

interface TokenInputProps {
	tokenDraft: string;
	tokenChanged: boolean;
	onChange: (val: string) => void;
	onApply: () => void;
}

export function TokenInput({ tokenDraft, tokenChanged, onChange, onApply }: TokenInputProps) {
	return (
		<div style={{ padding: "8px 20px", borderBottom: "2px solid var(--border-dark)", display: "flex", gap: "8px", background: "var(--bg-app)", flexShrink: 0 }}>
			<input
				className="input"
				type="password"
				placeholder="GitHub Personal Access Token (optional, for higher rate limits)"
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
	);
}
