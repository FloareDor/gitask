"""
Generate src/lib/eval-embeddings.json from CodeSearchNet — all 6 languages.

Python  (~100 queries): uses the official annotationStore.csv with human
         relevance scores (0–3), fetching actual code from GitHub.
Others  (~30 each)    : uses the HuggingFace `code_search_net` dataset
         (docstring↔function pairs, binary relevance).

Total target: ~250 queries, ~2500 chunks.

Requirements:
    pip install sentence-transformers datasets tqdm requests numpy

Usage:
    python scripts/generate_eval_codesearchnet.py
    python scripts/generate_eval_codesearchnet.py --py-queries 50 --other-queries 20
"""

import argparse, csv, io, json, random, re, sys, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

# ── Defaults ──────────────────────────────────────────────────────────────────
DEFAULT_PY_QUERIES    = 100   # Python (human-annotated)
DEFAULT_OTHER_QUERIES = 30    # per language for JS/Java/Go/PHP/Ruby
NEGATIVES_PER_QUERY   = 9
MIN_POSITIVES         = 1     # min positives required to keep a Python query
RELEVANCE_THRESHOLD   = 2     # CSN score >= this counts as relevant (Python)
FETCH_TIMEOUT         = 12
TRUNCATE              = 1500  # max chars per code snippet
SEED                  = 42
MODEL_ID              = "sentence-transformers/all-MiniLM-L6-v2"
OUT_PATH              = Path(__file__).parent.parent / "src" / "lib" / "eval-embeddings.json"

HF_LANGUAGES = ["javascript", "java", "go", "php", "ruby"]


# ── Python annotated section ──────────────────────────────────────────────────

def fetch_python_annotated(target: int) -> tuple[list[dict], list[dict]]:
    """
    Fetch Python queries using the official CSN annotationStore.csv.
    Returns (queries_raw, chunks_raw) with per-query chunk pools.
    """
    print("Fetching CSN annotationStore.csv (Python, human-annotated)...")
    CSN_URL = (
        "https://raw.githubusercontent.com/github/CodeSearchNet"
        "/master/resources/annotationStore.csv"
    )
    with urllib.request.urlopen(CSN_URL, timeout=20) as r:
        raw_csv = r.read().decode()

    rows = list(csv.DictReader(io.StringIO(raw_csv)))
    py_rows = [r for r in rows if r["Language"] == "Python"]

    by_query: dict[str, list[dict]] = defaultdict(list)
    for r in py_rows:
        by_query[r["Query"]].append({
            "url": r["GitHubUrl"],
            "relevance": int(r["Relevance"] or 0),
        })

    good_queries = sorted(
        [
            (q, cs)
            for q, cs in by_query.items()
            if sum(1 for c in cs if c["relevance"] >= RELEVANCE_THRESHOLD) >= MIN_POSITIVES
        ],
        key=lambda x: -sum(1 for c in x[1] if c["relevance"] >= RELEVANCE_THRESHOLD),
    )[:target]

    print(f"  Selected {len(good_queries)} Python queries from annotation store")

    def github_url_to_raw(url: str) -> tuple[str, int, int]:
        m = re.match(
            r"https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+?)"
            r"(?:#L(\d+)(?:-L(\d+))?)?$",
            url,
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
            start = max(0, start - 1)
            end   = min(len(lines), end)
            snippet = "\n".join(lines[start:end]).strip()
            return snippet[:TRUNCATE] if len(snippet) >= 30 else None
        except Exception:
            return None

    # Collect all fetch jobs
    fetch_jobs: list[tuple[str, str, int]] = []
    for query, candidates in good_queries:
        positives = [c for c in candidates if c["relevance"] >= RELEVANCE_THRESHOLD]
        negatives = [c for c in candidates if c["relevance"] < RELEVANCE_THRESHOLD]
        selected  = positives + negatives[: NEGATIVES_PER_QUERY + 2 - len(positives)]
        for c in selected:
            fetch_jobs.append((query, c["url"], c["relevance"]))

    print(f"  Fetching {len(fetch_jobs)} code snippets from GitHub (parallel)...")
    results: dict[str, str | None] = {}
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {
            pool.submit(fetch_code, url): (query, url, rel)
            for query, url, rel in fetch_jobs
        }
        done = 0
        for fut in as_completed(futures):
            done += 1
            if done % 40 == 0:
                print(f"    {done}/{len(futures)}")
            query, url, rel = futures[fut]
            results[url] = fut.result()

    fetched_ok = sum(1 for v in results.values() if v)
    print(f"  Fetched {fetched_ok}/{len(results)} snippets")

    chunks_raw: list[dict] = []
    queries_raw: list[dict] = []
    chunk_counter: dict[str, int] = defaultdict(int)

    for qi, (query, candidates) in enumerate(good_queries):
        qid = f"py_q_{qi:03d}"
        positives = [c for c in candidates if c["relevance"] >= RELEVANCE_THRESHOLD]
        negatives = [c for c in candidates if c["relevance"] < RELEVANCE_THRESHOLD]
        selected  = positives + negatives[: NEGATIVES_PER_QUERY + 2 - len(positives)]

        q_chunks: list[dict] = []
        for c in selected:
            code = results.get(c["url"])
            if not code:
                continue
            chunk_counter[qid] += 1
            cid = f"{qid}_c{chunk_counter[qid]:02d}"
            q_chunks.append({
                "id":       cid,
                "query_id": qid,
                "relevance": c["relevance"],
                "code":     code,
                "language": "python",
            })

        if not q_chunks:
            continue

        relevant_ids = [c["id"] for c in q_chunks if c["relevance"] >= RELEVANCE_THRESHOLD]
        if len(relevant_ids) < MIN_POSITIVES:
            continue

        rel_scores = {c["id"]: c["relevance"] for c in q_chunks}
        queries_raw.append({
            "id":              qid,
            "query":           query,
            "relevantIds":     relevant_ids,
            "relevanceScores": rel_scores,
            "chunkIds":        [c["id"] for c in q_chunks],
        })
        chunks_raw.extend(q_chunks)

    print(f"  Python: {len(queries_raw)} queries, {len(chunks_raw)} chunks")
    return queries_raw, chunks_raw


# ── HuggingFace section (other languages) ────────────────────────────────────

def fetch_hf_language(lang: str, target: int, rng: random.Random) -> tuple[list[dict], list[dict]]:
    """
    Build queries for one language using HuggingFace code_search_net dataset.
    Each query = function's docstring → that function is the one positive.
    Negatives are randomly sampled from other functions in the same language pool.
    """
    try:
        from datasets import load_dataset
    except ImportError:
        print(f"  SKIP {lang}: `datasets` not installed. Run: pip install datasets")
        return [], []

    print(f"  Loading {lang} from HuggingFace...")
    try:
        ds = load_dataset("code_search_net", lang, split="test", trust_remote_code=True)
    except Exception as e:
        print(f"  SKIP {lang}: {e}")
        return [], []

    valid_idx = [
        i for i in range(len(ds))
        if (ds[i]["func_documentation_string"] or "").strip()
        and len((ds[i]["func_documentation_string"] or "").strip()) > 20
        and (ds[i]["whole_func_string"] or "").strip()
    ]

    if len(valid_idx) < target + NEGATIVES_PER_QUERY:
        print(f"  SKIP {lang}: only {len(valid_idx)} valid rows")
        return [], []

    selected_idx  = rng.sample(valid_idx, target + NEGATIVES_PER_QUERY + 20)
    query_idx     = selected_idx[:target]
    neg_pool_idx  = selected_idx[target:]

    queries_raw: list[dict] = []
    chunks_raw:  list[dict] = []

    for local_i, row_idx in enumerate(query_idx):
        row    = ds[row_idx]
        qid    = f"{lang}_q_{local_i:03d}"
        pos_id = f"{qid}_c00_pos"

        doc = (row["func_documentation_string"] or "").strip()
        # Take first sentence as concise query
        first = re.split(r"[.\n]", doc)[0].strip()
        query_text = (first if len(first) > 10 else doc)[:200]

        pos_code = (row["whole_func_string"] or "")[:TRUNCATE]
        chunks_raw.append({
            "id":       pos_id,
            "query_id": qid,
            "relevance": 3,
            "code":     pos_code,
            "language": lang,
        })

        negs = rng.sample(neg_pool_idx, min(NEGATIVES_PER_QUERY, len(neg_pool_idx)))
        neg_ids: list[str] = []
        for j, neg_idx in enumerate(negs):
            neg_row = ds[neg_idx]
            neg_id  = f"{qid}_c{j+1:02d}_neg"
            chunks_raw.append({
                "id":       neg_id,
                "query_id": qid,
                "relevance": 0,
                "code":     (neg_row["whole_func_string"] or "")[:TRUNCATE],
                "language": lang,
            })
            neg_ids.append(neg_id)

        rel_scores = {pos_id: 3, **{n: 0 for n in neg_ids}}
        queries_raw.append({
            "id":              qid,
            "query":           query_text,
            "relevantIds":     [pos_id],
            "relevanceScores": rel_scores,
            "chunkIds":        [pos_id] + neg_ids,
        })

    print(f"  {lang}: {len(queries_raw)} queries, {len(chunks_raw)} chunks")
    return queries_raw, chunks_raw


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--py-queries",    type=int, default=DEFAULT_PY_QUERIES,
                        help=f"Python queries (annotated, default {DEFAULT_PY_QUERIES})")
    parser.add_argument("--other-queries", type=int, default=DEFAULT_OTHER_QUERIES,
                        help=f"Queries per other language (default {DEFAULT_OTHER_QUERIES})")
    parser.add_argument("--seed",          type=int, default=SEED)
    parser.add_argument("--output",        default=str(OUT_PATH))
    parser.add_argument("--skip-python",   action="store_true",
                        help="Skip Python annotation fetch (useful for quick test)")
    args = parser.parse_args()

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        sys.exit("Install requirements: pip install sentence-transformers datasets tqdm numpy")

    rng = random.Random(args.seed)
    all_queries: list[dict] = []
    all_chunks:  list[dict] = []

    # ── Python (human-annotated) ──────────────────────────────────────────────
    if not args.skip_python:
        py_queries, py_chunks = fetch_python_annotated(args.py_queries)
        all_queries.extend(py_queries)
        all_chunks.extend(py_chunks)

    # ── Other languages (HuggingFace) ─────────────────────────────────────────
    print("\nFetching HuggingFace languages...")
    for lang in HF_LANGUAGES:
        q, c = fetch_hf_language(lang, args.other_queries, rng)
        all_queries.extend(q)
        all_chunks.extend(c)

    if not all_queries:
        sys.exit("No queries collected — check network and pip packages.")

    print(f"\nTotal: {len(all_queries)} queries, {len(all_chunks)} chunks")

    # ── Embed ─────────────────────────────────────────────────────────────────
    print(f"\nLoading model: {MODEL_ID} ...")
    model = SentenceTransformer(MODEL_ID)

    print(f"Embedding {len(all_chunks)} chunks...")
    chunk_texts = [c["code"] for c in all_chunks]
    chunk_embs  = model.encode(
        chunk_texts, batch_size=64,
        show_progress_bar=True, normalize_embeddings=True
    )
    for c, emb in zip(all_chunks, chunk_embs):
        c["embedding"] = emb.tolist()

    print(f"Embedding {len(all_queries)} queries...")
    query_texts = [q["query"] for q in all_queries]
    query_embs  = model.encode(
        query_texts, batch_size=64,
        show_progress_bar=True, normalize_embeddings=True
    )
    for q, emb in zip(all_queries, query_embs):
        q["embedding"] = emb.tolist()

    # ── Write ─────────────────────────────────────────────────────────────────
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    output = {
        "dataset":     "CodeSearchNet (Python annotated + JS/Java/Go/PHP/Ruby HuggingFace)",
        "datasetUrl":  "https://github.com/github/CodeSearchNet",
        "model":       MODEL_ID,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "queryCount":  len(all_queries),
        "chunkCount":  len(all_chunks),
        "queries":     all_queries,
        "chunks":      all_chunks,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    size_mb = out_path.stat().st_size / 1e6
    print(f"\nWrote {out_path}  ({size_mb:.1f} MB)")
    print(f"  {len(all_queries)} queries across Python + {len(HF_LANGUAGES)} other languages")
    print(f"  {len(all_chunks)} total chunks")


if __name__ == "__main__":
    main()
