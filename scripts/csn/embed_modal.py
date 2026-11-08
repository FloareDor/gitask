"""
Step 3 of the CodeSearchNet benchmark: embed every chunk and query on a Modal GPU.

Matches the production embedder (src/lib/embedder.ts): all-MiniLM-L12-v2 over the
raw chunk code, mean pooling, L2 normalisation, truncation at the tokenizer's
512-token limit. sentence-transformers defaults this model to 128 tokens, so the
limit is set explicitly. Production runs the ONNX export (q8 on WASM, fp16 on
WebGPU); this runs fp32, and bench.run.ts reports how closely the two agree.

Writes .context/csn/<lang>/{chunk,query}_embeddings.f32 — row-major float32,
one row per line of chunks.jsonl / queries.jsonl.

Usage:
    modal run scripts/csn/embed_modal.py
    modal run scripts/csn/embed_modal.py --languages javascript
"""

import json
from pathlib import Path

import modal

MODEL_ID = "sentence-transformers/all-MiniLM-L12-v2"
MAX_SEQ_LENGTH = 512


def download_model() -> None:
    from sentence_transformers import SentenceTransformer

    SentenceTransformer(MODEL_ID)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.5.1", "sentence-transformers==3.3.1", "numpy<2")
    .run_function(download_model)
)
app = modal.App("gitask-csn-embed", image=image)


@app.function(gpu="L4", timeout=1800)
def embed(texts: list[str]) -> bytes:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(MODEL_ID, device="cuda")
    model.max_seq_length = MAX_SEQ_LENGTH
    vectors = model.encode(
        texts,
        batch_size=128,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return vectors.astype(np.float32).tobytes()


def read_jsonl(path: Path, field: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line)[field] for line in fh if line.strip()]


@app.local_entrypoint()
def main(languages: str = "python,javascript") -> None:
    # Resolved here, not at import: the container has no repo around this file.
    ROOT = Path(__file__).resolve().parents[2]
    jobs = []
    for lang in languages.split(","):
        out = ROOT / ".context" / "csn" / lang
        jobs.append((out / "chunk_embeddings.f32", read_jsonl(out / "chunks.jsonl", "code")))
        jobs.append((out / "query_embeddings.f32", read_jsonl(out / "queries.jsonl", "query")))

    for (path, texts), payload in zip(jobs, embed.map([texts for _, texts in jobs])):
        path.write_bytes(payload)
        print(f"{path.relative_to(ROOT)}: {len(texts)} vectors")

    meta = {"model": MODEL_ID, "dims": 384, "maxSeqLength": MAX_SEQ_LENGTH, "dtype": "float32"}
    for lang in languages.split(","):
        (ROOT / ".context" / "csn" / lang / "embeddings.json").write_text(json.dumps(meta, indent=2))
