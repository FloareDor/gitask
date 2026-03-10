import { generateFull, getLLMConfig } from "./llm";
import { multiPathHybridSearch } from "./search";
import type { VectorStore } from "./vectorStore";

export type NodeCategory =
	| "service"
	| "database"
	| "queue"
	| "external"
	| "component"
	| "function";

export interface DiagramNode {
	id: string;
	label: string;
	sublabel?: string;
	category: NodeCategory;
}

export interface DiagramEdge {
	source: string;
	target: string;
	label?: string;
}

export interface DiagramData {
	title: string;
	nodes: DiagramNode[];
	edges: DiagramEdge[];
}

const SYSTEM_PROMPT = `You analyze codebases and produce data flow diagrams.
Return ONLY valid JSON — no markdown fences, no explanation, no extra text.

Schema:
{
  "title": "short descriptive title (max 8 words)",
  "nodes": [
    { "id": "snake_case_id", "label": "Node Name", "sublabel": "optional short description", "category": "service|database|queue|external|component|function" }
  ],
  "edges": [
    { "source": "id1", "target": "id2", "label": "optional short action label" }
  ]
}

Rules:
- 5 to 12 nodes total
- All IDs: lowercase, underscores only, unique
- All edge sources and targets must be valid node IDs
- Focus on the main data flow, not every internal call
- Choose the category that best describes each node's role`;

function extractJSON(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return trimmed;
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
	throw new Error("Could not extract JSON from LLM response");
}

const VALID_CATEGORIES = new Set<string>([
	"service", "database", "queue", "external", "component", "function",
]);

export function parseDiagramData(raw: unknown): DiagramData {
	if (!raw || typeof raw !== "object") throw new Error("Response is not an object");
	const d = raw as Record<string, unknown>;
	if (typeof d.title !== "string" || !d.title.trim()) throw new Error("Missing title");
	if (!Array.isArray(d.nodes) || d.nodes.length < 2) throw new Error("Need at least 2 nodes");
	if (!Array.isArray(d.edges)) throw new Error("Missing edges");

	const nodeIds = new Set<string>();
	const nodes: DiagramNode[] = d.nodes.map((n, i) => {
		if (!n || typeof n !== "object") throw new Error(`Node ${i} invalid`);
		const node = n as Record<string, unknown>;
		if (typeof node.id !== "string" || !node.id) throw new Error(`Node ${i} missing id`);
		if (typeof node.label !== "string" || !node.label) throw new Error(`Node ${i} missing label`);
		if (nodeIds.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
		nodeIds.add(node.id);
		return {
			id: node.id,
			label: node.label,
			sublabel: typeof node.sublabel === "string" && node.sublabel ? node.sublabel : undefined,
			category: VALID_CATEGORIES.has(String(node.category))
				? (node.category as NodeCategory)
				: "component",
		};
	});

	const edges: DiagramEdge[] = (d.edges as unknown[])
		.filter((e) => {
			if (!e || typeof e !== "object") return false;
			const edge = e as Record<string, unknown>;
			return (
				typeof edge.source === "string" && nodeIds.has(edge.source) &&
				typeof edge.target === "string" && nodeIds.has(edge.target) &&
				edge.source !== edge.target
			);
		})
		.map((e) => {
			const edge = e as Record<string, unknown>;
			return {
				source: edge.source as string,
				target: edge.target as string,
				label: typeof edge.label === "string" && edge.label ? edge.label : undefined,
			};
		});

	return { title: d.title.trim(), nodes, edges };
}

const MESSAGE_VIZ_PROMPT = `You extract visual flow diagrams from explanations about code or architecture.
Given an AI-generated explanation, identify the key entities and relationships and return them as a diagram.
Return ONLY valid JSON — no markdown fences, no extra text.

Schema:
{
  "title": "short title max 8 words",
  "nodes": [{ "id": "snake_case", "label": "Name", "sublabel": "optional short description", "category": "service|database|queue|external|component|function" }],
  "edges": [{ "source": "id1", "target": "id2", "label": "optional short action label" }]
}

Rules:
- 4 to 10 nodes focused on the specific flow described
- All IDs: lowercase underscores, unique
- All edge sources/targets must be valid node IDs
- If no clear flow or process is described, return {"skip": true}`;

export async function generateMessageDiagram(messageContent: string): Promise<DiagramData | null> {
	const response = await generateFull([
		{ role: "system", content: MESSAGE_VIZ_PROMPT },
		{
			role: "user",
			content: `Extract a flow diagram from this explanation:\n\n${messageContent.slice(0, 4000)}`,
		},
	]);

	const json = extractJSON(response);
	const parsed = JSON.parse(json) as unknown;
	if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).skip === true) {
		return null;
	}
	return parseDiagramData(parsed);
}

const QUERY_DIAGRAM_PROMPT = `You generate query-specific diagrams to accompany code explanations.

Given a user's question and code context, decide:
- If the question explains a flow, process, architecture, pipeline, or sequence → return a JSON diagram
- If NOT (greeting, "bruh", simple lookup, yes/no, vague, off-topic, no clear process) → return {"skip": true}

Return ONLY valid JSON. For diagrams use this schema:
{
  "title": "short title max 8 words",
  "nodes": [{ "id": "snake_case", "label": "Name", "sublabel": "optional", "category": "service|database|queue|external|component|function" }],
  "edges": [{ "source": "id1", "target": "id2", "label": "optional" }]
}

Rules:
- 4 to 10 nodes, focused on the specific flow in the question
- All IDs: lowercase underscores, unique
- All edge sources/targets must be valid node IDs
- Return {"skip": true} for anything that doesn't involve an explainable process or flow`;

export async function generateQueryDiagram(
	query: string,
	codeContext: string,
	owner: string,
	repo: string,
): Promise<DiagramData | null> {
	const config = getLLMConfig();
	if (config.provider !== "gemini" && config.provider !== "groq") return null;

	const response = await generateFull([
		{ role: "system", content: QUERY_DIAGRAM_PROMPT },
		{
			role: "user",
			content: `Repository: ${owner}/${repo}\nQuestion: "${query}"\n\nCode context:\n${codeContext}\n\nReturn diagram JSON or {"skip": true}.`,
		},
	]);

	const json = extractJSON(response);
	const parsed = JSON.parse(json) as unknown;
	if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).skip === true) {
		return null;
	}
	return parseDiagramData(parsed);
}

export async function generateRepoDiagram(
	owner: string,
	repo: string,
	store: VectorStore,
): Promise<DiagramData> {
	const config = getLLMConfig();
	if (config.provider !== "gemini" && config.provider !== "groq") {
		throw new Error(
			"Diagrams require Gemini or Groq. Switch providers in LLM Settings.",
		);
	}

	const queries = [
		"data flow architecture entry point main pipeline",
		"core processing service module handler",
	];
	const results = await multiPathHybridSearch(store, queries, { limit: 10 });

	const context = results
		.slice(0, 7)
		.map((r) => `// ${r.chunk.filePath}\n${r.chunk.code.slice(0, 500)}`)
		.join("\n\n---\n\n");

	const response = await generateFull([
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content: `Repository: ${owner}/${repo}\n\nRelevant code:\n${context}\n\nGenerate the data flow diagram JSON.`,
		},
	]);

	const json = extractJSON(response);
	const parsed = JSON.parse(json) as unknown;
	return parseDiagramData(parsed);
}
