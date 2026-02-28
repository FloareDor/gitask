/**
 * Gemini BYOK vault — encrypted API key storage via byok-vault.
 * Uses sessionMode: "tab" so unlock persists for the tab session.
 */

import { BYOKVault } from "byok-vault";

let vaultInstance: BYOKVault | null = null;

export function isGeminiVaultSupported(): boolean {
	if (typeof window === "undefined") return false;
	if (!window.isSecureContext) return false;
	try {
		if (!window.localStorage) return false;
	} catch {
		return false;
	}
	return !!window.crypto?.subtle;
}

/**
 * Get the singleton Gemini vault instance.
 * Safe to call on server (returns null when no window).
 */
export function getGeminiVault(): BYOKVault | null {
	if (!isGeminiVaultSupported()) return null;
	if (!vaultInstance) {
		vaultInstance = new BYOKVault({
			namespace: "gitask-gemini",
			localStorage: window.localStorage,
			sessionMode: "tab",
		});
	}
	return vaultInstance;
}
