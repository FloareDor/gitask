import type { CodeChunk } from "./chunker";

export interface DirectoryFileStat {
	path: string;
	charCount: number;
	chunkCount: number;
	hasLargeFileSummary: boolean;
}

export interface DirectoryStat {
	fileCount: number;
	totalChars: number;
	files: DirectoryFileStat[];
}

export interface DirectorySummaryLimits {
	maxFilesPerDir: number;
	maxCharsPerDir: number;
	maxSummaryChars: number;
}

export type DirectoryStatsMap = Record<string, DirectoryStat>;

export function getDirectoryPath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash === -1 ? "." : normalized.slice(0, lastSlash);
}

export function updateDirectoryStats(
	stats: DirectoryStatsMap,
	filePath: string,
	fileCharCount: number,
	chunkCount: number,
	hasLargeFileSummary: boolean
): void {
	const dirPath = getDirectoryPath(filePath);
	if (!stats[dirPath]) {
		stats[dirPath] = {
			fileCount: 0,
			totalChars: 0,
			files: [],
		};
	}

	const dir = stats[dirPath];
	dir.fileCount += 1;
	dir.totalChars += fileCharCount;
	dir.files.push({
		path: filePath,
		charCount: fileCharCount,
		chunkCount,
		hasLargeFileSummary,
	});
}

export function createDirectorySummaryChunks(
	stats: DirectoryStatsMap,
	limits: DirectorySummaryLimits
): CodeChunk[] {
	const out: CodeChunk[] = [];

	for (const [dirPath, dir] of Object.entries(stats)) {
		const overflow =
			dir.fileCount > limits.maxFilesPerDir || dir.totalChars > limits.maxCharsPerDir;
		if (!overflow) continue;

		const topBySize = [...dir.files]
			.sort((a, b) => b.charCount - a.charCount)
			.slice(0, 12)
			.map(
				(file) =>
					`${file.path} (${file.charCount} chars, ${file.chunkCount} chunks${file.hasLargeFileSummary ? ", file-summary" : ""
					})`
			);

		const omittedCount = Math.max(0, dir.files.length - topBySize.length);

		const summary = [
			"[DIRECTORY_SUMMARY]",
			`directory: ${dirPath}`,
			"",
			"known:",
			`- file_count: ${dir.fileCount}`,
			`- total_chars: ${dir.totalChars}`,
			`- overflow_reason: ${dir.fileCount > limits.maxFilesPerDir ? "too many files" : "too many chars"}`,
			"",
			"inferred:",
			"- this directory likely includes high-volume assets or generated content",
			"",
			"unknown:",
			"- full semantics of omitted files are not included in this summary",
			"",
			"evidence:",
			"- indexing-time directory aggregate statistics",
			`- top_files_by_size_sample_count: ${topBySize.length}`,
			"",
			"top_files_by_size:",
			...topBySize.map((line) => `- ${line}`),
			...(omittedCount > 0 ? [`- ...(omitted ${omittedCount} files)`] : []),
			"",
			"confidence: medium",
		].join("\n");

		out.push({
			id: `${dirPath}::directory_summary`,
			filePath: `${dirPath}/[directory_summary]`,
			language: "text",
			nodeType: "directory_summary",
			name: "directory_summary",
			code: summary.slice(0, limits.maxSummaryChars),
			startLine: 1,
			endLine: 1,
		});
	}

	return out;
}
