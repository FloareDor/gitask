export type ChatProvider = "mlc" | "gemini" | "groq";

export type ProviderChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type GeminiTurn = {
	role: "user" | "model";
	parts: Array<{ text: string }>;
};

export function getChatHistoryLimit(provider: ChatProvider): number {
	return provider === "gemini" || provider === "groq" ? 10 : 6;
}

export function buildChatRequestMessages({
	provider,
	systemPrompt,
	priorMessages,
	userMessage,
}: {
	provider: ChatProvider;
	systemPrompt: string;
	priorMessages: Array<{ role: "user" | "assistant"; content: string }>;
	userMessage: string;
}): ProviderChatMessage[] {
	const recentHistory = priorMessages.slice(-getChatHistoryLimit(provider));
	return [
		{ role: "system", content: systemPrompt },
		...recentHistory.map((message) => ({
			role: message.role,
			content: message.content,
		})),
		{ role: "user", content: userMessage },
	];
}

export function normalizeGeminiHistory(history: GeminiTurn[]): GeminiTurn[] {
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

	while (normalized.length > 0 && normalized[0].role !== "user") {
		normalized.shift();
	}
	while (normalized.length > 0 && normalized[normalized.length - 1].role !== "user") {
		normalized.pop();
	}
	return normalized;
}

export function prepareGeminiChat(messages: ProviderChatMessage[]): {
	history: GeminiTurn[];
	prompt: string;
} {
	const systemMsg = messages.find((message) => message.role === "system");
	const rawHistory: GeminiTurn[] = messages
		.filter((message) => message.role !== "system")
		.map((message) => ({
			role: (message.role === "assistant" ? "model" : "user") as "user" | "model",
			parts: [{ text: message.content }],
		}));
	const history = normalizeGeminiHistory(rawHistory);
	const lastTurn = history.pop();

	if (!lastTurn || lastTurn.role !== "user") {
		throw new Error("No valid user prompt found for Gemini request.");
	}

	const systemPrefix = systemMsg?.content
		? `${systemMsg.content}\n\n---\n\n`
		: "";
	if (systemPrefix) {
		const firstUser = history.find((turn) => turn.role === "user");
		if (firstUser) {
			firstUser.parts[0].text = systemPrefix + firstUser.parts[0].text;
		} else {
			lastTurn.parts[0].text = systemPrefix + lastTurn.parts[0].text;
		}
	}

	return {
		history,
		prompt: lastTurn.parts[0].text,
	};
}
