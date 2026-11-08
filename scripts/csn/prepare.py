"""
Build the CodeSearchNet retrieval benchmark inputs.

For each language this writes, under .context/csn/<lang>/:
    functions.jsonl  every function in the CSN test split (deduplicated) — the
                     fixed corpus every ablation config searches over
    queries.jsonl    a seeded sample of docstring queries, each pointing at the
                     one function it was taken from

The query is the first paragraph of the function's docstring, as in the
CodeSearchNet challenge. The docstring is stripped from the indexed Python code
so the query text cannot be matched against itself; CSN's JavaScript functions
already exclude the leading JSDoc comment.

Usage:
    python scripts/csn/prepare.py --queries 2000
"""

import argparse, json, random, re, urllib.request
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / ".context" / "csn"
PARQUET_URL = (
    "https://huggingface.co/api/datasets/code-search-net/code_search_net"
    "/parquet/{lang}/test/0.parquet"
)
LANGUAGES = ["python", "javascript"]
MIN_QUERY_WORDS = 3
MAX_QUERY_CHARS = 300

# A def header, then the first statement if it is a string literal.
PY_DOCSTRING = re.compile(
    r"^(?P<head>[\s\S]*?\bdef\b[\s\S]*?:[ \t]*(?:#[^\n]*)?\r?\n(?:[ \t]*(?:#[^\n]*)?\r?\n)*)"
    r"(?P<indent>[ \t]*)[rRuUbB]{0,2}"
    r"(?P<doc>\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?'''|\"(?:[^\"\\\n]|\\.)*\"|'(?:[^'\\\n]|\\.)*')"
    r"[ \t]*\n?"
)


def strip_python_docstring(code: str) -> tuple[str, bool]:
    match = PY_DOCSTRING.match(code)
    if not match:
        return code, False
    rest = code[match.end():]
    # A function whose only statement was the docstring still needs a body.
    if not rest.strip():
        rest = f"{match.group('indent')}pass\n"
    return match.group("head") + rest, True


def query_from_docstring(doc: str) -> str:
    first_paragraph = re.split(r"\n\s*\n", doc.strip(), maxsplit=1)[0]
    return re.sub(r"\s+", " ", first_paragraph).strip()[:MAX_QUERY_CHARS]


def load_split(lang: str) -> list[dict]:
    path = OUT_DIR / f"{lang}-test.parquet"
    if not path.exists():
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {lang} test split...")
        urllib.request.urlretrieve(PARQUET_URL.format(lang=lang), path)
    return pq.read_table(path).to_pylist()


def build_language(lang: str, query_count: int, rng: random.Random) -> None:
    rows = load_split(lang)
    functions: list[dict] = []
    seen_code: set[str] = set()
    stripped_count = 0

    for row in rows:
        code = row["func_code_string"] or ""
        if lang == "python":
            code, stripped = strip_python_docstring(code)
            stripped_count += stripped
        normalized = re.sub(r"\s+", " ", code).strip()
        if not normalized or normalized in seen_code:
            continue
        seen_code.add(normalized)
        functions.append({
            "id": f"{lang[:2]}_{len(functions):06d}",
            "repo": row["repository_name"],
            "path": row["func_path_in_repository"],
            "name": row["func_name"],
            "url": row["func_code_url"],
            "code": code,
            "query": query_from_docstring(row["func_documentation_string"] or ""),
        })

    # A query shared by several functions ("Constructor.") has no single answer.
    query_counts = Counter(f["query"].lower() for f in functions)
    eligible = [
        f for f in functions
        if len(f["query"].split()) >= MIN_QUERY_WORDS and query_counts[f["query"].lower()] == 1
    ]
    sampled = rng.sample(eligible, min(query_count, len(eligible)))

    # The docstring must not survive into the indexed code, or BM25 matches the query to itself.
    leaked = sum(1 for f in sampled if f["query"][:40] in f["code"])

    out = OUT_DIR / lang
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "functions.jsonl", "w", encoding="utf-8") as fh:
        for f in functions:
            fh.write(json.dumps({k: f[k] for k in ("id", "repo", "path", "name", "url", "code")}) + "\n")
    with open(out / "queries.jsonl", "w", encoding="utf-8") as fh:
        for i, f in enumerate(sampled):
            fh.write(json.dumps({"id": f"{lang[:2]}_q{i:05d}", "query": f["query"], "functionId": f["id"]}) + "\n")

    print(
        f"{lang}: {len(rows)} rows -> {len(functions)} unique functions, "
        f"{len(eligible)} eligible queries, {len(sampled)} sampled"
    )
    if lang == "python":
        print(f"  docstrings stripped from {stripped_count}/{len(rows)} functions")
    print(f"  sampled queries whose text still appears in the code: {leaked}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queries", type=int, default=2000, help="queries per language")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--languages", nargs="+", default=LANGUAGES)
    args = parser.parse_args()

    for lang in args.languages:
        build_language(lang, args.queries, random.Random(f"{args.seed}:{lang}"))


if __name__ == "__main__":
    main()
