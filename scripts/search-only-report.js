/**
 * Splits the agent's gain over RAG into "from looping" and "from exact tools".
 *
 *   rag           one retrieval (+ one refinement hop when it looks weak)
 *   agent_search  the agent loop, but semantic_search is the only tool
 *                 — i.e. iterative RAG with the agent's budget and prompt
 *   agent         the agent loop with all five tools
 *
 *   agent_search − rag          = what the loop buys
 *   agent        − agent_search = what grep / read_file / definitions buy
 *
 * Arithmetic only, same rules as eval-report.js: a question is averaged across
 * its runs before averaging across questions; error and judge-unreadable rows
 * are excluded and counted. Every gap is paired over the questions both arms
 * answered.
 *
 * Usage:
 *   node scripts/search-only-report.js export.json [more.json ...] [--type multihop|lookup|all]
 *
 * Exports are merged, so the new agent_search run can be read next to an
 * earlier agent run — but only compare runs on the same model. The script
 * prints each export's model and refuses to mix them unless --allow-mixed.
 */
const fs = require("fs");

const SCORE = { correct: 1, partial: 0.5, wrong: 0 };
const ARMS = ["rag", "agent_search", "agent"];
const PRICE_IN = 0.75;
const PRICE_OUT = 3.75;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : fallback;
};
const type = flag("type", "multihop");
const allowMixed = argv.includes("--allow-mixed");
const files = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--type"));
if (!files.length) {
  console.error("usage: node scripts/search-only-report.js export.json [more.json ...] [--type multihop]");
  process.exit(1);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function stderr(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");

// ---- load ----------------------------------------------------------------
const models = new Map();
let records = [];
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const arms = [...new Set(data.records.map((r) => r.arm))].join(",");
  console.log(`${file}\n  model ${data.model} · ${data.records.length} records · arms ${arms}`);
  for (const r of data.records) {
    // An arm seen in two files: keep the later file's rows, so a re-run replaces
    // the original rather than doubling its runs.
    models.set(r.arm, data.model);
  }
  const incoming = new Set(data.records.map((r) => r.arm));
  records = records.filter((r) => !incoming.has(r.arm)).concat(data.records);
}
const distinctModels = new Set([...models.values()]);
if (distinctModels.size > 1) {
  const detail = [...models].map(([a, m]) => `${a}=${m}`).join(", ");
  if (!allowMixed) {
    console.error(`\nArms come from different models (${detail}). Pass --allow-mixed to read them anyway.`);
    process.exit(1);
  }
  console.log(`\n!! mixed models (${detail}) — gaps involving those arms include a model change`);
}

if (type !== "all") records = records.filter((r) => r.type === type);
const present = ARMS.filter((a) => records.some((r) => r.arm === a));

// ---- per arm ---------------------------------------------------------------
const usable = (r) => !r.error && !r.judgeUnreadable;

function perQuestion(rows, value) {
  const groups = new Map();
  for (const r of rows) {
    const v = value(r);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    if (!groups.has(r.questionId)) groups.set(r.questionId, []);
    groups.get(r.questionId).push(v);
  }
  return new Map([...groups].map(([q, vs]) => [q, mean(vs)]));
}

const byArm = {};
for (const arm of present) {
  const all = records.filter((r) => r.arm === arm);
  const rows = all.filter(usable);
  const scoreQ = perQuestion(rows, (r) => SCORE[r.verdict]);
  const citeQ = perQuestion(rows, (r) => r.citation?.precision ?? null);
  const tokens = rows.reduce((a, r) => a + (r.tokensIn || 0) + (r.tokensOut || 0), 0);
  const points = rows.reduce((a, r) => a + SCORE[r.verdict], 0);
  const cost = rows.reduce((a, r) => a + ((r.tokensIn || 0) * PRICE_IN + (r.tokensOut || 0) * PRICE_OUT) / 1e6, 0);
  const toolCounts = {};
  for (const r of rows) for (const s of r.trace || []) toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
  byArm[arm] = {
    runs: all.length,
    dropped: all.length - rows.length,
    questions: scoreQ.size,
    scoreQ,
    citeQ,
    score: mean([...scoreQ.values()]),
    scoreSe: stderr([...scoreQ.values()]),
    cite: mean([...citeQ.values()]),
    tokensPerCorrect: points ? tokens / points : NaN,
    costPerQuestion: scoreQ.size ? cost / rows.length : NaN,
    latency: mean(rows.map((r) => r.elapsedMs / 1000)),
    steps: arm === "rag" ? NaN : mean(rows.map((r) => r.steps ?? 0)),
    stepCap: arm === "rag" ? NaN : rows.filter((r) => r.stopReason === "step_cap").length / (rows.length || 1),
    toolCounts,
  };
}

// ---- print -----------------------------------------------------------------
console.log(`\n## Arms — ${type} questions\n`);
const head = ["arm", "q", "runs (dropped)", "score ± SE", "cite prec", "tok/correct", "$/run", "latency", "steps", "step cap"];
console.log(head.join(" | "));
for (const arm of present) {
  const a = byArm[arm];
  console.log([
    arm, a.questions, `${a.runs} (${a.dropped})`, `${f2(a.score)} ± ${f2(a.scoreSe)}`, pct(a.cite),
    Number.isFinite(a.tokensPerCorrect) ? Math.round(a.tokensPerCorrect).toLocaleString() : "—",
    Number.isFinite(a.costPerQuestion) ? `$${a.costPerQuestion.toFixed(4)}` : "—",
    `${a.latency.toFixed(1)}s`, f2(a.steps), pct(a.stepCap),
  ].join(" | "));
}

for (const arm of present.filter((a) => a !== "rag")) {
  const counts = byArm[arm].toolCounts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const mix = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${pct(n / total)}`).join(", ");
  console.log(`\n${arm} tool mix (${total} calls): ${mix}`);
}

function paired(a, b, key) {
  const A = byArm[a]?.[key];
  const B = byArm[b]?.[key];
  if (!A || !B) return null;
  const common = [...A.keys()].filter((q) => B.has(q));
  const diffs = common.map((q) => A.get(q) - B.get(q));
  return { n: common.length, gap: mean(diffs), se: stderr(diffs) };
}

const PAIRS = [
  ["agent_search", "rag", "what the loop buys"],
  ["agent", "agent_search", "what the exact tools buy"],
  ["agent", "rag", "total"],
];
for (const [key, label] of [["scoreQ", "score"], ["citeQ", "citation precision"]]) {
  console.log(`\n## Paired gaps — ${label}\n`);
  console.log("comparison | questions | gap ± SE | SE multiple");
  for (const [a, b, meaning] of PAIRS) {
    const p = paired(a, b, key);
    if (!p) continue;
    const multiple = p.se > 0 ? `${(p.gap / p.se).toFixed(1)} SE` : "—";
    const fmt = key === "citeQ" ? (x) => `${(x * 100).toFixed(1)}pp` : (x) => x.toFixed(3);
    console.log(`${a} − ${b} (${meaning}) | ${p.n} | ${fmt(p.gap)} ± ${fmt(p.se)} | ${multiple}`);
  }
}

// ---- reading -----------------------------------------------------------------
const loop = paired("agent_search", "rag", "scoreQ");
const total = paired("agent", "rag", "scoreQ");
if (loop && total && Math.abs(total.gap) > 1e-9) {
  const share = loop.gap / total.gap;
  console.log(
    `\nThe loop alone recovers ${pct(share)} of the agent's score gain over RAG ` +
    `(${loop.gap.toFixed(3)} of ${total.gap.toFixed(3)}). ` +
    "Read it against the SEs above — at this n, a share is a direction, not a measurement."
  );
}
