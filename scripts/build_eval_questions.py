"""
Builds src/lib/eval/questions.json.

The SWE-QA half is lifted from the published benchmark (Apache-2.0) — question
and gold answer verbatim, with `goldLocations` parsed out of the prose the gold
answer already cites and then checked by hand against the pinned commit. The
`type` label and the authored half are ours.

Usage:
    python scripts/download_sweqa.py            # fetches the two splits
    python scripts/build_eval_questions.py
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SWEQA_DIR = os.path.join(ROOT, "scripts", "sweqa")
OUT = os.path.join(ROOT, "src", "lib", "eval", "questions.json")

# Pinned by SWE-QA's own repo_commit.txt. Gold line numbers only hold at these.
REFS = {"flask": "85c5d93", "requests": "46e939b"}
REPOS = {"flask": "pallets/flask", "requests": "psf/requests"}

# Hand-picked: every one cites two or more distinct source files, so a single
# retrieval round can't cover it. Index into the published split, then the gold
# spans transcribed from that record's answer.
PICKS = {
    "flask": [
        (0, [("src/flask/json/provider.py", 144, 148), ("tests/test_json.py", 48, 54)]),
        (1, [("src/flask/sansio/blueprints.py", 172, 172), ("src/flask/sansio/scaffold.py", 42, 42)]),
        (5, [("src/flask/sansio/blueprints.py", 461, 475), ("src/flask/templating.py", 138, 150)]),
        (11, [("src/flask/ctx.py", 117, 149), ("src/flask/app.py", 1313, 1314)]),
        (19, [("src/flask/sessions.py", 52, 82), ("src/flask/ctx.py", 384, 389)]),
        (20, [("src/flask/ctx.py", 29, 115), ("src/flask/globals.py", 24, 24)]),
        (39, [("src/flask/app.py", 208, 208), ("src/flask/views.py", 56, 56)]),
        (40, [("src/flask/sansio/app.py", 823, 846), ("src/flask/sansio/scaffold.py", 123, 126)]),
        (45, [("src/flask/ctx.py", 380, 389), ("src/flask/app.py", 1321, 1322), ("src/flask/sessions.py", 141, 146)]),
    ],
    "requests": [
        (1, [("tests/test_utils.py", 381, 384), ("src/requests/utils.py", 479, 501)]),
        (3, [("tests/test_requests.py", 82, 82), ("src/requests/__init__.py", 165, 176)]),
        (9, [("src/requests/exceptions.py", 17, 24), ("src/requests/models.py", 1026, 1026), ("src/requests/adapters.py", 368, 368)]),
        (11, [("src/requests/models.py", 483, 492), ("src/requests/utils.py", 1024, 1032), ("src/requests/_internal_utils.py", 25, 35), ("src/requests/structures.py", 13, 80)]),
        (24, [("src/requests/models.py", 351, 377), ("src/requests/auth.py", 299, 299)]),
        (28, [("src/requests/utils.py", 251, 255), ("src/requests/models.py", 185, 185)]),
        (35, [("src/requests/sessions.py", 223, 232), ("src/requests/models.py", 548, 551)]),
        (41, [("src/requests/_internal_utils.py", 25, 25), ("tests/test_utils.py", 712, 712), ("src/requests/utils.py", 27, 27)]),
        (45, [("src/requests/sessions.py", 191, 191), ("src/requests/exceptions.py", 95, 95)]),
    ],
}

PROVENANCE = (
    "30 questions from SWE-QA (Apache-2.0, swe-qa/SWE-QA-Benchmark) for flask and requests, "
    "pinned to the benchmark's own commits; question and gold answer verbatim, gold line spans "
    "transcribed from the gold answer's prose and verified against the pinned source. "
    "Caveat: SWE-QA gold answers were drafted by a RAG+LLM pipeline before human validation, "
    "so the judge may mildly favour RAG-shaped answers — that bias runs against the agent. "
    "The remaining 15 gitask questions and all 18 lookups are authored; lookups deliberately "
    "name a concrete symbol, which favours the RAG baseline."
)


def load_split(name):
    path = os.path.join(SWEQA_DIR, f"{name}.jsonl")
    if not os.path.exists(path):
        sys.exit(f"missing {path} — run scripts/download_sweqa.py first")
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def build_sweqa():
    out = []
    for split, picks in PICKS.items():
        rows = load_split(split)
        for index, locations in picks:
            row = rows[index]
            out.append({
                "id": f"sweqa-{split}-{index:02d}",
                "repo": REPOS[split],
                "ref": REFS[split],
                "source": "swe-qa",
                "type": "multihop",
                "question": row["question"],
                "goldAnswer": row["answer"],
                "goldLocations": [
                    {"path": p, "startLine": a, "endLine": b} for p, a, b in locations
                ],
            })
    return out


def main():
    with open(os.path.join(ROOT, "scripts", "eval_authored.json"), encoding="utf-8") as fh:
        authored = json.load(fh)
    questions = build_sweqa() + authored
    payload = {
        "name": "gitask agent eval v1",
        "provenance": PROVENANCE,
        "questions": questions,
    }
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    by_repo = {}
    by_type = {}
    for q in questions:
        by_repo[q["repo"]] = by_repo.get(q["repo"], 0) + 1
        by_type[q["type"]] = by_type.get(q["type"], 0) + 1
    print(f"wrote {len(questions)} questions -> {OUT}")
    print(" by repo:", by_repo)
    print(" by type:", by_type)


if __name__ == "__main__":
    main()
