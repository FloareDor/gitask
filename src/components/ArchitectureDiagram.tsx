"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ArchitectureDiagram.module.css";

type FlowNode = {
  id: string;
  phase: string;
  title: string;
  detail: string;
};

const NODES: FlowNode[] = [
  {
    id: "url",
    phase: "Input",
    title: "URL Trigger",
    detail: "proxy.ts validates owner/repo and starts local processing.",
  },
  {
    id: "github",
    phase: "Ingestion",
    title: "GitHub Fetch",
    detail: "Repository tree and source blobs are pulled into browser memory.",
  },
  {
    id: "chunker",
    phase: "Parse",
    title: "AST Chunker",
    detail: "tree-sitter WASM segments code into semantically stable chunks.",
  },
  {
    id: "embed",
    phase: "Compute",
    title: "Embedding Pipeline",
    detail: "transformers.js runs WebGPU embeddings for chunk vectors.",
  },
  {
    id: "quant",
    phase: "Optimize",
    title: "Binary Quantisation",
    detail: "Vectors are compressed for fast local similarity operations.",
  },
  {
    id: "db",
    phase: "Persist",
    title: "IndexedDB",
    detail: "IndexedDB stores vectors, metadata, and symbol structure locally.",
  },
  {
    id: "search",
    phase: "Retrieval",
    title: "Hybrid Search",
    detail: "Hamming distance and regex matching are fused for recall.",
  },
  {
    id: "rerank",
    phase: "Selection",
    title: "Matryoshka Reranker",
    detail: "Candidate chunks are reranked before prompt construction.",
  },
  {
    id: "llm",
    phase: "Inference",
    title: "WebLLM Worker",
    detail: "Qwen2-0.5B generates grounded answers in a dedicated worker.",
  },
  {
    id: "ui",
    phase: "Output",
    title: "Chat UI + CoVe",
    detail: "Answer and verification loop are streamed to the interface.",
  },
];

export function ArchitectureDiagram() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setHasEntered(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className={styles.flow} aria-label="Architecture flow">
      {NODES.map((node, index) => (
        <div key={node.id} className={styles.nodeWrap}>
          <article
            className={`${styles.step} ${hasEntered ? styles.isVisible : ""}`}
            style={{ transitionDelay: `${index * 70}ms` }}
          >
            <div className={styles.card}>
              <div className={styles.meta}>
                <span className={styles.index}>{String(index + 1).padStart(2, "0")}</span>
                <span className={styles.phase}>{node.phase}</span>
              </div>
              <h3 className={styles.title}>{node.title}</h3>
              <p className={styles.detail}>{node.detail}</p>
            </div>
          </article>

          {index < NODES.length - 1 && (
            <div
              className={`${styles.connector} ${hasEntered ? styles.connectorVisible : ""}`}
              style={{ transitionDelay: `${index * 70 + 120}ms` }}
              aria-hidden
            >
              <span className={styles.connectorLine} />
              <span className={styles.connectorArrow} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
