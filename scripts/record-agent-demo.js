/**
 * Records one agent run on the real chat page, for the deck's demo slide.
 *
 * Produces a .webm of the whole run plus stills at the moments worth pausing
 * on: the trace mid-investigation, and the finished answer with citations.
 *
 * Run it with nothing else heavy on the machine. Indexing embeds in-browser on
 * the CPU, and the eval competes for exactly the same cores.
 *
 * Usage:
 *   node scripts/record-agent-demo.js [owner/repo] [--q "question"] [--out DIR] [--headed]
 *
 * Requires the app on port 3000 (`npm start` after a build, or `npm run dev`).
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:3000";
const INDEX_TIMEOUT_MS = 15 * 60 * 1000;
const ANSWER_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_MS = 1000;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : fallback;
};
const repo = argv.find((a) => a.includes("/") && !a.startsWith("--")) || "psf/requests";
const outDir = flag("out", "demo");
const headed = argv.includes("--headed");
const apiKey = flag("key", process.env.GEMINI_API_KEY);
// A question that needs more than one file, or the recording shows a single
// tool call and proves nothing.
const question = flag(
  "q",
  "How does a redirect get resolved end to end, from send() through to the final response?"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

(async () => {
  if (!apiKey) throw new Error("need GEMINI_API_KEY or --key");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(([key]) => {
    localStorage.setItem("gitask_llm_config", JSON.stringify({ provider: "gemini", cloudStorage: "local" }));
    localStorage.setItem("gitask_gemini_api_key_local", key);
  }, [apiKey]);

  const page = await context.newPage();
  page.on("pageerror", (e) => log(`  [pageerror] ${String(e).slice(0, 200)}`));

  log(`opening ${repo}`);
  await page.goto(`${BASE}/${repo}`, { waitUntil: "domcontentloaded" });

  // The chat page indexes on mount. The textarea stays disabled until it is
  // done, which makes it a more reliable signal than any progress text.
  log("indexing (in-browser, this is the slow part)");
  const started = Date.now();
  while (Date.now() - started < INDEX_TIMEOUT_MS) {
    const ready = await page.evaluate(() => {
      const box = document.querySelector("#chat-input");
      return !!box && !box.disabled;
    });
    if (ready) break;
    if ((Date.now() - started) % 30000 < POLL_MS) {
      const status = await page.evaluate(() => document.body.innerText.slice(0, 160).replace(/\s+/g, " "));
      log(`  ${Math.round((Date.now() - started) / 1000)}s — ${status}`);
    }
    await sleep(POLL_MS);
  }
  const indexed = await page.evaluate(() => {
    const box = document.querySelector("#chat-input");
    return !!box && !box.disabled;
  });
  if (!indexed) throw new Error("repo never finished indexing");
  log("indexed");

  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((b) => b.innerText.trim() === "agent");
    if (!button) return "no agent button";
    if (button.disabled) return `agent disabled: ${button.title}`;
    button.click();
    return "ok";
  });
  if (clicked !== "ok") throw new Error(clicked);
  log("agent mode selected");
  await sleep(500);
  await page.screenshot({ path: path.join(outDir, "1-ready.png") });

  await page.fill("#chat-input", question);
  await sleep(400);
  await page.click("#send-btn");
  log(`asked: ${question}`);

  // Grab a still while tools are still running — that frame is the slide.
  let traceShot = false;
  const askedAt = Date.now();
  while (Date.now() - askedAt < ANSWER_TIMEOUT_MS) {
    const state = await page.evaluate(() => ({
      generating: !!document.querySelector("#send-btn")?.disabled,
      text: document.body.innerText,
    }));
    if (!traceShot && /semantic_search|grep|read_file|find_definition|find_references/.test(state.text)) {
      await sleep(2500);
      await page.screenshot({ path: path.join(outDir, "2-trace.png"), fullPage: true });
      traceShot = true;
      log("captured trace still");
    }
    if (!state.generating && traceShot) break;
    await sleep(POLL_MS);
  }

  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, "3-answer.png"), fullPage: true });
  log("captured answer still");

  const summary = await page.evaluate(() => {
    const text = document.body.innerText;
    const tools = (text.match(/semantic_search|grep|read_file|find_definition|find_references/g) || []).length;
    const citations = (text.match(/[\w/.-]+\.(ts|tsx|py|js):\d+/g) || []).length;
    return { tools, citations, chars: text.length };
  });
  log(`tool mentions=${summary.tools} citation-shaped refs=${summary.citations}`);

  // Video only lands on disk once the context closes.
  await context.close();
  await browser.close();
  const video = fs.readdirSync(outDir).find((f) => f.endsWith(".webm"));
  log(`done — ${outDir}/ (${video || "no video"}, 3 stills)`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
