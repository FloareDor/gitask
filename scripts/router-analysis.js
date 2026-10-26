/**
 * What would a router have bought, measured on the eval that already ran.
 *
 * Both arms answered every question, so the export already contains what each
 * one scored and what each one cost. Any routing policy is then a choice of
 * which column to read per question — no new API calls, and the endpoints
 * (always-RAG, always-agent) fall out of the same arithmetic as the policies.
 *
 * Three policies, as the plan specified:
 *   rule    — a heuristic over the question text
 *   oracle  — always picks the arm that was right, i.e. the ceiling
 *   (the LLM router needs a live model and is not computed here)
 *
 * The gap between the rule and the oracle is the honest "future work" number.
 *
 * Usage:
 *   node scripts/router-analysis.js export.json
 */
const fs = require("fs");

const PRICE_IN = 0.75;
const PRICE_OUT = 3.75;
const SCORE = { correct: 1, partial: 0.5, wrong: 0 };

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/router-analysis.js export.json");
  process.exit(1);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * "Short, and names something concrete."
 *
 * The lookups name a symbol outright — send_from_directory, MethodView,
 * Config.from_prefixed_env. The multi-hop questions describe the same kind of
 * thing in prose instead ("the registration tracking flag in the blueprint
 * collection class"), which is what makes one retrieval insufficient. So the
 * rule is a proxy for "is the thing being asked about already named here".
 *
 * Deliberately not tuned past this. With 45 questions, anything fitted harder
 * would be fitted to the eval rather than to the problem.
 */
const IDENTIFIER = [
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, // snake_case
  /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\b/, // module.function
  /\b[A-Z][a-z0-9]+[A-Z]\w*\b/, // CamelCase
  /`[^`]+`/, // explicitly quoted
];
const MAX_WORDS = 18;

function routeByRule(question) {
  const words = question.split(/\s+/).length;
  const named = IDENTIFIER.some((re) => re.test(question));
  return words <= MAX_WORDS && named ? "rag" : "agent";
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));

// Per question, per arm: mean score and mean tokens over its runs. Runs that
// produced no answer are excluded, same as the main report.
const byQuestion = new Map();
for (const r of data.records) {
  if (r.judgeUnreadable || r.error) continue;
  if (!byQuestion.has(r.questionId)) {
    byQuestion.set(r.questionId, { id: r.questionId, type: r.type, question: null, rag: [], agent: [] });
  }
  const q = byQuestion.get(r.questionId);
  q[r.arm].push({
    score: SCORE[r.verdict] ?? 0,
    tin: r.tokensIn || 0,
    tout: r.tokensOut || 0,
  });
}

const questions = JSON.parse(
  fs.readFileSync("src/lib/eval/questions.json", "utf8")
).questions;
const text = new Map(questions.map((q) => [q.id, q.question]));

const rows = [];
for (const q of byQuestion.values()) {
  if (!q.rag.length || !q.agent.length) continue; // needs both arms to be routable
  const arm = (a) => ({
    score: mean(q[a].map((r) => r.score)),
    tin: mean(q[a].map((r) => r.tin)),
    tout: mean(q[a].map((r) => r.tout)),
  });
  rows.push({ id: q.id, type: q.type, question: text.get(q.id) || "", rag: arm("rag"), agent: arm("agent") });
}

const usd = (tin, tout) => (tin / 1e6) * PRICE_IN + (tout / 1e6) * PRICE_OUT;

function evaluate(name, pick) {
  const chosen = rows.map((r) => ({ r, arm: pick(r) }));
  const score = mean(chosen.map(({ r, arm }) => r[arm].score));
  const tin = mean(chosen.map(({ r, arm }) => r[arm].tin));
  const tout = mean(chosen.map(({ r, arm }) => r[arm].tout));
  const toAgent = chosen.filter((c) => c.arm === "agent").length / chosen.length;
  return { name, score, tin, tout, toAgent, cost: usd(tin, tout) };
}

const policies = [
  evaluate("always rag", () => "rag"),
  evaluate("rule", (r) => routeByRule(r.question)),
  evaluate("always agent", () => "agent"),
  evaluate("oracle", (r) => (r.agent.score > r.rag.score ? "agent" : "rag")),
];

const row = (cells, w) => cells.map((c, i) => String(c).padEnd(w[i])).join("  ");
const widths = [16, 10, 12, 12, 14, 12];

console.log(`# Router analysis — ${rows.length} questions, computed from ${file}\n`);
console.log(row(["policy", "score", "tok in", "tok out", "USD/question", "% to agent"], widths));
for (const p of policies) {
  console.log(row([
    p.name,
    p.score.toFixed(3),
    Math.round(p.tin),
    Math.round(p.tout),
    `$${p.cost.toFixed(5)}`,
    `${(p.toAgent * 100).toFixed(0)}%`,
  ], widths));
}

const rule = policies.find((p) => p.name === "rule");
const oracle = policies.find((p) => p.name === "oracle");
const allAgent = policies.find((p) => p.name === "always agent");
const allRag = policies.find((p) => p.name === "always rag");

console.log("\n## What the rule buys\n");
const keptPct = ((rule.score - allRag.score) / (allAgent.score - allRag.score)) * 100;
const ruleSaved = (1 - rule.cost / allAgent.cost) * 100;
const oracleSaved = (1 - oracle.cost / allAgent.cost) * 100;
console.log(`  accuracy: recovers ${keptPct.toFixed(0)}% of the agent's gain over rag`);
console.log(`  cost:     ${ruleSaved.toFixed(0)}% cheaper than always-agent, against ${oracleSaved.toFixed(0)}% available to a perfect router`);
console.log(`  accuracy headroom to oracle: ${(oracle.score - rule.score).toFixed(3)}`);
console.log(`  cost headroom to oracle:     $${(rule.cost - oracle.cost).toFixed(5)} per question`);
console.log("");
console.log("  Read it this way: every policy lands near 0.96, so accuracy is not");
console.log("  where routers differ on this set. Cost is. The oracle reaches the");
console.log(`  agent's accuracy while sending only ${(oracle.toAgent * 100).toFixed(0)}% of questions to it, because rag`);
console.log("  already answers most of them correctly - the router's job is spotting");
console.log("  the minority that need more, and the rule is not good at that yet.");
console.log("");
console.log("  Oracle ties go to rag, i.e. use the cheaper arm when both are right.");
console.log("  That choice is what makes the oracle cheap, so state it rather than");
console.log("  letting the number look free.");

// How often the rule picks the arm that actually won. Reported separately
// because a router can route badly and still score well when the arms agree,
// and that flatters it.
let agree = 0;
let decided = 0;
for (const r of rows) {
  if (r.rag.score === r.agent.score) continue;
  decided += 1;
  const better = r.agent.score > r.rag.score ? "agent" : "rag";
  if (routeByRule(r.question) === better) agree += 1;
}
console.log(`\n  on the ${decided} questions where the arms disagreed, the rule picked the winner ${agree}/${decided} times`);

console.log("\n## Rule vs question type\n");
const w2 = [12, 12, 12];
console.log(row(["type", "-> rag", "-> agent"], w2));
for (const type of ["lookup", "multihop"]) {
  const sub = rows.filter((r) => r.type === type);
  const toRag = sub.filter((r) => routeByRule(r.question) === "rag").length;
  console.log(row([type, toRag, sub.length - toRag], w2));
}
console.log("\n  The rule is a proxy for question type, so this is also its confusion matrix.");
