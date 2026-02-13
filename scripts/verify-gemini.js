
require('dotenv').config({ path: '.env.local' });
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function verifyGemini() {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.error('Error: GEMINI_API_KEY not found in .env.local');
		process.exit(1);
	}

	console.log('Found GEMINI_API_KEY, testing...');
	const genAI = new GoogleGenerativeAI(apiKey);
	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

	try {
		const result = await model.generateContent("Hello, are you working?");
		const response = await result.response;
		const text = response.text();
		console.log('Gemini API Response:', text);
		console.log('SUCCESS: Gemini API key is working!');
	} catch (error) {
		console.error('ERROR: Gemini API key check failed:', error.message);
		process.exit(1);
	}
}

verifyGemini();
