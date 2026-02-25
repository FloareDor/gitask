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
				title={isGemini ? "Using Gemini Cloud" : "Using Local LLM"}
			>
				<span style={{ opacity: 0.8 }}>⚙</span> Settings
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
							: "Runs on Google Cloud using Gemini 2.5 Flash. Fast, no download required."}
					</p>
				</div>

				{config.provider === "gemini" && (
					<div style={styles.geminiSection}>
						{hasDefaultKey && (
							<p style={styles.hint}>
								A shared key is available. Adding your own gives you higher rate limits and keeps your requests private.
							</p>
						)}

						{needsMigration && (
							<div style={styles.field}>
								<label style={styles.label}>
									Migrate your existing API key (one-time)
								</label>
								<input
									type="password"
									placeholder="Enter passphrase (min 8 chars) to secure your key"
									value={migratePassphrase}
									onChange={(e) => setMigratePassphrase(e.target.value)}
									style={styles.input}
								/>
								<button
									onClick={handleMigrate}
									style={styles.saveBtn}
									disabled={
										reloading || migratePassphrase.length < 8
									}
								>
									{reloading ? "Migrating..." : "Migrate & Save"}
								</button>
							</div>
						)}

						{!needsMigration && vaultState === "none" && (
							<div style={styles.field}>
								<label style={styles.label}>Add your API key (encrypted)</label>
								<a
									href="https://aistudio.google.com/app/apikey"
									target="_blank"
									rel="noopener noreferrer"
									style={{ fontSize: 12, color: "var(--accent)", marginBottom: 4 }}
								>
									Get your Free Gemini API key →
								</a>
								<input
									type="password"
									placeholder="Paste your Gemini API Key"
									value={apiKeyInput}
									onChange={(e) => setApiKeyInput(e.target.value)}
									style={styles.input}
								/>
								{passkeySupported ? (
									<p style={styles.hint}>
										Secured with fingerprint / passkey
									</p>
								) : (
									<input
										type="password"
										placeholder="Passphrase (min 8 chars) to encrypt"
										value={passphraseInput}
										onChange={(e) => setPassphraseInput(e.target.value)}
										style={styles.input}
									/>
								)}
								<p style={styles.hint}>
									Encrypted in your browser. Never sent to our server.{" "}
									<a
										href="https://www.npmjs.com/package/byok-vault"
										target="_blank"
										rel="noopener noreferrer"
										style={{ color: "var(--accent)", textDecoration: "none" }}
									>
										Secured by byok-vault
									</a>
								</p>
							</div>
						)}

						{vaultState === "locked" && !needsMigration && (
							<div style={styles.field}>
								<label style={styles.label}>Unlock API key</label>
								{isPasskeyEnrolled ? (
									<button
										onClick={handleUnlockWithPasskey}
										style={styles.saveBtn}
										disabled={reloading}
									>
										{reloading ? "Unlocking..." : "Unlock with fingerprint"}
									</button>
								) : (
									<>
										<input
											type="password"
											placeholder="Enter passphrase"
											value={passphraseInput}
											onChange={(e) => setPassphraseInput(e.target.value)}
											style={styles.input}
										/>
										<button
											onClick={handleUnlock}
											style={styles.saveBtn}
											disabled={reloading || passphraseInput.length < 8}
										>
											{reloading ? "Unlocking..." : "Unlock"}
										</button>
									</>
								)}
							</div>
						)}

						{vaultState === "unlocked" && (
							<div style={styles.field}>
								<p style={{ ...styles.hint, color: "var(--success)" }}>
									API key stored (encrypted)
								</p>
								<div style={{ display: "flex", gap: 8 }}>
									<button
										onClick={handleLock}
										style={styles.cancelBtn}
									>
										Lock
									</button>
									<button
										onClick={handleResetKeys}
										style={styles.cancelBtn}
									>
										Reset keys
									</button>
								</div>
							</div>
						)}
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
						disabled={reloading || !canSave}
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
		background: "var(--bg-card)",
		border: "2px solid var(--border)",
		padding: "6px 14px",
		borderRadius: "2px",
		cursor: "pointer",
		zIndex: 50,
		fontSize: "13px",
		color: "var(--text)",
		fontWeight: 600,
		transition: "transform 0.1s ease, box-shadow 0.1s ease, border-color 0.1s ease",
		fontFamily: "var(--font-sans)",
	},
	overlay: {
		position: "fixed",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: "rgba(0,0,0,0.7)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 100,
	},
	modal: {
		width: "400px",
		maxWidth: "90%",
		padding: "28px",
		background: "var(--bg-card)",
		borderRadius: "4px",
		border: "2px solid var(--border-accent)",
		boxShadow: "5px 5px 0 var(--accent)",
		display: "flex",
		flexDirection: "column",
		gap: "20px",
	},
	title: {
		fontSize: "20px",
		fontWeight: 800,
		margin: 0,
		fontFamily: "var(--font-display)",
		letterSpacing: "-0.02em",
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	geminiSection: {
		display: "flex",
		flexDirection: "column",
		gap: "16px",
	},
	label: {
		fontSize: "13px",
		fontWeight: 700,
		color: "var(--text-secondary)",
		textTransform: "uppercase" as const,
		letterSpacing: "0.06em",
		fontFamily: "var(--font-display)",
	},
	toggleGroup: {
		display: "flex",
		gap: "6px",
		background: "var(--bg-secondary)",
		padding: "4px",
		border: "2px solid var(--border)",
		borderRadius: "2px",
	},
	toggleBtn: {
		flex: 1,
		padding: "8px",
		borderRadius: "2px",
		border: "2px solid transparent",
		background: "transparent",
		color: "var(--text-secondary)",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 600,
		transition: "all 0.1s ease",
		fontFamily: "var(--font-sans)",
	},
	activeBtn: {
		background: "var(--accent)",
		color: "#fff",
		border: "2px solid var(--accent)",
		boxShadow: "2px 2px 0 rgba(0,0,0,0.4)",
	},
	hint: {
		fontSize: "12px",
		color: "var(--text-muted)",
		margin: 0,
		lineHeight: "1.5",
	},
	input: {
		width: "100%",
		padding: "10px 12px",
		borderRadius: "2px",
		border: "2px solid var(--border)",
		background: "var(--bg-secondary)",
		color: "var(--text-primary)",
		fontSize: "14px",
		fontFamily: "var(--font-sans)",
		outline: "none",
		transition: "border-color 0.1s ease, box-shadow 0.1s ease",
	},
	status: {
		fontSize: "13px",
		color: "var(--accent)",
		textAlign: "center" as const,
		fontFamily: "var(--font-mono)",
	},
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		gap: "10px",
		marginTop: "4px",
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
		transition: "border-color 0.1s ease",
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
		fontFamily: "var(--font-display)",
		boxShadow: "2px 2px 0 rgba(0,0,0,0.4)",
		transition: "transform 0.1s ease, box-shadow 0.1s ease",
	},
};
