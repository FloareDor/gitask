export interface MessageRetrievalState {
	/** All query variants searched — first is original, rest are LLM-generated. */
	variants: string[];
	/** Refined query from the sufficiency check second pass, if triggered. */
	refinedQuery?: string;
	/** Active loading phase — only present while retrieval is in progress. */
	loadingPhase?: string;
	/** How many variant searches have completed (for per-row progress animation). */
	completedCount?: number;
}

export interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	citations?: MessageCitation[];
	retrieval?: MessageRetrievalState;
	ui?: MessageUIState;
	safety?: MessageSafetyState;
}

export interface MessageCitation {
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
	chunkCount: number;
}

export interface MessageUIState {
	sourcesExpanded?: boolean;
}

export interface MessageSafetyState {
	blocked?: boolean;
	reason?: string;
	signals?: string[];
}

export interface ContextChunk {
	filePath: string;
	code: string;
	score: number;
	nodeType: string;
}

export interface ChatSession {
	chat_id: string;
	title: string;
	messages: Message[];
	updatedAt: number;
}
