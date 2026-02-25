# GitAsk

Just a simple, browser-based RAG engine.

It turns any GitHub repo into a local AI assistant. Everything runs right on your device (WebGPU). no servers, no API keys, no costs.

Here's how it works:

![Architecture](https://mermaid.ink/img/Zmxvd2NoYXJ0IExSDQogICAgc3ViZ3JhcGggQnJvd3Nlcg0KICAgICAgICBBWyJVUkwgVHJpZ2dlcjxici8+KHByb3h5LnRzKSJdIC0tPiBCWyJHaXRIdWIgSW5nZXN0aW9uPGJyLz5TZXJ2aWNlIl0NCiAgICAgICAgQiAtLT4gQ1siQVNUIENodW5rZXI8YnIvPih0cmVlLXNpdHRlciBXQVNNKSJdDQogICAgICAgIEMgLS0+IERbIkVtYmVkZGluZyBQaXBlbGluZTxici8+KHRyYW5zZm9ybWVycy5qcyBXZWJHUFUpIl0NCiAgICAgICAgRCAtLT4gRVsiQmluYXJ5IFF1YW50aXNhdGlvbiJdDQogICAgICAgIEUgLS0+IEZbIkVudGl0eS1EQjxici8+KEluZGV4ZWREQikiXQ0KICAgICAgICBGIC0tPiBHWyJIeWJyaWQgU2VhcmNoPGJyLz4oSGFtbWluZyArIFJlZ2V4KSJdDQogICAgICAgIEcgLS0+IEhbIk1hdHJ5b3Noa2E8YnIvPlJlcmFua2VyIl0NCiAgICAgICAgSCAtLT4gSVsiV2ViTExNIFdvcmtlcjxici8+KFF3ZW4yLTAuNUIpIl0NCiAgICAgICAgSSAtLT4gSlsiQ2hhdCBVSSArPGJyLz5Db1ZlIExvb3AiXQ0KICAgIGVuZA0K)

## Retrieval (CodeRAG-style)

We use multi-query expansion and multi-path retrieval with preference reranking:

```mermaid
flowchart TB
  Q[User question] --> QE[Query expansion]
  QE --> Q1[Query 1: original]
  QE --> Q2[Query 2: code-style]
  Q1 --> E1[embedText]
  Q2 --> E2[embedText]
  E1 --> H1[hybridSearch]
  E2 --> H2[hybridSearch]
  Q1 --> H1
  Q2 --> H2
  H1 --> RRF[RRF over paths]
  H2 --> RRF
  RRF --> Pref[Preference rerank]
  Pref --> Top[Top-k chunks]
```

## How to run it

1. **Install**: `npm install`
2. **Start**: `npm run dev`
3. **Go**: Open `localhost:3000` and paste a GitHub URL.

that's it. hf.

## References

- **CodeRAG:** Zhang et al., *Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion*, EMNLP 2025. [arXiv:2509.16112](https://arxiv.org/abs/2509.16112)
- **CoVE:** Dhuliawala et al., *Chain-of-Verification Reduces Hallucination in Large Language Models*, Findings of ACL 2024. [arXiv:2309.11495](https://arxiv.org/abs/2309.11495)
