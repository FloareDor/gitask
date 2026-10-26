"""
Writes scripts/eval_authored.json — the hand-written half of the eval set.

Kept as code rather than hand-edited JSON so the gold spans stay next to the
answers they belong to, and so re-running it is the only way the file changes.
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

F = {"repo": "pallets/flask", "ref": "85c5d93"}
R = {"repo": "psf/requests", "ref": "46e939b"}
G = {"repo": "FloareDor/gitask", "ref": "51c4ec2"}


def q(id, base, type, question, answer, locs):
    return {
        "id": id,
        "repo": base["repo"],
        "ref": base["ref"],
        "source": "authored",
        "type": type,
        "question": question,
        "goldAnswer": answer,
        "goldLocations": [{"path": p, "startLine": a, "endLine": b} for p, a, b in locs],
    }


QUESTIONS = [
    # ── flask lookups ────────────────────────────────────────────────────────
    q("flask-l1", F, "lookup",
      "What does send_from_directory do, and how does it stop a client-supplied path from escaping the directory?",
      "`send_from_directory` is a thin wrapper around `werkzeug.utils.send_from_directory` that forwards the "
      "Flask-specific keyword arguments through `_prepare_send_file_kwargs`. Path safety is not implemented in "
      "Flask: Werkzeug uses `safe_join` so a path coming from the client cannot be crafted to point outside "
      "`directory`. If the resulting path is not an existing regular file, a 404 `NotFound` is raised. The "
      "docstring is explicit that `directory` must not be a client-supplied value.",
      [("src/flask/helpers.py", 526, 567)]),

    q("flask-l2", F, "lookup",
      "How does Config.from_prefixed_env decide which environment variables to load, and how does it set nested keys?",
      "`Config.from_prefixed_env` builds `prefix = f\"{prefix}_\"` (default `FLASK_`) and walks `sorted(os.environ)`, "
      "skipping any key that does not start with it. The prefix is stripped with `removeprefix`, then the value is "
      "passed through `loads` (default `json.loads`); if that raises, the exception is swallowed and the value stays "
      "a string. A key with no `__` in it is assigned directly. A key containing `__` is split on it, and the leading "
      "parts are walked as nested dicts — any missing intermediate key is initialised to `{}` — with the final part "
      "assigned on the innermost dict. It always returns True.",
      [("src/flask/config.py", 126, 185)]),

    q("flask-l3", F, "lookup",
      "What does SecureCookieSessionInterface.get_signing_serializer return when the app has no secret key, and how are fallback keys ordered?",
      "`get_signing_serializer` returns `None` when `app.secret_key` is falsy, which is how the session interface "
      "detects a null session. Otherwise it builds a key list from `app.config[\"SECRET_KEY_FALLBACKS\"]` first and "
      "appends `app.secret_key` last, with the comment that itsdangerous expects the current key at the top. It "
      "returns a `URLSafeTimedSerializer` over those keys with `salt=self.salt`, `serializer=self.serializer`, and "
      "`signer_kwargs` carrying `key_derivation` and `digest_method`.",
      [("src/flask/sessions.py", 317, 335)]),

    q("flask-l4", F, "lookup",
      "What does flask.abort do differently from werkzeug's abort?",
      "`abort` first checks `current_app`. If an application context is active it calls "
      "`current_app.aborter(code, *args, **kwargs)`, which lets an app register its own exceptions for a status "
      "code. It then falls through to Werkzeug's `abort` (imported as `_wz_abort`), which is the only path taken "
      "when no app is available. It is annotated `-> t.NoReturn` because both branches raise.",
      [("src/flask/helpers.py", 266, 287)]),

    q("flask-l5", F, "lookup",
      "How does MethodView populate its methods attribute, and what happens on a HEAD request with no head handler?",
      "`MethodView.__init_subclass__` runs on each subclass. If `methods` is not set in the subclass's own "
      "`__dict__`, it unions `methods` from every base that has one, then adds the upper-cased name of each "
      "attribute in `http_method_funcs` that the class actually defines, and assigns the result to `cls.methods` "
      "only if non-empty. `dispatch_request` looks up `getattr(self, request.method.lower(), None)`; when that is "
      "`None` and the method is HEAD it retries with `get`. It then asserts the handler exists and calls it through "
      "`current_app.ensure_sync`.",
      [("src/flask/views.py", 138, 192)]),

    q("flask-l6", F, "lookup",
      "Which Flask config key controls whether an OPTIONS handler is added automatically, and what is its default?",
      "`PROVIDE_AUTOMATIC_OPTIONS` defaults to `True` in the default config dict in `src/flask/app.py`. The per-view "
      "override lives on the view class as `provide_automatic_options: t.ClassVar[bool | None] = None`, so a view "
      "that leaves it `None` inherits the app-level setting.",
      [("src/flask/app.py", 208, 208), ("src/flask/views.py", 56, 56)]),

    # ── requests lookups ─────────────────────────────────────────────────────
    q("req-l1", R, "lookup",
      "How does super_len determine the length of a request body, and what does it return when it cannot?",
      "`super_len` tries, in order: `len(o)`, then `o.len`, then `os.fstat(o.fileno()).st_size`. On urllib3 2.x a "
      "`str` is encoded to utf-8 first, because urllib3 2.x treats strings as utf-8 rather than latin-1. The fstat "
      "branch warns with `FileModeWarning` if the file was opened without `'b'` in its mode, since a text-mode "
      "length may be wrong. It then subtracts the current position from `o.tell()` where available, falling back to "
      "seeking to the end and back for objects like StringIO that have `seek` but no usable fileno. If nothing "
      "worked `total_length` is 0, and the function returns `max(0, total_length - current_position)` so it never "
      "returns a negative length.",
      [("src/requests/utils.py", 136, 203)]),

    q("req-l2", R, "lookup",
      "How does guess_json_utf detect the encoding of a JSON payload?",
      "`guess_json_utf` looks only at `data[:4]`. It first checks for a BOM: UTF-32 LE/BE on the full four bytes, "
      "UTF-8 on the first three (returned as `utf-8-sig`), UTF-16 LE/BE on the first two. With no BOM it counts null "
      "bytes in the sample, relying on JSON always starting with two ASCII characters. Zero nulls means `utf-8`. Two "
      "nulls means UTF-16, big- or little-endian depending on whether the 1st and 3rd or the 2nd and 4th bytes are "
      "null. Three nulls means UTF-32, again disambiguated by null position. Anything else falls through to `None`.",
      [("src/requests/utils.py", 947, 978)]),

    q("req-l3", R, "lookup",
      "Which headers does default_headers set on a new Session?",
      "`default_headers` returns a `CaseInsensitiveDict` with four entries: `User-Agent` from "
      "`default_user_agent()`, `Accept-Encoding` from the module-level `DEFAULT_ACCEPT_ENCODING`, `Accept` set to "
      "`*/*`, and `Connection` set to `keep-alive`.",
      [("src/requests/utils.py", 890, 901)]),

    q("req-l4", R, "lookup",
      "What does requote_uri do when the URI cannot be unquoted?",
      "`requote_uri` normally runs the URI through `unquote_unreserved` and then `quote` with "
      "`safe_with_percent = \"!#$%&'()*+,/:;=?@[]~\"`, so reserved, unreserved and already-escaped `%` sequences "
      "survive untouched. If `unquote_unreserved` raises `InvalidURL`, it falls back to quoting the raw URI with "
      "`safe_without_percent`, which drops `%` from the safe set so any stray unquoted percent signs get escaped "
      "rather than left to break something downstream.",
      [("src/requests/utils.py", 650, 670)]),

    q("req-l5", R, "lookup",
      "How does Session.mount keep transport adapters in the right order?",
      "`mount` assigns `self.adapters[prefix] = adapter`, then collects every existing key shorter than the new "
      "prefix and pops and re-inserts each one. Because the adapter dict preserves insertion order, re-inserting the "
      "shorter keys after the new one leaves the adapters sorted in descending order by prefix length, so the "
      "longest matching prefix is found first.",
      [("src/requests/sessions.py", 799, 808)]),

    q("req-l6", R, "lookup",
      "What does extract_cookies_to_jar need from the response object, and what does it do if that is missing?",
      "`extract_cookies_to_jar` requires `response._original_response` — the wrapped httplib `HTTPResponse` — and "
      "returns immediately if the attribute is absent or falsy. Otherwise it wraps the requests `Request` in a "
      "`MockRequest` and the original response's `msg` headers in a `MockResponse`, then calls "
      "`jar.extract_cookies(res, req)`, since `http.cookiejar` expects urllib-shaped objects rather than requests' own.",
      [("src/requests/cookies.py", 124, 137)]),

    # ── gitask lookups ───────────────────────────────────────────────────────
    q("gitask-l1", G, "lookup",
      "How does binarize turn an embedding into a bit vector?",
      "`binarize` packs each dimension of the vector into one bit of a `Uint32Array`, setting the bit when the "
      "component is greater than zero. The output length is `ceil(dim / 32)` words, which is what makes the coarse "
      "retrieval stage 32x smaller than the float vectors.",
      [("src/lib/quantize.ts", 13, 27)]),

    q("gitask-l2", G, "lookup",
      "How is Hamming distance computed between two quantized vectors?",
      "`hammingDistance` XORs the two `Uint32Array`s word by word and counts the set bits in each result with a "
      "popcount, summing to the total number of differing dimensions. It is the distance used for the coarse "
      "retrieval pass before the cosine rerank.",
      [("src/lib/quantize.ts", 34, 48)]),

    q("gitask-l3", G, "lookup",
      "What does reciprocalRankFusion do with the ranked lists it is given?",
      "`reciprocalRankFusion` scores each document by summing `1 / (k + rank)` over every input list it appears in, "
      "with the usual RRF constant, then sorts by the fused score. It is what merges the dense and BM25 result lists "
      "without needing their scores to be on the same scale.",
      [("src/lib/search.ts", 29, 45)]),

    q("gitask-l4", G, "lookup",
      "How does classifyInjectionRisk decide between low, medium and high risk?",
      "`classifyInjectionRisk` counts matches of the prompt-injection patterns in the text and maps the count onto a "
      "level, returning the level together with the names of the signals that fired. The level is what "
      "`scanChunksForInjection` aggregates across the retrieved chunks and what the chat path uses to decide between "
      "sanitizing and blocking outright.",
      [("src/lib/promptSafety.ts", 71, 95)]),

    q("gitask-l5", G, "lookup",
      "What does extractEvidenceTerms strip out of a query?",
      "`extractEvidenceTerms` lowercases the query, splits it into word tokens, and drops anything in "
      "`EVIDENCE_STOP_WORDS` as well as very short tokens. What is left is the set of terms that citation grounding "
      "checks for inside the retrieved chunks.",
      [("src/lib/citationUtils.ts", 3, 19)]),

    q("gitask-l6", G, "lookup",
      "What does expandQuery produce from a single user message?",
      "`expandQuery` is the non-LLM fallback for multi-query retrieval: it derives a small list of query variants "
      "from the user message with string rules rather than a model call, which is the path taken when the provider "
      "is the local MLC model or query expansion is switched off.",
      [("src/lib/queryExpansion.ts", 72, 87)]),

    # ── gitask multihop ──────────────────────────────────────────────────────
    q("gitask-m1", G, "multihop",
      "Trace a chat question from the input box to a ranked list of chunks. Which functions run, and in what order?",
      "The chat path first expands the question into variants — `generateQueryVariants` when a hosted provider is "
      "configured, otherwise the rule-based `expandQuery`. The variants go into `multiPathHybridSearch`, which runs "
      "`hybridSearch` per variant and fuses the per-variant results. Each `hybridSearch` call is itself a fusion: a "
      "dense pass and a BM25 pass combined by `reciprocalRankFusion`, followed by graph expansion and a cosine rerank.",
      [("src/lib/queryExpansion.ts", 72, 87), ("src/lib/queryExpansion.ts", 98, 153),
       ("src/lib/search.ts", 269, 348), ("src/lib/search.ts", 151, 208)]),

    q("gitask-m2", G, "multihop",
      "Where does binary quantization get used during retrieval, and where do the full-precision vectors come back?",
      "`binarize` packs each embedding into a bit vector at index time, and `hammingDistance` scores those bit "
      "vectors in the coarse pass inside `vectorSearch`. The full-precision embeddings are not discarded: "
      "`vectorSearch` reranks the coarse candidates with `cosineSimilarity` over the original float vectors, so "
      "quantization only narrows the candidate set and never decides the final order.",
      [("src/lib/quantize.ts", 13, 27), ("src/lib/quantize.ts", 34, 48),
       ("src/lib/quantize.ts", 54, 68), ("src/lib/search.ts", 113, 142)]),

    q("gitask-m3", G, "multihop",
      "What stops a file in an indexed repository from hijacking the assistant with instructions in a comment?",
      "Retrieved chunks are scanned before they ever reach the prompt. `scanChunksForInjection` runs "
      "`classifyInjectionRisk` over every chunk and reports an aggregate level plus the chunk ids that looked risky. "
      "`buildSafeContext` then redacts or excludes those chunks when assembling the context, and the chat path "
      "blocks the answer entirely when the level is high or risky chunks dominate the result set.",
      [("src/lib/promptSafety.ts", 71, 95), ("src/lib/promptSafety.ts", 97, 132),
       ("src/lib/promptSafety.ts", 177, 226), ("src/app/[owner]/[repo]/page.tsx", 749, 767)]),

    q("gitask-m4", G, "multihop",
      "How is BM25 scoring kept off the main thread, and what happens when the worker fails?",
      "`bm25Search` prefers a worker: `getOrCreateWorker` lazily spawns `src/workers/bm25-worker.ts` and "
      "`scoreWithWorker` posts the documents and query across and waits for the scores. Failure is handled rather "
      "than fatal — `disposeBM25Worker` tears the worker down and rejects the pending requests, and scoring falls "
      "back to the synchronous path in the same module.",
      [("src/lib/bm25.ts", 217, 235), ("src/lib/bm25.ts", 111, 148),
       ("src/lib/bm25.ts", 96, 105), ("src/lib/bm25.ts", 167, 211),
       ("src/workers/bm25-worker.ts", 28, 66)]),

    q("gitask-m5", G, "multihop",
      "How does graph expansion decide which extra files to pull into a result set?",
      "`expandCandidatesWithGraph` takes the top retrieval hits and follows the import/definition graph out from "
      "their files, adding chunks from the neighbours. Resolving an import string to a real indexed path is "
      "`resolveImport`'s job, which handles relative specifiers, extension guessing and index files against the set "
      "of known paths that the store hands over through `getResolveFileData`.",
      [("src/lib/graphExpansion.ts", 101, 145), ("src/lib/graphExpansion.ts", 40, 95),
       ("src/lib/vectorStore.ts", 128, 147)]),

    q("gitask-m6", G, "multihop",
      "What does the CoVe pass do after an answer is generated, and what does it re-retrieve?",
      "`verifyAndRefine` runs after the first answer: it asks the model to pull out the checkable claims, re-runs "
      "retrieval for those claims through the hybrid search path, and then asks for a revised answer given what came "
      "back. The point is that verification uses fresh retrieval rather than the original context, which is why it "
      "can catch a claim the first context never supported.",
      [("src/lib/cove.ts", 23, 81), ("src/lib/search.ts", 269, 348)]),

    q("gitask-m7", G, "multihop",
      "How is an index restored from cache, and what makes a cached index unusable?",
      "`loadFromCache` reads the stored blob out of IndexedDB and hands it to `setFromBlob`, which repopulates the "
      "chunks, binaries, graph and raw file text in one go. A cache entry is only accepted when its embedding model "
      "matches: `isCompatibleEmbeddingModel` compares the stored value against `EMBEDDING_MODEL_ID`, so changing the "
      "embedding model invalidates every cached index rather than silently mixing vector spaces.",
      [("src/lib/vectorStore.ts", 415, 463), ("src/lib/vectorStore.ts", 221, 237),
       ("src/lib/vectorStore.ts", 65, 67), ("src/lib/embedder.ts", 22, 22)]),

    q("gitask-m8", G, "multihop",
      "How does the context sent to the LLM stay inside a provider's budget?",
      "`defaultLimitsForProvider` picks the budget from the configured provider, so a local MLC model gets a much "
      "smaller allowance than a hosted one. `buildScopedContext` renders the candidate chunks and, if the rendered "
      "text is already within budget, returns it untouched. When it is not, it degrades in stages — compacting the "
      "overflowing files first via `compactOverflowFiles`, then directories, then the repo — and records which stage "
      "it reached in the returned meta.",
      [("src/lib/contextAssembly.ts", 26, 47), ("src/lib/contextAssembly.ts", 57, 109),
       ("src/lib/contextAssembly.ts", 145, 197), ("src/app/[owner]/[repo]/page.tsx", 681, 681)]),

    q("gitask-m9", G, "multihop",
      "How does a citation shown under an answer get tied back to the chunks that were retrieved?",
      "Citations are built twice. Before generation, `buildGroundedCitationResults` keeps only the retrieved chunks "
      "that actually contain the query's evidence terms, so a citation is never shown for a chunk that has nothing "
      "to do with the question. After the answer streams in, `buildCorrelatedCitationResults` re-selects chunks by "
      "correlating them against the generated text. `evaluateEvidenceCoverage` scores how much of the evidence the "
      "results covered at all, and the chat path uses a weak score to refuse to answer rather than cite something "
      "unsupported.",
      [("src/lib/citationUtils.ts", 26, 37), ("src/lib/citationUtils.ts", 47, 87),
       ("src/lib/citationUtils.ts", 89, 109), ("src/app/[owner]/[repo]/page.tsx", 771, 790)]),
]

if __name__ == "__main__":
    out = os.path.join(ROOT, "scripts", "eval_authored.json")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(QUESTIONS, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {len(QUESTIONS)} authored questions -> {out}")
