"use client";

import { useEffect, useState } from "react";
import {
	getLLMConfig,
	setLLMConfig,
	reloadLLM,
	hasLegacyApiKey,
	type LLMConfig,
} from "@/lib/llm";
import { getGeminiVault } from "@/lib/gemini-vault";
import {
	BYOKVaultError,
	createBrowserPasskeyAdapter,
	getUserMessage,
} from "byok-vault";

export function ModelSettings() {
	const [isOpen, setIsOpen] = useState(false);
	const [config, setConfig] = useState<LLMConfig>({ provider: "mlc" });
	const [reloading, setReloading] = useState(false);
	const [statusMsg, setStatusMsg] = useState("");
	const [hasDefaultKey, setHasDefaultKey] = useState(false);
	const [apiKeyInput, setApiKeyInput] = useState("");
	const [passphraseInput, setPassphraseInput] = useState("");
	const [migratePassphrase, setMigratePassphrase] = useState("");

	const vault = getGeminiVault();
	const vaultState = vault?.getState() ?? "none";
	const canUseVault = vault?.canCall() ?? false;
	const passkeySupported =
		typeof window !== "undefined" && createBrowserPasskeyAdapter().isSupported();
	const isPasskeyEnrolled = vault?.isPasskeyEnrolled() ?? false;
	const needsMigration =
		config.provider === "gemini" &&
		hasLegacyApiKey(config) &&
		vaultState === "none";

	useEffect(() => {
		setConfig(getLLMConfig());
		setHasDefaultKey(!!process.env.NEXT_PUBLIC_HAS_GEMINI_KEY);
		setApiKeyInput("");
		setPassphraseInput("");
		setMigratePassphrase("");
	}, [isOpen]);

	const canSave =
		config.provider !== "gemini" ||
		hasDefaultKey ||
		canUseVault ||
		(apiKeyInput.trim() &&
			(passkeySupported || passphraseInput.length >= 8));

	const handleMigrate = async () => {
		if (!config.apiKey || migratePassphrase.length < 8 || !vault) return;
		setReloading(true);
		setStatusMsg("Migrating key to vault...");
		try {
			await vault.importKey(config.apiKey, migratePassphrase);
			const { apiKey: _omit, ...safe } = config;
			setLLMConfig(safe);
			setConfig(safe);
			setMigratePassphrase("");
			await reloadLLM((msg) => setStatusMsg(msg));
			setIsOpen(false);
		} catch (e) {
			console.error(e);
			setStatusMsg(
				e instanceof BYOKVaultError && e.code === "WRONG_PASSPHRASE"
					? "Wrong passphrase. Please try again."
					: getUserMessage(e)
			);
		} finally {
			setReloading(false);
		}
	};

	const handleUnlock = async () => {
		if (!vault || passphraseInput.length < 8) return;
		setReloading(true);
		setStatusMsg("Unlocking...");
		try {
			await vault.unlock(passphraseInput, { session: "tab" });
			setPassphraseInput("");
			await reloadLLM((msg) => setStatusMsg(msg));
		} catch (e) {
			console.error(e);
			setStatusMsg(
				e instanceof BYOKVaultError && e.code === "WRONG_PASSPHRASE"
					? "Wrong passphrase. Please try again."
					: getUserMessage(e)
			);
		} finally {
			setReloading(false);
		}
	};

	const handleUnlockWithPasskey = async () => {
		if (!vault) return;
		setReloading(true);
		setStatusMsg("Unlocking with fingerprint...");
		try {
			await vault.unlockWithPasskey({ session: "tab" });
			await reloadLLM((msg) => setStatusMsg(msg));
		} catch (e) {
			console.error(e);
			setStatusMsg(getUserMessage(e));
		} finally {
			setReloading(false);
		}
	};

	const handleLock = () => {
		vault?.lock();
		setConfig(getLLMConfig());
	};

	const handleResetKeys = () => {
		if (!confirm("Remove stored API key? You will need to re-enter it."))
			return;
		vault?.nuke();
		setConfig(getLLMConfig());
		setApiKeyInput("");
		setPassphraseInput("");
	};

	const handleSave = async () => {
		setReloading(true);
		setStatusMsg("Initializing...");
		try {
			if (
				config.provider === "gemini" &&
				apiKeyInput.trim() &&
				vault
			) {
				if (passkeySupported) {
					await vault.setConfigWithPasskey(
						{ apiKey: apiKeyInput.trim(), provider: "gemini" },
						{ rpName: "GitAsk", userName: "user" }
					);
				} else if (passphraseInput.length >= 8) {
					await vault.setConfig(
						{ apiKey: apiKeyInput.trim(), provider: "gemini" },
						passphraseInput
					);
				}
				setApiKeyInput("");
				setPassphraseInput("");
			}
			setLLMConfig({ provider: config.provider });
			await reloadLLM((msg) => setStatusMsg(msg));
			setIsOpen(false);
		} catch (e) {
			console.error(e);
			setStatusMsg(
				e instanceof BYOKVaultError && e.code === "WRONG_PASSPHRASE"
					? "Wrong passphrase. Please try again."
					: getUserMessage(e)
			);
		} finally {
			setReloading(false);
		}
	};

	if (!isOpen) {
		const isGemini = config.provider === "gemini";
		return (
			<button
				onClick={() => setIsOpen(true)}
				style={styles.settingsBtn}
				aria-label="Model settings"
			>
				<span style={{
					...styles.dot,
					background: isGemini ? "#a78bfa" : "var(--success)",
				}} />
				{isGemini ? "gemini" : "local"}
			</button>
		);
	}

	return (
		<div style={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}>
			<div style={styles.modal}>
				<div style={styles.modalTop}>
					<span style={styles.modalTitle}>llm</span>
					<button onClick={() => setIsOpen(false)} style={styles.closeBtn} aria-label="Close">✕</button>
				</div>

				{/* Provider toggle */}
				<div style={styles.toggleRow}>
					<button
						style={{ ...styles.toggleBtn, ...(config.provider === "mlc" ? styles.toggleBtnActive : {}) }}
						onClick={() => setConfig({ ...config, provider: "mlc" })}
					>
						local
					</button>
					<button
						style={{ ...styles.toggleBtn, ...(config.provider === "gemini" ? styles.toggleBtnActive : {}) }}
						onClick={() => setConfig({ ...config, provider: "gemini" })}
					>
						gemini
					</button>
				</div>
				<p style={styles.hint}>
					{config.provider === "mlc" ? (
						<>runs in your browser via{" "}
							<a href="https://github.com/mlc-ai/web-llm" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>web-llm</a>
							{" "}— needs ~4GB VRAM, downloads once</>
					) : (
						"google cloud, fast, no download — needs your API key"
					)}
				</p>

				{/* Gemini key fields */}
				{config.provider === "gemini" && (
					<div style={styles.geminiSection}>
						{hasDefaultKey && (
							<p style={styles.hint}>a shared key is set up. add your own key for better rate limits.</p>
						)}

						{needsMigration && (
							<div style={styles.field}>
								<label style={styles.label}>secure your existing key</label>
								<input
									type="password"
									placeholder="passphrase (min 8 chars)"
									value={migratePassphrase}
									onChange={(e) => setMigratePassphrase(e.target.value)}
									style={styles.input}
								/>
								<button onClick={handleMigrate} style={styles.saveBtn} disabled={reloading || migratePassphrase.length < 8}>
									{reloading ? "saving..." : "migrate"}
								</button>
							</div>
						)}

						{!needsMigration && vaultState === "none" && (
							<div style={styles.field}>
								<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={styles.accentLink}>
									get a free API key →
								</a>
								<input
									type="password"
									placeholder="paste API key"
									value={apiKeyInput}
									onChange={(e) => setApiKeyInput(e.target.value)}
									style={styles.input}
								/>
								{!passkeySupported && (
									<input
										type="password"
										placeholder="passphrase to encrypt it (min 8 chars)"
										value={passphraseInput}
										onChange={(e) => setPassphraseInput(e.target.value)}
										style={styles.input}
									/>
								)}
								<p style={styles.hint}>
									stays in your browser, secured by{" "}
									<a href="https://www.npmjs.com/package/byok-vault" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>byok-vault</a>
								</p>
							</div>
						)}

						{vaultState === "locked" && !needsMigration && (
							<div style={styles.field}>
								{isPasskeyEnrolled ? (
									<button onClick={handleUnlockWithPasskey} style={styles.saveBtn} disabled={reloading}>
										{reloading ? "unlocking..." : "unlock with fingerprint"}
									</button>
								) : (
									<>
										<input
											type="password"
											placeholder="passphrase"
											value={passphraseInput}
											onChange={(e) => setPassphraseInput(e.target.value)}
											style={styles.input}
										/>
										<button onClick={handleUnlock} style={styles.saveBtn} disabled={reloading || passphraseInput.length < 8}>
											{reloading ? "unlocking..." : "unlock"}
										</button>
									</>
								)}
							</div>
						)}

						{vaultState === "unlocked" && (
							<div style={styles.field}>
								<p style={{ ...styles.hint, color: "var(--success)" }}>key saved</p>
								<div style={{ display: "flex", gap: 8 }}>
									<button onClick={handleLock} style={styles.cancelBtn}>lock</button>
									<button onClick={handleResetKeys} style={styles.cancelBtn}>remove key</button>
								</div>
							</div>
						)}
					</div>
				)}

				{reloading && <p style={styles.status}>{statusMsg}</p>}

				<div style={styles.actions}>
					<button onClick={() => setIsOpen(false)} style={styles.cancelBtn} disabled={reloading}>cancel</button>
					<button onClick={handleSave} style={styles.saveBtn} disabled={reloading || !canSave}>
						{reloading ? "saving..." : "save"}
					</button>
				</div>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	settingsBtn: {
		display: "inline-flex",
		alignItems: "center",
		gap: "7px",
		background: "var(--bg-card)",
		border: "2px solid var(--border)",
		borderRadius: "3px",
		cursor: "pointer",
		padding: "6px 12px",
		fontSize: "13px",
		fontWeight: 600,
		color: "var(--text-secondary)",
		boxShadow: "2px 2px 0 var(--accent)",
		transition: "transform 0.1s ease, box-shadow 0.1s ease",
		fontFamily: "var(--font-sans)",
	},
	dot: {
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		flexShrink: 0,
		display: "inline-block",
	},
	overlay: {
		position: "fixed",
		top: 0, left: 0, right: 0, bottom: 0,
		background: "rgba(0,0,0,0.7)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 100,
	},
	modal: {
		width: "380px",
		maxWidth: "92vw",
		background: "var(--bg-card)",
		border: "2px solid var(--border)",
		borderRadius: "4px",
		boxShadow: "5px 5px 0 var(--accent)",
		display: "flex",
		flexDirection: "column",
		gap: "16px",
		padding: "20px",
	},
	modalTop: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
	},
	modalTitle: {
		fontSize: "18px",
		fontWeight: 800,
		fontFamily: "var(--font-display)",
		letterSpacing: "-0.01em",
		color: "var(--text-primary)",
	},
	closeBtn: {
		background: "transparent",
		border: "2px solid var(--border)",
		borderRadius: "2px",
		color: "var(--text-muted)",
		cursor: "pointer",
		fontSize: "12px",
		fontWeight: 700,
		width: "28px",
		height: "28px",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		flexShrink: 0,
	},
	toggleRow: {
		display: "flex",
		border: "2px solid var(--border)",
		borderRadius: "2px",
		overflow: "hidden",
	},
	toggleBtn: {
		flex: 1,
		padding: "9px",
		border: "none",
		background: "transparent",
		color: "var(--text-muted)",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 600,
		fontFamily: "var(--font-sans)",
		transition: "background 0.1s ease, color 0.1s ease",
	},
	toggleBtnActive: {
		background: "var(--accent)",
		color: "#fff",
	},
	hint: {
		fontSize: "12px",
		color: "var(--text-muted)",
		margin: 0,
		lineHeight: 1.5,
	},
	geminiSection: {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
		paddingTop: "4px",
		borderTop: "2px solid var(--border)",
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	label: {
		fontSize: "12px",
		fontWeight: 600,
		color: "var(--text-secondary)",
	},
	accentLink: {
		fontSize: "12px",
		color: "var(--accent)",
		textDecoration: "none",
	},
	input: {
		width: "100%",
		padding: "9px 12px",
		borderRadius: "2px",
		border: "2px solid var(--border)",
		background: "var(--bg-secondary)",
		color: "var(--text-primary)",
		fontSize: "13px",
		fontFamily: "var(--font-sans)",
		outline: "none",
	},
	status: {
		fontSize: "12px",
		color: "var(--accent)",
		margin: 0,
	},
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		gap: "8px",
		paddingTop: "4px",
		borderTop: "2px solid var(--border)",
	},
	cancelBtn: {
		background: "transparent",
		border: "2px solid var(--border)",
		borderRadius: "2px",
		color: "var(--text-secondary)",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 600,
		padding: "7px 14px",
		fontFamily: "var(--font-sans)",
	},
	saveBtn: {
		background: "var(--accent)",
		color: "white",
		border: "2px solid var(--accent)",
		borderRadius: "2px",
		padding: "7px 16px",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 700,
		fontFamily: "var(--font-sans)",
		boxShadow: "2px 2px 0 rgba(0,0,0,0.4)",
	},
};
