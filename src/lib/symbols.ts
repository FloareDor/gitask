/**
 * Regex-based symbol extractor for AST tree visualization.
 *
 * Extracts function/class/interface names from source code using
 * language-aware regex patterns. No WASM grammar files needed.
 */

export interface FileSymbol {
	name: string;
	kind: "function" | "class" | "interface" | "method" | "struct" | "enum" | "impl" | "type" | "constant";
	line: number;
}

interface SymbolPattern {
	regex: RegExp;
	kind: FileSymbol["kind"];
	nameGroup: number;
}

const JS_TS_PATTERNS: SymbolPattern[] = [
	{ regex: /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: "function", nameGroup: 1 },
	{ regex: /^[ \t]*(?:export\s+)?class\s+(\w+)/gm, kind: "class", nameGroup: 1 },
	{ regex: /^[ \t]*(?:export\s+)?interface\s+(\w+)/gm, kind: "interface", nameGroup: 1 },
	{ regex: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>/gm, kind: "function", nameGroup: 1 },
	{ regex: /^[ \t]*(?:export\s+)?type\s+(\w+)\s*=/gm, kind: "type", nameGroup: 1 },
];

const PYTHON_PATTERNS: SymbolPattern[] = [
	{ regex: /^[ \t]*(?:async\s+)?def\s+(\w+)/gm, kind: "function", nameGroup: 1 },
	{ regex: /^[ \t]*class\s+(\w+)/gm, kind: "class", nameGroup: 1 },
];

const RUST_PATTERNS: SymbolPattern[] = [
	{ regex: /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm, kind: "function", nameGroup: 1 },
	{ regex: /^[ \t]*(?:pub\s+)?struct\s+(\w+)/gm, kind: "struct", nameGroup: 1 },
	{ regex: /^[ \t]*(?:pub\s+)?enum\s+(\w+)/gm, kind: "enum", nameGroup: 1 },
	{ regex: /^[ \t]*impl(?:<[^>]*>)?\s+(\w+)/gm, kind: "impl", nameGroup: 1 },
	{ regex: /^[ \t]*(?:pub\s+)?trait\s+(\w+)/gm, kind: "interface", nameGroup: 1 },
];

const GO_PATTERNS: SymbolPattern[] = [
	{ regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)/gm, kind: "function", nameGroup: 1 },
	{ regex: /^type\s+(\w+)\s+struct/gm, kind: "struct", nameGroup: 1 },
	{ regex: /^type\s+(\w+)\s+interface/gm, kind: "interface", nameGroup: 1 },
];

const LANG_PATTERNS: Record<string, SymbolPattern[]> = {
	javascript: JS_TS_PATTERNS,
	typescript: JS_TS_PATTERNS,
	tsx: JS_TS_PATTERNS,
	python: PYTHON_PATTERNS,
	rust: RUST_PATTERNS,
	go: GO_PATTERNS,
};

/**
 * Extract symbols from source code using regex patterns.
 * Returns symbols sorted by line number.
 */
export function extractSymbols(code: string, language: string | null): FileSymbol[] {
	if (!language) return [];

	const patterns = LANG_PATTERNS[language];
	if (!patterns) return [];

	const symbols: FileSymbol[] = [];
	const lines = code.split("\n");

	for (const pattern of patterns) {
		// Clone the regex to reset lastIndex
		const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
		let match: RegExpExecArray | null;

		while ((match = regex.exec(code)) !== null) {
			const name = match[pattern.nameGroup];
			if (!name) continue;

			// Calculate line number from match index
			const upToMatch = code.slice(0, match.index);
			const line = upToMatch.split("\n").length;

			// Avoid duplicates at the same line
			if (!symbols.some((s) => s.line === line && s.name === name)) {
				symbols.push({ name, kind: pattern.kind, line });
			}
		}
	}

	return symbols.sort((a, b) => a.line - b.line);
}
