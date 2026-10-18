/**
 * Drives the real /eval page in a headless browser.
 *
 * Two halves, because they have different prerequisites:
 *   - indexing + the retrieval ablation need only the local embedder, so they
 *     run with no API key at all;
 *   - the RAG and agent arms and the judge need a Gemini key, supplied via
 *     GEMINI_API_KEY or --key and seeded into localStorage the same way the
 *     LLM Settings panel would.
 *
 * Usage:
 *   node scripts/smoke-eval.js [owner/repo] [--arms] [--key sk-...]
 *
 * Requires `npm run dev` on port 3000.
 */
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:3000/eval";
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 2000;

const argv = process.argv.slice(2);
const repo = argv.find((a) => a.includes("/") && !a.startsWith("--")) || "psf/requests";
const wantArms = argv.includes("--arms");
const keyFlag = argv.indexOf("--key");
const apiKey = keyFlag !== -1 ? argv[keyFlag + 1] : process.env.GEMINI_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPage() {
  return {
    text: document.body.innerText,
    tables: [...document.querySelectorAll("table")].map((t) =>
      [...t.querySelectorAll("tr")].map((r) =>
        [...r.querySelectorAll("th,td")].map((c) => c.innerText.trim())
      )
    ),
  };
}

async function waitFor(page, label, done, failed) {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < STEP_TIMEOUT_MS) {
    const state = await page.evaluate(readPage);
    if (done(state)) return state;
    if (failed && failed(state)) {
      throw new Error(`${label} failed — page said: ${state.text.slice(0, 600)}`);
    }
    const status = (state.text.match(/^.*(fetching|chunking|embedding|\d+\/\d+).*$/im) || [""])[0].trim();
    if (status && status !== lastStatus) {
      lastStatus = status;
      console.log(`  [${label} ${Math.round((Date.now() - started) / 1000)}s] ${status.slice(0, 140)}`);
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
  for (const row of rows || []) console.log("   " + row.join(" | "));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });

  if (apiKey) {
    // Same shape the LLM Settings panel writes, so getGeminiKeyScope() finds it.
    await context.addInitScript(([key]) => {
      localStorage.setItem("gitask_llm_config", JSON.stringify({
        provider: "gemini", cloudStorage: "local",
      }));
      localStorage.setItem("gitask_gemini_api_key_local", key);
    }, [apiKey]);
  }

  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [console.error] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 300)}`));

  console.log(`→ ${BASE} — repo=${repo} arms=${wantArms} key=${apiKey ? "set" : "absent"}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("select");

  // The repo select is the first one on the page; wait for React to re-render
  // the index button before trusting that the choice took.
  await page.selectOption("select >> nth=0", repo);
  await page.waitForFunction(
    (name) => [...document.querySelectorAll("button")]
      .some((b) => b.innerText.trim() === `index ${name}`.trim() || b.innerText.includes(name)),
    repo,
    { timeout: 10_000 }
  );
  const indexLabel = await page.evaluate(() =>
    [...document.querySelectorAll("button")].find((b) => b.innerText.startsWith("index")).innerText
  );
  if (!indexLabel.includes(repo)) throw new Error(`repo select did not take: ${indexLabel}`);

  console.log(`→ ${indexLabel}`);
  await clickButton(page, "index ");
  const indexed = await waitFor(
    page, "index",
    (s) => /\d+ chunks · \d+ questions/.test(s.text),
    (s) => /GitHub returned a partial file list|rate limit|Not Found/i.test(s.text)
  );
  console.log(`✓ ${(indexed.text.match(/^.*\d+ chunks · \d+ questions.*$/m) || [])[0].trim()}`);

  console.log("→ run ablation");
  await clickButton(page, "run ablation");
  const ablated = await waitFor(page, "ablation",
    (s) => s.text.includes("Retrieval ablation, same questions"));
  console.log("✓ ablation, from the live page:");
  printTable(ablated.tables.find((rows) => rows[0]?.includes("Recall@5")));

  if (wantArms) {
    if (!apiKey) throw new Error("--arms needs GEMINI_API_KEY or --key");
    console.log("→ smoke run: first 2 questions, both arms");
    await page.evaluate(() => {
      const box = [...document.querySelectorAll("input[type=checkbox]")]
        .find((i) => i.parentElement.innerText.includes("smoke run"));
      if (!box.checked) box.click();
    });
    await clickButton(page, "run eval");
    const ran = await waitFor(page, "eval", (s) => s.text.includes("Results"));
    console.log("✓ results, from the live page:");
    printTable(ran.tables.find((rows) => rows[0]?.includes("score")));
  }

  await page.screenshot({ path: "smoke-eval.png", fullPage: true });
  console.log("\nscreenshot: smoke-eval.png");
  await browser.close();
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
