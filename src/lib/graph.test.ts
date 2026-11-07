import { describe, it, expect } from "vitest";
import { extractDependencies } from "./graph";

// Mock Node structure
interface MockNode {
	type: string;
	text?: string;
	children?: MockNode[];
}

// Mock Cursor implementation
class MockCursor {
	currentNode: MockNode;
	private stack: { node: MockNode; index: number; parent: MockNode | null }[] = [];
	private parent: MockNode | null = null;
	private index: number = 0;

	constructor(root: MockNode) {
		this.currentNode = root;
	}

	gotoFirstChild(): boolean {
		if (this.currentNode.children && this.currentNode.children.length > 0) {
			this.stack.push({
				node: this.currentNode,
				index: this.index,
				parent: this.parent,
			});
			this.parent = this.currentNode;
			this.currentNode = this.currentNode.children[0];
			this.index = 0;
			return true;
		}
		return false;
	}

	gotoNextSibling(): boolean {
		if (this.parent && this.parent.children) {
			if (this.index + 1 < this.parent.children.length) {
				this.index++;
				this.currentNode = this.parent.children[this.index];
				return true;
			}
		}
		return false;
	}

	gotoParent(): boolean {
		if (this.stack.length > 0) {
			const frame = this.stack.pop()!;
			this.currentNode = frame.node;
			this.index = frame.index;
			this.parent = frame.parent;
			return true;
		}
		return false;
	}
}

// Mock Tree
const createMockTree = (root: MockNode) => ({
	walk: () => new MockCursor(root),
});

describe("extractDependencies", () => {
	it("extracts JS/TS imports", () => {
		const root: MockNode = {
			type: "program",
			children: [
				{
					type: "import_statement",
					children: [
						{ type: "import_clause", text: "x" },
						{ type: "string", text: '"./utils"' },
					],
				},
				{
					type: "import_statement",
					children: [
						{ type: "string", text: "'react'" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "typescript");
		expect(deps.imports).toContain("./utils");
		expect(deps.imports).toContain("react");
	});

	it("extracts JS/TS exports", () => {
		const root: MockNode = {
			type: "program",
			children: [
				{
					type: "export_statement",
					children: [
						{ type: "string", text: '"./constants"' },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "typescript");
		expect(deps.imports).toContain("./constants");
	});

	it("extracts JS/TS definitions", () => {
		const root: MockNode = {
			type: "program",
			children: [
				{
					type: "function_declaration",
					children: [{ type: "identifier", text: "myFunction" }],
				},
				{
					type: "class_declaration",
					children: [{ type: "identifier", text: "MyClass" }],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "typescript");
		expect(deps.definitions).toContain("myFunction");
		expect(deps.definitions).toContain("MyClass");
	});

	it("extracts Python imports", () => {
		const root: MockNode = {
			type: "module",
			children: [
				{
					type: "import_statement",
					children: [{ type: "dotted_name", text: "os" }],
				},
				{
					type: "import_from_statement",
					children: [
						{ type: "dotted_name", text: "typing" },
						{ type: "dotted_name", text: "List" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "python");
		expect(deps.imports).toContain("os");
		expect(deps.imports).toContain("typing");
	});

	it("extracts Python definitions", () => {
		const root: MockNode = {
			type: "module",
			children: [
				{
					type: "function_definition",
					children: [{ type: "identifier", text: "foo" }],
				},
				{
					type: "class_definition",
					children: [{ type: "identifier", text: "Bar" }],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "python");
		expect(deps.definitions).toContain("foo");
		expect(deps.definitions).toContain("Bar");
	});

	/**
	 * The node shapes below were read off the real grammars with
	 * web-tree-sitter, not guessed: tree-sitter-typescript names a class with
	 * `type_identifier` where tree-sitter-javascript uses `identifier`, and a
	 * Go `type_declaration` holds no identifier of its own at all.
	 */
	it("extracts TypeScript class, interface, type alias and enum names", () => {
		const root: MockNode = {
			type: "program",
			children: [
				// The TS grammar's class name is a type_identifier. Looking only
				// for `identifier` meant no TS class was ever recorded.
				{ type: "class_declaration", children: [{ type: "type_identifier", text: "VectorStore" }] },
				{ type: "interface_declaration", children: [{ type: "type_identifier", text: "FileDeps" }] },
				{ type: "type_alias_declaration", children: [{ type: "type_identifier", text: "ArmName" }] },
				{ type: "enum_declaration", children: [{ type: "identifier", text: "Mode" }] },
			],
		};

		const deps = extractDependencies(createMockTree(root), "typescript");
		expect(deps.definitions).toEqual(
			expect.arrayContaining(["VectorStore", "FileDeps", "ArmName", "Mode"])
		);
	});

	it("still extracts a JavaScript class, whose name is a plain identifier", () => {
		const root: MockNode = {
			type: "program",
			children: [{ type: "class_declaration", children: [{ type: "identifier", text: "Legacy" }] }],
		};

		expect(extractDependencies(createMockTree(root), "javascript").definitions).toContain("Legacy");
	});

	it("extracts Go type names from the type_spec below the declaration", () => {
		const root: MockNode = {
			type: "source_file",
			children: [
				{
					type: "type_declaration",
					children: [
						{
							type: "type_spec",
							children: [
								{ type: "type_identifier", text: "Server" },
								{ type: "struct_type" },
							],
						},
					],
				},
				{
					// A grouped declaration: `type ( Handler interface{}; ID int )`.
					type: "type_declaration",
					children: [
						{ type: "type_spec", children: [{ type: "type_identifier", text: "Handler" }] },
						{ type: "type_spec", children: [{ type: "type_identifier", text: "ID" }] },
					],
				},
				{ type: "function_declaration", children: [{ type: "identifier", text: "New" }] },
				{
					type: "method_declaration",
					children: [
						{ type: "parameter_list" },
						{ type: "field_identifier", text: "Serve" },
						{ type: "parameter_list" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "go");
		expect(deps.definitions).toEqual(
			expect.arrayContaining(["Server", "Handler", "ID", "New", "Serve"])
		);
	});

	it("extracts C++ class and struct names", () => {
		const root: MockNode = {
			type: "translation_unit",
			children: [
				// This used to look for a function_declarator child. A class has
				// none, so no C++ class name was ever recorded.
				{
					type: "class_specifier",
					children: [
						{ type: "type_identifier", text: "TokenValidator" },
						{ type: "field_declaration_list" },
					],
				},
				{
					type: "struct_specifier",
					children: [{ type: "type_identifier", text: "Point" }],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "cpp");
		expect(deps.definitions).toEqual(expect.arrayContaining(["TokenValidator", "Point"]));
	});

	it("extracts a C++ function name through a pointer declarator", () => {
		const root: MockNode = {
			type: "translation_unit",
			children: [
				{
					// `int *make_thing(int n) { ... }`
					type: "function_definition",
					children: [
						{ type: "primitive_type", text: "int" },
						{
							type: "pointer_declarator",
							children: [
								{ type: "*", text: "*" },
								{
									type: "function_declarator",
									children: [
										{ type: "identifier", text: "make_thing" },
										{ type: "parameter_list" },
									],
								},
							],
						},
						{ type: "compound_statement" },
					],
				},
			],
		};

		expect(extractDependencies(createMockTree(root), "cpp").definitions).toContain("make_thing");
	});

	it("does not mistake a C++ return type for the function name", () => {
		const root: MockNode = {
			type: "translation_unit",
			children: [
				{
					// `MyType build(int n) { ... }` — the return type is a
					// type_identifier sitting before the declarator.
					type: "function_definition",
					children: [
						{ type: "type_identifier", text: "MyType" },
						{
							type: "function_declarator",
							children: [
								{ type: "identifier", text: "build" },
								{ type: "parameter_list" },
							],
						},
						{ type: "compound_statement" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "cpp");
		expect(deps.definitions).toContain("build");
		expect(deps.definitions).not.toContain("MyType");
	});

	it("extracts Python module-level assignments as definitions", () => {
		const root: MockNode = {
			type: "module",
			children: [
				{
					type: "assignment",
					children: [{ type: "identifier", text: "CONSTANT" }, { type: "integer", text: "42" }],
				},
				{
					// `limit: int = 10` — the annotation sits between the target
					// and the value, so position-based reads would pick it up.
					type: "assignment",
					children: [
						{ type: "identifier", text: "limit" },
						{ type: "type", text: "int" },
						{ type: "integer", text: "10" },
					],
				},
				{
					// `a, b = 1, 2` binds both names.
					type: "assignment",
					children: [
						{
							type: "pattern_list",
							children: [
								{ type: "identifier", text: "a" },
								{ type: "identifier", text: "b" },
							],
						},
						{ type: "expression_list" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "python");
		expect(deps.definitions).toEqual(expect.arrayContaining(["CONSTANT", "limit", "a", "b"]));
	});

	it("does not treat an assignment's value as a definition", () => {
		const root: MockNode = {
			type: "module",
			children: [
				{
					// `other = compute()` must bind `other`, not `compute`.
					type: "assignment",
					children: [
						{ type: "identifier", text: "other" },
						{ type: "call", children: [{ type: "identifier", text: "compute" }] },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "python");
		expect(deps.definitions).toContain("other");
		expect(deps.definitions).not.toContain("compute");
	});

	it("extracts Rust traits, mods, consts, statics and type aliases", () => {
		const root: MockNode = {
			type: "source_file",
			children: [
				{
					// A visibility_modifier sits in front of the name.
					type: "trait_item",
					children: [
						{ type: "visibility_modifier", text: "pub" },
						{ type: "type_identifier", text: "Visitor" },
					],
				},
				{ type: "mod_item", children: [{ type: "identifier", text: "graph" }] },
				{ type: "const_item", children: [{ type: "identifier", text: "LIMIT" }] },
				{ type: "static_item", children: [{ type: "identifier", text: "NAME" }] },
				{ type: "type_item", children: [{ type: "type_identifier", text: "Alias" }] },
				{ type: "function_item", children: [{ type: "identifier", text: "go" }] },
			],
		};

		const deps = extractDependencies(createMockTree(root), "rust");
		expect(deps.definitions).toEqual(
			expect.arrayContaining(["Visitor", "graph", "LIMIT", "NAME", "Alias", "go"])
		);
	});

	// Java had no case in the language switch at all, so a Java file
	// contributed nothing to the graph.
	it("extracts Java imports", () => {
		const root: MockNode = {
			type: "program",
			children: [
				{
					type: "import_declaration",
					children: [{ type: "scoped_identifier", text: "java.util.List" }],
				},
				{
					type: "import_declaration",
					children: [
						{ type: "static", text: "static" },
						{ type: "scoped_identifier", text: "java.util.Arrays.asList" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "java");
		expect(deps.imports).toContain("java.util.List");
		expect(deps.imports).toContain("java.util.Arrays.asList");
	});

	it("extracts Java classes, interfaces, enums and methods", () => {
		const root: MockNode = {
			type: "program",
			children: [
				{
					type: "class_declaration",
					children: [
						{ type: "modifiers", text: "public" },
						{ type: "identifier", text: "TokenValidator" },
						{
							type: "class_body",
							children: [
								{
									// A return type sits between the modifiers and
									// the name.
									type: "method_declaration",
									children: [
										{ type: "modifiers", text: "public" },
										{ type: "integral_type", text: "int" },
										{ type: "identifier", text: "validate" },
									],
								},
								{
									type: "constructor_declaration",
									children: [{ type: "identifier", text: "TokenValidator" }],
								},
							],
						},
					],
				},
				{ type: "interface_declaration", children: [{ type: "identifier", text: "Validator" }] },
				{ type: "enum_declaration", children: [{ type: "identifier", text: "Mode" }] },
			],
		};

		const deps = extractDependencies(createMockTree(root), "java");
		expect(deps.definitions).toEqual(
			expect.arrayContaining(["TokenValidator", "validate", "Validator", "Mode"])
		);
	});

	it("does not mistake a Java method's return type for its name", () => {
		const root: MockNode = {
			type: "program",
			children: [
				{
					// `public MyType build() { ... }`
					type: "method_declaration",
					children: [
						{ type: "modifiers", text: "public" },
						{ type: "type_identifier", text: "MyType" },
						{ type: "identifier", text: "build" },
					],
				},
			],
		};

		const deps = extractDependencies(createMockTree(root), "java");
		expect(deps.definitions).toContain("build");
		expect(deps.definitions).not.toContain("MyType");
	});
});
