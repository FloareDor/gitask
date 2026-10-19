/**
 * Turns an eval export into the numbers the deck quotes.
 *
 * Deliberately arithmetic only. Scoring, citation checking and the failure
 * taxonomy already live in `src/lib/eval/` and the `/eval` page renders them;
 * reimplementing any of that here would give the deck a second source of truth
 * that can disagree with the app. What this adds is the money, which nothing
 * else computes, and a diff between two exports for Phase 5 before/after.
 *
 * Usage:
 *   node scripts/eval-report.js export.json [--before earlier.json]
 */
const fs = require("fs");

/**
 * Paid-tier gemini-3.8-flash, USD per million tokens, from
 * ai.google.dev/gemini-api/docs/pricing. Introductory rates that double on
 * 2027-01-01 — if that date has passed, these are wrong.
 */
const PRICE_IN = 0.75;
const PRICE_OUT = 3.75;

const SCORE = { correct: 1, partial: 0.5, wrong: 0 };

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const beforeIdx = argv.indexOf("--before");
const beforeFile = beforeIdx !== -1 ? argv[beforeIdx + 1] : null;
if (!file) {
  console.error("usage: node scripts/eval-report.js export.json [--before earlier.json]");
  process.exit(1);
}

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Standard error across questions, which is the unit the eval varies over. */
function stderr(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

/**
 * Average a question across its runs first, then average across questions, so
 * one question cannot count extra just because it ran more times. Same rule as
 * `lib/eval/scoring.ts` — if that changes, this has to follow.
 */
function byQuestion(records, value) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.questionId)) groups.set(r.questionId, []);
    groups.get(r.questionId).push(value(r));
  }
  return [...groups.values()].map((runs) =>
    mean(runs.filter((v) => v !== null && v !== undefined))
  );
}

function summarize(records) {
  const scored = records.filter((r) => !r.judgeUnreadable);
  if (!scored.length) return null;
  const perQuestion = byQuestion(scored, (r) => SCORE[r.verdict] ?? 0);
  const cited = scored.filter((r) => r.citation && r.citation.precision !== null);
  return {
    questions: new Set(scored.map((r) => r.questionId)).size,
    runs: scored.length,
    score: mean(perQuestion),
    se: stderr(perQuestion),
    correct: mean(byQuestion(scored, (r) => (r.verdict === "correct" ? 1 : 0))),
    citePrec: cited.length ? mean(byQuestion(cited, (r) => r.citation.precision)) : null,
    uncited: mean(byQuestion(scored, (r) => (r.citation && r.citation.total === 0 ? 1 : 0))),
    tokensIn: mean(scored.map((r) => r.tokensIn || 0)),
    tokensOut: mean(scored.map((r) => r.tokensOut || 0)),
    latency: mean(scored.map((r) => r.elapsedMs || 0)) / 1000,
    steps: scored.some((r) => r.steps != null)
      ? mean(scored.filter((r) => r.steps != null).map((r) => r.steps))
      : null,
  };
}

const pct = (x) => (x === null ? "-" : `${(x * 100).toFixed(0)}%`);
const row = (cells, widths) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");

function printArms(records) {
  console.log("\n## Arms\n");
  const widths = [18, 4, 5, 14, 9, 10, 9, 9, 9, 9, 6];
  console.log(row(
    ["arm / type", "q", "runs", "score", "correct", "cite prec", "uncited", "tok in", "tok out", "latency", "steps"],
    widths
  ));
  for (const arm of ["rag", "agent"]) {
    for (const type of [null, "lookup", "multihop"]) {
      const subset = records.filter((r) => r.arm === arm && (type === null || r.type === type));
      const s = summarize(subset);
      if (!s) continue;
      console.log(row([
        type === null ? `${arm} / all` : `${arm} / ${type}`,
        s.questions,
        s.runs,
        `${s.score.toFixed(2)} +/- ${s.se.toFixed(2)}`,
        pct(s.correct),
        pct(s.citePrec),
        pct(s.uncited),
        Math.round(s.tokensIn),
        Math.round(s.tokensOut),
        `${s.latency.toFixed(1)}s`,
        s.steps === null ? "-" : s.steps.toFixed(1),
      ], widths));
    }
  }
}

/**
 * The same split, but cut by where the question came from.
 *
 * Source and type are badly confounded in this set: every SWE-QA question is
 * multi-hop, and every lookup question was authored. So "agent wins on
 * multi-hop" and "agent wins on borrowed questions" predict the same table,
 * and the headline split alone cannot tell them apart. The 9 authored
 * multi-hop questions are the only place they come apart — if the multi-hop
 * gap survives inside `authored`, it is about question type. If it does not,
 * it was about provenance, and the honest claim is much weaker.
 */
function printBySource(records) {
  const cells = [
    ["swe-qa", "multihop"],
    ["authored", "multihop"],
    ["authored", "lookup"],
  ];
  const present = cells.filter(([src, type]) =>
    records.some((r) => r.source === src && r.type === type)
  );
  if (present.length < 2) return;

  console.log("\n## By source (the confound check)\n");
  const widths = [28, 4, 5, 14, 9, 10];
  console.log(row(["arm / source / type", "q", "runs", "score", "correct", "cite prec"], widths));
  for (const arm of ["rag", "agent"]) {
    for (const [src, type] of present) {
      const s = summarize(records.filter((r) => r.arm === arm && r.source === src && r.type === type));
      if (!s) continue;
      console.log(row([
        `${arm} / ${src} / ${type}`,
        s.questions,
        s.runs,
        `${s.score.toFixed(2)} +/- ${s.se.toFixed(2)}`,
        pct(s.correct),
        pct(s.citePrec),
      ], widths));
    }
  }

  const gap = (src, type) => {
    const a = summarize(records.filter((r) => r.arm === "agent" && r.source === src && r.type === type));
    const g = summarize(records.filter((r) => r.arm === "rag" && r.source === src && r.type === type));
    return a && g ? a.score - g.score : null;
  };
  const borrowed = gap("swe-qa", "multihop");
  const authored = gap("authored", "multihop");
  if (borrowed !== null && authored !== null) {
    console.log(`\n  agent - rag on multihop: ${borrowed >= 0 ? "+" : ""}${borrowed.toFixed(2)} borrowed, ${authored >= 0 ? "+" : ""}${authored.toFixed(2)} authored`);
    console.log("  Both positive and similar means the effect is about question type, not provenance.");
  }
}

function printCost(records) {
  console.log("\n## Cost\n");
  const widths = [10, 12, 12, 12, 10];
  console.log(row(["arm", "tok in", "tok out", "judge tok", "USD"], widths));
  let total = 0;
  for (const arm of ["rag", "agent"]) {
    const rs = records.filter((r) => r.arm === arm);
    if (!rs.length) continue;
    const tin = rs.reduce((a, r) => a + (r.tokensIn || 0), 0);
    const tout = rs.reduce((a, r) => a + (r.tokensOut || 0), 0);
    const jin = rs.reduce((a, r) => a + (r.judgeTokensIn || 0), 0);
    const jout = rs.reduce((a, r) => a + (r.judgeTokensOut || 0), 0);
    const usd = ((tin + jin) / 1e6) * PRICE_IN + ((tout + jout) / 1e6) * PRICE_OUT;
    total += usd;
    console.log(row(
      [arm, tin.toLocaleString("en-US"), tout.toLocaleString("en-US"), (jin + jout).toLocaleString("en-US"), `$${usd.toFixed(2)}`],
      widths
    ));
  }
  console.log(row(["total", "", "", "", `$${total.toFixed(2)}`], widths));

  // Tokens per correct answer, not tokens per run. Raw totals only show the
  // agent costing more; this shows what the extra tokens actually bought.
  console.log("");
  for (const arm of ["rag", "agent"]) {
    const rs = records.filter((r) => r.arm === arm && !r.judgeUnreadable);
    if (!rs.length) continue;
    const correct = rs.filter((r) => r.verdict === "correct").length;
    const tokens = rs.reduce((a, r) => a + (r.tokensIn || 0) + (r.tokensOut || 0), 0);
    const per = Math.round(tokens / Math.max(correct, 1));
    console.log(`  ${arm}: ${correct} correct runs, ${per.toLocaleString("en-US")} tokens per correct answer`);
  }
}

function printStops(records) {
  const agent = records.filter((r) => r.arm === "agent" && r.stopReason);
  if (!agent.length) return;
  console.log("\n## Agent stop reasons\n");
  const counts = {};
  for (const r of agent) counts[r.stopReason] = (counts[r.stopReason] || 0) + 1;
  for (const [reason, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(18)} ${n}  (${((n / agent.length) * 100).toFixed(0)}%)`);
  }
}

function printDiff(before, after) {
  console.log("\n## Before / after\n");
  const widths = [18, 16, 16, 10];
  console.log(row(["arm / type", "before", "after", "delta"], widths));
  for (const arm of ["rag", "agent"]) {
    for (const type of [null, "lookup", "multihop"]) {
      const pick = (rs) => rs.filter((r) => r.arm === arm && (type === null || r.type === type));
      // Restrict the before side to the questions the re-run actually covers,
      // or the delta measures the change in sample rather than the fix.
      const afterIds = new Set(pick(after.records).map((r) => r.questionId));
      const b = summarize(pick(before.records).filter((r) => afterIds.has(r.questionId)));
      const a = summarize(pick(after.records));
      if (!b || !a) continue;
      const delta = a.score - b.score;
      console.log(row([
        type === null ? `${arm} / all` : `${arm} / ${type}`,
        `${b.score.toFixed(2)} +/- ${b.se.toFixed(2)}`,
        `${a.score.toFixed(2)} +/- ${a.se.toFixed(2)}`,
        `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
      ], widths));
    }
  }
  console.log("\n  Compared only on the questions the re-run covers.");
}

const data = read(file);
console.log(`# ${data.evalSet}`);
const thinking = data.thinkingLevel ? ` - thinking ${data.thinkingLevel}` : "";
console.log(`model ${data.model}${thinking} - embed ${data.embeddingModel} - ${data.runsPerQuestion} runs/question`);
console.log(`generated ${data.generatedAt} - ${data.records.length} records`);
for (const repo of data.repos || []) {
  const missing = repo.missingGoldPaths || [];
  const warn = missing.length ? ` - MISSING GOLD: ${missing.join(", ")}` : "";
  console.log(`  ${repo.repo}@${repo.ref} - ${repo.indexedChunks} chunks, ${repo.questionCount} questions${warn}`);
}

const unreadable = data.records.filter((r) => r.judgeUnreadable).length;
const errored = data.records.filter((r) => r.error).length;
if (unreadable || errored) {
  console.log(`\n  dropped: ${unreadable} unreadable judge replies, ${errored} provider errors`);
}

printArms(data.records);
printBySource(data.records);
printStops(data.records);
printCost(data.records);
if (beforeFile) printDiff(read(beforeFile), data);
console.log("");
