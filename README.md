# GitAsk

Just a simple, browser-based RAG engine.

It turns any GitHub repo into a local AI assistant. Everything runs right on your device (WebGPU). no servers, no API keys, no costs.

Here's how it works:

```mermaid
flowchart TB
  subgraph Build["Ingestion + Indexing"]
    A["URL Trigger<br/>(proxy.ts)"] --> B["GitHub Ingestion<br/>Service"]
    B --> C["AST Chunker<br/>(tree-sitter WASM)"]
    C --> D["Embedding Pipeline<br/>(transformers.js WebGPU)"]
    D --> E["Binary Quantisation"]
    E --> F["Entity-DB<br/>(IndexedDB)"]
  end

  subgraph Query["Query-time Retrieval (CodeRAG-style)"]
    SP[" "]
    SP --> Q["User question"]
    Q --> QE["Query expansion"]
    QE --> Q1["Query 1: original"]
    QE --> Q2["Query 2: code-style"]
    Q1 --> H1["Hybrid Search<br/>(Hamming + Regex)"]
    Q2 --> H2["Hybrid Search<br/>(Hamming + Regex)"]
    F --> H1
    F --> H2
    H1 --> RRF["RRF over paths"]
    H2 --> RRF
    RRF --> Pref["Preference rerank"]
    Pref --> Top["Top-k chunks"]
    Top --> I["WebLLM Worker<br/>(Qwen2-0.5B)"]
    I --> J["Chat UI +<br/>CoVe Loop"]
    style SP fill:transparent,stroke:transparent,color:transparent
  end
```

## Retrieval (CodeRAG-style)

It uses multi-query expansion and multi-path retrieval with preference reranking (shown in the unified diagram above).

## How to run it

1. **Install**: `npm install`
2. **Start**: `npm run dev`
3. **Go**: Open `localhost:3000` and paste a GitHub URL.

that's it. hf.

## References

- **Inspired by CodeRAG:** Zhang et al., *Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion*, EMNLP 2025. [arXiv:2509.16112](https://arxiv.org/abs/2509.16112)
- **Inspired by CoVE:** Dhuliawala et al., *Chain-of-Verification Reduces Hallucination in Large Language Models*, Findings of ACL 2024. [arXiv:2309.11495](https://arxiv.org/abs/2309.11495)
