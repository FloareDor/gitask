"""
Generate src/lib/eval-repo-embeddings.json — a repo-level eval set for gitask.

Unlike CodeSearchNet (function retrieval), this eval tests whether the retriever
can locate the right SOURCE FILES when asked natural-language questions about the
gitask codebase — which is what users actually do.

Corpus  : all chunks from src/lib/*.ts (excluding test files, generated files)
Queries : 50 manually annotated questions about the gitask codebase
Relevance: file-level — all chunks from relevant files are marked relevant (score=2),
            chunks from closely related files are scored 1.

Requirements:
    pip install sentence-transformers numpy

Usage:
    python scripts/generate_eval_repo.py
    python scripts/generate_eval_repo.py --chunk-size 600 --overlap 80
"""

import argparse, json, re
from datetime import datetime, timezone
from pathlib import Path

MODEL_ID  = "sentence-transformers/all-MiniLM-L6-v2"
OUT_PATH  = Path(__file__).parent.parent / "src" / "lib" / "eval-repo-embeddings.json"
REPO_ROOT = Path(__file__).parent.parent

# Source files to include in the corpus (relative to REPO_ROOT)
CORPUS_FILES = [
    "src/lib/search.ts",
    "src/lib/chunker.ts",
    "src/lib/contextAssembly.ts",
    "src/lib/cove.ts",
    "src/lib/directorySummary.ts",
    "src/lib/embedder.ts",
    "src/lib/gemini-vault.ts",
    "src/lib/github.ts",
    "src/lib/graph.ts",
    "src/lib/indexer.ts",
    "src/lib/llm.ts",
    "src/lib/metrics.ts",
    "src/lib/quantize.ts",
    "src/lib/queryExpansion.ts",
    "src/lib/vectorStore.ts",
    "src/lib/webgpu.ts",
]

# ── Manually annotated queries ───────────────────────────────────────────────
#
# Format: (query_text, [primary_files], [secondary_files])
# primary_files   → all their chunks scored 2 (directly relevant)
# secondary_files → all their chunks scored 1 (related, useful context)
#
QUERIES = [
    # Search & retrieval
    ("how does vector similarity search work",
     ["src/lib/search.ts"], ["src/lib/quantize.ts"]),
    ("how is RRF reciprocal rank fusion implemented",
     ["src/lib/search.ts"], []),
    ("how does hybrid search combine keyword and vector results",
     ["src/lib/search.ts"], ["src/lib/queryExpansion.ts"]),
    ("how does keyword search score code chunks",
     ["src/lib/search.ts"], []),
    ("how does the multipath search generate multiple query variants",
     ["src/lib/search.ts", "src/lib/queryExpansion.ts"], []),
    ("how are search results reranked using cosine similarity",
     ["src/lib/search.ts", "src/lib/quantize.ts"], []),
    ("what is the coarse candidates step in hybrid search",
     ["src/lib/search.ts"], []),
    ("how does the preference alpha parameter affect search",
     ["src/lib/search.ts"], []),

    # Chunking
    ("how are source files split into code chunks",
     ["src/lib/chunker.ts"], []),
    ("how does AST-based chunking work",
     ["src/lib/chunker.ts", "src/lib/graph.ts"], []),
    ("how are large files summarized during indexing",
     ["src/lib/chunker.ts"], ["src/lib/directorySummary.ts"]),
    ("how does text chunking fall back when AST is unavailable",
     ["src/lib/chunker.ts"], []),
    ("how are chunk size limits enforced",
     ["src/lib/chunker.ts"], []),
    ("how are directory summaries created from file stats",
     ["src/lib/directorySummary.ts"], ["src/lib/chunker.ts"]),

    # Embedder
    ("how is the embedding model initialized in the browser",
     ["src/lib/embedder.ts"], ["src/lib/webgpu.ts"]),
    ("how are code chunks embedded in batches",
     ["src/lib/embedder.ts"], []),
    ("how is mean pooling applied to get a single embedding vector",
     ["src/lib/embedder.ts"], []),
    ("how does WebGPU acceleration work for embeddings",
     ["src/lib/embedder.ts", "src/lib/webgpu.ts"], []),

    # Indexer
    ("how does the indexer orchestrate fetching and embedding",
     ["src/lib/indexer.ts"], ["src/lib/github.ts", "src/lib/embedder.ts"]),
    ("how are repository files fetched from GitHub",
     ["src/lib/github.ts", "src/lib/indexer.ts"], []),
    ("how is indexing resumable after tab close",
     ["src/lib/indexer.ts", "src/lib/vectorStore.ts"], []),
    ("how is indexing cancelled with an abort signal",
     ["src/lib/indexer.ts"], []),
    ("how does the indexer detect and fail on truncated repo trees",
     ["src/lib/indexer.ts", "src/lib/github.ts"], []),
    ("how are file priorities determined during indexing",
     ["src/lib/github.ts"], ["src/lib/indexer.ts"]),
    ("how are non-indexable files filtered out",
     ["src/lib/github.ts"], []),
    ("how is the dependency graph built from import statements",
     ["src/lib/graph.ts", "src/lib/indexer.ts"], []),

    # Vector store
    ("how are embeddings persisted to IndexedDB",
     ["src/lib/vectorStore.ts"], []),
    ("how does the vector store cache invalidate on new commits",
     ["src/lib/vectorStore.ts"], ["src/lib/indexer.ts"]),
    ("how does partial indexing progress get saved and restored",
     ["src/lib/vectorStore.ts", "src/lib/indexer.ts"], []),
    ("how are chunks looked up by file path",
     ["src/lib/vectorStore.ts"], []),

    # LLM
    ("how is the Gemini API called for chat responses",
     ["src/lib/llm.ts"], []),
    ("how does the Web-LLM MLC engine get initialized",
     ["src/lib/llm.ts"], ["src/lib/webgpu.ts"]),
    ("how does the LLM streaming response work",
     ["src/lib/llm.ts"], []),
    ("how is the active LLM provider determined at runtime",
     ["src/lib/llm.ts"], []),
    ("how are Gemini API errors normalized and surfaced",
     ["src/lib/llm.ts"], []),
    ("how does the generateFull function work for non-streaming calls",
     ["src/lib/llm.ts"], []),

    # Security / keys
    ("how are API keys encrypted and stored in the browser",
     ["src/lib/gemini-vault.ts"], ["src/lib/llm.ts"]),
    ("how does the BYOK vault manage key scope and unlock",
     ["src/lib/gemini-vault.ts"], []),
    ("how does the local fallback key storage work without the vault",
     ["src/lib/llm.ts"], ["src/lib/gemini-vault.ts"]),

    # Context assembly
    ("how is the LLM context window assembled from search results",
     ["src/lib/contextAssembly.ts"], []),
    ("how is context truncated when it exceeds the token budget",
     ["src/lib/contextAssembly.ts"], []),
    ("how are token budgets set per provider",
     ["src/lib/contextAssembly.ts"], ["src/lib/llm.ts"]),

    # CoVe
    ("how does CoVe chain of verification refine answers",
     ["src/lib/cove.ts"], []),
    ("what prompts does CoVe use to verify and revise responses",
     ["src/lib/cove.ts"], []),

    # Query expansion
    ("how are query variants generated for multi-path search",
     ["src/lib/queryExpansion.ts"], ["src/lib/search.ts"]),
    ("what synonym and sub-query strategies does query expansion use",
     ["src/lib/queryExpansion.ts"], []),

    # Quantization
    ("how does binary quantization compress embeddings",
     ["src/lib/quantize.ts"], ["src/lib/search.ts"]),
    ("how is Hamming distance used in the vector search",
     ["src/lib/quantize.ts", "src/lib/search.ts"], []),

    # Metrics
    ("how are search and embedding metrics recorded",
     ["src/lib/metrics.ts"], []),

    # Graph
    ("how are code symbols extracted from AST trees",
     ["src/lib/graph.ts"], ["src/lib/chunker.ts"]),
    ("how does the symbol extraction handle imports and exports",
     ["src/lib/graph.ts"], []),
]


# ── Text chunker ─────────────────────────────────────────────────────────────

def chunk_text(file_path: str, content: str, chunk_size: int, overlap: int) -> list[dict]:
    """Split file content into overlapping character chunks."""
    chunks: list[dict] = []
    lines  = content.splitlines(keepends=True)

    current = ""
    start_line = 1
    line_num   = 1
    chunk_idx  = 0

    for line in lines:
        current += line
        if len(current) >= chunk_size:
            chunk_id = f"{file_path}::chunk_{chunk_idx:04d}"
            chunks.append({
                "id":        chunk_id,
                "filePath":  file_path,
                "nodeType":  "chunk",
                "startLine": start_line,
                "endLine":   line_num,
                "code":      current.strip()[:chunk_size + 200],
            })
            chunk_idx += 1
            # overlap: keep last `overlap` chars
            current    = current[-overlap:] if overlap > 0 else ""
            start_line = line_num
        line_num += 1

    # Remainder
    if current.strip():
        chunk_id = f"{file_path}::chunk_{chunk_idx:04d}"
        chunks.append({
            "id":        chunk_id,
            "filePath":  file_path,
            "nodeType":  "chunk",
            "startLine": start_line,
            "endLine":   line_num - 1,
            "code":      current.strip()[:chunk_size + 200],
        })

    return chunks


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunk-size", type=int, default=500,
                        help="Target chunk size in characters (default 500)")
    parser.add_argument("--overlap",    type=int, default=60,
                        help="Overlap between consecutive chunks in characters (default 60)")
    parser.add_argument("--output",     default=str(OUT_PATH))
    args = parser.parse_args()

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        import sys
        sys.exit("Install requirements: pip install sentence-transformers numpy")

    # ── Build corpus ──────────────────────────────────────────────────────────
    all_chunks: list[dict] = []
    file_to_chunk_ids: dict[str, list[str]] = {}

    print("Chunking source files...")
    for rel_path in CORPUS_FILES:
        abs_path = REPO_ROOT / rel_path
        if not abs_path.exists():
            print(f"  WARN: not found — {rel_path}")
            continue
        content = abs_path.read_text(encoding="utf-8")
        chunks  = chunk_text(rel_path, content, args.chunk_size, args.overlap)
        all_chunks.extend(chunks)
        file_to_chunk_ids[rel_path] = [c["id"] for c in chunks]
        print(f"  {rel_path}: {len(chunks)} chunks")

    print(f"Total corpus: {len(all_chunks)} chunks from {len(file_to_chunk_ids)} files")

    # ── Build query set ───────────────────────────────────────────────────────
    queries_raw: list[dict] = []

    for qi, (query_text, primary_files, secondary_files) in enumerate(QUERIES):
        qid = f"repo_q_{qi:03d}"
        rel_scores: dict[str, int] = {}

        for f in primary_files:
            for cid in file_to_chunk_ids.get(f, []):
                rel_scores[cid] = 2

        for f in secondary_files:
            for cid in file_to_chunk_ids.get(f, []):
                if cid not in rel_scores:
                    rel_scores[cid] = 1

        relevant_ids = [cid for cid, score in rel_scores.items() if score >= 2]

        if not relevant_ids:
            print(f"  WARN: no relevant chunks for query {qi}: {query_text[:60]}")
            continue

        queries_raw.append({
            "id":              qid,
            "query":           query_text,
            "relevantIds":     relevant_ids,
            "relevanceScores": rel_scores,
        })

    print(f"Queries: {len(queries_raw)}")

    # ── Embed ─────────────────────────────────────────────────────────────────
    print(f"\nLoading model: {MODEL_ID} ...")
    model = SentenceTransformer(MODEL_ID)

    print(f"Embedding {len(all_chunks)} corpus chunks...")
    chunk_texts = [c["code"] for c in all_chunks]
    chunk_embs  = model.encode(
        chunk_texts, batch_size=64,
        show_progress_bar=True, normalize_embeddings=True
    )
    for c, emb in zip(all_chunks, chunk_embs):
        c["embedding"] = emb.tolist()

    print(f"Embedding {len(queries_raw)} queries...")
    query_texts = [q["query"] for q in queries_raw]
    query_embs  = model.encode(
        query_texts, batch_size=64,
        show_progress_bar=True, normalize_embeddings=True
    )
    for q, emb in zip(queries_raw, query_embs):
        q["embedding"] = emb.tolist()

    # ── Write ─────────────────────────────────────────────────────────────────
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Strip embeddings from output for compact storage of chunk metadata
    chunks_out = [
        {k: v for k, v in c.items()}
        for c in all_chunks
    ]

    output = {
        "dataset":     "gitask repo eval (src/lib/*.ts, manually annotated)",
        "repoUrl":     "https://github.com/CosmoBean/gitask",
        "model":       MODEL_ID,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "queryCount":  len(queries_raw),
        "chunkCount":  len(chunks_out),
        "chunkSize":   args.chunk_size,
        "overlap":     args.overlap,
        "queries":     queries_raw,
        "chunks":      chunks_out,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"\nWrote {out_path}  ({size_kb:.0f} KB)")
    print(f"  {len(queries_raw)} queries, {len(chunks_out)} chunks")
    print(f"  Covers: {', '.join(Path(f).name for f in CORPUS_FILES if (REPO_ROOT/f).exists())}")


if __name__ == "__main__":
    main()
