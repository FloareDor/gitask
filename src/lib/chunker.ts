/**
 * AST-based code chunker using Tree-sitter WASM.
 *
 * Parses source code into an AST and extracts meaningful chunks
 * (functions, classes, etc.) to preserve logical boundaries.
 * Falls back to text-based splitting for unsupported languages.
 */

export interface CodeChunk {
	id: string;
	filePath: string;
	language: string;
	nodeType: string;
	name: string;
	code: string;
	startLine: number;
	endLine: number;
}

/** Map file extensions to tree-sitter grammar names */
const LANG_MAP: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "tsx",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
};

/** AST node types we extract as chunks */
const CHUNK_NODE_TYPES = new Set([
	// JavaScript / TypeScript
	"function_declaration",
	"function",
	"arrow_function",
	"method_definition",
	"class_declaration",
	"export_statement",
	"lexical_declaration",
	"variable_declaration",
	// Python
	"function_definition",
	"class_definition",
	// Rust
	"function_item",
	"impl_item",
	"struct_item",
	"enum_item",
	// Go
	"function_declaration",
	"method_declaration",
	"type_declaration",
	// Java
	"class_declaration",
	"method_declaration",
	"constructor_declaration",
	"interface_declaration",
]);

/**
 * Detect language from file extension.
 */
export function detectLanguage(filePath: string): string | null {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return LANG_MAP[ext] ?? null;
}

/**
 * Chunk code using AST when tree-sitter is available.
 * This is the main entry point — it tries AST chunking first,
 * then falls back to text-based chunking.
 */
export function chunkCode(
	filePath: string,
	code: string,
	language?: string
): CodeChunk[] {
	const lang = language ?? detectLanguage(filePath);

	// For non-code files or unsupported languages, use text chunking
	if (!lang || !Object.values(LANG_MAP).includes(lang)) {
		return chunkByText(filePath, code);
	}

	// AST chunking requires the browser-only tree-sitter init
	// which happens asynchronously. For the library layer we provide
	// the text-based fallback synchronously and let the caller
	// use chunkWithTreeSitter when the parser is ready.
	return chunkByText(filePath, code, lang);
}

/**
 * AST-based chunking using an initialised tree-sitter parser.
 * Caller must pass a parser that already has the language set.
 */
export function chunkWithTreeSitter(
	filePath: string,
	code: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	parser: any,
	language: string
): CodeChunk[] {
	const tree = parser.parse(code);
	const chunks: CodeChunk[] = [];
	const cursor = tree.walk();

	function visit() {
		const node = cursor.currentNode;
		if (CHUNK_NODE_TYPES.has(node.type)) {
			const name = extractName(node) || `${node.type}_L${node.startPosition.row + 1}`;
			chunks.push({
				id: `${filePath}::${name}`,
				filePath,
				language,
				nodeType: node.type,
				name,
				code: node.text,
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			});
			// Don't recurse into children of extracted nodes
			return;
		}

		// Recurse into children
		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	}

	visit();

	// If no AST chunks found (e.g. file is just imports), fall back
	if (chunks.length === 0) {
		return chunkByText(filePath, code, language);
	}

	return chunks;
}

/**
 * Extract the name of an AST node (function name, class name, etc.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractName(node: any): string | null {
	// Look for a 'name' or 'identifier' child
	for (const child of node.children ?? []) {
		if (
			child.type === "identifier" ||
			child.type === "property_identifier" ||
			child.type === "type_identifier"
		) {
			return child.text;
		}
	}
	return null;
}

/**
 * Fallback: Text-based chunking by double-newline paragraphs.
 * Max ~512 tokens (~2048 chars) per chunk.
 */
export function chunkByText(
	filePath: string,
	code: string,
	language: string = "text"
): CodeChunk[] {
	const MAX_CHARS = 2048;
	const chunks: CodeChunk[] = [];
	const paragraphs = code.split(/\n\n+/);

	let current = "";
	let startLine = 1;
	let currentLine = 1;

	for (const para of paragraphs) {
		const paraLines = para.split("\n").length;

		if (current.length + para.length > MAX_CHARS && current.length > 0) {
			chunks.push({
				id: `${filePath}::chunk_${chunks.length}`,
				filePath,
				language,
				nodeType: "text_chunk",
				name: `chunk_${chunks.length}`,
				code: current.trim(),
				startLine,
				endLine: currentLine - 1,
			});
			current = "";
			startLine = currentLine;
		}

		current += (current ? "\n\n" : "") + para;
		currentLine += paraLines + 1; // +1 for the blank line
	}

	if (current.trim()) {
		chunks.push({
			id: `${filePath}::chunk_${chunks.length}`,
			filePath,
			language,
			nodeType: "text_chunk",
			name: `chunk_${chunks.length}`,
			code: current.trim(),
			startLine,
			endLine: currentLine - 1,
		});
	}

	return chunks;
}
