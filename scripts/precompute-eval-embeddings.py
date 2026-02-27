"""
Precompute eval embeddings from CodeSearchNet Python annotated queries.

Fetches real code from GitHub, embeds with all-MiniLM-L6-v2 (same model as
production), writes src/lib/eval-embeddings.json.

Run once: python scripts/precompute-eval-embeddings.py
"""

import csv, io, json, re, urllib.request, sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

# ── Config ───────────────────────────────────────────────────────────────────
TARGET_QUERIES  = 25
MAX_CANDIDATES  = 12   # per query (includes all positives + random negatives)
MIN_POSITIVES   = 2    # queries with fewer positives are skipped
RELEVANCE_THRESHOLD = 2  # >= this → "relevant" for Recall/MRR
FETCH_TIMEOUT   = 12
OUT_PATH        = Path(__file__).parent.parent / "src" / "lib" / "eval-embeddings.json"

# ── Fetch annotation CSV ─────────────────────────────────────────────────────
print("Fetching CodeSearchNet annotations...")
CSN_URL = "https://raw.githubusercontent.com/github/CodeSearchNet/master/resources/annotationStore.csv"
with urllib.request.urlopen(CSN_URL, timeout=20) as r:
    raw_csv = r.read().decode()

rows = list(csv.DictReader(io.StringIO(raw_csv)))
py_rows = [r for r in rows if r["Language"] == "Python"]

# Group by query
by_query: dict[str, list[dict]] = defaultdict(list)
for r in py_rows:
    by_query[r["Query"]].append({
        "url": r["GitHubUrl"],
        "relevance": int(r["Relevance"] or 0),
    })

# Pick queries with enough positive signal, sorted by #positives desc
good_queries = sorted(
    [(q, cs) for q, cs in by_query.items()
     if sum(1 for c in cs if c["relevance"] >= RELEVANCE_THRESHOLD) >= MIN_POSITIVES],
    key=lambda x: -sum(1 for c in x[1] if c["relevance"] >= RELEVANCE_THRESHOLD)
)[:TARGET_QUERIES]

print(f"Selected {len(good_queries)} queries")

# ── Fetch code from GitHub ────────────────────────────────────────────────────
def github_url_to_raw(url: str) -> tuple[str, int, int]:
    """Convert blob GitHub URL to raw URL + line range."""
    # e.g. https://github.com/owner/repo/blob/SHA/path/file.py#L10-L30
    m = re.match(
        r"https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+?)(?:#L(\d+)(?:-L(\d+))?)?$",
        url
    )
    if not m:
        raise ValueError(f"Can't parse: {url}")
    owner, repo, sha, path, l1, l2 = m.groups()
    raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}"
    start = int(l1) if l1 else 1
    end   = int(l2) if l2 else start + 40
    return raw, start, end

def fetch_code(url: str) -> str | None:
    try:
        raw_url, start, end = github_url_to_raw(url)
        with urllib.request.urlopen(raw_url, timeout=FETCH_TIMEOUT) as r:
            lines = r.read().decode(errors="replace").splitlines()
        # clamp to file bounds
        start = max(0, start - 1)
        end   = min(len(lines), end)
        snippet = "\n".join(lines[start:end]).strip()
        if len(snippet) < 30:
            return None
        return snippet[:2000]  # cap length
    except Exception:
        return None

# Build candidate list per query (all positives + fill negatives up to MAX_CANDIDATES)
print("Fetching code from GitHub (parallel)...")
fetch_jobs: list[tuple[str, str, int]] = []  # (query, url, relevance)
for query, candidates in good_queries:
    positives = [c for c in candidates if c["relevance"] >= RELEVANCE_THRESHOLD]
    negatives = [c for c in candidates if c["relevance"] < RELEVANCE_THRESHOLD]
    selected  = positives + negatives[:MAX_CANDIDATES - len(positives)]
    for c in selected:
        fetch_jobs.append((query, c["url"], c["relevance"]))

results: dict[str, str | None] = {}
with ThreadPoolExecutor(max_workers=20) as pool:
    futures = {pool.submit(fetch_code, url): (query, url, rel)
               for query, url, rel in fetch_jobs}
    done = 0
    for fut in as_completed(futures):
        done += 1
        if done % 20 == 0:
            print(f"  {done}/{len(futures)}")
        query, url, rel = futures[fut]
        results[url] = fut.result()

print(f"Fetched {sum(1 for v in results.values() if v)} / {len(results)} snippets")

# ── Build structured dataset ──────────────────────────────────────────────────
chunks_raw: list[dict] = []
queries_raw: list[dict] = []

chunk_counter: dict[str, int] = defaultdict(int)

for qi, (query, candidates) in enumerate(good_queries):
    qid = f"q_{qi:02d}"
    positives = [c for c in candidates if c["relevance"] >= RELEVANCE_THRESHOLD]
    negatives = [c for c in candidates if c["relevance"] < RELEVANCE_THRESHOLD]
    selected  = positives + negatives[:MAX_CANDIDATES - len(positives)]

    q_chunks: list[dict] = []
    for c in selected:
        code = results.get(c["url"])
        if not code:
            continue
        chunk_counter[qid] += 1
        cid = f"{qid}_c{chunk_counter[qid]:02d}"
        q_chunks.append({
            "id": cid,
            "query_id": qid,
            "relevance": c["relevance"],
            "source_url": c["url"],
            "code": code,
        })

    if not q_chunks:
        continue

    relevant_ids = [c["id"] for c in q_chunks if c["relevance"] >= RELEVANCE_THRESHOLD]
    if len(relevant_ids) < MIN_POSITIVES:
        continue  # skip if too many fetches failed

    relevance_scores = {c["id"]: c["relevance"] for c in q_chunks}

    queries_raw.append({
        "id": qid,
        "query": query,
        "relevantIds": relevant_ids,
        "relevanceScores": relevance_scores,
        "chunkIds": [c["id"] for c in q_chunks],
    })
    chunks_raw.extend(q_chunks)

print(f"Dataset: {len(queries_raw)} queries, {len(chunks_raw)} chunks")

# ── Embed ─────────────────────────────────────────────────────────────────────
print("Loading sentence-transformers model (all-MiniLM-L6-v2)...")
from sentence_transformers import SentenceTransformer
import numpy as np

model = SentenceTransformer("all-MiniLM-L6-v2")

texts_to_embed = [c["code"] for c in chunks_raw] + [q["query"] for q in queries_raw]
print(f"Embedding {len(texts_to_embed)} texts...")
embeddings = model.encode(texts_to_embed, normalize_embeddings=True, show_progress_bar=True)

n_chunks = len(chunks_raw)
chunk_embeddings = embeddings[:n_chunks]
query_embeddings = embeddings[n_chunks:]

# ── Assemble output ───────────────────────────────────────────────────────────
chunks_out = []
for i, c in enumerate(chunks_raw):
    chunks_out.append({
        "id":        c["id"],
        "query_id":  c["query_id"],
        "relevance": c["relevance"],
        "code":      c["code"],
        "embedding": chunk_embeddings[i].tolist(),
    })

queries_out = []
for i, q in enumerate(queries_raw):
    queries_out.append({
        "id":              q["id"],
        "query":           q["query"],
        "relevantIds":     q["relevantIds"],
        "relevanceScores": q["relevanceScores"],
        "chunkIds":        q["chunkIds"],
        "embedding":       query_embeddings[i].tolist(),
    })

output = {
    "model":        "sentence-transformers/all-MiniLM-L6-v2",
    "dims":         384,
    "generatedAt":  datetime.now(timezone.utc).isoformat(),
    "dataset":      "CodeSearchNet Python (annotated)",
    "datasetUrl":   "https://github.com/github/CodeSearchNet",
    "queryCount":   len(queries_out),
    "chunkCount":   len(chunks_out),
    "chunks":       chunks_out,
    "queries":      queries_out,
}

OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

size_kb = OUT_PATH.stat().st_size / 1024
print(f"\nWrote {OUT_PATH} ({size_kb:.0f} KB)")
print(f"  {len(queries_out)} queries, {len(chunks_out)} chunks")
