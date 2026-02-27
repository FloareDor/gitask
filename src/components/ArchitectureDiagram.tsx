"use client";

import { useEffect, useRef, useState } from "react";
import s from "./ArchitectureDiagram.module.css";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { NodeDef, INGEST, QUERY_TOP, QUERY_BRANCH, QUERY_BOTTOM } from "./ArchitectureDiagramData";


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
      <line x1="140" y1="0" x2="140" y2="22" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      <line x1="56" y1="22" x2="224" y2="22" stroke="var(--border)" strokeWidth="2" />
      <line x1="56" y1="22" x2="56" y2="56" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      <line x1="224" y1="22" x2="224" y2="56" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

function MergeSVG() {
  return (
    <svg className={s.mergeSvg} viewBox="0 0 280 56" preserveAspectRatio="none" aria-hidden>
      <line x1="56" y1="0" x2="56" y2="34" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      <line x1="224" y1="0" x2="224" y2="34" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
      <line x1="56" y1="34" x2="224" y2="34" stroke="var(--border)" strokeWidth="2" />
      <line x1="140" y1="34" x2="140" y2="56" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.65s" repeatCount="indefinite" />
      </line>
    </svg>
  );
}

function Node({
  node, index, visible, badge, onClick, isSelected,
}: {
  node: NodeDef; index: number; visible: boolean; badge?: string;
  onClick?: () => void;
  isSelected?: boolean;
}) {
  const handleClick = () => {
    if (onClick) onClick();
  };

  return (
    <div
      data-node-id={node.id}
      className={`${s.node} ${visible ? s.nodeVisible : ""} ${isSelected ? s.nodeSelected : ""}`}
      style={{ transitionDelay: `${index * 55}ms` }}
    >
      <div
        className={`${s.card} ${onClick ? s.cardClickable : ""} ${isSelected ? s.cardSelected : ""}`}
        onClick={handleClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={onClick ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); }
        } : undefined}
        aria-pressed={isSelected}
      >
        <div className={s.meta}>
          <span className={s.phase}>{node.phase}</span>
          {badge && <span className={s.dbBadge}>{badge}</span>}
          {node.snippet && <span className={s.codeHint}>{"</>"}</span>}
        </div>
        <h3 className={s.title}>{node.title}</h3>
        <p className={s.detail}>{node.detail}</p>
      </div>

    </div>
  );
}

const PANEL_W = 620;
const PANEL_MAX_H = 760;

function CodePanel({
  node,
  onClose,
}: {
  node: NodeDef;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const scrollY = window.scrollY;
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyPosition = document.body.style.position;
    const prevBodyTop = document.body.style.top;
    const prevBodyWidth = document.body.style.width;

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.position = prevBodyPosition;
      document.body.style.top = prevBodyTop;
      document.body.style.width = prevBodyWidth;
      window.scrollTo(0, scrollY);
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <>
      <motion.div
        className={s.backdrop}
        onClick={onClose}
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
      />
      <div className={s.modalFrame}>
        <motion.div
          className={`${s.codePanel} ${s.codePanelCentered}`}
          style={{ width: `min(90vw, ${PANEL_W}px)`, maxHeight: `min(88vh, ${PANEL_MAX_H}px)` }}
          role="dialog"
          aria-modal
          aria-label={`Code for ${node.title}`}
          onClick={(e) => e.stopPropagation()}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 16 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 10 }}
          transition={
            reduceMotion
              ? { duration: 0.12 }
              : { type: "spring", stiffness: 380, damping: 32, mass: 0.9 }
          }
        >
          <div className={s.codePanelHeader}>
            <div className={s.codePanelHeaderInner}>
              <p className={s.codePanelTitle}>{node.title}</p>
              {node.file && <p className={s.codePanelFilePath}>{node.file}</p>}
            </div>
            <button className={s.closeBtn} onClick={onClose} aria-label="Close panel">×</button>
          </div>
          <div className={s.codeBody}>
            {node.snippet ? (
              <SyntaxHighlighter
                language="typescript"
                style={oneDark}
                customStyle={{
                  margin: 0,
                  borderRadius: "2px",
                  fontSize: "0.78rem",
                  lineHeight: "1.55",
                  border: "2px solid var(--border)",
                  boxShadow: "3px 3px 0 var(--border)",
                  overflow: "auto",
                }}
                showLineNumbers
                lineNumberStyle={{ color: "#636d83", fontSize: "0.68rem", minWidth: "2.2em" }}
              >
                {node.snippet}
              </SyntaxHighlighter>
            ) : (
              <p className={s.noSnippet}>No snippet available.</p>
            )}
          </div>
        </motion.div>
      </div>
    </>,
    document.body
  );
}

export function ArchitectureDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const ingestRowRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showIngestCue, setShowIngestCue] = useState(false);
  const [ingestAtEnd, setIngestAtEnd] = useState(false);

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

  useEffect(() => {
    const row = ingestRowRef.current;
    if (!row) return;

    const update = () => {
      const overflow = row.scrollWidth - row.clientWidth > 8;
      const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 8;
      setShowIngestCue(overflow);
      setIngestAtEnd(atEnd);
    };

    update();
    row.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      row.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const handleSelect = (node: NodeDef) => {
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  };

  const allNodes = [...INGEST, ...QUERY_TOP, ...QUERY_BRANCH, ...QUERY_BOTTOM];
  const selectedNode = selectedId ? allNodes.find((n) => n.id === selectedId) ?? null : null;

  return (
    <>
      <div ref={ref} className={s.root}>
        <div className={s.phaseBlock}>
          <div className={s.phaseLabel}>
            <span className={s.phasePill}>01</span>
            Ingestion + Indexing
          </div>
          <div className={s.ingestShell}>
            <div ref={ingestRowRef} className={s.ingestRow}>
              {INGEST.map((node, i) => (
                <div key={node.id} className={s.ingestItem}>
                  <Node
                    node={node} index={i} visible={visible}
                    onClick={() => handleSelect(node)}
                    isSelected={selectedId === node.id}
                  />
                  {i < INGEST.length - 1 && <HArrow />}
                </div>
              ))}
            </div>
            {showIngestCue && !ingestAtEnd && (
              <>
                <div className={s.ingestFade} aria-hidden />
                <div className={s.ingestCue}>Scroll →</div>
              </>
            )}
          </div>
        </div>

        <div className={s.phaseBridge}>
          <VArrow />
          <span className={s.bridgeLabel}>index ready â†’ query time</span>
        </div>

        <div className={s.phaseBlock}>
          <div className={s.phaseLabel}>
            <span className={s.phasePill}>02</span>
            Query-time Retrieval (CodeRAG-style)
          </div>
          <div className={s.queryFlow}>
            {QUERY_TOP.map((node, i) => (
              <div key={node.id} className={s.queryItem}>
                <Node
                  node={node} index={INGEST.length + i} visible={visible}
                  onClick={() => handleSelect(node)}
                  isSelected={selectedId === node.id}
                />
                {i < QUERY_TOP.length - 1 && <VArrow />}
              </div>
            ))}

            <ForkSVG />

            <div className={s.branchRow}>
              {QUERY_BRANCH.map((node, i) => (
                <Node
                  key={node.id}
                  node={node}
                  index={INGEST.length + QUERY_TOP.length + i}
                  visible={visible}
                  badge="IndexedDB"
                  onClick={() => handleSelect(node)}
                  isSelected={selectedId === node.id}
                />
              ))}
            </div>

            <MergeSVG />

            {QUERY_BOTTOM.map((node, i) => (
              <div key={node.id} className={s.queryItem}>
                <Node
                  node={node}
                  index={INGEST.length + QUERY_TOP.length + QUERY_BRANCH.length + i}
                  visible={visible}
                  onClick={() => handleSelect(node)}
                  isSelected={selectedId === node.id}
                />
                {i < QUERY_BOTTOM.length - 1 && <VArrow />}
              </div>
            ))}
          </div>
        </div>
      </div>
      <AnimatePresence mode="wait">
        {selectedNode && (
          <CodePanel key={selectedNode.id} node={selectedNode} onClose={() => setSelectedId(null)} />
        )}
      </AnimatePresence>
    </>
  );
}

