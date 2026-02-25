/**
 * Test byok-vault with user-provided Gemini key.
 * Run with: GEMINI_API_KEY=your_key node scripts/test-byok-vault.js
 */

const USER_API_KEY = process.env.GEMINI_API_KEY;
const PASSPHRASE = process.env.BYOK_PASSPHRASE || "testpass123";

if (!USER_API_KEY) {
	console.error("Set GEMINI_API_KEY in the environment to run this test.");
	process.exit(1);
}

async function testInNode() {
	// Minimal localStorage mock for Node
	const store = {};
	const mockStorage = {
		getItem: (k) => store[k] ?? null,
		setItem: (k, v) => {
			store[k] = String(v);
		},
		removeItem: (k) => delete store[k],
		clear: () => Object.keys(store).forEach((k) => delete store[k]),
		length: 0,
		key: () => null,
	};

	let BYOKVault;
	try {
		const mod = await import("byok-vault");
		BYOKVault = mod.BYOKVault;
	} catch (e) {
		console.error("Failed to import byok-vault:", e.message);
		process.exit(1);
	}

	const vault = new BYOKVault({
		namespace: "test-gitask",
		localStorage: mockStorage,
		sessionStorage: mockStorage,
	});

	console.log("[byok] 1. hasStoredKey (initial):", vault.hasStoredKey());

	try {
		await vault.setConfig(
			{ apiKey: USER_API_KEY, provider: "gemini" },
			PASSPHRASE
		);
		console.log("[byok] 2. setConfig: OK");
	} catch (e) {
		console.error("[byok] 2. setConfig FAILED:", e.message);
		process.exit(1);
	}

	console.log("[byok] 3. hasStoredKey (after set):", vault.hasStoredKey());
	console.log("[byok] 4. isLocked:", vault.isLocked());

	let retrieved = null;
	try {
		await vault.withKey(async (key) => {
			retrieved = key;
		});
		console.log(
			"[byok] 5. withKey: OK, key matches:",
			retrieved === USER_API_KEY
		);
	} catch (e) {
		console.error("[byok] 5. withKey FAILED:", e.message);
		process.exit(1);
	}

	// Test real Gemini API call using key from vault
	console.log("[byok] 6. Testing Gemini API call via vault.withKey...");
	try {
		await vault.withKey(async (apiKey) => {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: "Reply with exactly: hello byok" }] }],
				}),
			});
			const json = await res.json();
			const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
			if (text) {
				console.log("[byok] 6. Gemini response:", text);
			} else {
				console.error("[byok] 6. Gemini error:", JSON.stringify(json).slice(0, 200));
			}
		});
	} catch (e) {
		console.error("[byok] 6. Gemini API FAILED:", e.message);
	}

	vault.lock();
	console.log("[byok] 7. After lock, isLocked:", vault.isLocked());

	try {
		await vault.unlock(PASSPHRASE);
		console.log("[byok] 8. unlock: OK");
	} catch (e) {
		console.error("[byok] 8. unlock FAILED:", e.message);
		process.exit(1);
	}

	retrieved = null;
	await vault.withKey(async (key) => {
		retrieved = key;
	});
	console.log("[byok] 9. After unlock, withKey works:", retrieved === USER_API_KEY);

	vault.nuke();
	console.log("[byok] 10. After nuke, hasStoredKey:", vault.hasStoredKey());

	console.log("\n[byok] ✅ All tests passed.");
}

testInNode().catch((e) => {
	console.error(e);
	process.exit(1);
});
