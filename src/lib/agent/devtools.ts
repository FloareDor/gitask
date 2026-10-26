/**
 * Bind the toolbox to an indexed store and hang it off `window.gitask` so the
 * tools can be driven from the browser console:
 *
 *   await gitask.semantic_search("how are chunks embedded")
 *   gitask.grep("hybridSearch", { glob: "src/lib/*.ts" })
 *   gitask.read_file("src/lib/search.ts", 151, 180)
 *   await gitask.agent("how does a question become a Gemini request?", "<key>")
 */

import type { VectorStore } from "../vectorStore";
import type { GrepOptions } from "./grep";
import { runAgent, type AgentEvent } from "./loop";
import { geminiProvider, staticKeyScope } from "./providers/gemini";
import { findDefinition, findReferences, grep, readFile, semanticSearch } from "./tools";

/** Run the loop and log each event as it lands, so a run is watchable live. */
async function traceAgent(
	store: VectorStore,
	question: string,
	apiKey: string,
	repo?: string
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of runAgent(question, store, {
		provider: geminiProvider({ withKey: staticKeyScope(apiKey) }),
		repo,
	})) {
		events.push(event);
		console.log(event.type, event);
	}
	return events;
}

export function exposeAgentTools(store: VectorStore, repo?: string): void {
	if (typeof window === "undefined") return;
	(window as unknown as Record<string, unknown>).gitask = {
		store,
		agent: (question: string, apiKey: string) => traceAgent(store, question, apiKey, repo),
		semantic_search: (query: string, k?: number) => semanticSearch(store, query, k),
		grep: (pattern: string, options?: GrepOptions) => grep(store, pattern, options),
		read_file: (path: string, startLine?: number, endLine?: number) =>
			readFile(store, path, startLine, endLine),
		find_definition: (symbol: string) => findDefinition(store, symbol),
		find_references: (symbol: string) => findReferences(store, symbol),
	};
}
