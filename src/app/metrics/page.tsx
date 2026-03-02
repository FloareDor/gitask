"use client";

import type { CSSProperties } from "react";
import { useEffect, useState, useCallback } from "react";
import { getMetrics, clearMetrics, type MetricEvent, type AggregateTotals } from "@/lib/metrics";

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `~${(n / 1000).toFixed(1)}k`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function BarRow({
  label,
  value,
  max,
  detail,
  color,
}: {
  label: string;
  value: number;
  max: number;
  detail: string;
  color: string;
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div style={barRowStyles.row}>
      <span style={barRowStyles.label}>{label}</span>
      <div style={barRowStyles.track}>
        <div style={{ ...barRowStyles.fill, width: `${pct}%`, background: color }} />
      </div>
      <span style={barRowStyles.detail}>{detail}</span>
    </div>
  );
}

const barRowStyles: Record<string, CSSProperties> = {
  row: {
    display: "grid",
    gridTemplateColumns: "90px 1fr 140px",
    alignItems: "center",
    gap: "12px",
  },
  label: {
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    color: "var(--text-secondary)",
    textAlign: "right",
  },
  track: {
    height: "14px",
    background: "var(--bg-secondary)",
    border: "2px solid var(--border)",
    position: "relative",
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    left: 0,
    height: "100%",
    transition: "width 0.3s ease",
  },
  detail: {
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
  },
};

function EventRow({ event }: { event: MetricEvent }) {
  let typeLabel = event.type.toUpperCase();
  let detail = fmtMs(event.durationMs);

  if (event.type === "llm") {
    typeLabel = `LLM/${event.provider ?? "?"}`;
    const accuracy = event.tokenAccuracy === "actual" ? "" : "~";
    if (event.tokensIn != null || event.tokensOut != null) {
      detail += `  ${accuracy}${fmtTokens(event.tokensIn ?? 0)} in / ${accuracy}${fmtTokens(event.tokensOut ?? 0)} out`;
    }
  } else if (event.type === "embed") {
    typeLabel = "EMBED";
    if (event.chunks != null) detail += `  ${event.chunks} chunks`;
  } else if (event.type === "index") {
    typeLabel = "INDEX";
    if (event.files != null) detail += `  ${event.files} files`;
    if (event.chunks != null) detail += ` / ${event.chunks} chunks`;
    if (event.repo) detail += `  (${event.repo})`;
  } else if (event.type === "search") {
    typeLabel = "SEARCH";
  }

  return (
    <div style={eventRowStyles.row}>
      <span style={eventRowStyles.ts}>{fmtTime(event.ts)}</span>
      <span style={eventRowStyles.type}>{typeLabel}</span>
      <span style={eventRowStyles.detail}>{detail}</span>
    </div>
  );
}

const eventRowStyles: Record<string, CSSProperties> = {
  row: {
    display: "grid",
    gridTemplateColumns: "80px 110px 1fr",
    gap: "12px",
    alignItems: "center",
    padding: "7px 14px",
    borderBottom: "1px solid var(--border)",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
  },
  ts: {
    color: "var(--text-muted)",
  },
  type: {
    color: "var(--accent)",
    fontWeight: 700,
  },
  detail: {
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};

function MemoryGauge() {
  const [mem, setMem] = useState<{ used: number; total: number } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perf = performance as any;
    if (!perf.memory) return;

    function read() {
      setMem({
        used: perf.memory.usedJSHeapSize,
        total: perf.memory.totalJSHeapSize,
      });
    }
    read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, []);

  if (!mem) return null;

  const usedMB = (mem.used / 1024 / 1024).toFixed(1);
  const totalMB = (mem.total / 1024 / 1024).toFixed(1);
  const pct = Math.round((mem.used / mem.total) * 100);

  return (
    <div style={sectionStyles.card}>
      <div style={sectionStyles.cardTopBar}>
        <span style={sectionStyles.cardLabel}>Memory (Chrome)</span>
        <span style={sectionStyles.cardHint}>live · JS heap</span>
      </div>
      <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <BarRow
          label="JS Heap"
          value={mem.used}
          max={mem.total}
          detail={`${usedMB} MB / ${totalMB} MB (${pct}%)`}
          color="var(--accent)"
        />
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const [totals, setTotals] = useState<AggregateTotals | null>(null);
  const [events, setEvents] = useState<MetricEvent[]>([]);

  const refresh = useCallback(() => {
    const { totals: t, events: e } = getMetrics();
    setTotals(t);
    setEvents([...e].reverse().slice(0, 20));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function handleClear() {
    clearMetrics();
    refresh();
  }

  const geminiPct =
    totals && totals.llmCalls > 0
      ? Math.round((totals.geminiCalls / totals.llmCalls) * 100)
      : 0;
  const mlcPct = totals && totals.llmCalls > 0 ? 100 - geminiPct : 0;
  const totalTokens =
    totals ? totals.totalTokensIn + totals.totalTokensOut : 0;
  const inPct =
    totalTokens > 0 ? Math.round((totals!.totalTokensIn / totalTokens) * 100) : 0;
  const outPct = totalTokens > 0 ? 100 - inPct : 0;

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        {/* Header row */}
        <div style={styles.topRow}>
          <a href="/" style={styles.back}>
            ← back
          </a>
          <h1 style={styles.title}>Compute Metrics</h1>
          <button
            type="button"
            onClick={handleClear}
            style={styles.clearBtn}
          >
            Clear All
          </button>
        </div>

        {/* Summary stats */}
        <div style={sectionStyles.statGrid}>
          <StatCard label="Queries" value={String(totals?.llmCalls ?? 0)} />
          <StatCard
            label="Est. Tokens"
            value={fmtTokens(totalTokens)}
            prefix="~"
          />
          <StatCard
            label="LLM Time"
            value={fmtMs(totals?.totalLLMMs ?? 0)}
          />
          <StatCard
            label="Embed Time"
            value={fmtMs(totals?.totalEmbedMs ?? 0)}
          />
        </div>

        {/* Provider breakdown */}
        {totals && totals.llmCalls > 0 && (
          <div style={sectionStyles.card}>
            <div style={sectionStyles.cardTopBar}>
              <span style={sectionStyles.cardLabel}>Provider Breakdown</span>
              <span style={sectionStyles.cardHint}>{totals.llmCalls} calls</span>
            </div>
            <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <BarRow
                label="Gemini"
                value={geminiPct}
                max={100}
                detail={`${geminiPct}%  (${totals.geminiCalls} calls)`}
                color="var(--accent)"
              />
              <BarRow
                label="MLC"
                value={mlcPct}
                max={100}
                detail={`${mlcPct}%  (${totals.mlcCalls} calls)`}
                color="var(--success)"
              />
            </div>
          </div>
        )}

        {/* Token usage */}
        {totals && totalTokens > 0 && (
          <div style={sectionStyles.card}>
            <div style={sectionStyles.cardTopBar}>
              <span style={sectionStyles.cardLabel}>Token Usage (estimated)</span>
              <span style={sectionStyles.cardHint}>chars / 4 unless noted</span>
            </div>
            <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <BarRow
                label="Input"
                value={inPct}
                max={100}
                detail={`~${fmtTokens(totals.totalTokensIn)} tokens`}
                color="var(--accent)"
              />
              <BarRow
                label="Output"
                value={outPct}
                max={100}
                detail={`~${fmtTokens(totals.totalTokensOut)} tokens`}
                color="#a78bfa"
              />
            </div>
          </div>
        )}

        {/* Memory gauge — Chrome only */}
        <MemoryGauge />

        {/* Recent activity */}
        <div style={sectionStyles.card}>
          <div style={sectionStyles.cardTopBar}>
            <span style={sectionStyles.cardLabel}>Recent Activity</span>
            <span style={sectionStyles.cardHint}>last 20 events</span>
          </div>
          {events.length === 0 ? (
            <div style={sectionStyles.empty}>No events recorded yet. Send a message or trigger indexing.</div>
          ) : (
            <div>
              {events.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </div>
          )}
        </div>

        <footer style={styles.footer}>
          <span>gitask</span>
          <span style={styles.footerSep}>·</span>
          <span>compute metrics</span>
          <span style={styles.footerSep}>·</span>
          <span>localStorage persisted</span>
        </footer>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  prefix,
}: {
  label: string;
  value: string;
  prefix?: string;
}) {
  return (
    <div style={sectionStyles.statCard}>
      <span style={sectionStyles.statValue}>
        {prefix && <span style={sectionStyles.statPrefix}>{prefix}</span>}
        {value}
      </span>
      <span style={sectionStyles.statLabel}>{label}</span>
    </div>
  );
}

const sectionStyles: Record<string, CSSProperties> = {
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "12px",
  },
  statCard: {
    border: "2px solid var(--border)",
    background: "var(--bg-card)",
    boxShadow: "3px 3px 0 var(--accent)",
    padding: "16px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    alignItems: "center",
  },
  statValue: {
    fontSize: "28px",
    fontWeight: 800,
    fontFamily: "var(--font-display)",
    color: "var(--text-primary)",
    letterSpacing: "-0.03em",
  },
  statPrefix: {
    fontSize: "16px",
    color: "var(--text-muted)",
    marginRight: "1px",
  },
  statLabel: {
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  },
  card: {
    border: "2px solid var(--border)",
    background: "var(--bg-card)",
    boxShadow: "3px 3px 0 var(--border)",
  },
  cardTopBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "9px 14px",
    borderBottom: "2px solid var(--border)",
    background: "var(--bg-secondary)",
  },
  cardLabel: {
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--accent)",
  },
  cardHint: {
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
  },
  empty: {
    padding: "24px 14px",
    fontSize: "13px",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    textAlign: "center",
  },
};

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at 10% 10%, rgba(99, 102, 241, 0.08), transparent 40%), radial-gradient(circle at 85% 15%, rgba(234, 88, 12, 0.07), transparent 45%), var(--bg-primary)",
  },
  container: {
    maxWidth: "860px",
    margin: "0 auto",
    padding: "36px 20px 72px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  back: {
    color: "var(--text-secondary)",
    textDecoration: "none",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    border: "2px solid var(--border)",
    padding: "6px 12px",
    background: "var(--bg-card)",
    flexShrink: 0,
    transition: "color 0.1s ease, border-color 0.1s ease",
  },
  title: {
    margin: 0,
    fontFamily: "var(--font-display)",
    fontSize: "28px",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    color: "var(--text-primary)",
    flex: 1,
  },
  clearBtn: {
    flexShrink: 0,
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    padding: "6px 12px",
    border: "2px solid var(--error)",
    background: "transparent",
    color: "var(--error)",
    cursor: "pointer",
    letterSpacing: "0.04em",
    transition: "background 0.1s ease",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    color: "var(--text-muted)",
    borderTop: "2px solid var(--border)",
    paddingTop: "14px",
  },
  footerSep: {
    color: "var(--border-hover)",
  },
};
