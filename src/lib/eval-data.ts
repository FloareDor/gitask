import evalEmbeddings from "./eval-embeddings.json";
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
};

type EvalEmbeddingsQuery = {
  id: string;
  query: string;
  embedding: number[];
  chunkIds?: string[];
  relevantIds: string[];
  relevanceScores: Record<string, 0 | 1 | 2 | 3>;
};

const chunks = (evalEmbeddings.chunks as unknown as EvalEmbeddingsChunk[]) ?? [];
const queries = (evalEmbeddings.queries as unknown as EvalEmbeddingsQuery[]) ?? [];

function inferName(code: string, fallbackId: string): string {
  const firstLine = code.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? fallbackId;
}

export const EVAL_CHUNKS: EmbeddedChunk[] = chunks.map((chunk) => ({
  id: chunk.id,
  filePath: `codesearchnet/python/${chunk.query_id}/${chunk.id}.py`,
  language: "python",
  nodeType: "function_definition",
  name: inferName(chunk.code, chunk.id),
  code: chunk.code,
  startLine: 1,
  endLine: chunk.code.split("\n").length,
  embedding: chunk.embedding,
}));

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
  name: evalEmbeddings.dataset,
  url: evalEmbeddings.datasetUrl,
  queryCount: evalEmbeddings.queryCount,
  chunkCount: evalEmbeddings.chunkCount,
  model: evalEmbeddings.model,
};
