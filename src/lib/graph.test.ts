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
});
