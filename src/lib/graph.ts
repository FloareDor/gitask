/**
 * Graph Extractor — extracts static dependencies (imports) and definitions (exports/declarations)
 * from source code using Tree-sitter ASTs.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tree = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyntaxNode = any;

export interface FileDependencies {
	imports: string[];
	definitions: string[];
}

export interface FileSymbol {
	name: string;
	kind: string;
	line: number;
}

/**
 * Extract dependencies and definitions from a Tree-sitter tree.
 */
export function extractDependencies(tree: Tree, language: string): FileDependencies {
	const imports: Set<string> = new Set();
	const definitions: Set<string> = new Set();

	const cursor = tree.walk();
	visit(cursor, language, imports, definitions);

	return {
		imports: Array.from(imports),
		definitions: Array.from(definitions),
	};
}

/**
 * Extract symbols (functions, classes, etc.) with location data.
 */
export function extractSymbolsFromTree(tree: Tree, language: string): FileSymbol[] {
	const symbols: FileSymbol[] = [];
	const cursor = tree.walk();

	visitSymbols(cursor, language, symbols);

	return symbols;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function visit(cursor: any, language: string, imports: Set<string>, definitions: Set<string>) {
	const node: SyntaxNode = cursor.currentNode;

	// Language-specific extraction logic
	switch (language) {
		case "javascript":
		case "typescript":
		case "tsx":
			extractJsTs(node, imports, definitions);
			break;
		case "python":
			extractPython(node, imports, definitions);
			break;
		case "go":
			extractGo(node, imports, definitions);
			break;
		case "rust":
			extractRust(node, imports, definitions);
			break;
		case "c":
		case "cpp":
			extractCpp(node, imports, definitions);
			break;
	}

	// Recurse
	if (cursor.gotoFirstChild()) {
		do {
			visit(cursor, language, imports, definitions);
		} while (cursor.gotoNextSibling());
		cursor.gotoParent();
	}
}

function extractJsTs(node: SyntaxNode, imports: Set<string>, definitions: Set<string>) {
	if (node.type === "import_statement") {
		// import ... from "source"
		const source = node.children.find((c: SyntaxNode) => c.type === "string");
		if (source?.text) imports.add(stripQuotes(source.text));
	} else if (node.type === "export_statement") {
		// export ... from "source"
		const source = node.children.find((c: SyntaxNode) => c.type === "string");
		if (source?.text) imports.add(stripQuotes(source.text));
	} else if (node.type === "call_expression") {
		// require("source")
		if (node.text.startsWith("require(")) { // simple check
			const args = node.children.find((c: SyntaxNode) => c.type === "arguments");
			if (args) {
				const source = args.children.find((c: SyntaxNode) => c.type === "string");
				if (source?.text) imports.add(stripQuotes(source.text));
			}
		}
	} else if (
		node.type === "function_declaration" ||
		node.type === "class_declaration" ||
		node.type === "variable_declarator" // const x = ...
	) {
		const nameNode = node.children.find((c: SyntaxNode) => c.type === "identifier");
		if (nameNode?.text) definitions.add(nameNode.text);
	}
}

function extractPython(node: SyntaxNode, imports: Set<string>, definitions: Set<string>) {
	if (node.type === "import_statement") {
		// import x
		// Check 'dotted_name' or 'aliased_import'
		node.children.forEach((c: SyntaxNode) => {
			if (c.type === "dotted_name") imports.add(c.text);
			else if (c.type === "aliased_import") {
				const name = c.children.find((child: SyntaxNode) => child.type === "dotted_name");
				if (name?.text) imports.add(name.text);
			}
		});
	} else if (node.type === "import_from_statement") {
		// from x import y
		const moduleName = node.children.find((c: SyntaxNode) => c.type === "dotted_name" || c.type === "relative_import");
		if (moduleName?.text) imports.add(moduleName.text);
	} else if (node.type === "function_definition" || node.type === "class_definition") {
		const nameNode = node.children.find((c: SyntaxNode) => c.type === "identifier");
		if (nameNode?.text) definitions.add(nameNode.text);
	}
}

function extractGo(node: SyntaxNode, imports: Set<string>, definitions: Set<string>) {
	if (node.type === "import_spec") {
		const path = node.children.find((c: SyntaxNode) => c.type === "interpreted_string_literal");
		if (path?.text) imports.add(stripQuotes(path.text));
	} else if (node.type === "function_declaration" || node.type === "type_declaration") {
		const nameNode = node.children.find((c: SyntaxNode) => c.type === "identifier");
		if (nameNode?.text) definitions.add(nameNode.text);
	}
}

function extractRust(node: SyntaxNode, imports: Set<string>, definitions: Set<string>) {
	if (node.type === "use_declaration") {
		// Simplification: just capture the whole text of the path
		// use std::io; -> std::io
		// tree-sitter-rust structure is complex, text fallback is okay for now
		imports.add(node.text.replace(/^use\s+|;/g, "").trim());
	} else if (node.type === "function_item" || node.type === "struct_item" || node.type === "enum_item") {
		const nameNode = node.children.find((c: SyntaxNode) => c.type === "identifier" || c.type === "type_identifier");
		if (nameNode?.text) definitions.add(nameNode.text);
	}
}

function extractCpp(node: SyntaxNode, imports: Set<string>, definitions: Set<string>) {
	if (node.type === "preproc_include") {
		const path = node.children.find((c: SyntaxNode) => c.type === "string_literal" || c.type === "system_lib_string");
		if (path?.text) imports.add(stripQuotes(path.text, true));
	} else if (node.type === "function_definition" || node.type === "class_specifier") {
		// Declarators are nested in C++, this is a "best effort" top-level check
		const declarator = node.children.find((c: SyntaxNode) => c.type === "function_declarator");
		if (declarator) {
			const name = declarator.children.find((c: SyntaxNode) => c.type === "identifier");
			if (name?.text) definitions.add(name.text);
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function visitSymbols(cursor: any, language: string, symbols: FileSymbol[]) {
	const node: SyntaxNode = cursor.currentNode;
	let kind = "";
	let nameNode: SyntaxNode | null = null;

	// Simple mapping based on node type
	if (node.type === "function_declaration" || node.type === "function_definition" || node.type === "function_item") {
		kind = "function";
	} else if (node.type === "class_declaration" || node.type === "class_definition") {
		kind = "class";
	} else if (node.type === "interface_declaration") {
		kind = "interface";
	} else if (node.type === "method_definition" || node.type === "method_declaration") {
		kind = "method";
	}

	if (kind) {
		// Try to find identifier
		nameNode = node.children.find((c: SyntaxNode) => c.type === "identifier" || c.type === "type_identifier" || c.type === "name");

		if (nameNode?.text) {
			symbols.push({
				name: nameNode.text,
				kind,
				line: node.startPosition.row + 1
			});
		}
	}

	// Recurse
	if (cursor.gotoFirstChild()) {
		do {
			visitSymbols(cursor, language, symbols);
		} while (cursor.gotoNextSibling());
		cursor.gotoParent();
	}
}

function stripQuotes(str: string, includeBrackets = false): string {
	if (str.length < 2) return str;
	const first = str[0];
	const last = str[str.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
		return str.slice(1, -1);
	}
	if (includeBrackets && first === '<' && last === '>') {
		return str.slice(1, -1);
	}
	return str;
}
