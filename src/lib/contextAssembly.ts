import type { CodeChunk } from "./chunker";

export interface ContextCandidate {
	chunk: CodeChunk;
	score: number;
}

export interface ContextAssemblyMeta {
	truncated: boolean;
	totalChars: number;
	maxChars: number;
	estimatedTokens: number;
	maxTokens: number;
	compactionStage: "none" | "file" | "directory" | "repo" | "truncated";
}

export interface ContextAssemblyLimits {
	maxChars: number;
	maxTokens: number;
	maxFileChars: number;
	maxDirChars: number;
	maxDirFiles: number;
	maxSnippetChars: number;
}

export function defaultLimitsForProvider(
	provider: "gemini" | "mlc"
): ContextAssemblyLimits {
	if (provider === "gemini") {
		return {
			maxChars: 300_000,
			maxTokens: 75_000,
			maxFileChars: 60_000,
			maxDirChars: 120_000,
			maxDirFiles: 12,
			maxSnippetChars: 2_000,
		};
	}
	return {
		maxChars: 24_000,
		maxTokens: 6_000,
		maxFileChars: 8_000,
		maxDirChars: 12_000,
		maxDirFiles: 6,
		maxSnippetChars: 1_200,
	};
}

interface ScopedBlock {
	filePath: string;
	dirPath: string;
	score: number;
	code: string;
	nodeType: string;
}

export function buildScopedContext(
	candidates: ContextCandidate[],
	limits: ContextAssemblyLimits
): { context: string; meta: ContextAssemblyMeta } {
	const blocks: ScopedBlock[] = candidates.map(({ chunk, score }) => ({
		filePath: chunk.filePath,
		dirPath: getDirectoryPath(chunk.filePath),
		score,
		code: chunk.code,
		nodeType: chunk.nodeType,
	}));

	const rawContext = renderBlocks(blocks);
	if (withinBudget(rawContext, limits)) {
		return {
			context: rawContext,
			meta: buildMeta(rawContext, limits, "none", false),
		};
	}

	const fileCompacted = compactOverflowFiles(blocks, limits);
	const fileContext = renderBlocks(fileCompacted);
	if (withinBudget(fileContext, limits)) {
		return {
			context: fileContext,
			meta: buildMeta(rawContext, limits, "file", false),
		};
	}

	const dirCompacted = compactOverflowDirectories(fileCompacted, limits);
	const dirContext = renderBlocks(dirCompacted);
	if (withinBudget(dirContext, limits)) {
		return {
			context: dirContext,
			meta: buildMeta(rawContext, limits, "directory", false),
		};
	}

	const repoCompacted = compactRepo(dirCompacted, limits);
	const repoContext = renderBlocks(repoCompacted);
	if (withinBudget(repoContext, limits)) {
		return {
			context: repoContext,
			meta: buildMeta(rawContext, limits, "repo", false),
		};
	}

	const truncated = `${repoContext.slice(0, limits.maxChars)}\n...(truncated)`;
	return {
		context: truncated,
		meta: buildMeta(rawContext, limits, "truncated", true),
	};
}

function buildMeta(
	totalText: string,
	limits: ContextAssemblyLimits,
	compactionStage: ContextAssemblyMeta["compactionStage"],
	truncated: boolean
): ContextAssemblyMeta {
	return {
		truncated,
		totalChars: totalText.length,
		maxChars: limits.maxChars,
		estimatedTokens: estimateTokens(totalText),
		maxTokens: limits.maxTokens,
		compactionStage,
	};
}

function withinBudget(text: string, limits: ContextAssemblyLimits): boolean {
	return text.length <= limits.maxChars && estimateTokens(text) <= limits.maxTokens;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function renderBlocks(blocks: ScopedBlock[]): string {
	return [...blocks]
		.sort((a, b) => b.score - a.score)
		.map(
			(block) =>
				`### ${block.filePath} (${block.nodeType}, score: ${block.score.toFixed(3)})\n\`\`\`\n${block.code}\n\`\`\``
		)
		.join("\n\n");
}

function compactOverflowFiles(
	blocks: ScopedBlock[],
	limits: ContextAssemblyLimits
): ScopedBlock[] {
	const byFile = new Map<string, ScopedBlock[]>();
	for (const block of blocks) {
		const list = byFile.get(block.filePath) ?? [];
		list.push(block);
		byFile.set(block.filePath, list);
	}

	const out: ScopedBlock[] = [];
	for (const [filePath, fileBlocks] of byFile.entries()) {
		const totalChars = fileBlocks.reduce((sum, block) => sum + block.code.length, 0);
		if (totalChars <= limits.maxFileChars) {
			out.push(...fileBlocks);
			continue;
		}

		const top = [...fileBlocks].sort((a, b) => b.score - a.score)[0];
		const sample = top.code.slice(0, limits.maxSnippetChars);
		out.push({
			filePath,
			dirPath: top.dirPath,
			score: top.score,
			nodeType: "file_compaction_summary",
			code: [
				"[FILE_COMPACTION_SUMMARY]",
				`file: ${filePath}`,
				"",
				"known:",
				`- chunk_count_in_context: ${fileBlocks.length}`,
				`- total_chars_in_context: ${totalChars}`,
				"",
				"inferred:",
				"- file may contain broad or verbose content; summarized to stay in budget",
				"",
				"unknown:",
				"- omitted file sections not shown in this compact view",
				"",
				"evidence:",
				`- retained_top_snippet_chars: ${sample.length}`,
				"",
				"snippet:",
				sample,
				"",
				"confidence: medium",
			].join("\n"),
		});
	}

	return out;
}

function compactOverflowDirectories(
	blocks: ScopedBlock[],
	limits: ContextAssemblyLimits
): ScopedBlock[] {
	const byDir = new Map<string, ScopedBlock[]>();
	for (const block of blocks) {
		const list = byDir.get(block.dirPath) ?? [];
		list.push(block);
		byDir.set(block.dirPath, list);
	}

	const out: ScopedBlock[] = [];
	for (const [dirPath, dirBlocks] of byDir.entries()) {
		const uniqueFiles = new Set(dirBlocks.map((block) => block.filePath)).size;
		const totalChars = dirBlocks.reduce((sum, block) => sum + block.code.length, 0);
		const overflow =
			uniqueFiles > limits.maxDirFiles || totalChars > limits.maxDirChars;
		if (!overflow) {
			out.push(...dirBlocks);
			continue;
		}

		const topFiles = [...new Map(
			dirBlocks
				.sort((a, b) => b.score - a.score)
				.map((block) => [block.filePath, block])
		).values()].slice(0, 8);

		out.push({
			filePath: `${dirPath}/[context_directory_summary]`,
			dirPath,
			score: topFiles[0]?.score ?? 0,
			nodeType: "directory_compaction_summary",
			code: [
				"[DIRECTORY_COMPACTION_SUMMARY]",
				`directory: ${dirPath}`,
				"",
				"known:",
				`- file_count_in_context: ${uniqueFiles}`,
				`- total_chars_in_context: ${totalChars}`,
				`- overflow_reason: ${uniqueFiles > limits.maxDirFiles ? "too many files in context" : "too many chars in context"}`,
				"",
				"inferred:",
				"- directory likely contains broad related context; compacted for token budget",
				"",
				"unknown:",
				"- non-listed files or omitted sections may contain additional details",
				"",
				"evidence:",
				"- top_files_by_retrieval_score in current context",
				"",
				"top_files:",
				...topFiles.map((block) => `- ${block.filePath} (${block.score.toFixed(3)})`),
				"",
				"confidence: medium",
			].join("\n"),
		});
	}

	return out;
}

function compactRepo(
	blocks: ScopedBlock[],
	limits: ContextAssemblyLimits
): ScopedBlock[] {
	const top = [...blocks].sort((a, b) => b.score - a.score).slice(0, 12);
	const scoreAvg =
		top.length > 0 ? top.reduce((sum, block) => sum + block.score, 0) / top.length : 0;
	const sample = top
		.slice(0, 4)
		.map((block) => `${block.filePath}: ${block.code.slice(0, limits.maxSnippetChars / 2)}`)
		.join("\n\n");

	return [
		{
			filePath: "[repo_compaction_summary]",
			dirPath: ".",
			score: scoreAvg,
			nodeType: "repo_compaction_summary",
			code: [
				"[REPO_COMPACTION_SUMMARY]",
				"",
				"known:",
				`- candidate_blocks: ${blocks.length}`,
				`- top_blocks_used: ${top.length}`,
				"",
				"inferred:",
				"- prompt budget still exceeded after file and directory compaction",
				"",
				"unknown:",
				"- many lower-ranked details are omitted",
				"",
				"evidence:",
				"- ranked retrieval scores",
				"",
				"top_paths:",
				...top.map((block) => `- ${block.filePath} (${block.score.toFixed(3)})`),
				"",
				"sample:",
				sample,
				"",
				"confidence: low",
			].join("\n"),
		},
	];
}

function getDirectoryPath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const idx = normalized.lastIndexOf("/");
	return idx === -1 ? "." : normalized.slice(0, idx);
}
