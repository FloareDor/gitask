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
const beforeIdx = argv.indexOf("--before");
const beforeFile = beforeIdx !== -1 ? argv[beforeIdx + 1] : null;
// Several exports can be merged. A run long enough to be interrupted gets
// finished in a second session, and the per-repo checkpoints are separate
// files — the report should still read as one eval.
const files = argv.filter(
  (a, i) => !a.startsWith("--") && !(beforeIdx !== -1 && i === beforeIdx + 1)
);
if (!files.length) {
  console.error("usage: node scripts/eval-report.js export.json [more.json ...] [--before earlier.json]");
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

/**
 * A run that never produced an answer is not a wrong answer.
 *
 * `error` rows are timeouts and provider failures — the model never replied,
 * so there is nothing to grade. Counting them as wrong would charge whichever
 * arm was unlucky, and the luck is not evenly spread: the agent makes six to
 * twelve calls per question to RAG's one, so it is far likelier to be caught
 * by a timeout, and it is caught on the slowest questions. Scoring them would
 * bias the comparison against the agent on exactly the multi-hop questions the
 * whole eval is about. They are excluded here and counted out loud instead.
 */
function scorable(records) {
  return records.filter((r) => !r.judgeUnreadable && !r.error);
}

function summarize(records) {
  const scored = scorable(records);
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
 *
 * The check has a limit of its own, and the slide has to say so: all 9 authored
 * multi-hop questions are gitask questions, so `authored / multihop` is also
 * `repo = gitask`. This separates provenance from question type; it cannot
 * separate either from the repo. Hence the repo column.
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
  const widths = [28, 22, 4, 5, 14, 9, 10];
  console.log(row(["arm / source / type", "repos", "q", "runs", "score", "correct", "cite prec"], widths));
  for (const arm of ["rag", "agent"]) {
    for (const [src, type] of present) {
      const subset = records.filter((r) => r.arm === arm && r.source === src && r.type === type);
      const s = summarize(subset);
      if (!s) continue;
      const repos = [...new Set(subset.map((r) => (r.repo || "").split("/").pop()))].sort();
      console.log(row([
        `${arm} / ${src} / ${type}`,
        repos.join(","),
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
    // Same exclusion as the scoring tables. A run that never answered spent no
    // tokens, so leaving it in would not move the ratio — but the two sections
    // disagreeing about what counts is how a number ends up on a slide that
    // nobody can reproduce from the other table.
    const rs = scorable(records).filter((r) => r.arm === arm);
    if (!rs.length) continue;
    const correct = rs.filter((r) => r.verdict === "correct").length;
    const tokens = rs.reduce((a, r) => a + (r.tokensIn || 0) + (r.tokensOut || 0), 0);
    const per = Math.round(tokens / Math.max(correct, 1));
    console.log(`  ${arm}: ${correct} correct runs, ${per.toLocaleString("en-US")} tokens per correct answer`);
  }
}

/**
 * Questions where the two arms consistently disagree across every run.
 *
 * This is where the slide-4 example comes from. A question the agent wins once
 * is a coin flip and will not survive someone asking "did you run it twice?";
 * a question it wins on all three runs while RAG loses all three is a real
 * difference and safe to put on a slide. Printed in both directions, because
 * the questions RAG wins are the honest half of the story and the ones the
 * router slide needs.
 */
function printDisagreements(records) {
  const byQ = new Map();
  for (const r of scorable(records)) {
    if (!byQ.has(r.questionId)) {
      byQ.set(r.questionId, { id: r.questionId, type: r.type, source: r.source, repo: r.repo, rag: [], agent: [] });
    }
    byQ.get(r.questionId)[r.arm]?.push(SCORE[r.verdict] ?? 0);
  }

  const rows = [];
  for (const q of byQ.values()) {
    // Needs every run of both arms, or "consistent" is not established.
    if (q.rag.length < 2 || q.agent.length < 2) continue;
    const rag = mean(q.rag);
    const agent = mean(q.agent);
    if (rag === agent) continue;
    if (Math.min(...q.rag) === Math.max(...q.rag) && Math.min(...q.agent) === Math.max(...q.agent)) {
      rows.push({ ...q, rag, agent, gap: agent - rag });
    }
  }
  if (!rows.length) return;

  console.log("\n## Clean disagreements (slide-4 candidates)\n");
  const widths = [22, 10, 10, 10, 7, 7];
  console.log(row(["question", "repo", "type", "source", "rag", "agent"], widths));
  rows.sort((a, b) => b.gap - a.gap);
  for (const r of rows) {
    console.log(row([
      r.id,
      (r.repo || "").split("/").pop(),
      r.type,
      r.source,
      r.rag.toFixed(2),
      r.agent.toFixed(2),
    ], widths));
  }
  const agentWins = rows.filter((r) => r.gap > 0).length;
  console.log(`\n  ${agentWins} agent-wins-every-run, ${rows.length - agentWins} rag-wins-every-run.`);
}

/**
 * Paired comparison, which is the test this design actually calls for.
 *
 * Both arms answer the same questions, so comparing two independent means
 * throws away that pairing and reports a wider interval than the data
 * supports. Differencing per question cancels the "some questions are just
 * harder" variance, which is the dominant source here.
 *
 * Restricted to questions both arms answered. When one arm loses a question
 * entirely — a timeout, a blocked candidate — the unpaired means are computed
 * over different question sets and are not comparable at all.
 */
function printPaired(records) {
  const scored = scorable(records);
  console.log("\n## Paired comparison (same questions, both arms)\n");
  const widths = [12, 12, 16, 16, 30];
  console.log(row(["type", "questions", "rag", "agent", "gap (agent-rag)"], widths));

  for (const type of [null, "lookup", "multihop"]) {
    const perArm = {};
    for (const arm of ["rag", "agent"]) {
      const byQ = new Map();
      for (const r of scored) {
        if (r.arm !== arm) continue;
        if (type !== null && r.type !== type) continue;
        if (!byQ.has(r.questionId)) byQ.set(r.questionId, []);
        byQ.get(r.questionId).push(SCORE[r.verdict] ?? 0);
      }
      perArm[arm] = new Map([...byQ].map(([q, v]) => [q, mean(v)]));
    }
    const common = [...perArm.rag.keys()].filter((q) => perArm.agent.has(q));
    if (common.length < 2) continue;

    const ragVals = common.map((q) => perArm.rag.get(q));
    const agentVals = common.map((q) => perArm.agent.get(q));
    const diffs = common.map((q) => perArm.agent.get(q) - perArm.rag.get(q));
    const gap = mean(diffs);
    const se = stderr(diffs);
    // Report the gap in standard errors rather than a significant/not flag.
    // At n this small the interesting cases sit right on the line, and a
    // binary label would hide exactly those.
    const ratio = se > 0 ? Math.abs(gap) / se : Infinity;
    const note = se === 0 ? "" : `  ${ratio.toFixed(1)} SE${ratio < 2 ? " — noise" : ""}`;
    console.log(row([
      type === null ? "all" : type,
      common.length,
      mean(ragVals).toFixed(2),
      mean(agentVals).toFixed(2),
      `${gap >= 0 ? "+" : ""}${gap.toFixed(2)} +/- ${se.toFixed(2)}${note}`,
    ], widths));
  }

  const dropped = scored.length && [...new Set(scored.map((r) => r.questionId))].length;
  if (dropped) console.log(`\n  Questions either arm lost entirely are excluded from the pairing.`);
}

/**
 * The retrieval ablation, pooled across repos and per repo.
 *
 * Retrieval is deterministic, so the error bars are the spread between
 * questions, not run-to-run variance — 15 questions per repo is the sample,
 * and the spread between them is the honest uncertainty on each mean.
 *
 * Pooled is what slide 3 shows; the per-repo rows are there because the arms
 * data already showed one repo can disagree sharply with another, and an
 * average that hides that is worth less than the disagreement.
 */
function printAblation(rows) {
  if (!rows || !rows.length) return;
  console.log("\n## Retrieval ablation\n");
  const widths = [20, 14, 6, 16, 16, 16, 10];
  console.log(row(["config", "repo", "q", "Recall@5", "MRR", "NDCG@10", "latency"], widths));

  const configs = [...new Set(rows.map((r) => r.config))];
  const line = (label, repo, rs) => {
    const q = rs.reduce((a, r) => a + r.questions, 0);
    // Weight by questions, since repos can contribute different counts.
    const wmean = (pick) => rs.reduce((a, r) => a + pick(r) * r.questions, 0) / (q || 1);
    // Pooling independent per-repo means: errors add in quadrature, weighted.
    const wse = (pick) =>
      Math.sqrt(rs.reduce((a, r) => a + (pick(r) * r.questions) ** 2, 0)) / (q || 1);
    console.log(row([
      label,
      repo,
      q,
      `${(wmean((r) => r.avgRecallAt5) * 100).toFixed(0)}% +/- ${(wse((r) => r.stderrRecallAt5) * 100).toFixed(0)}%`,
      `${wmean((r) => r.avgMRR).toFixed(3)} +/- ${wse((r) => r.stderrMRR).toFixed(3)}`,
      `${wmean((r) => r.avgNdcgAt10).toFixed(3)} +/- ${wse((r) => r.stderrNdcgAt10).toFixed(3)}`,
      `${wmean((r) => r.avgLatencyMs).toFixed(1)}ms`,
    ], widths));
  };

  for (const config of configs) line(config, "all", rows.filter((r) => r.config === config));
  console.log("");
  for (const config of configs) {
    for (const r of rows.filter((x) => x.config === config)) {
      line(config, (r.repo || "").split("/").pop(), [r]);
    }
  }
  const desc = new Map(rows.map((r) => [r.config, r.description]));
  console.log("");
  for (const [config, d] of desc) console.log(`  ${config}: ${d}`);
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

/**
 * Merge exports, keyed so a repo re-run replaces its rows rather than doubling
 * them — the same rule the /eval page uses when you re-run a repo.
 */
function merge(parts) {
  const records = [];
  const seen = new Set();
  const repos = new Map();
  const ablation = new Map();
  // Later files win, so pass them in the order they were produced.
  for (const part of parts) {
    for (const r of part.records || []) {
      const key = `${r.repo}|${r.questionId}|${r.arm}|${r.run}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(r);
    }
    for (const repo of part.repos || []) repos.set(repo.repo, repo);
    for (const a of part.ablation || []) ablation.set(`${a.repo}|${a.config}`, a);
  }
  return { ...parts[parts.length - 1], records, repos: [...repos.values()], ablation: [...ablation.values()] };
}

const parts = files.map(read);
const models = [...new Set(parts.map((p) => `${p.model}/${p.thinkingLevel ?? "?"}`))];
if (models.length > 1) {
  console.error(`REFUSING TO MERGE: these exports used different models — ${models.join(" vs ")}`);
  process.exit(1);
}
const data = parts.length === 1 ? parts[0] : merge(parts.slice().reverse());
if (parts.length > 1) console.log(`merged ${parts.length} exports`);
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
const errored = data.records.filter((r) => r.error);
if (unreadable || errored.length) {
  console.log(`\n  excluded from scoring: ${unreadable} unreadable judge replies, ${errored.length} runs with no answer`);
  // Broken out by arm and type because even exclusion is not neutral: if the
  // losses are lopsided, the surviving samples are not comparable and the
  // slide has to say so rather than quoting a clean-looking mean.
  const by = {};
  for (const r of errored) {
    const key = `${r.arm}/${r.type}`;
    by[key] = by[key] || { n: 0, reasons: new Set() };
    by[key].n += 1;
    by[key].reasons.add((r.error || "").slice(0, 40));
  }
  for (const [key, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) {
    const total = data.records.filter((r) => `${r.arm}/${r.type}` === key).length;
    console.log(`    ${key.padEnd(16)} ${v.n}/${total} lost  (${[...v.reasons].join("; ")})`);
  }
}

printArms(data.records);
printPaired(data.records);
printBySource(data.records);
printDisagreements(data.records);
printAblation(data.ablation);
printStops(data.records);
printCost(data.records);
if (beforeFile) printDiff(read(beforeFile), data);
console.log("");
