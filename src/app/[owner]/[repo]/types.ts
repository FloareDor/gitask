export interface MessageDiagram {
	title: string;
	nodes: Array<{ id: string; label: string; sublabel?: string; category: string }>;
	edges: Array<{ source: string; target: string; label?: string }>;
}

export interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	citations?: MessageCitation[];
	ui?: MessageUIState;
	safety?: MessageSafetyState;
	diagramStatus?: "loading" | "ready" | "skipped" | "error";
	diagram?: MessageDiagram;
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
