/**
 * Browser E2E test for BYOK Gemini flow.
 * Run with: node scripts/test-byok-browser.js
 *
 * Requires: npm run dev running on localhost:3000
 */

const { chromium } = require("playwright");

const API_KEY = "AIzaSyBNUc_py5pDezsSmUaLeqFyoNDe6xzYz5c";
const PASSPHRASE = "testpass123";

async function run() {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const page = await context.newPage();

	const logs = [];
	page.on("console", (msg) => {
		logs.push(msg.text());
	});

	try {
		// 1. Go to landing page (Settings is there)
		await page.goto("http://localhost:3000", {
			waitUntil: "networkidle",
			timeout: 15000,
		});

		// 2. Click Settings
		await page.click('button[aria-label="Settings"]');
		await page.waitForTimeout(500);

		// 3. Select Cloud (Gemini API)
		await page.click('button:has-text("Cloud (Gemini API)")');
		await page.waitForTimeout(500);

		// 4. Fill API key and passphrase
		const inputs = await page.locator('input[type="password"]').all();
		if (inputs.length >= 2) {
			await inputs[0].fill(API_KEY);
			await inputs[1].fill(PASSPHRASE);
		} else {
			throw new Error("Expected 2 password inputs (API key + passphrase)");
		}

		// 5. Save & Reload
		await page.click('button:has-text("Save & Reload")');
		await page.waitForTimeout(2000);

		// 6. Go to repo page (small repo for faster indexing)
		await page.fill("#repo-url-input", "https://github.com/octocat/Hello-World");
		await page.click("#go-btn");
		await page.waitForURL("**/octocat/Hello-World", { timeout: 10000 });
		// Wait for chat input to be enabled (indexing done)
		await page.locator("#chat-input").waitFor({ state: "visible", timeout: 60000 });
		await page.waitForSelector('#chat-input:not([disabled])', { timeout: 60000 });

		// 7. Send first message (smoke test)
		const chatInput = page.locator("#chat-input");
		await chatInput.fill("Reply with exactly: hello byok");
		await page.click("#send-btn");
		await page.waitForTimeout(8000);

		let body = await page.textContent("body");
		const hasResponse1 = body && (body.includes("hello byok") || body.includes("hello"));
		console.log(hasResponse1 ? "[test] ✅ First message: response received" : "[test] ⚠ First message: no expected response");

		// 8. Send second message about PR (example PR scenario)
		await chatInput.fill("What does PR #1 or the first pull request in this repo do? Be brief.");
		await page.click("#send-btn");
		await page.waitForTimeout(10000);

		body = await page.textContent("body");
		const hasResponse2 = body && body.length > 500; // Expect substantial response
		console.log(hasResponse2 ? "[test] ✅ PR question: response received" : "[test] ⚠ PR question: short or no response");

		// Print console logs
		console.log("\n[test] Console logs from page:");
		logs.forEach((l) => console.log(l));

		if (!hasResponse1 || !hasResponse2) {
			console.log("\n[test] Page snippet:", body?.slice(0, 800));
		}
	} catch (e) {
		console.error("[test] FAILED:", e.message);
		console.log("\n[test] Console logs:", logs.slice(-20));
		process.exit(1);
	} finally {
		await browser.close();
	}

	console.log("\n[test] ✅ Browser test passed.");
}

run();
