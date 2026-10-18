/**
 * Bind the toolbox to an indexed store and hang it off `window.gitask` so the
 * tools can be driven from the browser console:
 *
 *   await gitask.semantic_search("how are chunks embedded")
 *   gitask.grep("hybridSearch", { glob: "src/lib/*.ts" })
 *   gitask.read_file("src/lib/search.ts", 151, 180)
 */

import type { VectorStore } from "../vectorStore";
import type { GrepOptions } from "./grep";
import { findDefinition, findReferences, grep, readFile, semanticSearch } from "./tools";

export function exposeAgentTools(store: VectorStore): void {
	if (typeof window === "undefined") return;
	(window as unknown as Record<string, unknown>).gitask = {
		store,
		semantic_search: (query: string, k?: number) => semanticSearch(store, query, k),
		grep: (pattern: string, options?: GrepOptions) => grep(store, pattern, options),
		read_file: (path: string, startLine?: number, endLine?: number) =>
			readFile(store, path, startLine, endLine),
		find_definition: (symbol: string) => findDefinition(store, symbol),
		find_references: (symbol: string) => findReferences(store, symbol),
	};
}
