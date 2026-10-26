"""Fetch the SWE-QA splits the eval set borrows from. Output is gitignored."""

import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "scripts", "sweqa")
BASE = "https://huggingface.co/datasets/swe-qa/SWE-QA-Benchmark/resolve/main"

os.makedirs(OUT, exist_ok=True)
for split in ("flask", "requests"):
    dest = os.path.join(OUT, f"{split}.jsonl")
    urllib.request.urlretrieve(f"{BASE}/{split}.jsonl", dest)
    print(f"{split}: {os.path.getsize(dest)} bytes -> {dest}")
