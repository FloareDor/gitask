"use client";

import { useEffect, useRef, useState } from "react";
import s from "./ArchitectureDiagram.module.css";

type NodeDef = { id: string; phase: string; title: string; detail: string };

const INGEST: NodeDef[] = [
  { id: "url",    phase: "Input",    title: "URL Trigger",           detail: "proxy.ts validates owner/repo" },
  { id: "github", phase: "Ingest",   title: "GitHub Fetch",          detail: "Repo tree + blobs → browser" },
  { id: "ast",    phase: "Parse",    title: "AST Chunker",           detail: "tree-sitter WASM semantic splits" },
  { id: "embed",  phase: "Compute",  title: "Embedding Pipeline",    detail: "transformers.js WebGPU vectors" },
  { id: "quant",  phase: "Optimize", title: "Binary Quantization",   detail: "Compressed for fast Hamming search" },
  { id: "db",     phase: "Store",    title: "Entity-DB (IndexedDB)", detail: "Vectors + metadata persisted locally" },
];

const QUERY_TOP: NodeDef[] = [
  { id: "q",  phase: "Input",  title: "User Question",   detail: "Natural language query to the repo" },
  { id: "qe", phase: "Expand", title: "Query Expansion", detail: "Multi-query generation (CodeRAG-style)" },
];

const QUERY_BRANCH: NodeDef[] = [
  { id: "q1", phase: "Search", title: "Q1 · Original",   detail: "Hybrid search — Hamming + regex" },
  { id: "q2", phase: "Search", title: "Q2 · Code-Style", detail: "Hybrid search — Hamming + regex" },
];

const QUERY_BOTTOM: NodeDef[] = [
  { id: "rrf",    phase: "Merge",     title: "RRF Fusion",        detail: "Reciprocal Rank Fusion over both paths" },
  { id: "rerank", phase: "Rank",      title: "Preference Rerank", detail: "Matryoshka reranker on candidates" },
  { id: "topk",   phase: "Select",    title: "Top-k Chunks",      detail: "Best chunks assembled for context" },
  { id: "llm",    phase: "Inference", title: "WebLLM Worker",     detail: "Qwen2-0.5B in a dedicated web worker" },
  { id: "ui",     phase: "Output",    title: "Chat UI + CoVe",    detail: "Streamed answer + verification loop" },
];

// ── Animated connector primitives ──────────────────────────────────────────

function VArrow() {
  return (
    <svg className={s.vArrow} viewBox="0 0 16 40" aria-hidden>
      <line x1="8" y1="0" x2="8" y2="30" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      <polygon points="4,28 8,38 12,28" fill="var(--accent)" />
    </svg>
  );
}

function HArrow() {
  return (
    <svg className={s.hArrow} viewBox="0 0 40 16" aria-hidden>
      <line x1="0" y1="8" x2="30" y2="8" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      <polygon points="28,4 38,8 28,12" fill="var(--accent)" />
    </svg>
  );
}

function ForkSVG() {
  return (
    <svg className={s.forkSvg} viewBox="0 0 280 56" preserveAspectRatio="none" aria-hidden>
      {/* stem down */}
      <line x1="140" y1="0" x2="140" y2="22" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      {/* horizontal bar */}
      <line x1="56" y1="22" x2="224" y2="22" stroke="var(--border)" strokeWidth="2" />
      {/* left drop */}
      <line x1="56" y1="22" x2="56" y2="56" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      {/* right drop */}
      <line x1="224" y1="22" x2="224" y2="56" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

function MergeSVG() {
  return (
    <svg className={s.mergeSvg} viewBox="0 0 280 56" preserveAspectRatio="none" aria-hidden>
      {/* left rise */}
      <line x1="56" y1="0" x2="56" y2="34" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      {/* right rise */}
      <line x1="224" y1="0" x2="224" y2="34" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      {/* horizontal merge */}
      <line x1="56" y1="34" x2="224" y2="34" stroke="var(--border)" strokeWidth="2" />
      {/* stem down */}
      <line x1="140" y1="34" x2="140" y2="56" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

// ── Node card ───────────────────────────────────────────────────────────────

function Node({
  node, index, visible, badge,
}: {
  node: NodeDef; index: number; visible: boolean; badge?: string;
}) {
  return (
    <div
      className={`${s.node} ${visible ? s.nodeVisible : ""}`}
      style={{ transitionDelay: `${index * 55}ms` }}
    >
      <div className={s.card}>
        <div className={s.meta}>
          <span className={s.phase}>{node.phase}</span>
          {badge && <span className={s.dbBadge}>{badge}</span>}
        </div>
        <h3 className={s.title}>{node.title}</h3>
        <p className={s.detail}>{node.detail}</p>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function ArchitectureDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} className={s.root}>

      {/* ── Phase 1: Ingestion ── */}
      <div className={s.phaseBlock}>
        <div className={s.phaseLabel}>
          <span className={s.phasePill}>01</span>
          Ingestion + Indexing
        </div>
        <div className={s.ingestRow}>
          {INGEST.map((node, i) => (
            <div key={node.id} className={s.ingestItem}>
              <Node node={node} index={i} visible={visible} />
              {i < INGEST.length - 1 && <HArrow />}
            </div>
          ))}
        </div>
      </div>

      {/* ── Phase bridge ── */}
      <div className={s.phaseBridge}>
        <VArrow />
        <span className={s.bridgeLabel}>index ready → query time</span>
      </div>

      {/* ── Phase 2: Query ── */}
      <div className={s.phaseBlock}>
        <div className={s.phaseLabel}>
          <span className={s.phasePill}>02</span>
          Query-time Retrieval (CodeRAG-style)
        </div>
        <div className={s.queryFlow}>

          {/* top linear */}
          {QUERY_TOP.map((node, i) => (
            <div key={node.id} className={s.queryItem}>
              <Node node={node} index={INGEST.length + i} visible={visible} />
              {i < QUERY_TOP.length - 1 && <VArrow />}
            </div>
          ))}

          {/* fork */}
          <ForkSVG />

          {/* branch */}
          <div className={s.branchRow}>
            {QUERY_BRANCH.map((node, i) => (
              <Node
                key={node.id}
                node={node}
                index={INGEST.length + QUERY_TOP.length + i}
                visible={visible}
                badge="← IndexedDB"
              />
            ))}
          </div>

          {/* merge */}
          <MergeSVG />

          {/* bottom linear */}
          {QUERY_BOTTOM.map((node, i) => (
            <div key={node.id} className={s.queryItem}>
              <Node
                node={node}
                index={INGEST.length + QUERY_TOP.length + QUERY_BRANCH.length + i}
                visible={visible}
              />
              {i < QUERY_BOTTOM.length - 1 && <VArrow />}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
