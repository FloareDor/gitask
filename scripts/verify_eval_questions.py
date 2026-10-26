"""
Checks every gold location in src/lib/eval/questions.json against the pinned
source, so a typo'd line number can't quietly make a question unanswerable.

flask and requests are read from tarballs of the pinned commits; gitask is read
out of its own git history. Run it after editing the eval set.

    python scripts/verify_eval_questions.py [--work <dir>]
"""

import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUESTIONS = os.path.join(ROOT, "src", "lib", "eval", "questions.json")
TARBALLS = {
    "pallets/flask": ("https://codeload.github.com/pallets/flask/tar.gz/{ref}", "flask-{ref}"),
    "psf/requests": ("https://codeload.github.com/psf/requests/tar.gz/{ref}", "requests-{ref}"),
}


def ensure_tree(repo, ref, work):
    url, prefix = TARBALLS[repo]
    target = os.path.join(work, prefix.format(ref=ref))
    if os.path.isdir(target):
        return target
    os.makedirs(work, exist_ok=True)
    print(f"fetching {repo}@{ref}")
    with urllib.request.urlopen(url.format(ref=ref)) as response:
        blob = response.read()
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        tar.extractall(work)
    return target


def read_lines(repo, ref, path, work):
    if repo in TARBALLS:
        full = os.path.join(ensure_tree(repo, ref, work), path)
        if not os.path.exists(full):
            return None
        with open(full, encoding="utf-8") as fh:
            return fh.read().split("\n")
    # gitask: read straight out of this repo's history.
    done = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=ROOT,
                          capture_output=True, text=True)
    return None if done.returncode != 0 else done.stdout.split("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", default=os.path.join(ROOT, "scripts", "sweqa", "repos"))
    args = parser.parse_args()

    with open(QUESTIONS, encoding="utf-8") as fh:
        questions = json.load(fh)["questions"]

    problems = []
    for question in questions:
        for location in question["goldLocations"]:
            lines = read_lines(question["repo"], question["ref"], location["path"], args.work)
            if lines is None:
                problems.append(f"{question['id']}: no such file {location['path']}")
                continue
            if location["endLine"] > len(lines):
                problems.append(
                    f"{question['id']}: {location['path']}:{location['startLine']}-"
                    f"{location['endLine']} past end of file ({len(lines)} lines)"
                )
                continue
            span = lines[location["startLine"] - 1:location["endLine"]]
            if not any(line.strip() for line in span):
                problems.append(
                    f"{question['id']}: {location['path']}:{location['startLine']}-"
                    f"{location['endLine']} is blank"
                )

    total = sum(len(q["goldLocations"]) for q in questions)
    print(f"checked {total} gold locations across {len(questions)} questions")
    for problem in problems:
        print(f"  FAIL {problem}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
