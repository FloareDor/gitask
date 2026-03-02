import evalEmbeddings from "./eval-embeddings.json";
import evalRepoEmbeddings from "./eval-repo-embeddings.json";
import type { EmbeddedChunk } from "./embedder";

export interface EvalQuery {
  id: string;
  query: string;
  queryEmbedding: number[];
  relevantChunkIds: string[];
  relevanceScores: Record<string, 0 | 1 | 2 | 3>;
}

type EvalEmbeddingsChunk = {
  id: string;
  query_id: string;
  relevance: 0 | 1 | 2 | 3;
  code: string;
  embedding: number[];
  language?: string;
  filePath?: string;
};

type EvalEmbeddingsQuery = {
  id: string;
  query: string;
  embedding: number[];
  chunkIds?: string[];
  relevantIds: string[];
  relevanceScores: Record<string, 0 | 1 | 2 | 3>;
};

type EvalEmbeddingsPayload = {
  chunks?: EvalEmbeddingsChunk[];
  queries?: EvalEmbeddingsQuery[];
  queryCount?: number;
  chunkCount?: number;
  model?: string;
  name?: string;
  url?: string;
  dataset?: string;
  datasetUrl?: string;
};

const payload = evalEmbeddings as unknown as EvalEmbeddingsPayload;
const chunks = payload.chunks ?? [];
const queries = payload.queries ?? [];

function inferName(code: string, fallbackId: string): string {
  const firstLine = code.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? fallbackId;
}

export const EVAL_CHUNKS: EmbeddedChunk[] = chunks.map((chunk) => {
  const lang = chunk.language ?? "python";
  const ext = lang === "python" ? "py" : lang === "javascript" ? "js"
    : lang === "java" ? "java" : lang === "go" ? "go"
    : lang === "php" ? "php" : lang === "ruby" ? "rb" : "txt";
  const filePath = chunk.filePath
    ?? `codesearchnet/${lang}/${chunk.query_id}/${chunk.id}.${ext}`;
  return {
    id: chunk.id,
    filePath,
    language: lang,
    nodeType: "function_definition",
    name: inferName(chunk.code, chunk.id),
    code: chunk.code,
    startLine: 1,
    endLine: chunk.code.split("\n").length,
    embedding: chunk.embedding,
  };
});

export const EVAL_QUERIES: EvalQuery[] = queries.map((query) => {
  const relevanceScores: Record<string, 0 | 1 | 2 | 3> = {};
  for (const [chunkId, score] of Object.entries(query.relevanceScores ?? {})) {
    if (score === 0 || score === 1 || score === 2 || score === 3) {
      relevanceScores[chunkId] = score;
    }
  }

  return {
    id: query.id,
    query: query.query,
    queryEmbedding: query.embedding,
    relevantChunkIds: query.relevantIds,
    relevanceScores,
  };
});

export const DATASET_META = {
  name: payload.name ?? payload.dataset ?? "Unknown dataset",
  url: payload.url ?? payload.datasetUrl ?? "#",
  queryCount: payload.queryCount ?? queries.length,
  chunkCount: payload.chunkCount ?? chunks.length,
  model: payload.model ?? "unknown",
};

// ── Repo eval (gitask src/lib — manually annotated) ──────────────────────────

type RepoPayload = {
  chunks?: Array<{
    id: string;
    filePath: string;
    nodeType: string;
    startLine: number;
    endLine: number;
    code: string;
    embedding: number[];
  }>;
  queries?: Array<{
    id: string;
    query: string;
    embedding: number[];
    relevantIds: string[];
    relevanceScores: Record<string, number>;
  }>;
  queryCount?: number;
  chunkCount?: number;
  model?: string;
  dataset?: string;
  repoUrl?: string;
};

const repoPayload = evalRepoEmbeddings as unknown as RepoPayload;
const repoChunks  = repoPayload.chunks  ?? [];
const repoQueries = repoPayload.queries ?? [];

export const REPO_EVAL_CHUNKS: EmbeddedChunk[] = repoChunks.map((c) => ({
  id:        c.id,
  filePath:  c.filePath,
  language:  "typescript",
  nodeType:  c.nodeType,
  name:      c.id,
  code:      c.code,
  startLine: c.startLine,
  endLine:   c.endLine,
  embedding: c.embedding,
}));

export const REPO_EVAL_QUERIES: EvalQuery[] = repoQueries.map((q) => {
  const relevanceScores: Record<string, 0 | 1 | 2 | 3> = {};
  for (const [cid, score] of Object.entries(q.relevanceScores ?? {})) {
    const s = score as number;
    if (s === 0 || s === 1 || s === 2 || s === 3) {
      relevanceScores[cid] = s as 0 | 1 | 2 | 3;
    }
  }
  return {
    id:               q.id,
    query:            q.query,
    queryEmbedding:   q.embedding,
    relevantChunkIds: q.relevantIds,
    relevanceScores,
  };
});

export const REPO_DATASET_META = {
  name:       repoPayload.dataset ?? "gitask repo eval",
  url:        repoPayload.repoUrl ?? "#",
  queryCount: repoPayload.queryCount ?? repoQueries.length,
  chunkCount: repoPayload.chunkCount ?? repoChunks.length,
  model:      repoPayload.model ?? "unknown",
};
