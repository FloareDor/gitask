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
const runsFlag = argv.indexOf("--runs");
const runsPerQuestion = runsFlag !== -1 ? argv[runsFlag + 1] : null;
const keyFlag = argv.indexOf("--key");
const apiKey = keyFlag !== -1 ? argv[keyFlag + 1] : process.env.GEMINI_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPage() {
  return {
    text: document.body.innerText,
    // Every control is disabled while a run is in flight, so "run eval is
    // clickable again" is the one unambiguous finished signal. Text-based
    // checks kept firing early, before React had rendered the running phase.
    busy: [...document.querySelectorAll("button")]
      .some((b) => b.innerText.trim() === "run eval" && b.disabled),
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

  // Wait for hydration: on a cold dev compile the buttons appear well after
  // domcontentloaded, and selecting before then silently does nothing.
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.innerText.startsWith("index ")),
    null,
    { timeout: 120_000 }
  );

  // Two things bite here. React's value tracker suppresses onChange when
  // select.value is set directly, so the change has to go through the native
  // setter; and the select's handler is attached a beat after the button first
  // renders, so a single dispatch can land before React is listening. Hence:
  // dispatch, check the observable effect, retry.
  const selectRepo = () => page.evaluate((name) => {
    const select = document.querySelector("select");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, name);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, repo);

  let selected = false;
  for (let attempt = 0; attempt < 10 && !selected; attempt += 1) {
    await selectRepo();
    await sleep(1000);
    selected = await page.evaluate((name) => [...document.querySelectorAll("button")]
      .some((b) => b.innerText.startsWith("index ") && b.innerText.includes(name)), repo);
  }
  if (!selected) {
    const saw = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => b.innerText.trim()));
    throw new Error(`repo select did not take. buttons: ${JSON.stringify(saw)}`);
  }

  const indexLabel = await page.evaluate(() =>
    [...document.querySelectorAll("button")].find((b) => b.innerText.startsWith("index ")).innerText
  );

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
    console.log(`→ smoke run: first question, both arms${runsPerQuestion ? `, runs=${runsPerQuestion}` : ""}`);
    if (runsPerQuestion) {
      // Same native-setter dance as the repo select; this is the second one.
      await page.evaluate((value) => {
        const select = document.querySelectorAll("select")[1];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, runsPerQuestion);
      await sleep(500);
    }
    await page.evaluate(() => {
      const box = [...document.querySelectorAll("input[type=checkbox]")]
        .find((i) => i.parentElement.innerText.includes("smoke run"));
      if (!box.checked) box.click();
    });
    await clickButton(page, "run eval");
    // Records stream into the table as they land, so "Results exists" only
    // means the first row arrived. The page's own progress counter reaching
    // done/total is the finish line, and it doesn't depend on render timing.
    await sleep(3000);
    const ran = await waitFor(page, "eval", (s) => s.text.includes("Results") && !s.busy);
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
