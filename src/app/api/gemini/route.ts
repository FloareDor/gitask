
import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

// Initialize Gemini with server-side key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

export async function GET() {
	return NextResponse.json({ status: "Gemini Proxy Online" });
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

		// Create a readable stream for the response
		const stream = new ReadableStream({
			async start(controller) {
				try {
					const chat = model.startChat({
						systemInstruction: systemMsg?.content,
						history,
					});

					const result = await chat.sendMessageStream(lastMsg.parts[0].text);

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
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 }
		);
	}
}
