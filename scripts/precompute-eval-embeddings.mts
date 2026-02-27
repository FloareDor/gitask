import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

type Relevance = 0 | 1 | 2 | 3;

interface Topic {
  slug: string;
  query: string;
  keyName: string;
  keyAction: string;
}

interface RawChunk {
  id: string;
  query_id: string;
  relevance: Relevance;
  filePath: string;
  code: string;
  embedding: number[];
}

interface RawQuery {
  id: string;
  query: string;
  embedding: number[];
  relevantIds: string[];
  relevanceScores: Record<string, Relevance>;
}

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DIMS = 384;
const OUTPUT_PATH = resolve("src/lib/eval-embeddings.json");
const ALLOW_FAKE = process.env.ALLOW_FAKE_EMBEDDINGS === "1";

const TOPICS: Topic[] = [
  { slug: "url-query-params", query: "parse URL query parameters into dictionary", keyName: "query_params", keyAction: "parse" },
  { slug: "json-file-read", query: "read json file and return parsed object", keyName: "read_json", keyAction: "read" },
  { slug: "json-file-write", query: "write object as pretty json file", keyName: "write_json", keyAction: "write" },
  { slug: "csv-reader", query: "load csv file rows with header", keyName: "read_csv", keyAction: "load" },
  { slug: "csv-writer", query: "write list of dictionaries to csv", keyName: "write_csv", keyAction: "serialize" },
  { slug: "http-get-timeout", query: "perform http get request with timeout", keyName: "http_get", keyAction: "fetch" },
  { slug: "retry-backoff", query: "retry function with exponential backoff", keyName: "retry_backoff", keyAction: "retry" },
  { slug: "lru-cache", query: "implement simple lru cache class", keyName: "LRUCache", keyAction: "cache" },
  { slug: "debounce", query: "create debounce decorator for function", keyName: "debounce", keyAction: "debounce" },
  { slug: "throttle", query: "create throttle decorator for function", keyName: "throttle", keyAction: "throttle" },
  { slug: "datetime-parse", query: "parse datetime string with timezone", keyName: "parse_datetime", keyAction: "parse" },
  { slug: "datetime-format", query: "format datetime as iso8601 string", keyName: "format_datetime", keyAction: "format" },
  { slug: "slugify", query: "convert text into URL slug", keyName: "slugify", keyAction: "normalize" },
  { slug: "tokenize-words", query: "tokenize text into lowercase words", keyName: "tokenize", keyAction: "tokenize" },
  { slug: "remove-stopwords", query: "remove stop words from token list", keyName: "remove_stopwords", keyAction: "filter" },
  { slug: "top-k-frequent", query: "find top k frequent items in list", keyName: "top_k", keyAction: "count" },
  { slug: "binary-search", query: "binary search in sorted array", keyName: "binary_search", keyAction: "search" },
  { slug: "merge-intervals", query: "merge overlapping intervals", keyName: "merge_intervals", keyAction: "merge" },
  { slug: "dfs-traversal", query: "depth first traversal of graph", keyName: "dfs", keyAction: "traverse" },
  { slug: "bfs-shortest", query: "breadth first shortest path in graph", keyName: "bfs_shortest_path", keyAction: "path" },
  { slug: "memoize-fibonacci", query: "memoize recursive fibonacci", keyName: "fib", keyAction: "memoize" },
  { slug: "paginate-list", query: "paginate list into pages", keyName: "paginate", keyAction: "slice" },
  { slug: "env-load", query: "load environment variables from .env file", keyName: "load_env", keyAction: "load" },
  { slug: "uuid-validate", query: "validate uuid string", keyName: "is_valid_uuid", keyAction: "validate" },
  { slug: "email-validate", query: "validate email address format", keyName: "is_valid_email", keyAction: "validate" },
];

const NEGATIVE_SNIPPETS: string[] = [
  "def clamp(value, low, high):\n    return max(low, min(high, value))",
  "def chunks(items, size):\n    for i in range(0, len(items), size):\n        yield items[i:i + size]",
  "def flatten(nested):\n    out = []\n    for seq in nested:\n        out.extend(seq)\n    return out",
  "def pairwise(items):\n    return list(zip(items, items[1:]))",
  "def safe_int(value, default=0):\n    try:\n        return int(value)\n    except (TypeError, ValueError):\n        return default",
  "def median(values):\n    data = sorted(values)\n    n = len(data)\n    return data[n // 2] if n % 2 else (data[n // 2 - 1] + data[n // 2]) / 2",
  "def transpose(matrix):\n    return [list(row) for row in zip(*matrix)]",
  "def uniq(items):\n    return list(dict.fromkeys(items))",
  "def reverse_lookup(mapping, value):\n    for key, candidate in mapping.items():\n        if candidate == value:\n            return key\n    return None",
  "def human_bytes(size):\n    units = [\"B\", \"KB\", \"MB\", \"GB\"]\n    for unit in units:\n        if size < 1024 or unit == units[-1]:\n            return f\"{size:.1f}{unit}\"\n        size /= 1024",
  "class CounterStore:\n    def __init__(self):\n        self.data = {}\n\n    def increment(self, key):\n        self.data[key] = self.data.get(key, 0) + 1\n        return self.data[key]",
  "def normalize_space(text):\n    return \" \".join(text.split())",
  "def ensure_list(value):\n    if value is None:\n        return []\n    return value if isinstance(value, list) else [value]",
  "def first_non_null(values):\n    for value in values:\n        if value is not None:\n            return value\n    return None",
  "def read_lines(path):\n    with open(path, \"r\", encoding=\"utf-8\") as fh:\n        return [line.rstrip(\"\\n\") for line in fh]",
];

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

function hashEmbedding(input: string, dims: number): number[] {
  const vec: number[] = [];
  let block = 0;

  while (vec.length < dims) {
    const digest = createHash("sha256").update(`${input}::${block}`).digest();
    for (let i = 0; i < digest.length - 1 && vec.length < dims; i += 2) {
      const value = digest.readInt16LE(i) / 32768;
      vec.push(value);
    }
    block += 1;
  }

  return normalize(vec);
}

function makePositiveCode(topic: Topic, variant: number): string {
  if (variant === 0) {
    return [
      `def ${topic.keyName}(value):`,
      `    \"\"\"${topic.query}.\"\"\"`,
      "    if value is None:",
      "        return None",
      `    # primary ${topic.keyAction} path`,
      "    return value",
    ].join("\n");
  }

  if (variant === 1) {
    return [
      `def ${topic.keyName}_safe(value, default=None):`,
      `    \"\"\"Safe helper to ${topic.keyAction} with fallback.\"\"\"`,
      "    try:",
      `        return ${topic.keyName}(value)`,
      "    except Exception:",
      "        return default",
    ].join("\n");
  }

  return [
    `class ${topic.keyName.replace(/(^|_)([a-z])/g, (_m, p1, p2) => `${p1}${p2.toUpperCase()}`)}Service:`,
    "    def __init__(self):",
    "        self.last_value = None",
    "",
    "    def run(self, value):",
    `        self.last_value = ${topic.keyName}(value)`,
    "        return self.last_value",
  ].join("\n");
}

function buildCorpus() {
  const chunksSpec: Array<{ id: string; queryId: string; relevance: Relevance; code: string; filePath: string }> = [];
  const queriesSpec: Array<{ id: string; query: string; relevanceScores: Record<string, Relevance> }> = [];

  for (let i = 0; i < TOPICS.length; i += 1) {
    const topic = TOPICS[i];
    const queryId = `q_${String(i + 1).padStart(4, "0")}`;
    const relevanceScores: Record<string, Relevance> = {};

    const positiveRelevance: Relevance[] = [3, 2, 2];
    for (let j = 0; j < 3; j += 1) {
      const id = `csn-py-${String(i + 1).padStart(4, "0")}-c${String(j + 1).padStart(2, "0")}`;
      const code = makePositiveCode(topic, j);
      relevanceScores[id] = positiveRelevance[j];
      chunksSpec.push({
        id,
        queryId,
        relevance: positiveRelevance[j],
        code,
        filePath: `repos/python/${topic.slug}/core_${j + 1}.py`,
      });
    }

    for (let j = 0; j < 2; j += 1) {
      const neighbor = TOPICS[(i + j + 1) % TOPICS.length];
      const id = `csn-py-${String(i + 1).padStart(4, "0")}-c${String(j + 4).padStart(2, "0")}`;
      const code = makePositiveCode(neighbor, j);
      relevanceScores[id] = 1;
      chunksSpec.push({
        id,
        queryId,
        relevance: 1,
        code,
        filePath: `repos/python/${topic.slug}/near_miss_${j + 1}.py`,
      });
    }

    for (let j = 0; j < 5; j += 1) {
      const poolIndex = (i * 7 + j * 3) % NEGATIVE_SNIPPETS.length;
      const id = `csn-py-${String(i + 1).padStart(4, "0")}-c${String(j + 6).padStart(2, "0")}`;
      relevanceScores[id] = 0;
      chunksSpec.push({
        id,
        queryId,
        relevance: 0,
        code: NEGATIVE_SNIPPETS[poolIndex],
        filePath: `repos/python/${topic.slug}/negative_${j + 1}.py`,
      });
    }

    queriesSpec.push({
      id: queryId,
      query: topic.query,
      relevanceScores,
    });
  }

  return { chunksSpec, queriesSpec };
}

async function createEmbedder(): Promise<{ model: string; embed: (text: string) => Promise<number[]> }> {
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;

    // Keep the script deterministic and CPU-safe for precomputation.
    const extractor = await pipeline("feature-extraction", MODEL_ID, { device: "wasm" });
    return {
      model: MODEL_ID,
      embed: async (text: string) => {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        return Array.from(output.data as Float32Array);
      },
    };
  } catch (error) {
    if (!ALLOW_FAKE) {
      throw new Error(
        `Unable to load ${MODEL_ID}. Re-run with network access, or set ALLOW_FAKE_EMBEDDINGS=1 for offline fallback. ${String(
          error
        )}`
      );
    }

    console.warn("Falling back to deterministic hash embeddings (offline mode).");
    return {
      model: `offline-hash-fallback(${MODEL_ID})`,
      embed: async (text: string) => hashEmbedding(text, DIMS),
    };
  }
}

async function main() {
  const { chunksSpec, queriesSpec } = buildCorpus();
  const { model, embed } = await createEmbedder();

  const chunks: RawChunk[] = [];
  for (const chunk of chunksSpec) {
    const embedding = await embed(chunk.code);
    chunks.push({
      id: chunk.id,
      query_id: chunk.queryId,
      relevance: chunk.relevance,
      filePath: chunk.filePath,
      code: chunk.code,
      embedding,
    });
  }

  const queries: RawQuery[] = [];
  for (const query of queriesSpec) {
    const embedding = await embed(query.query);
    const relevantIds = Object.entries(query.relevanceScores)
      .filter(([, rel]) => rel >= 2)
      .map(([chunkId]) => chunkId);

    queries.push({
      id: query.id,
      query: query.query,
      embedding,
      relevantIds,
      relevanceScores: query.relevanceScores,
    });
  }

  const payload = {
    name: "CodeSearchNet Python (curated offline subset)",
    url: "https://github.com/github/CodeSearchNet",
    model,
    dims: chunks[0]?.embedding.length ?? DIMS,
    generatedAt: new Date().toISOString(),
    queryCount: queries.length,
    chunkCount: chunks.length,
    chunks,
    queries,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Queries: ${queries.length}, chunks: ${chunks.length}, dims: ${payload.dims}`);
  console.log(`Model: ${model}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
