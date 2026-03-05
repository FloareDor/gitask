import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

// Prevent static optimization - fixes 405 on Vercel production
export const dynamic = "force-dynamic";

// Initialize Gemini with server-side key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

interface GeminiErrorPayload {
	error: string;
	code: string;
	status: number;
	detail?: string;
}

type GeminiTurn = {
	role: "user" | "model";
	parts: Array<{ text: string }>;
};

function classifyGeminiError(error: unknown): GeminiErrorPayload {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();

	if (
		lower.includes("api_key_invalid") ||
		lower.includes("api key not valid") ||
		lower.includes("invalid api key")
	) {
		return {
			error: "Invalid Gemini API key. Open LLM Settings and enter a valid key.",
			code: "INVALID_API_KEY",
			status: 401,
		};
	}
	if (
		lower.includes("quota") ||
		lower.includes("rate limit") ||
		lower.includes("resource_exhausted") ||
		lower.includes("429")
	) {
		return {
			error: "Gemini API rate limit or quota exceeded. Wait a moment and try again.",
			code: "RATE_LIMITED",
			status: 429,
		};
	}
	if (
		lower.includes("permission_denied") ||
		lower.includes("forbidden") ||
		lower.includes("403")
	) {
		return {
			error: "Gemini API key does not have permission for this model. Check your key in LLM Settings.",
			code: "PERMISSION_DENIED",
			status: 403,
		};
	}
	if (
		lower.includes("service unavailable") ||
		lower.includes("503") ||
		lower.includes("overloaded")
	) {
		return {
			error: "Gemini service is temporarily unavailable. Try again in a moment.",
			code: "SERVICE_UNAVAILABLE",
			status: 503,
		};
	}

	return {
		error: "Gemini request failed. Check your API key and try again.",
		code: "UNKNOWN_ERROR",
		status: 500,
		detail: msg,
	};
}

function toGeminiErrorResponse(error: unknown) {
	const mapped = classifyGeminiError(error);
	return NextResponse.json(
		{
			error: mapped.error,
			code: mapped.code,
			detail: mapped.detail,
		},
		{ status: mapped.status }
	);
}

function normalizeGeminiHistory(history: GeminiTurn[]): GeminiTurn[] {
	const normalized: GeminiTurn[] = [];
	for (const turn of history) {
		const text = turn.parts?.[0]?.text ?? "";
		if (!text.trim()) continue;
		const prev = normalized[normalized.length - 1];
		if (prev && prev.role === turn.role) {
			prev.parts[0].text = `${prev.parts[0].text}\n\n${text}`;
			continue;
		}
		normalized.push({
			role: turn.role,
			parts: [{ text }],
		});
	}

	// Gemini requires user-first history.
	while (normalized.length > 0 && normalized[0].role !== "user") {
		normalized.shift();
	}
	// Prompt must be user turn; remove trailing model turns.
	while (normalized.length > 0 && normalized[normalized.length - 1].role !== "user") {
		normalized.pop();
	}
	return normalized;
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

		const { messages, safetyMeta } = await req.json();

		if (!messages || !Array.isArray(messages)) {
			return NextResponse.json(
				{ error: "Invalid request body" },
				{ status: 400 }
			);
		}
		if (safetyMeta && typeof safetyMeta === "object" && safetyMeta.blocked === true) {
			return NextResponse.json(
				{ error: "Request blocked by client safety policy." },
				{ status: 400 }
			);
		}

		// Convert messages to Gemini format
		const systemMsg = messages.find((m: any) => m.role === "system");
		const rawHistory: GeminiTurn[] = messages
			.filter((m: any) => m.role !== "system")
			.map((m: any) => ({
				role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
				parts: [{ text: typeof m.content === "string" ? m.content : "" }],
			}));
		const history = normalizeGeminiHistory(rawHistory);

		const lastMsg = history.pop();
		if (!lastMsg || lastMsg.role !== "user") {
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
			const firstUser = history.find((turn) => turn.role === "user");
			if (firstUser) {
				firstUser.parts[0].text = systemPrefix + firstUser.parts[0].text;
			} else {
				lastMsg.parts[0].text = systemPrefix + lastMsg.parts[0].text;
			}
		}

		// Resolve Gemini stream before returning HTTP 200 so auth/quota errors
		// can be mapped to correct HTTP status codes.
		const chat = model.startChat({ history });
		const result = await chat.sendMessageStream(lastMsg.parts[0].text);

		// Create a readable stream for the response
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				try {
					for await (const chunk of result.stream) {
						const text = chunk.text();
						if (text) {
							controller.enqueue(
								encoder.encode(
									`${JSON.stringify({ type: "chunk", text })}\n`
								)
							);
						}
					}
					controller.close();
				} catch (err) {
					const mapped = classifyGeminiError(err);
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({
								type: "error",
								code: mapped.code,
								message: mapped.error,
								detail: mapped.detail,
							})}\n`
						)
					);
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson; charset=utf-8",
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
