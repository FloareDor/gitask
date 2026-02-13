"use client";

import { useEffect, useState } from "react";
import {
	getLLMConfig,
	setLLMConfig,
	reloadLLM,
	type LLMConfig,
	type LLMProvider,
} from "@/lib/llm";

export function ModelSettings() {
	const [isOpen, setIsOpen] = useState(false);
	const [config, setConfig] = useState<LLMConfig>({ provider: "mlc" });
	const [reloading, setReloading] = useState(false);
	const [statusMsg, setStatusMsg] = useState("");
	const [hasDefaultKey, setHasDefaultKey] = useState(false);

	useEffect(() => {
		// Load initial config
		setConfig(getLLMConfig());
		// Check if env key exists (client-side check rely on process.env being replaced at build time)
		setHasDefaultKey(!!process.env.NEXT_PUBLIC_HAS_GEMINI_KEY);
	}, [isOpen]);

	const handleSave = async () => {
		setReloading(true);
		setStatusMsg("Initializing...");
		try {
			setLLMConfig(config);
			await reloadLLM((msg) => setStatusMsg(msg));
			setIsOpen(false);
		} catch (e) {
			console.error(e);
			setStatusMsg("Error: " + String(e));
		} finally {
			setReloading(false);
		}
	};

	if (!isOpen) {
		const isGemini = config.provider === "gemini";
		return (
			<button
				onClick={() => setIsOpen(true)}
				style={{
					...styles.settingsBtn,
					borderColor: isGemini ? "var(--success)" : "var(--border)",
				}}
				aria-label="Settings"
			>
				{isGemini ? "⚡ Using Gemini Cloud" : "🔒 Using Local LLM"} <span style={{ opacity: 0.5, marginLeft: 4 }}> (Settings)</span>
			</button>
		);
	}

	return (
		<div style={styles.overlay}>
			<div style={styles.modal} className="glass">
				<h2 style={styles.title}>Model Settings</h2>

				<div style={styles.field}>
					<label style={styles.label}>LLM Provider</label>
					<div style={styles.toggleGroup}>
						<button
							style={{
								...styles.toggleBtn,
								...(config.provider === "mlc" ? styles.activeBtn : {}),
							}}
							onClick={() => setConfig({ ...config, provider: "mlc" })}
						>
							Local (MLC WebGPU)
						</button>
						<button
							style={{
								...styles.toggleBtn,
								...(config.provider === "gemini" ? styles.activeBtn : {}),
							}}
							onClick={() => setConfig({ ...config, provider: "gemini" })}
						>
							Cloud (Gemini API)
						</button>
					</div>
					<p style={styles.hint}>
						{config.provider === "mlc"
							? "Runs privately in your browser. Needs ~4GB VRAM. Downloads ~3GB model once."
							: "Runs on Google Cloud using Gemini 3 Flash Preview. Fast, no download required."}
					</p>
				</div>

				{config.provider === "gemini" && (
					<div style={styles.field}>
						<label style={styles.label}>Gemini API Key</label>
						<input
							type="password"
							placeholder={hasDefaultKey ? "Using default key from environment" : "Paste your API Key here"}
							value={config.apiKey || ""}
							onChange={(e) =>
								setConfig({ ...config, apiKey: e.target.value })
							}
							style={{
								...styles.input,
								...(hasDefaultKey && !config.apiKey ? { border: "1px solid var(--success)" } : {}),
							}}
						/>
						<p style={styles.hint}>
							{hasDefaultKey && !config.apiKey
								? "✅ Default API Key is active. You can override it above."
								: "Stored only in your browser's localStorage. Never sent to our server."
							}
						</p>
					</div>
				)}

				{reloading && <div style={styles.status}>{statusMsg}</div>}

				<div style={styles.actions}>
					<button
						onClick={() => setIsOpen(false)}
						style={styles.cancelBtn}
						disabled={reloading}
					>
						Cancel
					</button>
					<button
						onClick={handleSave}
						style={styles.saveBtn}
						disabled={reloading || (config.provider === "gemini" && !config.apiKey && !hasDefaultKey)}
					>
						{reloading ? "Saving & Reloading..." : "Save & Reload"}
					</button>
				</div>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	settingsBtn: {
		// position: "fixed", // Removed for inline placement
		// top: "20px",
		// right: "20px",
		background: "var(--bg-glass)",
		border: "1px solid var(--border)",
		padding: "8px 16px",
		borderRadius: "20px",
		cursor: "pointer",
		zIndex: 50,
		fontSize: "13px",
		color: "var(--text)",
		fontWeight: 500,
		transition: "all 0.2s",
	},
	overlay: {
		position: "fixed",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: "rgba(0,0,0,0.6)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 100,
		backdropFilter: "blur(4px)",
	},
	modal: {
		width: "400px",
		maxWidth: "90%",
		padding: "24px",
		background: "#111",
		borderRadius: "16px",
		border: "1px solid var(--border)",
		display: "flex",
		flexDirection: "column",
		gap: "20px",
	},
	title: {
		fontSize: "20px",
		fontWeight: 600,
		margin: 0,
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	label: {
		fontSize: "14px",
		fontWeight: 500,
		color: "var(--text-secondary)",
	},
	toggleGroup: {
		display: "flex",
		gap: "8px",
		background: "#222",
		padding: "4px",
		borderRadius: "8px",
	},
	toggleBtn: {
		flex: 1,
		padding: "8px",
		borderRadius: "6px",
		border: "none",
		background: "transparent",
		color: "#888",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 500,
		transition: "all 0.2s",
	},
	activeBtn: {
		background: "var(--accent)",
		color: "#fff",
	},
	hint: {
		fontSize: "12px",
		color: "#666",
		margin: 0,
		lineHeight: "1.4",
	},
	input: {
		width: "100%",
		padding: "10px",
		borderRadius: "8px",
		border: "1px solid #333",
		background: "#000",
		color: "#fff",
		fontSize: "14px",
	},
	status: {
		fontSize: "13px",
		color: "var(--accent)",
		textAlign: "center",
	},
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		gap: "12px",
		marginTop: "8px",
	},
	cancelBtn: {
		background: "transparent",
		border: "none",
		color: "#888",
		cursor: "pointer",
		fontSize: "14px",
	},
	saveBtn: {
		background: "var(--accent)",
		color: "white",
		border: "none",
		padding: "8px 16px",
		borderRadius: "8px",
		cursor: "pointer",
		fontSize: "14px",
		fontWeight: 500,
	},
};
