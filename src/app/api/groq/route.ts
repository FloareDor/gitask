import { NextResponse } from "next/server";

// Prevent static optimization - fixes 405 on Vercel production
export const dynamic = "force-dynamic";

interface GroqErrorPayload {
	error: string;
	code: string;
	status: number;
	detail?: string;
}

function classifyGroqError(error: unknown): GroqErrorPayload {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();

	if (
		lower.includes("invalid api key") ||
		lower.includes("invalid_api_key") ||
		lower.includes("authentication") ||
		lower.includes("unauthorized")
	) {
		return {
			error: "Invalid Groq API key. Open LLM Settings and enter a valid key.",
			code: "INVALID_API_KEY",
			status: 401,
		};
	}
	if (
		lower.includes("quota") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("429")
	) {
		return {
			error: "Groq API rate limit or quota exceeded. Wait a moment and try again.",
			code: "RATE_LIMITED",
			status: 429,
		};
	}
	if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("403")) {
		return {
			error: "Groq API key does not have permission for this model. Check your key in LLM Settings.",
			code: "PERMISSION_DENIED",
			status: 403,
		};
	}
	if (lower.includes("service unavailable") || lower.includes("503") || lower.includes("overloaded")) {
		return {
			error: "Groq service is temporarily unavailable. Try again in a moment.",
			code: "SERVICE_UNAVAILABLE",
			status: 503,
		};
	}

	return {
		error: "Groq request failed. Check your API key and try again.",
		code: "UNKNOWN_ERROR",
		status: 500,
		detail: msg,
	};
}

function toGroqErrorResponse(error: unknown) {
	const mapped = classifyGroqError(error);
	return NextResponse.json(
		{
			error: mapped.error,
			code: mapped.code,
			detail: mapped.detail,
		},
		{ status: mapped.status }
	);
}

export async function GET() {
	return NextResponse.json({ status: "Groq Proxy Online v1" });
}

export async function POST(req: Request) {
	try {
		if (!process.env.GROQ_API_KEY) {
			return NextResponse.json(
				{ error: "Server configuration error: Missing GROQ_API_KEY" },
				{ status: 500 }
			);
		}

		const { messages } = await req.json();
		if (!messages || !Array.isArray(messages)) {
			return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
		}

		const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
			},
			body: JSON.stringify({
				model: "llama-3.3-70b-versatile",
				messages,
				stream: true,
				stream_options: { include_usage: true },
				temperature: 0.2,
			}),
		});

		if (!groqRes.ok) {
			let detail = groqRes.statusText;
			try {
				const payload = await groqRes.json();
				if (payload?.error?.message) detail = String(payload.error.message);
			} catch {
				// ignore
			}
			return toGroqErrorResponse(new Error(`Groq API request failed (${groqRes.status}): ${detail}`));
		}

		if (!groqRes.body) {
			return NextResponse.json({ error: "No response body from Groq" }, { status: 502 });
		}

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const reader = groqRes.body.getReader();
		const stream = new ReadableStream({
			async start(controller) {
				let buffer = "";
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							buffer += decoder.decode();
							break;
						}
						buffer += decoder.decode(value, { stream: true });

						const frames = buffer.split("\n\n");
						buffer = frames.pop() ?? "";
						for (const frame of frames) {
							for (const rawLine of frame.split("\n")) {
								const line = rawLine.trim();
								if (!line.startsWith("data:")) continue;
								const payload = line.slice(5).trim();
								if (!payload || payload === "[DONE]") continue;
								const data = JSON.parse(payload) as {
									error?: { message?: string };
									choices?: Array<{ delta?: { content?: string } }>;
								};
								if (data.error?.message) {
									throw new Error(data.error.message);
								}
								const text = data.choices?.[0]?.delta?.content;
								if (text) {
									controller.enqueue(
										encoder.encode(`${JSON.stringify({ type: "chunk", text })}\n`)
									);
								}
							}
						}
					}

					const trailing = buffer.trim();
					if (trailing.length > 0) {
						for (const rawLine of trailing.split("\n")) {
							const line = rawLine.trim();
							if (!line.startsWith("data:")) continue;
							const payload = line.slice(5).trim();
							if (!payload || payload === "[DONE]") continue;
							const data = JSON.parse(payload) as {
								choices?: Array<{ delta?: { content?: string } }>;
							};
							const text = data.choices?.[0]?.delta?.content;
							if (text) {
								controller.enqueue(
									encoder.encode(`${JSON.stringify({ type: "chunk", text })}\n`)
								);
							}
						}
					}

					controller.close();
				} catch (err) {
					const mapped = classifyGroqError(err);
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
		console.error("Groq Proxy Error:", error);
		return toGroqErrorResponse(error);
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
