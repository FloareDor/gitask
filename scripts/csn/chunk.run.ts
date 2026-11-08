/**
 * Step 2 of the CodeSearchNet benchmark: chunk every corpus function with the
 * same tree-sitter path the indexer uses, and record which function each chunk
 * came from so retrieved chunks can be scored at the function level.
 *
 * Run one language per process. The shipped Python grammar imports a C++ symbol
 * (`_Znwm`) that web-tree-sitter 0.26 does not provide, so every Python parse
 * throws and falls back to text chunking — exactly as it does in the indexer —
 * and the failed call leaves the shared wasm runtime unable to parse anything
 * afterwards, which would silently push JavaScript onto the fallback too.
 *
 *   $env:CSN_LANGUAGES='python'; npx vitest run --config scripts/csn/vitest.config.mts scripts/csn/chunk.run.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { chunkCode, chunkFromTree } from "../../src/lib/chunker";

const ROOT = resolve(__dirname, "../..");
const LANGUAGES = (process.env.CSN_LANGUAGES ?? "python,javascript").split(",");
const EXTENSIONS: Record<string, string> = { python: "py", javascript: "js" };

interface CsnFunction {
	id: string;
	repo: string;
	path: string;
	code: string;
}

function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

it("chunks the CodeSearchNet corpus", async () => {
	await Parser.init();

	for (const lang of LANGUAGES) {
		const dir = resolve(ROOT, ".context/csn", lang);
		const functions = readJsonl<CsnFunction>(resolve(dir, "functions.jsonl"));
		const parser = new Parser();
		parser.setLanguage(await Language.load(resolve(ROOT, `public/wasms/tree-sitter-${lang}.wasm`)));

		const lines: string[] = [];
		const seenIds = new Set<string>();
		let astFunctions = 0;
		let textFallbacks = 0;

		for (const fn of functions) {
			// One file per function keeps chunk ids unique across the corpus.
			const filePath = `${fn.repo}/${fn.id}/${fn.path.replace(/\.[^/.]+$/, "")}.${EXTENSIONS[lang]}`;
			let chunks;
			try {
				const tree = parser.parse(fn.code);
				try {
					chunks = chunkFromTree(filePath, fn.code, tree, lang);
				} finally {
					tree?.delete();
				}
			} catch {
				chunks = chunkCode(filePath, fn.code);
			}

			if (chunks.some((chunk) => chunk.nodeType === "text_chunk")) textFallbacks += 1;
			else astFunctions += 1;

			for (const chunk of chunks) {
				let id = chunk.id;
				for (let n = 2; seenIds.has(id); n += 1) id = `${chunk.id}#${n}`;
				seenIds.add(id);
				lines.push(JSON.stringify({ ...chunk, id, functionId: fn.id }));
			}
		}

		parser.delete();
		writeFileSync(resolve(dir, "chunks.jsonl"), lines.join("\n") + "\n");
		console.log(
			`${lang}: ${functions.length} functions -> ${lines.length} chunks ` +
			`(${astFunctions} AST-chunked, ${textFallbacks} fell back to text chunking)`
		);
	}
});
