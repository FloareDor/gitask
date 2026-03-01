import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

// Prevent static optimization - fixes 405 on Vercel production
export const dynamic = "force-dynamic";

// Initialize Gemini with server-side key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

function toGeminiErrorResponse(error: unknown) {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();

	if (
		lower.includes("api_key_invalid") ||
		lower.includes("api key not valid") ||
		lower.includes("invalid api key")
	) {
		return NextResponse.json(
			{ error: "Invalid Gemini API key. Open LLM Settings and enter a valid key.", code: "INVALID_API_KEY" },
			{ status: 401 }
		);
	}
	if (
		lower.includes("quota") ||
		lower.includes("rate limit") ||
		lower.includes("resource_exhausted") ||
		lower.includes("429")
	) {
		return NextResponse.json(
			{ error: "Gemini API rate limit or quota exceeded. Wait a moment and try again.", code: "RATE_LIMITED" },
			{ status: 429 }
		);
	}
	if (
		lower.includes("permission_denied") ||
		lower.includes("forbidden") ||
		lower.includes("403")
	) {
		return NextResponse.json(
			{ error: "Gemini API key does not have permission for this model. Check your key in LLM Settings.", code: "PERMISSION_DENIED" },
			{ status: 403 }
		);
	}
	if (
		lower.includes("service unavailable") ||
		lower.includes("503") ||
		lower.includes("overloaded")
	) {
		return NextResponse.json(
			{ error: "Gemini service is temporarily unavailable. Try again in a moment.", code: "SERVICE_UNAVAILABLE" },
			{ status: 503 }
		);
	}

	return NextResponse.json(
		{ error: "Gemini request failed. Check your API key and try again.", code: "UNKNOWN_ERROR", detail: msg },
		{ status: 500 }
	);
}

export async function GET() {
	return NextResponse.json({ status: "Gemini Proxy Online v2" });
}

export async function POST(req: Request) {
	try {
		if (!process.env.GEMINI_API_KEY) {
			return NextResponse.json(
				{ error: "Server configuration error: Missing API Key" },
				{ status: 500 }
			);
		}

		const { messages } = await req.json();

		if (!messages || !Array.isArray(messages)) {
			return NextResponse.json(
				{ error: "Invalid request body" },
				{ status: 400 }
			);
		}

		// Convert messages to Gemini format
		const systemMsg = messages.find((m: any) => m.role === "system");
		const history = messages
			.filter((m: any) => m.role !== "system")
			.map((m: any) => ({
				role: m.role === "assistant" ? "model" : "user",
				parts: [{ text: m.content }],
			}));

		const lastMsg = history.pop();
		if (!lastMsg) {
			return NextResponse.json(
				{ error: "No user message found" },
				{ status: 400 }
			);
		}

		// Fold system instruction into first user message (some models don't support systemInstruction)
		const systemPrefix = systemMsg?.content
			? `${systemMsg.content}\n\n---\n\n`
			: "";
		if (systemPrefix) {
			if (history.length > 0) {
				history[0].parts[0].text = systemPrefix + history[0].parts[0].text;
			} else {
				lastMsg.parts[0].text = systemPrefix + lastMsg.parts[0].text;
			}
		}

		// Resolve Gemini stream before returning HTTP 200 so auth/quota errors
		// can be mapped to correct HTTP status codes.
		const chat = model.startChat({ history });
		const result = await chat.sendMessageStream(lastMsg.parts[0].text);

		// Create a readable stream for the response
		const stream = new ReadableStream({
			async start(controller) {
				try {
					for await (const chunk of result.stream) {
						const text = chunk.text();
						if (text) {
							controller.enqueue(new TextEncoder().encode(text));
						}
					}
					controller.close();
				} catch (err) {
					controller.error(err);
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
			},
		});
	} catch (error) {
		console.error("Gemini Proxy Error:", error);
		return toGeminiErrorResponse(error);
	}
}

export async function OPTIONS() {
	return new NextResponse(null, {
		status: 200,
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		},
	});
}
