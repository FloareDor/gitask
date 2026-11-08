import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Runs the CodeSearchNet benchmark steps, which are long scripts rather than tests. */
export default defineConfig({
	test: {
		include: ["scripts/csn/*.run.ts"],
		testTimeout: 6 * 60 * 60 * 1000,
		hookTimeout: 6 * 60 * 60 * 1000,
		fileParallelism: false,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "../../src"),
		},
	},
});
