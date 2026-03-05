/**
 * Groq BYOK vault — encrypted API key storage via byok-vault.
 * Uses sessionMode: "tab" so unlock persists for the tab session.
 */

import { BYOKVault } from "byok-vault";

let vaultInstance: BYOKVault | null = null;

export function isGroqVaultSupported(): boolean {
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
 * Get the singleton Groq vault instance.
 * Safe to call on server (returns null when no window).
 */
export function getGroqVault(): BYOKVault | null {
	if (!isGroqVaultSupported()) return null;
	if (!vaultInstance) {
		vaultInstance = new BYOKVault({
			namespace: "gitask-groq",
			localStorage: window.localStorage,
			sessionMode: "tab",
		});
	}
	return vaultInstance;
}
