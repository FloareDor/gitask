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

export const CHUNKING_LIMITS = {
	MAX_FILE_CHARS: 120_000,
	MAX_CHUNK_CHARS: 20_000,
	MAX_TEXT_CHARS: 2_048,
	MAX_SAMPLE_FIELD_CHARS: 200,
	MAX_SERIALIZED_SAMPLES_CHARS: 8_000,
	HEAD_TAIL_MIDDLE_COUNT: 20,
	RANDOM_SAMPLE_COUNT: 20,
	DETERMINISTIC_SEED: 42,
} as const;

const LARGE_DATA_EXTENSIONS = new Set([
	"json",
	"bin",
	"pt",
	"onnx",
	"ckpt",
	"npy",
	"npz",
	"parquet",
	"csv",
]);

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
	const extension = filePath.split(".").pop()?.toLowerCase() ?? "";

	if (
		code.length > CHUNKING_LIMITS.MAX_FILE_CHARS ||
		(LARGE_DATA_EXTENSIONS.has(extension) &&
			code.length > CHUNKING_LIMITS.MAX_TEXT_CHARS)
	) {
		return [summarizeLargeFile(filePath, code, extension, lang ?? "text")];
	}

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
	try {
		return chunkFromTree(filePath, code, tree, language);
	} finally {
		tree.delete();
	}
}

/**
 * Chunk code using an existing Tree-sitter AST.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function chunkFromTree(
	filePath: string,
	code: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tree: any,
	language: string
): CodeChunk[] {
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
	const chunks: CodeChunk[] = [];
	const paragraphs = code.split(/\n\n+/);

	let current = "";
	let startLine = 1;
	let currentLine = 1;

	for (const para of paragraphs) {
		const paraUnits = splitOversizedUnit(para, CHUNKING_LIMITS.MAX_TEXT_CHARS);

		for (const unit of paraUnits) {
			const unitLines = unit.split("\n").length;

			if (
				current.length + unit.length > CHUNKING_LIMITS.MAX_TEXT_CHARS &&
				current.length > 0
			) {
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

			current += (current ? "\n\n" : "") + unit;
			currentLine += unitLines + 1; // +1 for separator boundary
		}
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

	// Hard safety: never emit an oversized chunk.
	const safeChunks: CodeChunk[] = [];
	for (const chunk of chunks) {
		if (chunk.code.length <= CHUNKING_LIMITS.MAX_CHUNK_CHARS) {
			safeChunks.push(chunk);
			continue;
		}

		const split = splitOversizedUnit(chunk.code, CHUNKING_LIMITS.MAX_CHUNK_CHARS);
		let offsetLine = chunk.startLine;
		for (let i = 0; i < split.length; i++) {
			const part = split[i];
			const lineCount = part.split("\n").length;
			safeChunks.push({
				id: `${filePath}::chunk_${safeChunks.length}`,
				filePath,
				language,
				nodeType: "text_chunk",
				name: `chunk_${safeChunks.length}`,
				code: part,
				startLine: offsetLine,
				endLine: offsetLine + lineCount - 1,
			});
			offsetLine += lineCount;
		}
	}

	return safeChunks;
}

function splitOversizedUnit(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	// 1) Prefer semantic/code boundaries.
	const semanticChunks = splitByRegexBoundary(
		text,
		/\n(?=(export\s+|async\s+function|function\s+|class\s+|interface\s+|type\s+|const\s+\w+\s*=|def\s+|#\s|##\s))/g,
		maxChars
	);
	if (semanticChunks.every((chunk) => chunk.length <= maxChars)) {
		return semanticChunks;
	}

	// 2) Then split by line blocks.
	const lineChunks = splitByLineBudget(text, maxChars);
	if (lineChunks.every((chunk) => chunk.length <= maxChars)) {
		return lineChunks;
	}

	// 3) Final fixed-size split.
	const fixed: string[] = [];
	for (let i = 0; i < text.length; i += maxChars) {
		fixed.push(text.slice(i, i + maxChars));
	}
	return fixed;
}

function splitByRegexBoundary(
	text: string,
	boundaryRegex: RegExp,
	maxChars: number
): string[] {
	const units = text.split(boundaryRegex);
	return mergeUnitsWithBudget(units, maxChars, "\n");
}

function splitByLineBudget(text: string, maxChars: number): string[] {
	const lines = text.split("\n");
	return mergeUnitsWithBudget(lines, maxChars, "\n");
}

function mergeUnitsWithBudget(
	units: string[],
	maxChars: number,
	separator: string
): string[] {
	const merged: string[] = [];
	let current = "";

	for (const rawUnit of units) {
		const unit = rawUnit ?? "";
		if (!unit) continue;

		// If a single unit is too large, force split at fixed width.
		if (unit.length > maxChars) {
			if (current) {
				merged.push(current);
				current = "";
			}
			for (let i = 0; i < unit.length; i += maxChars) {
				merged.push(unit.slice(i, i + maxChars));
			}
			continue;
		}

		const candidate = current ? `${current}${separator}${unit}` : unit;
		if (candidate.length > maxChars && current) {
			merged.push(current);
			current = unit;
		} else {
			current = candidate;
		}
	}

	if (current) merged.push(current);
	return merged.length > 0 ? merged : [textFallback(units)];
}

function textFallback(units: string[]): string {
	return units.filter(Boolean).join("\n");
}

function summarizeLargeFile(
	filePath: string,
	content: string,
	extension: string,
	language: string
): CodeChunk {
	const lineCount = content.split("\n").length;
	const known: string[] = [
		`path: ${filePath}`,
		`size_chars: ${content.length}`,
		`line_count: ${lineCount}`,
	];
	const inferred: string[] = [];
	const unknown: string[] = [];
	const evidence: string[] = [];

	const isJson = extension === "json";
	const samples = isJson
		? summarizeLargeJson(content, known, inferred, unknown, evidence)
		: summarizeLargeText(content, unknown, evidence);

	const summary = [
		"[LARGE_FILE_SUMMARY]",
		`path: ${filePath}`,
		`language: ${language}`,
		`reason: exceeded chunking guardrails; full payload omitted`,
		"",
		"known:",
		...known.map((k) => `- ${k}`),
		"",
		"inferred:",
		...(inferred.length > 0 ? inferred.map((k) => `- ${k}`) : ["- none"]),
		"",
		"unknown:",
		...unknown.map((k) => `- ${k}`),
		"",
		"evidence:",
		...evidence.map((k) => `- ${k}`),
		"",
		"samples:",
		samples,
		"",
		"confidence: medium",
	].join("\n");

	return {
		id: `${filePath}::large_file_summary`,
		filePath,
		language,
		nodeType: "file_summary",
		name: "large_file_summary",
		code: summary.slice(0, CHUNKING_LIMITS.MAX_CHUNK_CHARS),
		startLine: 1,
		endLine: lineCount,
	};
}

function summarizeLargeJson(
	content: string,
	known: string[],
	inferred: string[],
	unknown: string[],
	evidence: string[]
): string {
	try {
		const parsed = JSON.parse(content);
		const rootType = Array.isArray(parsed) ? "array" : typeof parsed;
		known.push(`json_root_type: ${rootType}`);
		evidence.push("json.parse(content) succeeded");

		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const keys = Object.keys(parsed as Record<string, unknown>);
			known.push(`top_level_key_count: ${keys.length}`);
			known.push(
				`top_level_keys_sample: ${JSON.stringify(keys.slice(0, CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT))}`
			);
		}
		if (Array.isArray(parsed)) {
			known.push(`array_length: ${parsed.length}`);
		}

		const samplePayload = buildSamplePayload(parsed);
		return truncateSerialized(samplePayload, CHUNKING_LIMITS.MAX_SERIALIZED_SAMPLES_CHARS);
	} catch {
		inferred.push("content looks like JSON but full parse failed");
		unknown.push("exact JSON structure (parse failed on omitted payload)");
		evidence.push("json.parse(content) failed");
		return truncateSerialized(
			buildTextSamples(content),
			CHUNKING_LIMITS.MAX_SERIALIZED_SAMPLES_CHARS
		);
	}
}

function summarizeLargeText(
	content: string,
	unknown: string[],
	evidence: string[]
): string {
	unknown.push(
		"full file semantics are not fully known because only bounded samples were kept"
	);
	evidence.push("head/tail/middle/random text sampling");
	return truncateSerialized(
		buildTextSamples(content),
		CHUNKING_LIMITS.MAX_SERIALIZED_SAMPLES_CHARS
	);
}

function buildSamplePayload(value: unknown): string {
	const payload = {
		head: sampleCollection(value, "head", CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT),
		tail: sampleCollection(value, "tail", CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT),
		middle: sampleCollection(
			value,
			"middle",
			CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT
		),
		random: sampleCollection(
			value,
			"random",
			CHUNKING_LIMITS.RANDOM_SAMPLE_COUNT
		),
	};
	return JSON.stringify(payload, null, 2);
}

function sampleCollection(
	value: unknown,
	mode: "head" | "tail" | "middle" | "random",
	count: number
): unknown {
	if (Array.isArray(value)) {
		const indices = sampleIndices(value.length, mode, count);
		return indices.map((idx) => ({
			index: idx,
			value: clipSample(value[idx]),
		}));
	}

	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		const indices = sampleIndices(entries.length, mode, count);
		return indices.map((idx) => ({
			key: entries[idx][0],
			value: clipSample(entries[idx][1]),
		}));
	}

	return clipSample(value);
}

function sampleIndices(
	length: number,
	mode: "head" | "tail" | "middle" | "random",
	count: number
): number[] {
	if (length <= 0) return [];
	const n = Math.min(length, count);
	if (mode === "head") return Array.from({ length: n }, (_, i) => i);
	if (mode === "tail") return Array.from({ length: n }, (_, i) => length - n + i);
	if (mode === "middle") {
		const start = Math.max(0, Math.floor((length - n) / 2));
		return Array.from({ length: n }, (_, i) => start + i);
	}
	return seededRandomSampleIndices(length, n, CHUNKING_LIMITS.DETERMINISTIC_SEED);
}

function seededRandomSampleIndices(
	length: number,
	count: number,
	seed: number
): number[] {
	const indices = new Set<number>();
	let state = seed >>> 0;
	while (indices.size < count) {
		state = (1664525 * state + 1013904223) >>> 0;
		indices.add(state % length);
	}
	return [...indices].sort((a, b) => a - b);
}

function clipSample(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > CHUNKING_LIMITS.MAX_SAMPLE_FIELD_CHARS
			? `${value.slice(0, CHUNKING_LIMITS.MAX_SAMPLE_FIELD_CHARS)}...(truncated)`
			: value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, 8).map((item) => clipSample(item));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(
			0,
			8
		)) {
			out[key] = clipSample(val);
		}
		return out;
	}
	return value;
}

function truncateSerialized(serialized: string, maxChars: number): string {
	if (serialized.length <= maxChars) return serialized;
	return `${serialized.slice(0, maxChars)}\n...(truncated)`;
}

function buildTextSamples(content: string): string {
	const lines = content.split("\n");
	const payload = {
		head: sampleLines(lines, "head", CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT),
		tail: sampleLines(lines, "tail", CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT),
		middle: sampleLines(lines, "middle", CHUNKING_LIMITS.HEAD_TAIL_MIDDLE_COUNT),
		random: sampleLines(lines, "random", CHUNKING_LIMITS.RANDOM_SAMPLE_COUNT),
	};
	return JSON.stringify(payload, null, 2);
}

function sampleLines(
	lines: string[],
	mode: "head" | "tail" | "middle" | "random",
	count: number
): Array<{ line: number; text: string }> {
	const indices = sampleIndices(lines.length, mode, count);
	return indices.map((idx) => ({
		line: idx + 1,
		text: clipSample(lines[idx] ?? "") as string,
	}));
}
