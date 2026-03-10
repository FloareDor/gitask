"use client";

import { useEffect, useState } from "react";
import {
	getLLMConfig,
	setLLMConfig,
	reloadLLM,
	hasLegacyApiKey,
	hasGeminiLocalApiKey,
	setGeminiLocalApiKey,
	hasGroqLocalApiKey,
	setGroqLocalApiKey,
	cancelMLCInit,
	getDownloadedMLCModels,
	deleteMLCModel,
	MLC_MODELS,
	type LLMConfig,
	type CloudStorageMode,
} from "@/lib/llm";
import { getGeminiVault, isGeminiVaultSupported } from "@/lib/gemini-vault";
import { getGroqVault, isGroqVaultSupported } from "@/lib/groq-vault";
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
	const [hasDefaultGeminiKey, setHasDefaultGeminiKey] = useState(false);
	const [hasDefaultGroqKey, setHasDefaultGroqKey] = useState(false);
	const [apiKeyInput, setApiKeyInput] = useState("");
	const [passphraseInput, setPassphraseInput] = useState("");
	const [migratePassphrase, setMigratePassphrase] = useState("");
	const [hasLocalKey, setHasLocalKey] = useState(false);
	const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
	const [deletingModel, setDeletingModel] = useState<string | null>(null);
	const [isCancelling, setIsCancelling] = useState(false);

	const vault = config.provider === "groq" ? getGroqVault() : getGeminiVault();
	const vaultState = vault?.getState() ?? "none";
	const canUseVault = vault?.canCall() ?? false;
	const vaultSupported =
		config.provider === "groq" ? isGroqVaultSupported() : isGeminiVaultSupported();
	const storageMode: CloudStorageMode =
		config.cloudStorage === "local" || config.geminiStorage === "local"
			? "local"
			: "vault";
	const bypassEnabled = storageMode === "local";
	const passkeySupported =
		typeof window !== "undefined" && createBrowserPasskeyAdapter().isSupported();
	const isPasskeyEnrolled = vault?.isPasskeyEnrolled() ?? false;
	const needsMigration =
		(config.provider === "gemini" || config.provider === "groq") &&
		storageMode === "vault" &&
		hasLegacyApiKey(config) &&
		vaultState === "none";
	const isCloudProvider = config.provider === "gemini" || config.provider === "groq";
	const activeProviderLabel = config.provider === "groq" ? "Groq" : "Gemini";
	const hasDefaultKey =
		config.provider === "groq" ? hasDefaultGroqKey : hasDefaultGeminiKey;

	useEffect(() => {
		const nextConfig = getLLMConfig();
		setConfig(nextConfig);
		setHasDefaultGeminiKey(!!process.env.NEXT_PUBLIC_HAS_GEMINI_KEY);
		setHasDefaultGroqKey(!!process.env.NEXT_PUBLIC_HAS_GROQ_KEY);
		setHasLocalKey(nextConfig.provider === "groq" ? hasGroqLocalApiKey() : hasGeminiLocalApiKey());
		setApiKeyInput("");
		setPassphraseInput("");
		setMigratePassphrase("");
		getDownloadedMLCModels().then(setDownloadedModels);
	}, [isOpen]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const openHandler = () => setIsOpen(true);
		window.addEventListener("gitask-open-llm-settings", openHandler);
		return () => window.removeEventListener("gitask-open-llm-settings", openHandler);
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		setHasLocalKey(config.provider === "groq" ? hasGroqLocalApiKey() : hasGeminiLocalApiKey());
	}, [config.provider, isOpen]);

	useEffect(() => {
		if (!isCloudProvider) return;
		if (vaultSupported || storageMode === "local") return;
		setConfig((prev) => ({ ...prev, cloudStorage: "local" }));
	}, [isCloudProvider, storageMode, vaultSupported]);

	const canSave = (() => {
		if (!isCloudProvider) return true;
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

	const handleCancelMLCInit = async () => {
		setIsCancelling(true);
		await cancelMLCInit();
		setReloading(false);
		setStatusMsg("");
		setIsCancelling(false);
	};

	const handleDeleteModel = async (modelId: string) => {
		if (!confirm(`Delete cached data for this model? You'll need to re-download it to use it.`)) return;
		setDeletingModel(modelId);
		await deleteMLCModel(modelId);
		setDownloadedModels((prev) => prev.filter((id) => id !== modelId));
		setDeletingModel(null);
	};

	const handleResetKeys = (mode: "all" | "vault" | "local" = "all") => {
		if (!confirm("Remove stored API key? You will need to re-enter it."))
			return;
		if (mode !== "local") {
			vault?.nuke();
		}
		if (mode !== "vault") {
			if (config.provider === "groq") {
				setGroqLocalApiKey(null);
			} else {
				setGeminiLocalApiKey(null);
			}
		}
		setConfig(getLLMConfig());
		setHasLocalKey(config.provider === "groq" ? hasGroqLocalApiKey() : hasGeminiLocalApiKey());
		setApiKeyInput("");
		setPassphraseInput("");
	};

	const handleSave = async () => {
		setReloading(true);
		setStatusMsg("Initializing...");
		let clearLocalKeyAfterSuccess = false;
		try {
			if (isCloudProvider) {
				if (storageMode === "local") {
					if (apiKeyInput.trim()) {
						if (config.provider === "groq") {
							setGroqLocalApiKey(apiKeyInput.trim());
							setHasLocalKey(hasGroqLocalApiKey());
						} else {
							setGeminiLocalApiKey(apiKeyInput.trim());
							setHasLocalKey(hasGeminiLocalApiKey());
						}
					}
				} else {
					clearLocalKeyAfterSuccess = true;
					if (apiKeyInput.trim() && vault) {
						if (passkeySupported) {
							await vault.setConfigWithPasskey(
								{ apiKey: apiKeyInput.trim(), provider: config.provider },
								{ rpName: "GitAsk", userName: "user" }
							);
						} else if (passphraseInput.length >= 8) {
							await vault.setConfig(
								{ apiKey: apiKeyInput.trim(), provider: config.provider },
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
				cloudStorage: storageMode,
				mlcModelId: config.mlcModelId,
			});
			await reloadLLM((msg) => setStatusMsg(msg));
			if (clearLocalKeyAfterSuccess) {
				if (config.provider === "groq") {
					setGroqLocalApiKey(null);
				} else {
					setGeminiLocalApiKey(null);
				}
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

	const dotColor =
		config.provider === "gemini"
			? "#a78bfa"
			: config.provider === "groq"
			? "#f97316"
			: "var(--success)";
	const badge =
		config.provider === "mlc"
			? "local"
			: config.provider === "groq"
			? "groq"
			: "gemini";

	return (
		<>
			{!isOpen && (
				<button
					onClick={() => setIsOpen(true)}
					style={styles.settingsBtn}
					aria-label="Model settings"
				>
					<span style={{ ...styles.dot, background: dotColor }} />
					{badge}
				</button>
			)}

			{isOpen && (
				<div
					style={styles.overlay}
					onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}
				>
					<div style={styles.sheet}>
						{/* Sheet header */}
						<div style={styles.sheetHeader}>
							<span style={styles.sheetTitle}>llm</span>
							<button
								onClick={() => setIsOpen(false)}
								style={styles.closeBtn}
								aria-label="Close"
							>
								×
							</button>
						</div>

						{/* Sheet body */}
						<div style={styles.sheetBody}>
							{/* Provider section */}
							<div style={{ marginBottom: 24 }}>
								<p style={styles.sectionLabel}>provider</p>

								<div
									style={{
										...styles.providerCard,
										...(config.provider === "mlc"
											? styles.providerCardSelected
											: styles.providerCardUnselected),
									}}
									onClick={() => setConfig({ ...config, provider: "mlc" })}
								>
									<span style={{
										...styles.dot,
										background: config.provider === "mlc" ? "var(--page-bg)" : "var(--success)",
									}} />
									local
								</div>

								<div
									style={{
										...styles.providerCard,
										...(config.provider === "gemini"
											? styles.providerCardSelected
											: styles.providerCardUnselected),
									}}
									onClick={() =>
										setConfig({
											...config,
											provider: "gemini",
											cloudStorage: storageMode === "local" ? "local" : "vault",
										})
									}
								>
									<span style={{
										...styles.dot,
										background: config.provider === "gemini" ? "var(--page-bg)" : "#a78bfa",
									}} />
									gemini
								</div>

								<div
									style={{
										...styles.providerCard,
										...(config.provider === "groq"
											? styles.providerCardSelected
											: styles.providerCardUnselected),
									}}
									onClick={() =>
										setConfig({
											...config,
											provider: "groq",
											cloudStorage: storageMode === "local" ? "local" : "vault",
										})
									}
								>
									<span style={{
										...styles.dot,
										background: config.provider === "groq" ? "var(--page-bg)" : "#f97316",
									}} />
									groq
								</div>

								<p style={styles.hint}>
									{config.provider === "mlc" ? (
										<>runs in your browser via{" "}
											<a href="https://github.com/mlc-ai/web-llm" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>web-llm</a>
											{" "}— private, offline, no API key needed</>
									) : config.provider === "groq" ? (
										"groq cloud, very fast, no download — needs your API key"
									) : (
										"google cloud, fast, no download — needs your API key"
									)}
								</p>
							</div>

							{/* Local model picker */}
							{config.provider === "mlc" && (
								<div style={{ marginBottom: 24 }}>
									<div style={styles.sectionDivider} />
									<p style={styles.sectionLabel}>local model</p>
									{MLC_MODELS.map((model) => {
										const isSelected = (config.mlcModelId ?? MLC_MODELS[0].id) === model.id;
										const isDownloaded = downloadedModels.includes(model.id);
										return (
											<div
												key={model.id}
												style={{
													...styles.mlcModelCard,
													...(isSelected ? styles.mlcModelCardSelected : styles.mlcModelCardUnselected),
												}}
												onClick={() => setConfig({ ...config, mlcModelId: model.id })}
											>
												<div style={styles.mlcModelRow}>
													<span style={{
														...styles.dot,
														background: isSelected ? "var(--page-bg)" : "var(--success)",
														flexShrink: 0,
													}} />
													<span style={styles.mlcModelName}>{model.label}</span>
													<span style={{
														...styles.mlcModelBadge,
														background: isSelected ? "rgba(255,255,255,0.15)" : "var(--page-surface)",
														color: isSelected ? "rgba(255,255,255,0.85)" : "var(--page-text-muted)",
														border: isSelected ? "1px solid rgba(255,255,255,0.2)" : "1px solid var(--page-border)",
													}}>
														{model.size}
													</span>
												</div>
												<div style={styles.mlcModelMeta}>
													<span style={{
														...styles.mlcModelMetaText,
														color: isSelected ? "rgba(255,255,255,0.5)" : "var(--page-text-dim)",
													}}>
														{model.vram} download
													</span>
													{isDownloaded && (
														<span style={{
															...styles.mlcModelMetaText,
															color: isSelected ? "rgba(134,239,172,0.9)" : "var(--success)",
															display: "flex",
															alignItems: "center",
															gap: 4,
														}}>
															<span style={{ fontSize: 7, lineHeight: 1 }}>●</span> cached
														</span>
													)}
												</div>
											</div>
										);
									})}

									{/* Manage downloaded models */}
									{downloadedModels.length > 0 && (
										<details style={{ marginTop: 16 }}>
											<summary style={styles.manageLabel}>manage downloads</summary>
											<div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
												{downloadedModels.map((id) => {
													const info = MLC_MODELS.find((m) => m.id === id);
													return (
														<div key={id} style={styles.downloadedRow}>
															<span style={styles.downloadedName}>{info?.label ?? id}</span>
															<span style={styles.downloadedSize}>{info?.vram}</span>
															<button
																style={styles.deleteBtn}
																disabled={deletingModel === id}
																onClick={() => handleDeleteModel(id)}
															>
																{deletingModel === id ? "deleting..." : "delete"}
															</button>
														</div>
													);
												})}
											</div>
										</details>
									)}
								</div>
							)}

							{/* Cloud key fields */}
							{isCloudProvider && (
								<div style={styles.cloudSection}>
									<div style={styles.sectionDivider} />

									{hasDefaultKey && (
										<p style={styles.hint}>a shared {activeProviderLabel} key is set up. add your own key for better rate limits.</p>
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
														cloudStorage: bypassEnabled ? "vault" : "local",
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
												local fallback stores your {activeProviderLabel} key in browser localStorage (less secure).
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
											<button
												onClick={handleMigrate}
												style={styles.saveBtn}
												disabled={reloading || migratePassphrase.length < 8}
											>
												{reloading ? "saving..." : "migrate"}
											</button>
										</div>
									)}

									{storageMode === "vault" && !needsMigration && vaultState === "none" && (
										<div style={styles.field}>
											<a
												href={config.provider === "groq" ? "https://console.groq.com/keys" : "https://aistudio.google.com/app/apikey"}
												target="_blank"
												rel="noopener noreferrer"
												style={styles.accentLink}
											>
												{config.provider === "groq" ? "get a Groq API key →" : "get a free API key →"}
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
											<a
												href={config.provider === "groq" ? "https://console.groq.com/keys" : "https://aistudio.google.com/app/apikey"}
												target="_blank"
												rel="noopener noreferrer"
												style={styles.accentLink}
											>
												{config.provider === "groq" ? "get a Groq API key →" : "get a free API key →"}
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
													<button onClick={() => handleResetKeys("local")} style={styles.ghostBtn}>
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
													<button
														onClick={handleUnlock}
														style={styles.saveBtn}
														disabled={reloading || passphraseInput.length < 8}
													>
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
												<button onClick={handleLock} style={styles.ghostBtn}>lock</button>
												<button onClick={() => handleResetKeys("vault")} style={styles.ghostBtn}>remove key</button>
											</div>
										</div>
									)}
								</div>
							)}

							{reloading && (
								<div style={styles.progressBlock}>
									<p style={styles.status}>{statusMsg || "Initializing..."}</p>
									{config.provider === "mlc" && (
										<button
											style={styles.cancelBtn}
											onClick={handleCancelMLCInit}
											disabled={isCancelling}
										>
											{isCancelling ? "cancelling..." : "cancel & clear download"}
										</button>
									)}
								</div>
							)}

							<div style={styles.sectionDivider} />

							<button
								onClick={handleSave}
								style={{
									...styles.saveBtn,
									...(reloading || !canSave ? { opacity: 0.5, cursor: "not-allowed" } : {}),
								}}
								disabled={reloading || !canSave}
							>
								{reloading ? "saving..." : "save"}
							</button>

							<details style={{ marginTop: 24 }}>
								<summary style={{
									fontFamily: "var(--font-mono)",
									fontSize: 12,
									cursor: "pointer",
									color: "#888",
									userSelect: "none",
									marginBottom: 12,
								}}>
									Advanced
								</summary>
								<div style={{ marginTop: 12 }}>
									<button
										onClick={() => setIsOpen(false)}
										style={styles.ghostBtn}
										disabled={reloading}
									>
										cancel
									</button>
								</div>
							</details>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

const styles: Record<string, React.CSSProperties> = {
	settingsBtn: {
		display: "inline-flex",
		alignItems: "center",
		gap: "7px",
		background: "var(--page-surface)",
		border: "1px solid var(--page-border)",
		borderRadius: 0,
		cursor: "pointer",
		padding: "6px 12px",
		fontSize: "13px",
		fontWeight: 600,
		color: "var(--page-text)",
		boxShadow: "var(--page-shadow-sm)",
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
		inset: 0,
		background: "rgba(0,0,0,0.5)",
		zIndex: 1000,
	},
	sheet: {
		position: "fixed",
		top: 0,
		right: 0,
		height: "100%",
		width: "min(560px, 100vw)",
		background: "var(--page-bg)",
		borderLeft: "2px solid var(--page-border)",
		overflowY: "auto",
		zIndex: 1001,
		display: "flex",
		flexDirection: "column",
	},
	sheetHeader: {
		padding: "20px 28px",
		borderBottom: "2px solid var(--page-border)",
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
	},
	sheetTitle: {
		fontFamily: "var(--font-display)",
		fontWeight: 800,
		fontSize: "1.2rem",
		color: "var(--page-text)",
	},
	closeBtn: {
		border: "2px solid var(--page-border)",
		background: "var(--page-surface)",
		padding: "4px 10px",
		cursor: "pointer",
		fontSize: "1rem",
		fontWeight: "bold",
		color: "var(--page-text)",
		lineHeight: 1,
	},
	sheetBody: {
		padding: "28px",
		flex: 1,
		overflowY: "auto",
	},
	sectionLabel: {
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		textTransform: "uppercase",
		letterSpacing: "0.08em",
		color: "var(--page-text-muted)",
		marginBottom: 12,
	} as React.CSSProperties,
	providerCard: {
		border: "2px solid",
		padding: "12px 16px",
		cursor: "pointer",
		display: "flex",
		alignItems: "center",
		gap: "10px",
		marginBottom: "8px",
		fontFamily: "var(--font-sans)",
		fontSize: "14px",
		fontWeight: 600,
	},
	providerCardSelected: {
		borderColor: "var(--page-text)",
		background: "var(--page-text)",
		color: "var(--page-bg)",
		boxShadow: "2px 2px 0 #16a34a",
	},
	providerCardUnselected: {
		borderColor: "var(--page-border)",
		background: "var(--page-surface)",
		color: "var(--page-text)",
	},
	cloudSection: {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
	},
	sectionDivider: {
		borderTop: "2px solid var(--page-border)",
		margin: "20px 0",
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},
	label: {
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		textTransform: "uppercase" as const,
		letterSpacing: "0.08em",
		color: "var(--page-text-muted)",
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
		border: "2px solid var(--page-border)",
		background: "var(--page-surface)",
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
		background: "var(--page-text-muted)",
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
		color: "var(--page-text-muted)",
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
		color: "var(--page-text-dim)",
		margin: 0,
		lineHeight: 1.5,
	},
	warningHint: {
		fontSize: "12px",
		color: "var(--warning)",
		margin: 0,
		lineHeight: 1.5,
	},
	accentLink: {
		fontSize: "12px",
		color: "var(--accent)",
		textDecoration: "none",
	},
	input: {
		width: "100%",
		padding: "12px 16px",
		border: "2px solid var(--page-border)",
		background: "var(--page-surface)",
		fontFamily: "var(--font-mono)",
		fontSize: "13px",
		outline: "none",
		marginBottom: "12px",
		color: "var(--page-text)",
		boxSizing: "border-box",
	},
	status: {
		fontFamily: "var(--font-mono)",
		fontSize: "12px",
		color: "var(--page-text-dim)",
		padding: "8px 12px",
		background: "var(--page-surface-alt)",
		border: "1px solid var(--page-border)",
		marginTop: "12px",
	},
	saveBtn: {
		background: "var(--page-text)",
		color: "var(--page-bg)",
		border: "2px solid var(--page-border)",
		padding: "12px 24px",
		fontWeight: 700,
		fontSize: "14px",
		cursor: "pointer",
		width: "100%",
		boxShadow: "3px 3px 0 var(--page-text)",
		fontFamily: "var(--font-display)",
	},
	ghostBtn: {
		background: "transparent",
		border: "2px solid var(--page-border)",
		padding: "8px 16px",
		fontSize: "13px",
		cursor: "pointer",
		fontWeight: 600,
		color: "var(--page-text)",
		fontFamily: "var(--font-sans)",
	},
	mlcModelCard: {
		border: "2px solid",
		padding: "12px 14px",
		cursor: "pointer",
		marginBottom: "6px",
		display: "flex",
		flexDirection: "column" as const,
		gap: 5,
		transition: "background 0.1s ease, border-color 0.1s ease",
	},
	mlcModelCardSelected: {
		borderColor: "var(--page-text)",
		background: "var(--page-text)",
		color: "var(--page-bg)",
		boxShadow: "2px 2px 0 #16a34a",
	},
	mlcModelCardUnselected: {
		borderColor: "var(--page-border)",
		background: "var(--page-surface)",
		color: "var(--page-text)",
	},
	mlcModelRow: {
		display: "flex",
		alignItems: "center",
		gap: 10,
	},
	mlcModelName: {
		flex: 1,
		fontFamily: "var(--font-sans)",
		fontSize: "14px",
		fontWeight: 600,
	},
	mlcModelBadge: {
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		padding: "2px 7px",
		flexShrink: 0,
	},
	mlcModelMeta: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		paddingLeft: 17,
	},
	mlcModelMetaText: {
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		lineHeight: 1.4,
	},
	progressBlock: {
		display: "flex",
		flexDirection: "column" as const,
		gap: 8,
		marginTop: 12,
	},
	cancelBtn: {
		background: "transparent",
		border: "2px solid var(--page-border)",
		padding: "8px 16px",
		fontSize: "12px",
		cursor: "pointer",
		fontWeight: 600,
		color: "var(--page-text-muted)",
		fontFamily: "var(--font-mono)",
		width: "100%",
		textAlign: "center" as const,
		letterSpacing: "0.03em",
	},
	manageLabel: {
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		cursor: "pointer",
		color: "var(--page-text-muted)",
		userSelect: "none" as const,
		letterSpacing: "0.06em",
		textTransform: "uppercase" as const,
	},
	downloadedRow: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "8px 10px",
		background: "var(--page-surface)",
		border: "1px solid var(--page-border)",
	},
	downloadedName: {
		flex: 1,
		fontFamily: "var(--font-sans)",
		fontSize: "13px",
		fontWeight: 600,
		color: "var(--page-text)",
	},
	downloadedSize: {
		fontFamily: "var(--font-mono)",
		fontSize: "11px",
		color: "var(--page-text-muted)",
		flexShrink: 0,
	},
	deleteBtn: {
		background: "transparent",
		border: "1px solid var(--page-border)",
		padding: "4px 10px",
		fontSize: "11px",
		cursor: "pointer",
		fontWeight: 600,
		color: "var(--page-text-muted)",
		fontFamily: "var(--font-mono)",
		flexShrink: 0,
	},
};
