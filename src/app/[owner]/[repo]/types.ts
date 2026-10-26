export interface MessageDiagram {
	title: string;
	nodes: Array<{ id: string; label: string; sublabel?: string; category: string }>;
	edges: Array<{ source: string; target: string; label?: string }>;
}

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

/** Which retrieval strategy answers a question. Auto is wired up in Phase 7. */
export type AnswerMode = "rag" | "agent" | "auto";

/** One row in the agent trace: a tool call and, once it lands, its result. */
export interface AgentTraceStep {
	id: string;
	step: number;
	tool: string;
	args: Record<string, unknown>;
	/** Absent while the call is still running. */
	result?: string;
	elapsedMs?: number;
	bytes?: number;
	truncated?: boolean;
	duplicate?: boolean;
	isError?: boolean;
	expanded?: boolean;
}

export interface MessageAgentState {
	steps: AgentTraceStep[];
	/** Prose the model emitted alongside its tool calls. */
	notes: string[];
	stopReason?: "answered" | "step_cap" | "context_budget";
	totalSteps?: number;
	toolBytes?: number;
	tokensIn?: number;
	tokensOut?: number;
	elapsedMs?: number;
	traceExpanded?: boolean;
}

export interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** Internal reasoning from thinking models (Qwen3), hidden by default. */
	thinking?: string;
	citations?: MessageCitation[];
	retrieval?: MessageRetrievalState;
	/** Present only on answers produced by agent mode. */
	agent?: MessageAgentState;
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
