import { describe, expect, it } from "vitest";
import {
	createDirectorySummaryChunks,
	getDirectoryPath,
	updateDirectoryStats,
	type DirectoryStatsMap,
} from "./directorySummary";

describe("directorySummary", () => {
	it("extracts directory paths", () => {
		expect(getDirectoryPath("src/app/page.tsx")).toBe("src/app");
		expect(getDirectoryPath("README.md")).toBe(".");
	});

	it("emits summaries only for overflowing directories", () => {
		const stats: DirectoryStatsMap = {};
		updateDirectoryStats(stats, "src/a.ts", 2_000, 2, false);
		updateDirectoryStats(stats, "src/b.ts", 2_500, 3, false);
		updateDirectoryStats(stats, "assets/x.json", 20_000, 1, true);
		updateDirectoryStats(stats, "assets/y.json", 22_000, 1, true);

		const chunks = createDirectorySummaryChunks(stats, {
			maxFilesPerDir: 1,
			maxCharsPerDir: 30_000,
			maxSummaryChars: 8_000,
		});

		expect(chunks.length).toBe(2);
		for (const chunk of chunks) {
			expect(chunk.nodeType).toBe("directory_summary");
			expect(chunk.code).toContain("[DIRECTORY_SUMMARY]");
			expect(chunk.code.length).toBeLessThanOrEqual(8_000);
		}
	});
});
