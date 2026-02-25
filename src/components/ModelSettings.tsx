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
				<span style={styles.settingsBtnIcon}>⚙</span>
				<span style={styles.settingsBtnSep} />
				<span style={styles.settingsBtnLabel}>
					{isGemini ? "CLOUD" : "LOCAL"}
				</span>
				<span style={{
					...styles.settingsBtnDot,
					background: isGemini ? "#a78bfa" : "var(--success)",
				}} />
			</button>
		);
	}

	return (
		<div style={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}>
			<div style={styles.modal}>
				{/* Modal header */}
				<div style={styles.modalHeader}>
					<div style={styles.modalHeaderLeft}>
						<span style={styles.modalHeaderIcon}>⚙</span>
						<div>
							<div style={styles.modalHeaderTitle}>Model Settings</div>
							<div style={styles.modalHeaderSub}>inference · encryption · provider</div>
						</div>
					</div>
					<button
						onClick={() => setIsOpen(false)}
						style={styles.closeBtn}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				{/* Provider picker — two large cards */}
				<div style={styles.providerRow}>
					{[
						{
							id: "mlc" as const,
							label: "LOCAL",
							sublabel: "MLC WebGPU",
							icon: "🖥",
							desc: "Runs privately in your browser. ~4GB VRAM. Downloads model once.",
						},
						{
							id: "gemini" as const,
							label: "CLOUD",
							sublabel: "Gemini 2.5 Flash",
							icon: "☁",
							desc: "Google Cloud inference. Fast, no download. Needs API key.",
						},
					].map((p) => {
						const active = config.provider === p.id;
						return (
							<button
								key={p.id}
								style={{
									...styles.providerCard,
									...(active ? styles.providerCardActive : {}),
								}}
								onClick={() => setConfig({ ...config, provider: p.id })}
							>
								<span style={styles.providerCardIcon}>{p.icon}</span>
								<span style={styles.providerCardLabel}>{p.label}</span>
								<span style={styles.providerCardSub}>{p.sublabel}</span>
								<span style={styles.providerCardDesc}>{p.desc}</span>
								{active && <span style={styles.providerCardTick}>✓</span>}
							</button>
						);
					})}
				</div>

				{/* Gemini-specific fields */}
				{config.provider === "gemini" && (
					<div style={styles.geminiSection}>
						<div style={styles.sectionDivider}>
							<span style={styles.sectionDividerLabel}>API KEY VAULT</span>
						</div>

						{hasDefaultKey && (
							<p style={styles.hint}>
								A shared key is available. Your own key gives higher rate limits and keeps requests private.
							</p>
						)}

						{needsMigration && (
							<div style={styles.field}>
								<label style={styles.label}>Migrate existing key (one-time)</label>
								<input
									type="password"
									placeholder="Passphrase (min 8 chars) to secure key"
									value={migratePassphrase}
									onChange={(e) => setMigratePassphrase(e.target.value)}
									style={styles.input}
								/>
								<button
									onClick={handleMigrate}
									style={styles.saveBtn}
									disabled={reloading || migratePassphrase.length < 8}
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
									style={styles.accentLink}
								>
									Get a free Gemini API key →
								</a>
								<input
									type="password"
									placeholder="Paste Gemini API key"
									value={apiKeyInput}
									onChange={(e) => setApiKeyInput(e.target.value)}
									style={styles.input}
								/>
								{passkeySupported ? (
									<p style={styles.hint}>🔑 Will be secured with fingerprint / passkey</p>
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
									Encrypted in-browser. Never sent to any server.{" "}
									<a
										href="https://www.npmjs.com/package/byok-vault"
										target="_blank"
										rel="noopener noreferrer"
										style={{ color: "var(--accent)", textDecoration: "none" }}
									>
										byok-vault
									</a>
								</p>
							</div>
						)}

						{vaultState === "locked" && !needsMigration && (
							<div style={styles.field}>
								<label style={styles.label}>Unlock vault</label>
								{isPasskeyEnrolled ? (
									<button onClick={handleUnlockWithPasskey} style={styles.saveBtn} disabled={reloading}>
										{reloading ? "Unlocking..." : "🔑 Unlock with fingerprint"}
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
										<button onClick={handleUnlock} style={styles.saveBtn} disabled={reloading || passphraseInput.length < 8}>
											{reloading ? "Unlocking..." : "Unlock"}
										</button>
									</>
								)}
							</div>
						)}

						{vaultState === "unlocked" && (
							<div style={styles.field}>
								<p style={{ ...styles.hint, color: "var(--success)", fontWeight: 600 }}>
									✓ API key stored &amp; encrypted
								</p>
								<div style={{ display: "flex", gap: 8 }}>
									<button onClick={handleLock} style={styles.cancelBtn}>Lock</button>
									<button onClick={handleResetKeys} style={styles.cancelBtn}>Reset keys</button>
								</div>
							</div>
						)}
					</div>
				)}

				{/* Status message */}
				{reloading && (
					<div style={styles.status}>
						<span style={styles.statusDot} className="pulse" />
						{statusMsg}
					</div>
				)}

				{/* Footer actions */}
				<div style={styles.actions}>
					<button onClick={() => setIsOpen(false)} style={styles.cancelBtn} disabled={reloading}>
						Cancel
					</button>
					<button onClick={handleSave} style={styles.saveBtn} disabled={reloading || !canSave}>
						{reloading ? "Saving..." : "Save & Reload"}
					</button>
				</div>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	/* ── Trigger button ── */
	settingsBtn: {
		display: "inline-flex",
		alignItems: "center",
		gap: 0,
		background: "var(--bg-card)",
		border: "2px solid var(--border)",
		borderRadius: "3px",
		cursor: "pointer",
		padding: 0,
		overflow: "hidden",
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		fontWeight: 700,
		color: "var(--text-primary)",
		boxShadow: "2px 2px 0 var(--accent)",
		transition: "transform 0.1s ease, box-shadow 0.1s ease",
		letterSpacing: "0.05em",
	},
	settingsBtnIcon: {
		padding: "6px 9px",
		background: "var(--accent)",
		color: "#fff",
		fontSize: "13px",
		lineHeight: 1,
		display: "flex",
		alignItems: "center",
	},
	settingsBtnSep: {
		width: "2px",
		alignSelf: "stretch",
		background: "var(--border)",
		flexShrink: 0,
	},
	settingsBtnLabel: {
		padding: "6px 8px",
		letterSpacing: "0.08em",
	},
	settingsBtnDot: {
		width: "6px",
		height: "6px",
		borderRadius: "50%",
		marginRight: "8px",
		flexShrink: 0,
	},

	/* ── Overlay ── */
	overlay: {
		position: "fixed",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: "rgba(0,0,0,0.75)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 100,
	},

	/* ── Modal panel ── */
	modal: {
		width: "440px",
		maxWidth: "94vw",
		background: "var(--bg-card)",
		border: "2px solid var(--border-accent)",
		borderRadius: "4px",
		boxShadow: "6px 6px 0 var(--accent)",
		display: "flex",
		flexDirection: "column",
		overflow: "hidden",
	},

	/* ── Modal header bar ── */
	modalHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "14px 18px",
		background: "var(--bg-secondary)",
		borderBottom: "2px solid var(--border)",
	},
	modalHeaderLeft: {
		display: "flex",
		alignItems: "center",
		gap: "12px",
	},
	modalHeaderIcon: {
		fontSize: "22px",
		lineHeight: 1,
		color: "var(--accent)",
	},
	modalHeaderTitle: {
		fontSize: "15px",
		fontWeight: 800,
		fontFamily: "var(--font-display)",
		letterSpacing: "-0.01em",
		color: "var(--text-primary)",
		lineHeight: 1.2,
	},
	modalHeaderSub: {
		fontSize: "10px",
		fontFamily: "var(--font-mono)",
		color: "var(--text-muted)",
		letterSpacing: "0.08em",
		textTransform: "uppercase" as const,
		marginTop: "2px",
	},
	closeBtn: {
		background: "transparent",
		border: "2px solid var(--border)",
		borderRadius: "2px",
		color: "var(--text-muted)",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 700,
		width: "30px",
		height: "30px",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		flexShrink: 0,
		fontFamily: "var(--font-mono)",
		transition: "border-color 0.1s ease, color 0.1s ease",
	},

	/* ── Provider picker ── */
	providerRow: {
		display: "flex",
		gap: "0",
		padding: "16px",
		paddingBottom: "0",
	},
	providerCard: {
		flex: 1,
		display: "flex",
		flexDirection: "column" as const,
		alignItems: "flex-start",
		gap: "4px",
		padding: "14px 14px 16px",
		background: "var(--bg-secondary)",
		border: "2px solid var(--border)",
		borderRadius: "2px",
		cursor: "pointer",
		textAlign: "left" as const,
		position: "relative" as const,
		transition: "border-color 0.1s ease, box-shadow 0.1s ease",
		margin: "2px",
	},
	providerCardActive: {
		border: "2px solid var(--accent)",
		boxShadow: "3px 3px 0 var(--accent)",
		background: "rgba(99,102,241,0.06)",
	},
	providerCardIcon: {
		fontSize: "20px",
		lineHeight: 1,
		marginBottom: "4px",
	},
	providerCardLabel: {
		fontSize: "12px",
		fontWeight: 800,
		fontFamily: "var(--font-mono)",
		letterSpacing: "0.1em",
		color: "var(--text-primary)",
	},
	providerCardSub: {
		fontSize: "11px",
		fontWeight: 600,
		color: "var(--accent)",
		fontFamily: "var(--font-mono)",
	},
	providerCardDesc: {
		fontSize: "11px",
		color: "var(--text-muted)",
		lineHeight: 1.4,
		marginTop: "4px",
	},
	providerCardTick: {
		position: "absolute" as const,
		top: "10px",
		right: "10px",
		fontSize: "12px",
		color: "var(--accent)",
		fontWeight: 800,
	},

	/* ── Gemini section ── */
	geminiSection: {
		display: "flex",
		flexDirection: "column",
		gap: "12px",
		padding: "16px",
		paddingTop: "12px",
	},
	sectionDivider: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		margin: "4px 0",
	},
	sectionDividerLabel: {
		fontSize: "10px",
		fontWeight: 700,
		fontFamily: "var(--font-mono)",
		letterSpacing: "0.12em",
		color: "var(--text-muted)",
	},

	field: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	label: {
		fontSize: "10px",
		fontWeight: 700,
		color: "var(--text-secondary)",
		textTransform: "uppercase" as const,
		letterSpacing: "0.1em",
		fontFamily: "var(--font-mono)",
	},
	accentLink: {
		fontSize: "12px",
		color: "var(--accent)",
		textDecoration: "none",
		fontFamily: "var(--font-mono)",
		fontWeight: 600,
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
		background: "var(--bg-primary)",
		color: "var(--text-primary)",
		fontSize: "13px",
		fontFamily: "var(--font-mono)",
		outline: "none",
		transition: "border-color 0.1s ease, box-shadow 0.1s ease",
	},

	/* ── Status bar ── */
	status: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		fontSize: "12px",
		color: "var(--accent)",
		fontFamily: "var(--font-mono)",
		padding: "10px 16px",
		background: "rgba(99,102,241,0.07)",
		borderTop: "2px solid rgba(99,102,241,0.2)",
	},
	statusDot: {
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		background: "var(--accent)",
		flexShrink: 0,
		display: "inline-block",
	},

	/* ── Footer ── */
	actions: {
		display: "flex",
		justifyContent: "flex-end",
		gap: "8px",
		padding: "14px 16px",
		borderTop: "2px solid var(--border)",
		background: "var(--bg-secondary)",
	},
	cancelBtn: {
		background: "transparent",
		border: "2px solid var(--border)",
		borderRadius: "2px",
		color: "var(--text-secondary)",
		cursor: "pointer",
		fontSize: "12px",
		fontWeight: 700,
		padding: "7px 14px",
		fontFamily: "var(--font-mono)",
		letterSpacing: "0.04em",
		transition: "border-color 0.1s ease",
	},
	saveBtn: {
		background: "var(--accent)",
		color: "white",
		border: "2px solid var(--accent)",
		borderRadius: "2px",
		padding: "7px 16px",
		cursor: "pointer",
		fontSize: "12px",
		fontWeight: 700,
		fontFamily: "var(--font-mono)",
		letterSpacing: "0.04em",
		boxShadow: "2px 2px 0 rgba(0,0,0,0.4)",
		transition: "transform 0.1s ease, box-shadow 0.1s ease",
	},
};
