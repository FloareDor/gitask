import type { CSSProperties } from "react";
import { DATASET_META } from "@/lib/eval-data";
import { ABLATION_RESULTS } from "@/lib/eval-results";

const DATASET_BADGE = `${DATASET_META.name} — ${DATASET_META.queryCount} queries — ${DATASET_META.chunkCount} candidates — human-labeled`;

export default function AblationPage() {
  const bestRecall = Math.max(...ABLATION_RESULTS.map((r) => r.avgRecallAt5));
  const bestMRR = Math.max(...ABLATION_RESULTS.map((r) => r.avgMRR));
  const bestNdcg = Math.max(...ABLATION_RESULTS.map((r) => r.avgNdcgAt10));
  const bestLatency = Math.min(...ABLATION_RESULTS.map((r) => r.avgLatencyUs));

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <a href="/" style={styles.back} className="ablation-back">
          ← back
        </a>

        <header style={styles.header}>
          <div style={styles.titleRow}>
            <h1 style={styles.title}>Ablation Study</h1>
            <span style={styles.countChip}>{ABLATION_RESULTS.length} configs</span>
          </div>
          <p style={styles.subtitle}>
            Retrieval quality benchmark with a fixed query/chunk corpus and precomputed
            embeddings.
          </p>
          <a href={DATASET_META.url} style={styles.badge}>
            {DATASET_BADGE}
          </a>
        </header>

        <section>
          <div style={styles.tableCard}>
            <div style={styles.tableTopBar}>
              <span style={styles.tableBarLabel}>Results</span>
              <span style={styles.tableBarHint}>hover row for description</span>
            </div>
            <div style={styles.tableScroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Config</th>
                    <th
                      style={styles.thRight}
                      title="Fraction of relevant chunks found in top 5."
                    >
                      Recall@5
                    </th>
                    <th
                      style={styles.thRight}
                      title="Mean reciprocal rank of first relevant result."
                    >
                      MRR
                    </th>
                    <th
                      style={styles.thRight}
                      title="Discounted ranking quality using 0–3 relevance labels."
                    >
                      NDCG@10
                    </th>
                    <th
                      style={styles.thRight}
                      title="Average per-query latency in microseconds."
                    >
                      Latency
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ABLATION_RESULTS.map((result, index) => {
                    const isBaseline = index === 0;
                    return (
                      <tr
                        key={result.config}
                        style={isBaseline ? styles.baselineRow : styles.row}
                      >
                        <td style={styles.tdConfig} title={result.description}>
                          <span style={styles.configName}>{result.config}</span>
                          {isBaseline && (
                            <span style={styles.baselineTag}>baseline</span>
                          )}
                        </td>
                        <td
                          style={{
                            ...styles.tdRight,
                            ...(result.avgRecallAt5 === bestRecall
                              ? styles.tdBest
                              : undefined),
                          }}
                        >
                          {(result.avgRecallAt5 * 100).toFixed(1)}%
                        </td>
                        <td
                          style={{
                            ...styles.tdRight,
                            ...(result.avgMRR === bestMRR
                              ? styles.tdBest
                              : undefined),
                          }}
                        >
                          {result.avgMRR.toFixed(3)}
                        </td>
                        <td
                          style={{
                            ...styles.tdRight,
                            ...(result.avgNdcgAt10 === bestNdcg
                              ? styles.tdBest
                              : undefined),
                          }}
                        >
                          {result.avgNdcgAt10.toFixed(3)}
                        </td>
                        <td
                          style={{
                            ...styles.tdRight,
                            ...(result.avgLatencyUs === bestLatency
                              ? styles.tdBestLatency
                              : undefined),
                          }}
                        >
                          {result.avgLatencyUs.toFixed(0)}μs
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer style={styles.footer}>
          <span>gitask</span>
          <span style={styles.footerSep}>·</span>
          <span>{ABLATION_RESULTS.length} configs</span>
          <span style={styles.footerSep}>·</span>
          <span>Feb 2026</span>
        </footer>
      </div>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at 10% 10%, rgba(99, 102, 241, 0.08), transparent 40%), radial-gradient(circle at 85% 15%, rgba(234, 88, 12, 0.07), transparent 45%), var(--bg-primary)",
  },
  container: {
    maxWidth: "900px",
    margin: "0 auto",
    padding: "36px 20px 72px",
    display: "flex",
    flexDirection: "column",
    gap: "24px",
  },

  /* Back link */
  back: {
    width: "fit-content",
    color: "var(--text-secondary)",
    textDecoration: "none",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    border: "2px solid var(--border)",
    padding: "6px 12px",
    background: "var(--bg-card)",
    transition: "color 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease, transform 0.1s ease",
  },

  /* Header */
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  title: {
    margin: 0,
    fontFamily: "var(--font-display)",
    fontSize: "34px",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    color: "var(--text-primary)",
  },
  countChip: {
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--accent)",
    border: "2px solid var(--accent)",
    padding: "3px 8px",
    background: "rgba(99, 102, 241, 0.08)",
  },
  subtitle: {
    margin: 0,
    color: "var(--text-secondary)",
    lineHeight: 1.55,
    maxWidth: "68ch",
    fontSize: "14px",
  },
  badge: {
    display: "inline-block",
    width: "fit-content",
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    border: "2px solid var(--border)",
    background: "var(--bg-secondary)",
    padding: "6px 12px",
    color: "var(--text-secondary)",
    textDecoration: "none",
    boxShadow: "2px 2px 0 var(--border-hover)",
    transition: "border-color 0.1s ease, box-shadow 0.1s ease, transform 0.1s ease",
  },

  /* Table card */
  tableCard: {
    border: "2px solid var(--border)",
    background: "var(--bg-card)",
    boxShadow: "4px 4px 0 var(--accent)",
  },
  tableTopBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderBottom: "2px solid var(--border)",
    background: "var(--bg-secondary)",
  },
  tableBarLabel: {
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--accent)",
  },
  tableBarHint: {
    fontSize: "11px",
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
  },
  tableScroll: {
    overflowX: "auto",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    minWidth: "640px",
  },

  /* Table head */
  th: {
    textAlign: "left",
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "10px 14px",
    borderBottom: "2px solid var(--border)",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    background: "var(--bg-secondary)",
  },
  thRight: {
    textAlign: "right",
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "10px 14px",
    borderBottom: "2px solid var(--border)",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    background: "var(--bg-secondary)",
  },

  /* Table rows */
  row: {},
  baselineRow: {
    borderLeft: "3px solid var(--accent)",
    background: "rgba(99, 102, 241, 0.06)",
  },

  /* Table cells */
  tdConfig: {
    padding: "13px 14px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  td: {
    padding: "13px 14px",
    borderBottom: "1px solid var(--border)",
  },
  tdRight: {
    padding: "13px 14px",
    borderBottom: "1px solid var(--border)",
    textAlign: "right",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    color: "var(--text-secondary)",
  },
  tdBest: {
    color: "var(--accent)",
    fontWeight: 700,
  },
  tdBestLatency: {
    color: "var(--success)",
    fontWeight: 700,
  },

  configName: {
    fontWeight: 600,
    fontSize: "14px",
    color: "var(--text-primary)",
    fontFamily: "var(--font-display)",
  },
  baselineTag: {
    fontSize: "10px",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--accent)",
    border: "1px solid rgba(99, 102, 241, 0.4)",
    background: "rgba(99, 102, 241, 0.1)",
    padding: "1px 6px",
  },

  /* Footer */
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
