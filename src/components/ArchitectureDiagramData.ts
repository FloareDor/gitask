export type NodeDef = { id: string; phase: string; title: string; detail: string; file?: string; snippet?: string };

export const INGEST: NodeDef[] = [
  {
    id: "url",
    phase: "Input",
    title: "URL Trigger",
    detail: "Route params resolved, indexing starts",
    file: "src/app/[owner]/[repo]/page.tsx",
    snippet: `useEffect(() => {
  params.then((p) => {
    setOwner(p.owner);
    setRepo(p.repo);
  });
}, [params]);

useEffect(() => {
  if (!owner || !repo) return;
  indexStartTimeRef.current = Date.now();
  const controller = new AbortController();
  const signal = controller.signal;

  (async () => {
    await indexRepository(
      owner, repo, storeRef.current,
      (progress) => setIndexProgress(progress),
      token || undefined, signal
    );
  })();

  return () => controller.abort();
}, [owner, repo, token, reindexKey]);`,
  },
  {
    id: "github",
    phase: "Ingest",
    title: "GitHub Fetch",
    detail: "Repo tree + blobs â†’ browser",
    file: "src/lib/github.ts",
    snippet: `export async function fetchRepoTree(
  owner: string, repo: string, token?: string
): Promise<TreeResponse> {
  const repoRes = await fetch(
    \`\${API_BASE}/repos/\${owner}/\${repo}\`,
    { headers: headers(token) }
  );
  const repoData = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;

  const treeRes = await fetch(
    \`\${API_BASE}/repos/\${owner}/\${repo}/git/trees/\${defaultBranch}?recursive=1\`,
    { headers: headers(token) }
  );
  const treeData = await treeRes.json();

  const files: RepoFile[] = (treeData.tree as any[])
    .filter((item) => item.type === "blob")
    .map((item) => ({
      path: item.path as string,
      size: (item.size ?? 0) as number,
      sha: item.sha as string,
      url: item.url as string,
    }));

  return { sha: repoData.sha || defaultBranch, files, truncated: treeData.truncated ?? false };
}`,
  },
  {
    id: "ast",
    phase: "Parse",
    title: "AST Chunker",
    detail: "tree-sitter WASM semantic splits",
    file: "src/lib/chunker.ts",
    snippet: `export function chunkFromTree(
  filePath: string, code: string, tree: any, language: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const cursor = tree.walk();

  function visit() {
    const node = cursor.currentNode;
    if (CHUNK_NODE_TYPES.has(node.type)) {
      const name = extractName(node) || \`\${node.type}_L\${node.startPosition.row + 1}\`;
      chunks.push({
        id: \`\${filePath}::\${name}\`,
        filePath, language,
        nodeType: node.type, name,
        code: node.text,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
      return;
    }
    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  visit();
  return chunks.length === 0 ? chunkByText(filePath, code, language) : chunks;
}`,
  },
  {
    id: "embed",
    phase: "Compute",
    title: "Embedding Pipeline",
    detail: "transformers.js WebGPU vectors",
    file: "src/lib/embedder.ts",
    snippet: `export async function initEmbedder(
  onProgress?: (msg: string) => void
): Promise<void> {
  if (embedPipeline) return;
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;

    const availability = await detectWebGPUAvailability();
    const device = availability.supported ? "webgpu" : "wasm";
    onProgress?.(\`Using device: \${device}\`);

    embedPipeline = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { device: device as any } as any
    );
  })();

  return pipelinePromise;
}

export async function embedText(text: string): Promise<number[]> {
  if (!embedPipeline) {
    await initEmbedder();
  }
  const output = await embedPipeline(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data as Float32Array);
}`,
  },
  {
    id: "quant",
    phase: "Optimize",
    title: "Binary Quantization",
    detail: "Compressed for fast Hamming search",
    file: "src/lib/quantize.ts",
    snippet: `export function binarize(vec: Float32Array | number[]): Uint32Array {
  const len = vec.length;
  const segments = Math.ceil(len / 32);
  const bits = new Uint32Array(segments);

  for (let i = 0; i < len; i++) {
    if (vec[i] > 0) {
      const seg = (i / 32) | 0;
      const off = i % 32;
      bits[seg] |= 1 << off;
    }
  }
  return bits;
}

export function hammingDistance(a: Uint32Array, b: Uint32Array): number {
  const len = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    let xor = a[i] ^ b[i];
    while (xor) { dist++; xor &= xor - 1; }
  }
  return dist;
}`,
  },
  {
    id: "db",
    phase: "Store",
    title: "Entity-DB (IndexedDB)",
    detail: "Vectors + metadata persisted locally",
    file: "src/lib/vectorStore.ts",
    snippet: `async persist(owner: string, repo: string, sha: string): Promise<void> {
  this.repoKey = \`\${owner}/\${repo}\`;
  const data = { sha, timestamp: Date.now(), chunks: this.chunks, graph: this.graph };

  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gitask-cache", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("repos"))
        db.createObjectStore("repos");
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("repos", "readwrite");
      tx.objectStore("repos").put(data, this.repoKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}`,
  },
];

export const QUERY_TOP: NodeDef[] = [
  {
    id: "q",
    phase: "Input",
    title: "User Question",
    detail: "Natural language query to the repo",
    file: "src/app/[owner]/[repo]/page.tsx",
    snippet: `const handleSend = useCallback(async (overrideText?: string) => {
  const userMessage = (overrideText ?? input).trim();
  if (!userMessage || isGenerating || !isIndexed) return;

  setInput("");
  setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
  setIsGenerating(true);

  const queryVariants = expandQuery(userMessage);
  const results = await multiPathHybridSearch(
    storeRef.current, queryVariants, { limit: 5 }
  );
  const assembled = buildScopedContext(
    results.map((r) => ({ chunk: r.chunk, score: r.score })), limits
  );

  for await (const token of generate(chatMessages)) {
    fullResponse += token;
    setMessages((prev) => {
      const updated = [...prev];
      updated[updated.length - 1] = { role: "assistant", content: fullResponse };
      return updated;
    });
  }
}, [input, isGenerating, isIndexed, messages, owner, repo]);`,
  },
  {
    id: "qe",
    phase: "Expand",
    title: "Query Expansion",
    detail: "Multi-query generation (CodeRAG-style)",
    file: "src/lib/queryExpansion.ts",
    snippet: `const SYMBOL_REGEX = /[a-zA-Z_]\\w+/g;

export function expandQuery(userMessage: string): string[] {
  const trimmed = userMessage.trim();
  if (!trimmed) return [trimmed];

  const symbols = trimmed.match(SYMBOL_REGEX);
  const seen = new Set<string>();
  const variants: string[] = [];

  variants.push(trimmed);
  seen.add(trimmed);

  if (symbols && symbols.length > 0) {
    const codeStyle = symbols.join(" ") + " implementation definition";
    if (!seen.has(codeStyle)) {
      variants.push(codeStyle);
      seen.add(codeStyle);
    }
  }

  return variants;
}`,
  },
];

export const QUERY_BRANCH: NodeDef[] = [
  {
    id: "q1",
    phase: "Search",
    title: "Q1 • Original",
    detail: "Hybrid search. Hamming + regex",
    file: "src/lib/search.ts",
    snippet: `export function vectorSearch(
  chunks: EmbeddedChunk[], queryEmbedding: number[], limit = 50
): Map<string, number> {
  const queryBinary = binarize(new Float32Array(queryEmbedding));
  const scored: { id: string; dist: number }[] = [];

  for (const chunk of chunks) {
    const chunkBinary = binarize(new Float32Array(chunk.embedding));
    const dist = hammingDistance(queryBinary, chunkBinary);
    scored.push({ id: chunk.id, dist });
  }
  scored.sort((a, b) => a.dist - b.dist);

  const results = new Map<string, number>();
  for (let i = 0; i < Math.min(limit, scored.length); i++) {
    results.set(scored[i].id, 1 / (1 + scored[i].dist));
  }
  return results;
}

export function keywordSearch(
  chunks: EmbeddedChunk[], query: string
): Map<string, number> {
  const scores = new Map<string, number>();
  const symbols = query.match(/[a-zA-Z_]\w+/g) ?? [];
  for (const chunk of chunks) {
    let matchCount = 0;
    for (const sym of symbols) {
      const regex = new RegExp(\`\\\\b\${escapeRegex(sym)}\\\\b\`, "gi");
      const matches = chunk.code.match(regex);
      if (matches) matchCount += matches.length;
    }
    if (matchCount > 0) scores.set(chunk.id, matchCount);
  }
  return scores;
}`,
  },
  {
    id: "q2",
    phase: "Search",
    title: "Q2 • Code-Style",
    detail: "Hybrid search. Hamming + regex",
    file: "src/lib/search.ts",
    snippet: `export async function multiPathHybridSearch(
  store: VectorStore,
  queryVariants: string[],
  options: MultiPathSearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 5, coarseCandidates = 50, rrfK = 60, preferenceAlpha = 0.7 } = options;
  const uniqueVariants = [...new Set(queryVariants.map((q) => q.trim()).filter(Boolean))];
  if (uniqueVariants.length === 0) return [];

  const chunks = store.getAll();
  if (chunks.length === 0) return [];
  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  const querySymbols = extractQuerySymbols(uniqueVariants[0]);

  const embeddings = await Promise.all(uniqueVariants.map((q) => embedText(q)));
  const perPathLimit = Math.max(limit * 2, 10);
  const pathResults = await Promise.all(
    uniqueVariants.map((q, i) =>
      hybridSearch(store, embeddings[i], q, { limit: perPathLimit, coarseCandidates, rrfK })
    )
  );

  const scoreMaps = pathResults.map((results) => {
    const m = new Map<string, number>();
    results.forEach((r) => m.set(r.chunk.id, r.score));
    return m;
  });
  const fusedScores = reciprocalRankFusion(scoreMaps, rrfK);
  const rrfTopIds = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, coarseCandidates)
    .map(([id]) => id);

  const primaryEmbedding = embeddings[0];
  const candidates: SearchResult[] = [];
  for (const id of rrfTopIds) {
    const chunk = chunkMap.get(id) as EmbeddedChunk | undefined;
    if (!chunk) continue;
    const score = cosineSimilarity(primaryEmbedding, chunk.embedding);
    candidates.push({ chunk, score, embedding: chunk.embedding });
  }

  const graph = store.getGraph();
  return applyPreferenceRerank(candidates, querySymbols, graph, limit, preferenceAlpha);
}`,
  },
];

export const QUERY_BOTTOM: NodeDef[] = [
  {
    id: "rrf",
    phase: "Merge",
    title: "RRF Fusion",
    detail: "Reciprocal Rank Fusion over both paths",
    file: "src/lib/search.ts",
    snippet: `export function reciprocalRankFusion(
  lists: Map<string, number>[],
  k: number = 60
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const ranked of lists) {
    const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([id], rank) => {
      const prev = scores.get(id) ?? 0;
      scores.set(id, prev + 1 / (k + rank + 1));
    });
  }

  return scores;
}`,
  },
  {
    id: "rerank",
    phase: "Rank",
    title: "Preference Rerank",
    detail: "Matryoshka reranker on candidates",
    file: "src/lib/search.ts",
    snippet: `function computePreferenceScore(
  chunk: EmbeddedChunk,
  querySymbols: string[],
  graph: Record<string, { imports: string[]; definitions: string[] }>
): number {
  if (querySymbols.length === 0) return 0;

  let definitionBonus = 0;
  const fileDefs = graph[chunk.filePath]?.definitions ?? [];
  const symbolSet = new Set(querySymbols.map((s) => s.toLowerCase()));
  if (chunk.name && symbolSet.has(chunk.name.toLowerCase())) {
    definitionBonus = 1;
  } else if (fileDefs.some((d) => symbolSet.has(d.toLowerCase()))) {
    const mentioned = fileDefs.some((d) => {
      if (!symbolSet.has(d.toLowerCase())) return false;
      const regex = new RegExp(\`\\\\b\${escapeRegex(d)}\\\\b\`, "i");
      return regex.test(chunk.code);
    });
    definitionBonus = mentioned ? 0.6 : 0;
  }

  let keywordCount = 0;
  for (const sym of querySymbols) {
    const regex = new RegExp(\`\\\\b\${escapeRegex(sym)}\\\\b\`, "gi");
    if (regex.test(chunk.code)) keywordCount++;
  }
  const keywordRatio = keywordCount / querySymbols.length;

  return Math.min(1, definitionBonus * 0.5 + keywordRatio * 0.5);
}`,
  },
  {
    id: "topk",
    phase: "Select",
    title: "Top-k Chunks",
    detail: "Best chunks assembled for context",
    file: "src/lib/contextAssembly.ts",
    snippet: `export function buildScopedContext(
  candidates: ContextCandidate[],
  limits: ContextAssemblyLimits
): { context: string; meta: ContextAssemblyMeta } {
  const blocks: ScopedBlock[] = candidates.map(({ chunk, score }) => ({
    filePath: chunk.filePath,
    dirPath: getDirectoryPath(chunk.filePath),
    score,
    code: chunk.code,
    nodeType: chunk.nodeType,
  }));

  const rawContext = renderBlocks(blocks);
  if (withinBudget(rawContext, limits)) {
    return {
      context: rawContext,
      meta: buildMeta(rawContext, limits, "none", false),
    };
  }

  const fileCompacted = compactOverflowFiles(blocks, limits);
  const fileContext = renderBlocks(fileCompacted);
  if (withinBudget(fileContext, limits)) {
    return {
      context: fileContext,
      meta: buildMeta(rawContext, limits, "file", false),
    };
  }

  const dirCompacted = compactOverflowDirectories(fileCompacted, limits);
  const dirContext = renderBlocks(dirCompacted);
  if (withinBudget(dirContext, limits)) {
    return {
      context: dirContext,
      meta: buildMeta(rawContext, limits, "directory", false),
    };
  }

  const repoCompacted = compactRepo(dirCompacted, limits);
  const repoContext = renderBlocks(repoCompacted);
  if (withinBudget(repoContext, limits)) {
    return {
      context: repoContext,
      meta: buildMeta(rawContext, limits, "repo", false),
    };
  }

  const truncated = \`\${repoContext.slice(0, limits.maxChars)}\\n...(truncated)\`;
  return {
    context: truncated,
    meta: buildMeta(rawContext, limits, "truncated", true),
  };
}`,
  },
  {
    id: "llm",
    phase: "Inference",
    title: "WebLLM Worker",
    detail: "Qwen2-0.5B in a dedicated web worker",
    file: "src/workers/llm-worker.ts",
    snippet: `// llm-worker.ts â€” dedicated Web Worker
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => { handler.onmessage(msg); };

// --- engine initialization (llm.ts) ---
const worker = new Worker(
  new URL("../workers/llm-worker.ts", import.meta.url),
  { type: "module" }
);
const engine = await CreateWebWorkerMLCEngine(worker, MLC_MODEL_ID, {
  initProgressCallback: (p) => onProgress?.(\`LLM: \${p.text}\`),
  appConfig: {
    model_list: [{
      model: "https://huggingface.co/mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC",
      model_id: MLC_MODEL_ID,
      low_resource_required: true,
      overrides: { context_window_size: 8192 },
    }],
  },
});`,
  },
  {
    id: "ui",
    phase: "Output",
    title: "Chat UI + CoVe",
    detail: "Streamed answer + verification loop",
    file: "src/lib/cove.ts",
    snippet: `export async function verifyAndRefine(
  initialAnswer: string, userQuestion: string, store: VectorStore
): Promise<string> {
  // 1. Extract factual claims
  const claimsText = await generateFull([
    { role: "system", content: "Extract key factual claims as a numbered list." },
    { role: "user", content: initialAnswer },
  ]);
  const claims = claimsText
    .split("\n")
    .filter((l) => /^\d+[.)]/.test(l.trim()))
    .map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
    .slice(0, 3);

  // 2. Verify each claim against the codebase
  const verifications: string[] = [];
  for (const claim of claims) {
    const embedding = await embedText(claim);
    const results = hybridSearch(store, embedding, claim, { limit: 2 });
    if (results.length > 0) {
      const evidence = results
        .map((r) => \`File: \${r.chunk.filePath}\n\`\`\`\n\${r.chunk.code.slice(0, 300)}\n\`\`\`\`)
        .join("\n");
      verifications.push(\`Claim: "\${claim}"\nEvidence:\n\${evidence}\`);
    }
  }

  // 3. Refine with evidence
  return generateFull([
    { role: "system", content: "Correct inaccurate claims based on evidence." },
    { role: "user", content: \`Q: \${userQuestion}\n\nAnswer: \${initialAnswer}\n\nVerifications:\n\${verifications.join("\n\n")}\` },
  ]);
}`,
  },
];