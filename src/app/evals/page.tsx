"use client";

import {
	ABLATION_RESULTS,
	COVE_ANALYSIS,
	STORAGE_COMPARISON,
} from "@/lib/eval-results";

export default function EvalsPage() {
	const maxLatency = Math.max(...ABLATION_RESULTS.map((r) => r.avgLatencyUs));

	return (
		<div style={styles.page}>
			<div style={styles.container}>
				{/* Nav */}
				<a href="/" style={styles.back}>← back</a>

				{/* Title */}
				<h1 style={styles.h1}>Ablation Study</h1>
				<p style={styles.lead}>
					I turned off one component at a time and measured what broke.
				</p>

				{/* ── Why These Metrics ── */}
				<section style={styles.section}>
					<h2 style={styles.h2}>Why these metrics</h2>
					<div style={styles.metricExplain}>
						<div style={styles.metricCard}>
							<strong>Recall@5</strong>
							<span style={styles.muted}>
								"Did the right code chunks show up in the top 5?" — measures if the system finds what it should.
							</span>
						</div>
						<div style={styles.metricCard}>
							<strong>MRR</strong>
							<span style={styles.muted}>
								"How high is the first correct result?" — 1.0 means it's #1 every time. Lower = buried.
							</span>
						</div>
						<div style={styles.metricCard}>
							<strong>Latency</strong>
							<span style={styles.muted}>
								Wall-clock time per query in microseconds. Measured in Node.js, no GPU.
							</span>
						</div>
					</div>
				</section>

				{/* ── Setup ── */}
				<section style={styles.section}>
					<h2 style={styles.h2}>Setup</h2>
					<p style={styles.muted}>
						30 code chunks from the GitAsk codebase. 15 questions with known answers.
						Deterministic embeddings (384-dim, seeded PRNG) so results are reproducible.
						Ran in Vitest, single thread, no GPU.
					</p>
				</section>

				{/* ── Results Table ── */}
				<section style={styles.section}>
					<h2 style={styles.h2}>Results</h2>
					<div style={styles.tableWrap}>
						<table style={styles.table}>
							<thead>
								<tr>
									<th style={styles.th}>Config</th>
									<th style={styles.thR}>Recall@5</th>
									<th style={styles.thR}>MRR</th>
									<th style={styles.thR}>Latency</th>
									<th style={styles.thC}>Quant</th>
									<th style={styles.thC}>Keyword</th>
									<th style={styles.thC}>RRF</th>
									<th style={styles.thC}>Rerank</th>
									<th style={styles.thC}>Multi-Path</th>
								</tr>
							</thead>
							<tbody>
								{ABLATION_RESULTS.map((r, i) => {
									const isDegraded = r.avgRecallAt5 < 1 || r.avgMRR < 1;
									return (
										<tr key={r.config} style={{
											borderBottom: "1px solid var(--border)",
											background: isDegraded ? "rgba(239,68,68,0.06)" : i === 0 ? "rgba(99,102,241,0.06)" : "transparent",
										}}>
											<td style={styles.td}>
												<span style={{ fontWeight: 600 }}>
													{i === 0 && <span style={styles.tag}>baseline</span>}
													{r.config}
												</span>
											</td>
											<td style={{
												...styles.tdR,
												color: r.avgRecallAt5 === 1 ? "var(--success)" : "var(--error)",
											}}>
												{(r.avgRecallAt5 * 100).toFixed(1)}%
											</td>
											<td style={{
												...styles.tdR,
												color: r.avgMRR === 1 ? "var(--success)" : "var(--error)",
											}}>
												{r.avgMRR.toFixed(3)}
											</td>
											<td style={styles.tdR}>{r.avgLatencyUs.toFixed(0)}μs</td>
											<td style={styles.tdC}>{r.features.binaryQuantization ? "✓" : "—"}</td>
											<td style={styles.tdC}>{r.features.keywordSearch ? "✓" : "—"}</td>
											<td style={styles.tdC}>{r.features.rrfFusion ? "✓" : "—"}</td>
											<td style={styles.tdC}>{r.features.cosineRerank ? "✓" : "—"}</td>
											<td style={styles.tdC}>{r.features.queryExpansion ? "✓" : "—"}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</section>

				{/* ── Bars ── */}
				<section style={styles.barSection}>
					<div style={styles.barGroup}>
						<h3 style={styles.h3}>Recall@5</h3>
						{ABLATION_RESULTS.map((r) => (
							<Bar key={r.config} label={r.config} value={r.avgRecallAt5 * 100} max={100} unit="%" bad={r.avgRecallAt5 < 1} />
						))}
					</div>
					<div style={styles.barGroup}>
						<h3 style={styles.h3}>MRR</h3>
						{ABLATION_RESULTS.map((r) => (
							<Bar key={r.config} label={r.config} value={r.avgMRR * 100} max={100} unit="" fmt={(v) => (v / 100).toFixed(3)} bad={r.avgMRR < 1} />
						))}
					</div>
					<div style={styles.barGroup}>
						<h3 style={styles.h3}>Latency (μs)</h3>
						{ABLATION_RESULTS.map((r) => (
							<Bar key={r.config} label={r.config} value={r.avgLatencyUs} max={maxLatency} unit="μs" />
						))}
					</div>
				</section>

				{/* ── Storage ── */}
				<section style={styles.section}>
					<h2 style={styles.h2}>Storage: Binary Quantization</h2>
					<div style={styles.storageRow}>
						<div style={styles.storageBox}>
							<span style={styles.muted}>Float32</span>
							<span style={styles.bigNum}>{STORAGE_COMPARISON.float32PerVector}B</span>
							<span style={styles.muted}>/vector</span>
						</div>
						<span style={styles.arrow}>→</span>
						<div style={{ ...styles.storageBox, borderColor: "var(--success)" }}>
							<span style={styles.muted}>Binary</span>
							<span style={{ ...styles.bigNum, color: "var(--success)" }}>{STORAGE_COMPARISON.binaryPerVector}B</span>
							<span style={styles.muted}>/vector</span>
						</div>
						<span style={styles.compressionTag}>{STORAGE_COMPARISON.compressionRatio}× smaller</span>
					</div>
					<p style={styles.muted}>
						For {STORAGE_COMPARISON.exampleRepoChunks} chunks: {STORAGE_COMPARISON.float32TotalKB.toFixed(0)}KB → {STORAGE_COMPARISON.binaryTotalKB.toFixed(0)}KB.
						Same recall. Fits in IndexedDB easily.
					</p>
				</section>

				{/* ── CoVe ── */}
				<section style={styles.section}>
					<h2 style={styles.h2}>CoVe (Chain-of-Verification)</h2>
					<p style={styles.muted}>
						Can't benchmark automatically — it needs the LLM. Here's what I observed manually:
					</p>
					<div style={styles.coveGrid}>
						{COVE_ANALYSIS.map((e) => (
							<div key={e.aspect} style={styles.coveItem}>
								<strong style={{ fontSize: "13px" }}>{e.aspect}</strong>
								<span style={styles.muted}>{e.observation}</span>
							</div>
						))}
					</div>
				</section>

				{/* ── Bottom Line ── */}
				<section style={styles.section}>
					<h2 style={styles.h2}>Bottom line</h2>
					<ul style={styles.list}>
						<li><strong>Reranking matters most.</strong> Only config that hurts quality. Don't skip it.</li>
						<li><strong>Quantization is free accuracy.</strong> 32× less storage, same recall.</li>
						<li><strong>Hybrid search is cheap insurance.</strong> Catches exact symbol names vectors miss.</li>
						<li><strong>CodeRAG multi-path matches the full pipeline</strong> in recall but costs ~57% more latency — worth it for hard queries.</li>
						<li><strong>CoVe helps on hard questions.</strong> Adds 2–4s latency. Best as opt-in.</li>
					</ul>
				</section>

				<footer style={styles.footer}>
					GitAsk · 30 chunks · 15 queries · 5 configs · Vitest · Feb 2026
				</footer>
			</div>
		</div>
	);
}

// ─── Bar component ──────────────────────────────────────────────────────────

function Bar({ label, value, max, unit, fmt, bad }: {
	label: string; value: number; max: number; unit: string;
	fmt?: (v: number) => string; bad?: boolean;
}) {
	const display = fmt ? fmt(value) : `${value.toFixed(value >= 100 ? 0 : 1)}${unit}`;
	return (
		<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
			<span style={{ fontSize: "11px", color: "var(--text-secondary)", width: "90px", flexShrink: 0 }}>{label}</span>
			<div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "var(--bg-secondary)", overflow: "hidden" }}>
				<div style={{
					height: "100%", borderRadius: "3px",
					width: `${(value / max) * 100}%`,
					background: bad ? "var(--error)" : "var(--accent)",
					transition: "width 0.4s ease",
				}} />
			</div>
			<span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", width: "55px", textAlign: "right" as const, color: bad ? "var(--error)" : "var(--text-primary)" }}>
				{display}
			</span>
		</div>
	);
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
	page: { minHeight: "100vh" },
	container: {
		maxWidth: "800px",
		margin: "0 auto",
		padding: "32px 24px 60px",
		display: "flex",
		flexDirection: "column",
		gap: "36px",
	},
	back: {
		fontSize: "13px",
		color: "var(--text-muted)",
		textDecoration: "none",
	},
	h1: {
		fontSize: "28px",
		fontWeight: 700,
		letterSpacing: "-0.02em",
		marginTop: "-20px",
	},
	lead: {
		fontSize: "15px",
		color: "var(--text-secondary)",
		marginTop: "-24px",
	},
	section: {
		display: "flex",
		flexDirection: "column",
		gap: "12px",
	},
	h2: {
		fontSize: "16px",
		fontWeight: 600,
		borderBottom: "1px solid var(--border)",
		paddingBottom: "8px",
	},
	h3: {
		fontSize: "13px",
		fontWeight: 600,
		color: "var(--text-secondary)",
		marginBottom: "4px",
	},
	muted: {
		fontSize: "13px",
		color: "var(--text-secondary)",
		lineHeight: 1.6,
	},

	// Metric explanation
	metricExplain: {
		display: "flex",
		flexDirection: "column",
		gap: "10px",
	},
	metricCard: {
		display: "flex",
		flexDirection: "column",
		gap: "2px",
		paddingLeft: "12px",
		borderLeft: "2px solid var(--border)",
		fontSize: "13px",
	},

	// Table
	tableWrap: { overflowX: "auto" },
	table: {
		width: "100%",
		borderCollapse: "collapse" as const,
		fontSize: "13px",
	},
	th: {
		textAlign: "left" as const,
		padding: "8px 10px",
		borderBottom: "2px solid var(--border)",
		color: "var(--text-muted)",
		fontSize: "11px",
		textTransform: "uppercase" as const,
		letterSpacing: "0.04em",
		fontWeight: 500,
	},
	thR: {
		textAlign: "right" as const,
		padding: "8px 10px",
		borderBottom: "2px solid var(--border)",
		color: "var(--text-muted)",
		fontSize: "11px",
		textTransform: "uppercase" as const,
		letterSpacing: "0.04em",
		fontWeight: 500,
	},
	thC: {
		textAlign: "center" as const,
		padding: "8px 10px",
		borderBottom: "2px solid var(--border)",
		color: "var(--text-muted)",
		fontSize: "11px",
		textTransform: "uppercase" as const,
		letterSpacing: "0.04em",
		fontWeight: 500,
	},
	td: { padding: "10px 10px" },
	tdR: {
		padding: "10px 10px",
		textAlign: "right" as const,
		fontFamily: "var(--font-mono)",
		fontWeight: 600,
		fontSize: "13px",
	},
	tdC: {
		padding: "10px 10px",
		textAlign: "center" as const,
		color: "var(--text-muted)",
	},
	tag: {
		fontSize: "9px",
		padding: "1px 5px",
		borderRadius: "3px",
		background: "var(--accent)",
		color: "white",
		fontWeight: 600,
		textTransform: "uppercase" as const,
		marginRight: "6px",
		verticalAlign: "middle",
	},

	// Bars
	barSection: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
		gap: "24px",
	},
	barGroup: {
		display: "flex",
		flexDirection: "column",
		gap: "8px",
	},

	// Storage
	storageRow: {
		display: "flex",
		alignItems: "center",
		gap: "16px",
		flexWrap: "wrap" as const,
	},
	storageBox: {
		padding: "14px 20px",
		borderRadius: "var(--radius-sm)",
		border: "1px solid var(--border)",
		background: "var(--bg-secondary)",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: "2px",
	},
	bigNum: {
		fontSize: "24px",
		fontWeight: 700,
		fontFamily: "var(--font-mono)",
	},
	arrow: {
		fontSize: "20px",
		color: "var(--text-muted)",
	},
	compressionTag: {
		fontSize: "12px",
		fontWeight: 600,
		color: "var(--success)",
		padding: "3px 8px",
		borderRadius: "4px",
		border: "1px solid rgba(34,197,94,0.3)",
		background: "rgba(34,197,94,0.08)",
	},

	// CoVe
	coveGrid: {
		display: "grid",
		gridTemplateColumns: "1fr 1fr",
		gap: "10px",
	},
	coveItem: {
		display: "flex",
		flexDirection: "column",
		gap: "4px",
		padding: "12px",
		borderRadius: "var(--radius-sm)",
		background: "var(--bg-secondary)",
		border: "1px solid var(--border)",
	},

	// Bottom line
	list: {
		listStyle: "none",
		padding: 0,
		display: "flex",
		flexDirection: "column",
		gap: "8px",
		fontSize: "14px",
		color: "var(--text-secondary)",
		lineHeight: 1.6,
	},

	footer: {
		textAlign: "center",
		fontSize: "11px",
		color: "var(--text-muted)",
		paddingTop: "12px",
		borderTop: "1px solid var(--border)",
	},
};
