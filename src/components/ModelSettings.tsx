"use client";

import { useEffect, useState } from "react";
import {
	getLLMConfig,
	setLLMConfig,
	reloadLLM,
	hasLegacyApiKey,
	hasGeminiLocalApiKey,
	setGeminiLocalApiKey,
	type LLMConfig,
	type GeminiStorageMode,
} from "@/lib/llm";
import { getGeminiVault, isGeminiVaultSupported } from "@/lib/gemini-vault";
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
	const [hasLocalKey, setHasLocalKey] = useState(false);

	const vault = getGeminiVault();
	const vaultState = vault?.getState() ?? "none";
	const canUseVault = vault?.canCall() ?? false;
	const vaultSupported = isGeminiVaultSupported();
	const storageMode: GeminiStorageMode =
		config.geminiStorage === "local" ? "local" : "vault";
	const bypassEnabled = storageMode === "local";
	const passkeySupported =
		typeof window !== "undefined" && createBrowserPasskeyAdapter().isSupported();
	const isPasskeyEnrolled = vault?.isPasskeyEnrolled() ?? false;
	const needsMigration =
		config.provider === "gemini" &&
		storageMode === "vault" &&
		hasLegacyApiKey(config) &&
		vaultState === "none";

	useEffect(() => {
		setConfig(getLLMConfig());
		setHasDefaultKey(!!process.env.NEXT_PUBLIC_HAS_GEMINI_KEY);
		setHasLocalKey(hasGeminiLocalApiKey());
		setApiKeyInput("");
		setPassphraseInput("");
		setMigratePassphrase("");
	}, [isOpen]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const openHandler = () => setIsOpen(true);
		window.addEventListener("gitask-open-llm-settings", openHandler);
		return () => window.removeEventListener("gitask-open-llm-settings", openHandler);
	}, []);

	useEffect(() => {
		if (config.provider !== "gemini") return;
		if (vaultSupported || storageMode === "local") return;
		setConfig((prev) => ({ ...prev, geminiStorage: "local" }));
	}, [config.provider, storageMode, vaultSupported]);

	const canSave = (() => {
		if (config.provider !== "gemini") return true;
		if (hasDefaultKey) return true;
		if (storageMode === "local") return hasLocalKey || apiKeyInput.trim().length > 0;
		if (!vaultSupported) return false;
		if (canUseVault) return true;
		return (
			apiKeyInput.trim().length > 0 &&
			(passkeySupported || passphraseInput.length >= 8)
		);
	})();

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

	const handleResetKeys = (mode: "all" | "vault" | "local" = "all") => {
		if (!confirm("Remove stored API key? You will need to re-enter it."))
			return;
		if (mode !== "local") {
			vault?.nuke();
		}
		if (mode !== "vault") {
			setGeminiLocalApiKey(null);
		}
		setConfig(getLLMConfig());
		setHasLocalKey(hasGeminiLocalApiKey());
		setApiKeyInput("");
		setPassphraseInput("");
	};

	const handleSave = async () => {
		setReloading(true);
		setStatusMsg("Initializing...");
		let clearLocalKeyAfterSuccess = false;
		try {
			if (config.provider === "gemini") {
				if (storageMode === "local") {
					if (apiKeyInput.trim()) {
						setGeminiLocalApiKey(apiKeyInput.trim());
						setHasLocalKey(hasGeminiLocalApiKey());
					}
				} else {
					clearLocalKeyAfterSuccess = true;
					if (apiKeyInput.trim() && vault) {
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
					}
				}
				setApiKeyInput("");
				setPassphraseInput("");
			}
			setLLMConfig({
				provider: config.provider,
				geminiStorage: storageMode,
			});
			await reloadLLM((msg) => setStatusMsg(msg));
			if (clearLocalKeyAfterSuccess) {
				setGeminiLocalApiKey(null);
				setHasLocalKey(false);
			}
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
						onClick={() =>
							setConfig({
								...config,
								provider: "gemini",
								geminiStorage: storageMode === "local" ? "local" : "vault",
							})
						}
					>
						gemini
					</button>
				</div>
				<p style={styles.hint}>
					{config.provider === "mlc" ? (
						<>runs in your browser via{" "}
							<a href="https://github.com/mlc-ai/web-llm" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>web-llm</a>
							{" "}— needs WebGPU + ~4GB VRAM, downloads once</>
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

						<div style={styles.field}>
							<div style={styles.switchInlineRow}>
								<span style={styles.label}>byok-vault bypass</span>
								<button
									type="button"
									role="switch"
									aria-checked={bypassEnabled}
									aria-label="Toggle BYOK vault bypass"
									style={{
										...styles.switchBtn,
										...(bypassEnabled ? styles.switchBtnOn : {}),
										...(!vaultSupported ? styles.switchBtnDisabled : {}),
									}}
									onClick={() =>
										setConfig((prev) => ({
											...prev,
											geminiStorage: bypassEnabled ? "vault" : "local",
										}))
									}
									disabled={!vaultSupported}
								>
									<span
										style={{
											...styles.switchThumb,
											...(bypassEnabled ? styles.switchThumbOn : {}),
										}}
									/>
								</button>
								<span
									style={{
										...styles.switchState,
										...(bypassEnabled ? styles.switchStateOn : {}),
										...(!vaultSupported ? styles.switchStateDisabled : {}),
									}}
								>
									{bypassEnabled ? "ON" : "OFF"}
								</span>
							</div>
							{!bypassEnabled ? (
								<p style={styles.hint}>
									stored encrypted with{" "}
									<a
										href="https://www.npmjs.com/package/byok-vault"
										target="_blank"
										rel="noopener noreferrer"
										style={{ color: "var(--accent)" }}
									>
										byok-vault
									</a>
									.
								</p>
							) : (
								<p style={styles.warningHint}>
									local fallback stores your Gemini key in browser localStorage (less secure).
								</p>
							)}
							{!vaultSupported && (
								<p style={styles.warningHint}>
									encrypted vault is not available in this browser. bypass is forced on.
								</p>
							)}
						</div>

						{storageMode === "vault" && needsMigration && (
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

						{storageMode === "vault" && !needsMigration && vaultState === "none" && (
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
							</div>
						)}

						{storageMode === "local" && (
							<div style={styles.field}>
								<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={styles.accentLink}>
									get a free API key →
								</a>
								<input
									type="password"
									placeholder={hasLocalKey ? "replace local API key (optional)" : "paste API key"}
									value={apiKeyInput}
									onChange={(e) => setApiKeyInput(e.target.value)}
									style={styles.input}
								/>
								{hasLocalKey && (
									<div style={{ display: "flex", gap: 8 }}>
										<p style={{ ...styles.hint, color: "var(--success)", flex: 1 }}>local key saved</p>
										<button onClick={() => handleResetKeys("local")} style={styles.cancelBtn}>
											remove key
										</button>
									</div>
								)}
							</div>
						)}

						{storageMode === "vault" && vaultState === "locked" && !needsMigration && (
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

						{storageMode === "vault" && vaultState === "unlocked" && (
							<div style={styles.field}>
								<p style={{ ...styles.hint, color: "var(--success)" }}>key saved</p>
								<div style={{ display: "flex", gap: 8 }}>
									<button onClick={handleLock} style={styles.cancelBtn}>lock</button>
									<button onClick={() => handleResetKeys("vault")} style={styles.cancelBtn}>remove key</button>
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
	toggleBtnDisabled: {
		opacity: 0.45,
		cursor: "not-allowed",
	},
	switchInlineRow: {
		display: "inline-flex",
		alignItems: "center",
		gap: "8px",
	},
	switchBtn: {
		width: "46px",
		height: "26px",
		borderRadius: "999px",
		border: "2px solid var(--border)",
		background: "var(--bg-card)",
		cursor: "pointer",
		padding: "2px",
		display: "flex",
		alignItems: "center",
		transition: "background 0.12s ease",
	},
	switchBtnOn: {
		background: "rgba(245,158,11,0.25)",
	},
	switchThumb: {
		width: "16px",
		height: "16px",
		borderRadius: "50%",
		background: "var(--text-muted)",
		transform: "translateX(0)",
		transition: "transform 0.12s ease, background 0.12s ease",
	},
	switchThumbOn: {
		transform: "translateX(18px)",
		background: "var(--warning)",
	},
	switchBtnDisabled: {
		cursor: "not-allowed",
		opacity: 0.6,
	},
	switchState: {
		fontSize: "11px",
		fontWeight: 700,
		color: "var(--text-muted)",
		fontFamily: "var(--font-mono)",
		minWidth: "24px",
	},
	switchStateOn: {
		color: "var(--warning)",
	},
	switchStateDisabled: {
		opacity: 0.7,
	},
	hint: {
		fontSize: "12px",
		color: "var(--text-muted)",
		margin: 0,
		lineHeight: 1.5,
	},
	warningHint: {
		fontSize: "12px",
		color: "var(--warning)",
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
