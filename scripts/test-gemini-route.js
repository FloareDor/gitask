/**
 * Tests the Next.js /api/gemini route (uses GEMINI_API_KEY from server env).
 * Run with: node scripts/test-gemini-route.js
 * Requires the app to be running (npm run dev or npm run start) and GEMINI_API_KEY set in .env.
 */

const BASE = process.env.API_BASE || 'http://localhost:3000';

async function testGeminiRoute() {
	console.log('Testing Gemini API route at', BASE);

	// 1. GET health
	const getRes = await fetch(`${BASE}/api/gemini`);
	if (!getRes.ok) {
		throw new Error(`GET /api/gemini failed: ${getRes.status}`);
	}
	const getJson = await getRes.json();
	console.log('GET /api/gemini:', getJson);

	// 2. POST chat (streaming)
	const postRes = await fetch(`${BASE}/api/gemini`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			messages: [
				{ role: 'user', content: 'Reply with exactly: API_OK' }
			]
		})
	});
	if (!postRes.ok) {
		const err = await postRes.text();
		throw new Error(`POST /api/gemini failed: ${postRes.status} ${err}`);
	}
	if (!postRes.body) throw new Error('No response body');
	const reader = postRes.body.getReader();
	const decoder = new TextDecoder();
	let full = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		full += decoder.decode(value, { stream: true });
	}
	console.log('POST /api/gemini (streamed):', full.slice(0, 200) + (full.length > 200 ? '...' : ''));
	if (!full || full.length < 2) throw new Error('Empty or too short response');
	console.log('SUCCESS: Gemini route returns streamed text.');
}

testGeminiRoute().catch(err => {
	console.error('FAIL:', err.message);
	process.exit(1);
});
