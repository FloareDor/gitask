/**
 * Ablation Study — Evaluation Dataset
 *
 * Deterministic synthetic embeddings + mock code chunks for benchmarking
 * the retrieval pipeline without needing the actual embedding model.
 *
 * Uses a seeded PRNG (Mulberry32) so all "embeddings" are reproducible.
 */

import type { EmbeddedChunk } from "./embedder";

// ─── Seeded PRNG ────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeEmbedding(seed: number, dims: number = 384): number[] {
	const rng = mulberry32(seed);
	const vec: number[] = [];
	for (let i = 0; i < dims; i++) {
		vec.push(rng() * 2 - 1); // values in [-1, 1]
	}
	// L2-normalise
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	return vec.map((v) => v / norm);
}

// ─── Mock Code Chunks ───────────────────────────────────────────────────────

const MOCK_CHUNKS_RAW: { id: string; filePath: string; code: string; seed: number }[] = [
	// Embedder module
	{
		id: "embedder::initEmbedder",
		filePath: "src/lib/embedder.ts",
		code: `export async function initEmbedder(onProgress) {
  if (embedPipeline) return;
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  embedPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { device });
}`,
		seed: 1001,
	},
	{
		id: "embedder::embedText",
		filePath: "src/lib/embedder.ts",
		code: `export async function embedText(text) {
  const output = await embedPipeline(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}`,
		seed: 1002,
	},
	{
		id: "embedder::embedChunks",
		filePath: "src/lib/embedder.ts",
		code: `export async function embedChunks(chunks, onProgress, batchSize = 8) {
  await initEmbedder();
  const results = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    for (const chunk of chunks.slice(i, i + batchSize)) {
      const embedding = await embedText(chunk.code);
      results.push({ ...chunk, embedding });
    }
  }
  return results;
}`,
		seed: 1003,
	},
	// Quantize module
	{
		id: "quantize::binarize",
		filePath: "src/lib/quantize.ts",
		code: `export function binarize(vec) {
  const segments = Math.ceil(vec.length / 32);
  const bits = new Uint32Array(segments);
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] > 0) { bits[(i / 32) | 0] |= 1 << (i % 32); }
  }
  return bits;
}`,
		seed: 2001,
	},
	{
		id: "quantize::hammingDistance",
		filePath: "src/lib/quantize.ts",
		code: `export function hammingDistance(a, b) {
  let dist = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let xor = a[i] ^ b[i];
    while (xor) { dist++; xor &= xor - 1; }
  }
  return dist;
}`,
		seed: 2002,
	},
	{
		id: "quantize::cosineSimilarity",
		filePath: "src/lib/quantize.ts",
		code: `export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}`,
		seed: 2003,
	},
	// Search module
	{
		id: "search::hybridSearch",
		filePath: "src/lib/search.ts",
		code: `export function hybridSearch(store, queryEmbedding, query, options = {}) {
  const chunks = store.getAll();
  const vectorScores = vectorSearch(chunks, queryEmbedding, coarseCandidates);
  const keywordScores = keywordSearch(chunks, query);
  const fusedScores = reciprocalRankFusion([vectorScores, keywordScores], rrfK);
  // rerank with cosine similarity
  return reranked.slice(0, limit);
}`,
		seed: 3001,
	},
	{
		id: "search::keywordSearch",
		filePath: "src/lib/search.ts",
		code: `export function keywordSearch(chunks, query) {
  const symbols = query.match(/[a-zA-Z_]\\w+/g) ?? [];
  for (const chunk of chunks) {
    let matchCount = 0;
    for (const sym of symbols) {
      const regex = new RegExp("\\\\b" + sym + "\\\\b", "gi");
      const matches = chunk.code.match(regex);
      if (matches) matchCount += matches.length;
    }
  }
}`,
		seed: 3002,
	},
	{
		id: "search::vectorSearch",
		filePath: "src/lib/search.ts",
		code: `export function vectorSearch(chunks, queryEmbedding, limit = 50) {
  const queryBinary = binarize(new Float32Array(queryEmbedding));
  for (const chunk of chunks) {
    const chunkBinary = binarize(new Float32Array(chunk.embedding));
    const dist = hammingDistance(queryBinary, chunkBinary);
    scored.push({ id: chunk.id, dist });
  }
  scored.sort((a, b) => a.dist - b.dist);
}`,
		seed: 3003,
	},
	{
		id: "search::reciprocalRankFusion",
		filePath: "src/lib/search.ts",
		code: `export function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map();
  for (const ranked of lists) {
    const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([id], rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}`,
		seed: 3004,
	},
	// Chunker module
	{
		id: "chunker::chunkCode",
		filePath: "src/lib/chunker.ts",
		code: `export function chunkCode(filePath, code, language) {
  const lang = language ?? detectLanguage(filePath);
  if (!lang) return chunkByText(filePath, code);
  return chunkByText(filePath, code, lang);
}`,
		seed: 4001,
	},
	{
		id: "chunker::chunkWithTreeSitter",
		filePath: "src/lib/chunker.ts",
		code: `export function chunkWithTreeSitter(filePath, code, parser, language) {
  const tree = parser.parse(code);
  const chunks = [];
  function visit() {
    const node = cursor.currentNode;
    if (CHUNK_NODE_TYPES.has(node.type)) {
      chunks.push({ id, filePath, language, nodeType: node.type, name, code: node.text });
    }
  }
  visit();
  return chunks;
}`,
		seed: 4002,
	},
	{
		id: "chunker::detectLanguage",
		filePath: "src/lib/chunker.ts",
		code: `export function detectLanguage(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? null;
}`,
		seed: 4003,
	},
	// VectorStore module
	{
		id: "vectorStore::VectorStore",
		filePath: "src/lib/vectorStore.ts",
		code: `export class VectorStore {
  private chunks = [];
  insert(chunks) { this.chunks.push(...chunks); }
  getAll() { return this.chunks; }
  get size() { return this.chunks.length; }
  clear() { this.chunks = []; }
  async persist(owner, repo, sha) { /* IndexedDB */ }
  async loadFromCache(owner, repo, sha) { /* IndexedDB */ }
}`,
		seed: 5001,
	},
	// CoVe module
	{
		id: "cove::verifyAndRefine",
		filePath: "src/lib/cove.ts",
		code: `export async function verifyAndRefine(initialAnswer, userQuestion, store) {
  // Step 1: Extract claims
  const claimsText = await generateFull(claimsPrompt);
  // Step 2: Verify against codebase
  for (const claim of claims.slice(0, 3)) {
    const queryEmbedding = await embedText(claim);
    const results = hybridSearch(store, queryEmbedding, claim, { limit: 2 });
  }
  // Step 3: Refine
  return generateFull(refinePrompt);
}`,
		seed: 6001,
	},
	// LLM module
	{
		id: "llm::initLLM",
		filePath: "src/lib/llm.ts",
		code: `export async function initLLM(onProgress) {
  const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");
  const worker = new Worker(new URL("../workers/llm-worker.ts", import.meta.url));
  engine = await CreateWebWorkerMLCEngine(worker, MODEL_ID, { initProgressCallback });
}`,
		seed: 7001,
	},
	{
		id: "llm::generate",
		filePath: "src/lib/llm.ts",
		code: `export async function* generate(messages) {
  const chunks = await engine.chat.completions.create({ messages, temperature: 0.3, max_tokens: 1024, stream: true });
  for await (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}`,
		seed: 7002,
	},
	// GitHub module
	{
		id: "github::fetchRepoTree",
		filePath: "src/lib/github.ts",
		code: `export async function fetchRepoTree(owner, repo, token) {
  const repoRes = await fetch(API_BASE + "/repos/" + owner + "/" + repo, { headers });
  const treeRes = await fetch(treeUrl + "?recursive=1", { headers });
  return { sha, files, truncated };
}`,
		seed: 8001,
	},
	{
		id: "github::fetchFileContent",
		filePath: "src/lib/github.ts",
		code: `export async function fetchFileContent(owner, repo, path, token) {
  const url = "https://raw.githubusercontent.com/" + owner + "/" + repo + "/HEAD/" + path;
  const res = await fetch(url, { headers: headers(token) });
  return res.text();
}`,
		seed: 8002,
	},
	{
		id: "github::isIndexable",
		filePath: "src/lib/github.ts",
		code: `export function isIndexable(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (path.startsWith("node_modules/") || path.startsWith(".git/")) return false;
  return INDEXABLE_EXTENSIONS.has(ext);
}`,
		seed: 8003,
	},
	// Indexer module
	{
		id: "indexer::indexRepository",
		filePath: "src/lib/indexer.ts",
		code: `export async function indexRepository(owner, repo, store, onProgress, token) {
  const tree = await fetchRepoTree(owner, repo, token);
  const cached = await store.loadFromCache(owner, repo, tree.sha);
  if (cached) return;
  const indexableFiles = prioritiseFiles(tree.files.filter(isIndexable));
  const allChunks = [];
  for (const file of indexableFiles) {
    const content = await fetchFileContent(owner, repo, file.path, token);
    allChunks.push(...chunkCode(file.path, content));
  }
  const embedded = await embedChunks(allChunks);
  store.insert(embedded);
  await store.persist(owner, repo, tree.sha);
}`,
		seed: 9001,
	},
	// Additional filler chunks for realistic corpus size
	{
		id: "github::prioritiseFiles",
		filePath: "src/lib/github.ts",
		code: `export function prioritiseFiles(files) {
  const readme = [], src = [], rest = [];
  for (const f of files) {
    if (f.path.toLowerCase() === "readme.md") readme.push(f);
    else if (f.path.startsWith("src/")) src.push(f);
    else rest.push(f);
  }
  return [...readme, ...src, ...rest];
}`,
		seed: 8004,
	},
	{
		id: "chunker::chunkByText",
		filePath: "src/lib/chunker.ts",
		code: `export function chunkByText(filePath, code, language = "text") {
  const MAX_CHARS = 2048;
  const paragraphs = code.split(/\\n\\n+/);
  // merge paragraphs into chunks under MAX_CHARS
  return chunks;
}`,
		seed: 4004,
	},
	{
		id: "llm::generateFull",
		filePath: "src/lib/llm.ts",
		code: `export async function generateFull(messages) {
  const reply = await engine.chat.completions.create({ messages, temperature: 0.2, max_tokens: 512 });
  return reply.choices?.[0]?.message?.content ?? "";
}`,
		seed: 7003,
	},
	{
		id: "llm::disposeLLM",
		filePath: "src/lib/llm.ts",
		code: `export async function disposeLLM() {
  if (engine) { engine = null; initPromise = null; setStatus("idle"); }
}`,
		seed: 7004,
	},
	{
		id: "embedder::isEmbedderReady",
		filePath: "src/lib/embedder.ts",
		code: `export function isEmbedderReady() { return embedPipeline != null; }`,
		seed: 1004,
	},
	{
		id: "llm::onStatusChange",
		filePath: "src/lib/llm.ts",
		code: `export function onStatusChange(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }`,
		seed: 7005,
	},
	{
		id: "github::headers",
		filePath: "src/lib/github.ts",
		code: `function headers(token) {
  const h = { Accept: "application/vnd.github.v3+json" };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}`,
		seed: 8005,
	},
	{
		id: "search::escapeRegex",
		filePath: "src/lib/search.ts",
		code: `function escapeRegex(str) { return str.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"); }`,
		seed: 3005,
	},
	{
		id: "chunker::extractName",
		filePath: "src/lib/chunker.ts",
		code: `function extractName(node) {
  for (const child of node.children ?? []) {
    if (child.type === "identifier" || child.type === "property_identifier") return child.text;
  }
  return null;
}`,
		seed: 4005,
	},
];

export const EVAL_CHUNKS: EmbeddedChunk[] = MOCK_CHUNKS_RAW.map((raw) => ({
	id: raw.id,
	filePath: raw.filePath,
	language: raw.filePath.endsWith(".ts") ? "typescript" : "text",
	nodeType: "function_declaration",
	name: raw.id.split("::")[1],
	code: raw.code,
	startLine: 1,
	endLine: raw.code.split("\n").length,
	embedding: makeEmbedding(raw.seed),
}));

// ─── Queries with Ground Truth ─────────────────────────────────────────────

export interface EvalQuery {
	id: string;
	query: string;
	queryEmbedding: number[];
	/** Chunk IDs that should appear in the top results */
	relevantChunkIds: string[];
}

/**
 * For each query, we generate an embedding close to the target chunks
 * by averaging target embeddings + small perturbation.
 */
function makeQueryEmbedding(targetSeeds: number[], querySeed: number): number[] {
	const targets = targetSeeds.map((s) => makeEmbedding(s));
	const dims = targets[0].length;
	const avg: number[] = new Array(dims).fill(0);
	for (const t of targets) {
		for (let i = 0; i < dims; i++) avg[i] += t[i] / targets.length;
	}
	// Add small noise
	const rng = mulberry32(querySeed);
	for (let i = 0; i < dims; i++) {
		avg[i] += (rng() - 0.5) * 0.1;
	}
	// L2-normalise
	const norm = Math.sqrt(avg.reduce((s, v) => s + v * v, 0));
	return avg.map((v) => v / norm);
}

export const EVAL_QUERIES: EvalQuery[] = [
	{
		id: "q1",
		query: "How does the embedding pipeline work?",
		queryEmbedding: makeQueryEmbedding([1001, 1002, 1003], 10001),
		relevantChunkIds: ["embedder::initEmbedder", "embedder::embedText", "embedder::embedChunks"],
	},
	{
		id: "q2",
		query: "How is binary quantization implemented?",
		queryEmbedding: makeQueryEmbedding([2001, 2002], 10002),
		relevantChunkIds: ["quantize::binarize", "quantize::hammingDistance"],
	},
	{
		id: "q3",
		query: "How does hybrid search work?",
		queryEmbedding: makeQueryEmbedding([3001, 3002, 3003], 10003),
		relevantChunkIds: ["search::hybridSearch", "search::keywordSearch", "search::vectorSearch"],
	},
	{
		id: "q4",
		query: "What does the CoVe verification loop do?",
		queryEmbedding: makeQueryEmbedding([6001], 10004),
		relevantChunkIds: ["cove::verifyAndRefine"],
	},
	{
		id: "q5",
		query: "How are code files chunked using tree sitter AST?",
		queryEmbedding: makeQueryEmbedding([4001, 4002], 10005),
		relevantChunkIds: ["chunker::chunkCode", "chunker::chunkWithTreeSitter"],
	},
	{
		id: "q6",
		query: "How does the vector store persist to IndexedDB?",
		queryEmbedding: makeQueryEmbedding([5001], 10006),
		relevantChunkIds: ["vectorStore::VectorStore"],
	},
	{
		id: "q7",
		query: "How is the LLM initialized with web worker?",
		queryEmbedding: makeQueryEmbedding([7001], 10007),
		relevantChunkIds: ["llm::initLLM"],
	},
	{
		id: "q8",
		query: "How does the repository indexing pipeline orchestrate everything?",
		queryEmbedding: makeQueryEmbedding([9001], 10008),
		relevantChunkIds: ["indexer::indexRepository"],
	},
	{
		id: "q9",
		query: "How do you fetch the repo tree from GitHub API?",
		queryEmbedding: makeQueryEmbedding([8001, 8002], 10009),
		relevantChunkIds: ["github::fetchRepoTree", "github::fetchFileContent"],
	},
	{
		id: "q10",
		query: "What is reciprocal rank fusion and how is it used?",
		queryEmbedding: makeQueryEmbedding([3004, 3001], 10010),
		relevantChunkIds: ["search::reciprocalRankFusion", "search::hybridSearch"],
	},
	{
		id: "q11",
		query: "How does cosine similarity work for reranking?",
		queryEmbedding: makeQueryEmbedding([2003, 3001], 10011),
		relevantChunkIds: ["quantize::cosineSimilarity", "search::hybridSearch"],
	},
	{
		id: "q12",
		query: "How does language detection work for file chunking?",
		queryEmbedding: makeQueryEmbedding([4003, 4001], 10012),
		relevantChunkIds: ["chunker::detectLanguage", "chunker::chunkCode"],
	},
	{
		id: "q13",
		query: "How does streaming LLM generation work?",
		queryEmbedding: makeQueryEmbedding([7002, 7003], 10013),
		relevantChunkIds: ["llm::generate", "llm::generateFull"],
	},
	{
		id: "q14",
		query: "Which file extensions are indexable?",
		queryEmbedding: makeQueryEmbedding([8003], 10014),
		relevantChunkIds: ["github::isIndexable"],
	},
	{
		id: "q15",
		query: "How does the file prioritisation order work for loading?",
		queryEmbedding: makeQueryEmbedding([8004], 10015),
		relevantChunkIds: ["github::prioritiseFiles"],
	},
];
