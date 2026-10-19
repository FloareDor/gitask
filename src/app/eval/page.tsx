"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { indexRepository, type IndexProgress } from "@/lib/indexer";
import { embedText } from "@/lib/embedder";
import { VectorStore } from "@/lib/vectorStore";
import { getGeminiKeyScope, getLLMStatus, initLLM } from "@/lib/llm";
import { GEMINI_MODEL } from "@/lib/geminiModel";
import type { Arm } from "@/lib/eval/arms";
import {
  buildExport,
  runEvalForRepo,
  summarizeRepo,
  DEFAULT_RUNS,
  type EvalProgress,
  type EvalRecord,
  type RepoSummary,
} from "@/lib/eval/harness";
import { EVAL_QUESTIONS, EVAL_SET, evalRepos, questionsForRepo, refForRepo } from "@/lib/eval/questions";
import { bucketCounts, classifyAll } from "@/lib/eval/failures";
import { disagreements, stopReasons, summaryTable } from "@/lib/eval/summary";
import { runAblationForRepo, type AblationProgress, type AblationRow } from "@/lib/eval/ablation";

/** A long run shouldn't be lost to a reload. Records are flushed here as they land. */
const DRAFT_KEY = "gitask-eval-draft";

type Phase = "idle" | "indexing" | "indexed" | "running" | "ablating" | "done" | "error";
type Subset = "all" | "lookup" | "multihop";

function loadDraft(): EvalRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as EvalRecord[]) : [];
  } catch {
    return [];
  }
}

function saveDraft(records: EvalRecord[]): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(records));
  } catch {
    // Quota. The in-memory copy and the download still work.
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export default function EvalPage() {
  const repos = useMemo(() => evalRepos(), []);
  const [repo, setRepo] = useState(repos[0]);
  const [token, setToken] = useState("");
  const [runs, setRuns] = useState(DEFAULT_RUNS);
  const [arms, setArms] = useState<Arm[]>(["rag", "agent"]);
  const [smoke, setSmoke] = useState(false);
  /**
   * Re-run one question type on its own. Phase 5 fixes a defect that only shows
   * up on multi-hop questions, and re-running the lookups it cannot affect
   * would only dilute the measured before/after.
   */
  const [subset, setSubset] = useState<Subset>("all");

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [evalProgress, setEvalProgress] = useState<EvalProgress | null>(null);
  const [summaries, setSummaries] = useState<RepoSummary[]>([]);
  const [records, setRecords] = useState<EvalRecord[]>(loadDraft);
  const [ablation, setAblation] = useState<AblationRow[]>([]);
  const [ablationProgress, setAblationProgress] = useState<AblationProgress | null>(null);

  const storeRef = useRef(new VectorStore());
  const abortRef = useRef<AbortController | null>(null);

  const ref = refForRepo(repo);
  const questions = useMemo(() => questionsForRepo(repo), [repo]);
  const pickedQuestions = useMemo(
    () => (subset === "all" ? questions : questions.filter((q) => q.type === subset)),
    [questions, subset]
  );
  const table = useMemo(() => summaryTable(records), [records]);
  const stops = useMemo(() => stopReasons(records), [records]);
  const splits = useMemo(() => disagreements(records), [records]);
  const failures = useMemo(() => bucketCounts(classifyAll(records, EVAL_QUESTIONS)), [records]);

  const handleIndex = useCallback(async () => {
    const [owner, name] = repo.split("/");
    setPhase("indexing");
    setError(null);
    storeRef.current = new VectorStore();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await indexRepository(
        owner, name, storeRef.current, setIndexProgress,
        token || undefined, controller.signal, ref
      );
      const summary = summarizeRepo(storeRef.current, repo);
      setSummaries((prev) => [...prev.filter((s) => s.repo !== repo), summary]);
      setPhase("indexed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [repo, ref, token]);

  const handleRun = useCallback(async () => {
    setPhase("running");
    setError(null);
    // The RAG arm's multi-query expansion and refinement both no-op unless the
    // shared LLM engine is ready. Without this the baseline would quietly run
    // single-query, which is not the RAG the app ships.
    try {
      await initLLM();
      if (getLLMStatus() !== "ready") throw new Error(`LLM status is ${getLLMStatus()}`);
    } catch (err) {
      setError(`Query expansion needs a working Gemini key: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("error");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // Re-running a repo replaces its rows rather than doubling them.
    const kept = records.filter((record) => record.repo !== repo);
    let collected = kept;
    setRecords(kept);

    try {
      await runEvalForRepo(storeRef.current, repo, {
        withKey: getGeminiKeyScope(),
        runs,
        arms,
        questionIds: pickedQuestions.length === questions.length && !smoke
          ? undefined
          : (smoke ? pickedQuestions.slice(0, 1) : pickedQuestions).map((q) => q.id),
        // Free-tier keys 429 the agent arm hard; a short breather costs an hour
        // of wall clock on a full run and saves a lot of wasted calls.
        pauseMs: 1500,
        signal: controller.signal,
        onProgress: setEvalProgress,
        onRecord: (record) => {
          collected = [...collected, record];
          setRecords(collected);
          saveDraft(collected);
        },
      });
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [arms, pickedQuestions, questions, records, repo, runs, smoke]);

  const handleAblation = useCallback(async () => {
    setPhase("ablating");
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const rows = await runAblationForRepo(storeRef.current, repo, {
        embedQuery: embedText,
        onProgress: setAblationProgress,
        signal: controller.signal,
      });
      setAblation((prev) => [...prev.filter((row) => row.repo !== repo), ...rows]);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [repo]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleDownload = useCallback(() => {
    const payload = buildExport({ model: GEMINI_MODEL, runs, repos: summaries, records, ablation });
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gitask-eval-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [ablation, records, runs, summaries]);

  const handleClear = useCallback(() => {
    setRecords([]);
    saveDraft([]);
  }, []);

  const summary = summaries.find((s) => s.repo === repo);
  const busy = phase === "indexing" || phase === "running" || phase === "ablating";

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <div style={styles.topRow}>
          <a href="/" style={styles.back}>← back</a>
          <ThemeToggle />
        </div>

        <header style={styles.header}>
          <h1 style={styles.title}>Eval</h1>
          <p style={styles.subtitle}>
            {EVAL_SET.name} — same index, same model ({GEMINI_MODEL}), same questions.
            The only variable is the retrieval strategy.
          </p>
          <p style={styles.provenance}>{EVAL_SET.provenance}</p>
        </header>

        <section style={styles.panel}>
          <div style={styles.controls}>
            <label style={styles.label}>
              repo
              <select
                value={repo}
                onChange={(e) => { setRepo(e.target.value); setPhase("idle"); }}
                disabled={busy}
                style={styles.input}
              >
                {repos.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>

            <label style={styles.label}>
              github token (optional)
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
                placeholder="ghp_…"
                style={styles.input}
              />
            </label>

            <label style={styles.label}>
              runs per question
              <select
                value={runs}
                onChange={(e) => setRuns(Number(e.target.value))}
                disabled={busy}
                style={styles.input}
              >
                {[1, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            {/* After the runs select on purpose: the headless runners address
                these by index, and inserting earlier would silently retarget
                them. */}
            <label style={styles.label}>
              questions
              <select
                value={subset}
                onChange={(e) => setSubset(e.target.value as Subset)}
                disabled={busy}
                style={styles.input}
              >
                {(["all", "lookup", "multihop"] as Subset[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            <div style={styles.label}>
              arms
              <div style={styles.checkRow}>
                {(["rag", "agent"] as Arm[]).map((arm) => (
                  <label key={arm} style={styles.check}>
                    <input
                      type="checkbox"
                      checked={arms.includes(arm)}
                      disabled={busy}
                      onChange={(e) => setArms((prev) =>
                        e.target.checked ? [...prev, arm] : prev.filter((a) => a !== arm)
                      )}
                    />
                    {arm}
                  </label>
                ))}
              </div>
            </div>

            <label style={styles.check}>
              <input
                type="checkbox"
                checked={smoke}
                disabled={busy}
                onChange={(e) => setSmoke(e.target.checked)}
              />
              smoke run (first question only)
            </label>
          </div>

          <div style={styles.buttonRow}>
            <button onClick={handleIndex} disabled={busy} style={styles.button}>
              index {repo}@{ref}
            </button>
            <button
              onClick={handleRun}
              disabled={busy || !summary || arms.length === 0}
              style={styles.button}
            >
              run eval
            </button>
            <button onClick={handleAblation} disabled={busy || !summary} style={styles.button}>
              run ablation
            </button>
            {busy && <button onClick={handleStop} style={styles.button}>stop</button>}
            <button onClick={handleDownload} disabled={records.length === 0} style={styles.button}>
              download json ({records.length} rows)
            </button>
            <button onClick={handleClear} disabled={busy || records.length === 0} style={styles.button}>
              clear
            </button>
          </div>

          {error && <p style={styles.error}>{error}</p>}

          {phase === "indexing" && indexProgress && (
            <p style={styles.status}>
              {indexProgress.phase}: {indexProgress.message} ({indexProgress.current}/{indexProgress.total})
            </p>
          )}

          {phase === "running" && evalProgress && (
            <p style={styles.status}>
              {evalProgress.done}/{evalProgress.total} — {evalProgress.questionId} · {evalProgress.arm} · run {evalProgress.run}
            </p>
          )}

          {phase === "ablating" && ablationProgress && (
            <p style={styles.status}>
              ablation — {ablationProgress.config}: {ablationProgress.done}/{ablationProgress.total}
            </p>
          )}

          {summary && (
            <p style={styles.status}>
              {summary.indexedChunks} chunks · {summary.questionCount} questions
              {summary.missingGoldPaths.length > 0 && (
                <span style={styles.warn}>
                  {" "}· {summary.missingGoldPaths.length} gold file(s) not in the index:{" "}
                  {summary.missingGoldPaths.join(", ")}
                </span>
              )}
            </p>
          )}
        </section>

        {table.length > 0 && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Results</h2>
            <div style={styles.scroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>arm</th>
                    <th style={styles.th}>type</th>
                    <th style={styles.th}>n</th>
                    <th style={styles.th}>score</th>
                    <th style={styles.th}>correct</th>
                    <th style={styles.th}>unstable</th>
                    <th style={styles.th}>cite prec</th>
                    <th style={styles.th}>uncited</th>
                    <th style={styles.th}>tok in</th>
                    <th style={styles.th}>tok out</th>
                    <th style={styles.th}>latency</th>
                    <th style={styles.th}>steps</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((cell) => (
                    <tr key={`${cell.arm}-${cell.type ?? "all"}`}>
                      <td style={styles.td}>{cell.arm}</td>
                      <td style={styles.td}>{cell.type ?? "all"}</td>
                      <td style={styles.td}>{cell.questions}×{Math.round(cell.runs / Math.max(1, cell.questions))}</td>
                      <td style={styles.td}>{cell.score.toFixed(2)} ± {cell.stderr.toFixed(2)}</td>
                      <td style={styles.td}>{pct(cell.correctRate)}</td>
                      <td style={styles.td}>{cell.unstableQuestions}</td>
                      <td style={styles.td}>
                        {cell.citationPrecision === null ? "—" : pct(cell.citationPrecision)}
                      </td>
                      <td style={styles.td}>{pct(cell.uncitedRate)}</td>
                      <td style={styles.td}>{Math.round(cell.meanTokensIn)}</td>
                      <td style={styles.td}>{Math.round(cell.meanTokensOut)}</td>
                      <td style={styles.td}>{(cell.meanLatencyMs / 1000).toFixed(1)}s</td>
                      <td style={styles.td}>{cell.meanSteps === null ? "—" : cell.meanSteps.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {ablation.length > 0 && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Retrieval ablation, same questions</h2>
            <div style={styles.scroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>config</th>
                    <th style={styles.th}>repo</th>
                    <th style={styles.th}>q</th>
                    <th style={styles.th}>Recall@5</th>
                    <th style={styles.th}>MRR</th>
                    <th style={styles.th}>NDCG@10</th>
                    <th style={styles.th}>latency</th>
                  </tr>
                </thead>
                <tbody>
                  {ablation.map((row) => (
                    <tr key={`${row.repo}-${row.config}`} title={row.description}>
                      <td style={styles.td}>{row.config}</td>
                      <td style={styles.td}>{row.repo}</td>
                      <td style={styles.td}>{row.questions}</td>
                      <td style={styles.td}>{pct(row.avgRecallAt5)} ± {pct(row.stderrRecallAt5)}</td>
                      <td style={styles.td}>{row.avgMRR.toFixed(3)} ± {row.stderrMRR.toFixed(3)}</td>
                      <td style={styles.td}>{row.avgNdcgAt10.toFixed(3)} ± {row.stderrNdcgAt10.toFixed(3)}</td>
                      <td style={styles.td}>{row.avgLatencyMs.toFixed(1)}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {failures.length > 0 && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Why runs failed</h2>
            <p style={styles.status}>
              Every run the judge didn&apos;t call correct, bucketed. A failure usually
              matches several buckets; <em>primary</em> is the one highest in the priority
              order, <em>matched</em> counts every run it applied to at all.
            </p>
            <div style={styles.scroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>bucket</th>
                    <th style={styles.th}>primary</th>
                    <th style={styles.th}>matched</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.map((row) => (
                    <tr key={row.bucket}>
                      <td style={styles.td}>{row.bucket}</td>
                      <td style={styles.td}>{row.primary}</td>
                      <td style={styles.td}>{row.matched}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {stops.length > 0 && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>How agent runs ended</h2>
            <p style={styles.status}>
              {stops.map((s) => `${s.reason}: ${s.count}`).join(" · ")}
            </p>
          </section>
        )}

        {splits.length > 0 && (
          <section style={styles.panel}>
            <h2 style={styles.h2}>Where the arms disagree</h2>
            <div style={styles.scroll}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>question</th>
                    <th style={styles.th}>type</th>
                    <th style={styles.th}>rag</th>
                    <th style={styles.th}>agent</th>
                  </tr>
                </thead>
                <tbody>
                  {splits.map((row) => (
                    <tr key={row.questionId}>
                      <td style={styles.td}>{row.questionId}</td>
                      <td style={styles.td}>{row.type}</td>
                      <td style={styles.td}>{row.ragScore.toFixed(2)}</td>
                      <td style={styles.td}>{row.agentScore.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { minHeight: "100vh", padding: "32px 16px", background: "var(--bg)", color: "var(--fg)" },
  container: { maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 },
  topRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  back: { fontSize: 13, opacity: 0.7, textDecoration: "none", color: "inherit" },
  header: { display: "flex", flexDirection: "column", gap: 6 },
  title: { fontSize: 28, fontWeight: 600, margin: 0 },
  subtitle: { fontSize: 14, opacity: 0.8, margin: 0 },
  provenance: { fontSize: 12, opacity: 0.6, margin: 0, lineHeight: 1.5 },
  panel: {
    border: "1px solid var(--border, #2a2a2a)", borderRadius: 10,
    padding: 16, display: "flex", flexDirection: "column", gap: 12,
  },
  h2: { fontSize: 15, fontWeight: 600, margin: 0 },
  controls: { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, opacity: 0.9 },
  input: {
    padding: "6px 8px", fontSize: 13, borderRadius: 6,
    border: "1px solid var(--border, #2a2a2a)", background: "transparent", color: "inherit",
  },
  checkRow: { display: "flex", gap: 10 },
  check: { display: "flex", alignItems: "center", gap: 5, fontSize: 12 },
  buttonRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  button: {
    padding: "6px 12px", fontSize: 13, borderRadius: 6, cursor: "pointer",
    border: "1px solid var(--border, #2a2a2a)", background: "transparent", color: "inherit",
  },
  status: { fontSize: 12, opacity: 0.75, margin: 0 },
  warn: { color: "#d97706" },
  error: { fontSize: 13, color: "#dc2626", margin: 0 },
  scroll: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", padding: "6px 10px", opacity: 0.6, fontWeight: 500, whiteSpace: "nowrap" },
  td: { padding: "6px 10px", borderTop: "1px solid var(--border, #2a2a2a)", whiteSpace: "nowrap" },
};
