/**
 * The full eval: every repo, every question, both arms.
 *
 * Same page as `smoke-eval.js` drives, with three differences that only matter
 * at this size:
 *   - the smoke checkbox stays off, so all 15 questions per repo run;
 *   - all repos run in one page session, because records, ablation rows and
 *     repo summaries live in React state and only the records half survives a
 *     reload;
 *   - the JSON is downloaded after every repo, not just at the end. A run this
 *     long will eventually die partway through, and a checkpoint turns that
 *     into a lost repo instead of a lost night.
 *
 * Usage:
 *   node scripts/full-eval.js [--repos a/b,c/d] [--out DIR] [--key ...]
 *
 * Requires `npm run dev` on port 3000.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:3000/eval";
// One repo is 15 questions x 3 runs x 2 arms, and a slow arm can push a single
// run past a minute, so this is deliberately far looser than the smoke's.
const EVAL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 5000;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : fallback;
};
const outDir = flag("out", ".");
const apiKey = flag("key", process.env.GEMINI_API_KEY);
const repoFilter = flag("repos", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

function readPage() {
  return {
    text: document.body.innerText,
    busy: [...document.querySelectorAll("button")]
      .some((b) => b.innerText.trim() === "run eval" && b.disabled),
    tables: [...document.querySelectorAll("table")].map((t) =>
      [...t.querySelectorAll("tr")].map((r) =>
        [...r.querySelectorAll("th,td")].map((c) => c.innerText.trim())
      )
    ),
  };
}

async function waitFor(page, label, done, timeoutMs) {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(readPage);
    if (done(state)) return state;
    // The page puts its own error text on screen; no point waiting out the
    // timeout once it has.
    const failure = state.text.match(/^.*(Error|failed|rate limit|Not Found).*$/im);
    if (failure && /error:/i.test(failure[0])) {
      throw new Error(`${label} failed — ${failure[0].slice(0, 300)}`);
    }
    // Match the page's three progress formats exactly. A loose pattern finds
    // the "run ablation" button label first and then never changes again,
    // which is indistinguishable from a stalled run.
    const status = state.text.split("\n").map((l) => l.trim()).reverse().find((l) =>
      /^\d+\/\d+\s+—/.test(l) || /\(\d+\/\d+\)$/.test(l) || /^ablation —/.test(l)
    ) || "";
    if (status && status !== lastStatus) {
      lastStatus = status;
      log(`  ${label} +${Math.round((Date.now() - started) / 1000)}s — ${status.slice(0, 120)}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function clickButton(page, startsWith) {
  return page.evaluate((prefix) => {
    const button = [...document.querySelectorAll("button")]
      .find((b) => b.innerText.trim().startsWith(prefix));
    if (!button) throw new Error(`no button starting with "${prefix}"`);
    if (button.disabled) throw new Error(`button "${button.innerText.trim()}" is disabled`);
    button.click();
  }, startsWith);
}

function printTable(rows) {
  for (const row of rows || []) console.log("    " + row.join(" | "));
}

/**
 * React's value tracker swallows a directly assigned select.value, so the
 * change has to go through the native setter. Lifted from smoke-eval.js.
 */
function selectRepo(page, name) {
  return page.evaluate((repo) => {
    const select = document.querySelector("select");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, repo);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

async function download(page, file) {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    clickButton(page, "download json"),
  ]);
  await dl.saveAs(file);
  log(`  saved ${file}`);
}

(async () => {
  if (!apiKey) throw new Error("need GEMINI_API_KEY or --key");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1400 },
    acceptDownloads: true,
  });
  await context.addInitScript(([key]) => {
    localStorage.setItem("gitask_llm_config", JSON.stringify({ provider: "gemini", cloudStorage: "local" }));
    localStorage.setItem("gitask_gemini_api_key_local", key);
    // Start from an empty sheet so a previous run's rows can't blend in.
    localStorage.removeItem("gitask-eval-draft");
  }, [apiKey]);

  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log(`  [console.error] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => log(`  [pageerror] ${String(e).slice(0, 200)}`));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.innerText.startsWith("index ")),
    null, { timeout: 120000 }
  );

  const repos = repoFilter
    ? repoFilter.split(",")
    : await page.evaluate(() => [...document.querySelectorAll("select")[0].options].map((o) => o.value));
  log(`repos: ${repos.join(", ")}`);

  const startedAll = Date.now();
  for (const repo of repos) {
    log(`=== ${repo} ===`);

    let ok = false;
    for (let attempt = 0; attempt < 10 && !ok; attempt += 1) {
      await selectRepo(page, repo);
      await sleep(1000);
      ok = await page.evaluate((name) => [...document.querySelectorAll("button")]
        .some((b) => b.innerText.startsWith("index ") && b.innerText.includes(name)), repo);
    }
    if (!ok) throw new Error(`repo select did not take for ${repo}`);

    log("  index");
    await clickButton(page, "index ");
    const indexed = await waitFor(page, "index",
      (s) => /\d+ chunks · \d+ questions/.test(s.text), STEP_TIMEOUT_MS);
    log(`  ${(indexed.text.match(/^.*\d+ chunks · \d+ questions.*$/m) || [])[0].trim()}`);

    log("  ablation");
    await clickButton(page, "run ablation");
    await waitFor(page, "ablation", (s) => !s.busy, STEP_TIMEOUT_MS);

    log("  eval — all questions, both arms");
    await clickButton(page, "run eval");
    await sleep(5000);
    const ran = await waitFor(page, "eval", (s) => s.text.includes("Results") && !s.busy, EVAL_TIMEOUT_MS);
    log("  results so far:");
    printTable(ran.tables.find((rows) => rows[0]?.includes("score")));

    await download(page, path.join(outDir, `gitask-eval-after-${repo.replace("/", "-")}.json`));
  }

  const final = await page.evaluate(readPage);
  console.log("\n=== arms ===");
  printTable(final.tables.find((rows) => rows[0]?.includes("score")));
  console.log("\n=== ablation ===");
  printTable(final.tables.find((rows) => rows[0]?.includes("Recall@5")));
  console.log("\n=== failures ===");
  printTable(final.tables.find((rows) => rows[0]?.some?.((c) => /bucket/i.test(c))));

  await download(page, path.join(outDir, "gitask-eval-full.json"));
  await page.screenshot({ path: path.join(outDir, "full-eval.png"), fullPage: true });
  log(`done in ${Math.round((Date.now() - startedAll) / 60000)} min`);
  await browser.close();
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
