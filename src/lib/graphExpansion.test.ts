/**
 * Import resolution across languages.
 *
 * The resolver used to assume JavaScript, so expansion was a no-op on Python,
 * Go and Rust repositories: the candidates went in and came straight back out.
 * Most of what follows would have returned `null` before.
 */

import { describe, expect, it } from "vitest";
import { buildResolveFileData, expandCandidatesWithGraph } from "./graphExpansion";

/**
 * A store with one chunk per file, so "did it expand" reads as "which files
 * did it reach".
 */
function storeOf(files: string[], graph: Record<string, string[]>) {
	const chunks = files.map((filePath) => ({ id: `${filePath}#0`, filePath }));
	return {
		getAll: () => chunks,
		getGraph: () =>
			Object.fromEntries(
				files.map((f) => [f, { imports: graph[f] ?? [], definitions: [] }])
			),
		getChunksByFile: (filePath: string) => chunks.filter((c) => c.filePath === filePath),
		getResolveFileData: () => buildResolveFileData(files),
	};
}

/** The files an import from `seed` reached, excluding the seed itself. */
function reachedFrom(files: string[], graph: Record<string, string[]>, seed: string): string[] {
	const store = storeOf(files, graph);
	const expanded = expandCandidatesWithGraph(store, [[`${seed}#0`, 1]]);
	return expanded
		.slice(1)
		.map(([id]) => id.replace(/#0$/, ""))
		.sort();
}

describe("resolveImport — Python", () => {
	const files = [
		"src/app/main.py",
		"src/app/utils/helpers.py",
		"src/app/utils/__init__.py",
		"src/app/models.py",
	];

	it("resolves a dotted absolute module path", () => {
		// `utils.helpers` never matched before: the dot was read as a file
		// extension, so no extension was ever appended.
		expect(reachedFrom(files, { "src/app/main.py": ["src.app.utils.helpers"] }, "src/app/main.py"))
			.toEqual(["src/app/utils/helpers.py"]);
	});

	it("resolves a dotted path by its tail when the root is not in the repo", () => {
		expect(reachedFrom(files, { "src/app/main.py": ["app.utils.helpers"] }, "src/app/main.py"))
			.toEqual(["src/app/utils/helpers.py"]);
	});

	it("treats one leading dot as the current package", () => {
		expect(reachedFrom(files, { "src/app/main.py": [".models"] }, "src/app/main.py"))
			.toEqual(["src/app/models.py"]);
	});

	it("climbs one directory per extra leading dot", () => {
		const nested = [...files, "src/app/api/routes.py"];
		expect(reachedFrom(nested, { "src/app/api/routes.py": ["..models"] }, "src/app/api/routes.py"))
			.toEqual(["src/app/models.py"]);
	});

	it("resolves a package to its __init__.py", () => {
		expect(reachedFrom(files, { "src/app/main.py": ["src.app.utils"] }, "src/app/main.py"))
			.toEqual(["src/app/utils/__init__.py"]);
	});
});

describe("resolveImport — Go", () => {
	const files = ["cmd/server/main.go", "internal/auth/token.go", "internal/store/db.go"];

	it("resolves a full module path by its in-repo tail", () => {
		expect(
			reachedFrom(files, { "cmd/server/main.go": ["github.com/org/repo/internal/auth"] }, "cmd/server/main.go")
		).toEqual(["internal/auth/token.go"]);
	});

	it("ignores a third-party import with no file in the repo", () => {
		expect(reachedFrom(files, { "cmd/server/main.go": ["github.com/spf13/cobra"] }, "cmd/server/main.go"))
			.toEqual([]);
	});
});

describe("resolveImport — Rust", () => {
	const files = ["src/main.rs", "src/graph/mod.rs", "src/graph/walk.rs", "src/util.rs"];

	it("resolves a crate-absolute path", () => {
		expect(reachedFrom(files, { "src/main.rs": ["crate::graph::walk"] }, "src/main.rs"))
			.toEqual(["src/graph/walk.rs"]);
	});

	it("resolves a module to its mod.rs", () => {
		expect(reachedFrom(files, { "src/main.rs": ["crate::graph"] }, "src/main.rs"))
			.toEqual(["src/graph/mod.rs"]);
	});

	it("climbs one level per super", () => {
		expect(reachedFrom(files, { "src/graph/walk.rs": ["super::util"] }, "src/graph/walk.rs"))
			.toEqual(["src/util.rs"]);
	});

	it("handles a brace group by resolving its prefix", () => {
		// The extractor hands over raw `use` text; `{a, b}` names siblings under
		// the same path, so the prefix is the thing to resolve.
		expect(reachedFrom(files, { "src/main.rs": ["crate::graph::{walk, prune}"] }, "src/main.rs"))
			.toEqual(["src/graph/mod.rs"]);
	});

	it("ignores an external crate", () => {
		expect(reachedFrom(files, { "src/main.rs": ["std::collections::HashMap"] }, "src/main.rs"))
			.toEqual([]);
	});
});

describe("resolveImport — JavaScript and TypeScript", () => {
	const files = ["src/app.ts", "src/lib/utils.ts", "src/lib/index.ts", "src/myutils.ts"];

	it("still resolves a relative import", () => {
		expect(reachedFrom(files, { "src/app.ts": ["./lib/utils"] }, "src/app.ts"))
			.toEqual(["src/lib/utils.ts"]);
	});

	it("still resolves a parent-relative import", () => {
		expect(reachedFrom(files, { "src/lib/utils.ts": ["../app"] }, "src/lib/utils.ts"))
			.toEqual(["src/app.ts"]);
	});

	it("still resolves a directory to its index file", () => {
		expect(reachedFrom(files, { "src/app.ts": ["./lib"] }, "src/app.ts"))
			.toEqual(["src/lib/index.ts"]);
	});

	it("resolves a .js specifier to the .ts source", () => {
		expect(reachedFrom(files, { "src/app.ts": ["./lib/utils.js"] }, "src/app.ts"))
			.toEqual(["src/lib/utils.ts"]);
	});

	// The old suffix fallback was a bare endsWith, so `./utils` matched
	// `src/myutils.ts` and expansion pulled in an unrelated file.
	it("does not match a path that only ends with the same characters", () => {
		expect(reachedFrom(files, { "src/app.ts": ["./utils"] }, "src/app.ts")).toEqual([]);
	});

	it("does not fall back to a repo-wide search for a broken relative import", () => {
		expect(reachedFrom(files, { "src/app.ts": ["./lib/missing"] }, "src/app.ts")).toEqual([]);
	});
});


describe("resolveImport — Java", () => {
	const files = [
		"src/main/java/com/example/App.java",
		"src/main/java/com/example/auth/TokenValidator.java",
		"src/main/java/com/example/auth/Validator.java",
	];
	const APP = "src/main/java/com/example/App.java";

	it("resolves a package path, which the build directories prefix", () => {
		// The package is `com.example.auth`, but the file lives under
		// `src/main/java/...`, so only a suffix of the path is real.
		expect(reachedFrom(files, { [APP]: ["com.example.auth.TokenValidator"] }, APP))
			.toEqual(["src/main/java/com/example/auth/TokenValidator.java"]);
	});

	it("resolves a static import by dropping the member it names", () => {
		// `import static com.example.auth.TokenValidator.check` addresses a
		// method; the file is one segment shorter than the import.
		expect(reachedFrom(files, { [APP]: ["com.example.auth.TokenValidator.check"] }, APP))
			.toEqual(["src/main/java/com/example/auth/TokenValidator.java"]);
	});

	it("resolves a wildcard import to the package directory", () => {
		// `import com.example.auth.*` arrives as the package alone, which is a
		// directory — so it reaches whatever that directory holds.
		const reached = reachedFrom(files, { [APP]: ["com.example.auth"] }, APP);
		expect(reached).toHaveLength(1);
		expect(reached[0]).toMatch(/^src\/main\/java\/com\/example\/auth\//);
	});

	it("ignores a JDK import with no file in the repo", () => {
		expect(reachedFrom(files, { [APP]: ["java.util.List"] }, APP)).toEqual([]);
	});
});
describe("expandCandidatesWithGraph", () => {
	const files = ["a.py", "b.py"];
	const graph = { "a.py": ["b"] };

	it("keeps the original candidates ahead of what it added", () => {
		const store = storeOf(files, graph);
		const expanded = expandCandidatesWithGraph(store, [["a.py#0", 1]]);
		expect(expanded[0]).toEqual(["a.py#0", 1]);
		expect(expanded).toHaveLength(2);
	});

	it("scores a neighbour down by the expansion weight", () => {
		const store = storeOf(files, graph);
		const expanded = expandCandidatesWithGraph(store, [["a.py#0", 1]], { expansionWeight: 0.25 });
		expect(expanded[1][1]) .toBe(0.25);
	});

	it("rebuilds the path index when the store predates moduleIndex", () => {
		const store = storeOf(files, graph);
		// An older store shape: the field the resolver needs is simply absent.
		const stale = {
			...store,
			getResolveFileData: () => {
				const data = buildResolveFileData(files) as Partial<
					ReturnType<typeof buildResolveFileData>
				>;
				delete data.moduleIndex;
				return data as ReturnType<typeof buildResolveFileData>;
			},
		};
		expect(expandCandidatesWithGraph(stale, [["a.py#0", 1]])).toHaveLength(2);
	});

	it("returns candidates untouched when nothing resolves", () => {
		const store = storeOf(files, { "a.py": ["requests"] });
		expect(expandCandidatesWithGraph(store, [["a.py#0", 1]])).toHaveLength(1);
	});
});
