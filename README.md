<div align="center">

# GitAsk

**turn any github repo into an AI you can talk to, right in your browser. no server. no API key. no cloud.**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![WebGPU](https://img.shields.io/badge/WebGPU-enabled-orange?style=flat-square)](https://developer.chrome.com/docs/web-platform/webgpu)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](https://github.com/FloareDor/gitask/pulls)

</div>

---

paste a github URL. ask a question. get an answer grounded in the actual code.

no API key setup. no docker. no postgres. no cloud bill. the model runs on your GPU, the index lives in your browser, and nothing leaves your machine (unless you want it to).

it started as a toy to see if I can make a basic offline RAG system for code. it ended up being the way I actually explore unfamiliar repos.

---

## demo

<div align="center">
  <a href="https://drive.google.com/file/d/1I91z52aV2g4xpZOWVt_rIryyLjfDWzWm/view?usp=sharing">
    <img src="assets/gitask-demo-poster.png" alt="GitAsk demo video preview" width="800" />
  </a>
</div>

watch the walkthrough:
[gitask autoresearch music demo](https://drive.google.com/file/d/1I91z52aV2g4xpZOWVt_rIryyLjfDWzWm/view?usp=sharing)

---

## how it works

<div align="center">
  <img src="assets/diagram.gif" alt="gitask architecture - ingestion pipeline and query-time retrieval" width="800" />
</div>

### ingestion

1. **github fetch** - pulls the full file tree in one API call, then fetches files on-demand.
2. **AST chunking** - tree-sitter WASM parses your source and cuts at real boundaries: functions, classes, methods. not arbitrary line counts. supports JS/TS/TSX, Python, Rust, Go, Java, C/C++, and more. falls back to text splitting for everything else.
3. **embedding** - `all-MiniLM-L12-v2` via `@huggingface/transformers`, running on WebGPU if available, WASM otherwise. adaptive batch sizing squeezes out throughput.
4. **binary quantization** - float32 embeddings are sign-bit packed into `Uint32Array`s. 32x smaller in memory. hamming distance runs fast even on large repos.
5. **persistence** - everything lives in IndexedDB via entity-db. re-open the tab, the index is still there.

### retrieval

this is the part that actually makes answers good.

- **multi-query expansion** - your question gets expanded into two variants: the raw question, and a code-symbol-focused version. catches things a single-query approach misses.
- **hybrid search** - dense retrieval (hamming distance on binary embeddings) fused with BM25 sparse search. neither one alone is enough.
- **RRF** - reciprocal rank fusion merges the ranked lists from each query/retriever into one signal.
- **graph expansion** - the import/definition graph lets retrieval hop from a file to its dependencies when the chunk boundary cuts off relevant context.
- **cosine rerank** - the coarse RRF candidates get reranked with full cosine similarity before being handed to the LLM.

### generation

- **WebLLM** - Qwen2-0.5B runs entirely in your browser via `@mlc-ai/web-llm`. first load takes a few minutes (model download), then it's cached.
- **CoVe loop** - after generating an answer, the model extracts its own claims and verifies each one against the vector store. wrong claims get corrected. it's one pass of chain-of-verification, tuned for a small model.
- **BYOK** - if you'd rather use Gemini or Groq, you can. keys are encrypted in a local vault and never leave your device.

---

## quick start

```bash
npm install
npm run dev
```

open `http://localhost:3000`, paste a github URL, and start asking.

that's the whole setup.

Local note: this repo uses `webpack` for `npm run dev` because the `[owner]/[repo]`
route currently hangs under Turbopack on some local machines.

---

## stack

| layer | what |
|---|---|
| framework | Next.js 16 + React 19 |
| LLM (local) | `@mlc-ai/web-llm` - Qwen2-0.5B on WebGPU |
| embeddings | `@huggingface/transformers` - all-MiniLM-L12-v2 |
| AST parsing | `web-tree-sitter` (WASM) |
| vector store | `@babycommando/entity-db` -> IndexedDB |
| cloud LLM (optional) | Gemini, Groq via BYOK vault |
| UI | Framer Motion, React Markdown, syntax highlighting |

---

## features

- **zero backend** - the entire pipeline runs in-browser
- **WebGPU inference** with WASM fallback - works on most modern machines
- **AST-aware chunking** - chunks respect code structure, not just line counts
- **binary quantization** - 32x memory savings on the embedding index
- **hybrid search** - dense + sparse, fused with RRF
- **multi-query expansion** - CodeRAG-style, catches what single queries miss
- **dependency graph traversal** - retrieval follows imports to surface related code
- **CoVe self-correction** - the model checks its own answers against the codebase
- **persistent index** - close the tab, reopen, resume chatting
- **BYOK** - swap in Gemini or Groq if you want a bigger model
- **multi-session chat** - multiple chat histories per repo

---

## why not just use an existing tool?

most code-search tools either require a cloud backend, or they do naive chunking that cuts functions in half. I wanted something that:

1. runs completely locally
2. understands code structure (AST chunks)
3. retrieves well (hybrid search + RRF, not just cosine similarity)
4. is actually fast to set up (paste URL, done)

this is the thing I built to scratch that itch.

---

## research

the retrieval design draws from two papers:

- **CodeRAG** - Zhang et al., *Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion*, EMNLP 2025. [arXiv:2509.16112](https://arxiv.org/abs/2509.16112)
  -> multi-query expansion, hybrid retrieval, RRF fusion

- **CoVe** - Dhuliawala et al., *Chain-of-Verification Reduces Hallucination in Large Language Models*, Findings of ACL 2024. [arXiv:2309.11495](https://arxiv.org/abs/2309.11495)
  -> self-verification loop on generated answers

---

## star history

<a href="https://star-history.com/#FloareDor/gitask&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=FloareDor/gitask&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=FloareDor/gitask&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=FloareDor/gitask&type=Date" />
  </picture>
</a>

---

## acknowledgments

shoutout to [CosmoBean](https://github.com/CosmoBean) for shipping a ridiculous number of PRs on this. BM25, prompt injection guards, chunking perf, metrics, embeddings - a lot of the good stuff in here is his. he's my roommate and he just kept opening pull requests. genuinely made this project way better than it would've been.

---

## contributing

issues and PRs are welcome. if something doesn't work on your machine, open an issue with your browser + GPU info. browser ML is still a mess and edge cases are rreal.

---

## license

MIT
