const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FRAMES_DIR = path.join(__dirname, '../diagram-frames');
const FPS = 12;
const DURATION_S = 5; // seconds to capture
const TOTAL_FRAMES = FPS * DURATION_S;

async function capture() {
  if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('Loading page...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // Scroll to architecture diagram section (it's near bottom of page)
  console.log('Scrolling to diagram...');

  // First scroll to bottom to trigger IntersectionObserver + Framer Motion
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  // Hide fixed navbar so it doesn't appear in element screenshot
  await page.evaluate(() => {
    const nav = document.querySelector('nav, header, [class*="nav"], [class*="Nav"], [class*="header"], [class*="Header"]');
    if (nav && getComputedStyle(nav).position === 'fixed') nav.style.display = 'none';
    // Also hide any fixed/sticky elements at top
    document.querySelectorAll('*').forEach(el => {
      const style = getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'sticky') && el.getBoundingClientRect().top < 100) {
        el.style.setProperty('display', 'none', 'important');
      }
    });
  });

  // Scroll diagram into view
  await page.evaluate(() => {
    const el = document.querySelector('[class*="ArchitectureDiagram-module"][class*="root"]');
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  });

  // Wait a bit
  await page.waitForTimeout(200);

  // Find the diagram element and get its bounding box
  const diagBox = await page.evaluate(() => {
    const el = document.querySelector('[class*="ArchitectureDiagram-module"][class*="root"]');
    if (el) {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, selector: 'ArchitectureDiagram-module root' };
    }
    return null;
  });

  console.log('Diagram box:', diagBox);

  // Get the diagram element handle for element-level screenshots
  const diagEl = await page.$('[class*="ArchitectureDiagram-module"][class*="root"]');

  // Capture frames
  console.log(`Capturing ${TOTAL_FRAMES} frames...`);
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const framePath = path.join(FRAMES_DIR, `frame-${String(i).padStart(4, '0')}.png`);

    if (diagEl) {
      // Element screenshot captures the full element even if it extends beyond viewport
      await diagEl.screenshot({ path: framePath });
    } else if (diagBox) {
      const padding = 20;
      await page.screenshot({
        path: framePath,
        clip: {
          x: Math.max(0, diagBox.x - padding),
          y: Math.max(0, diagBox.y - padding),
          width: Math.min(1280, diagBox.width + padding * 2),
          height: Math.min(900, diagBox.height + padding * 2),
        }
      });
    } else {
      await page.screenshot({ path: framePath });
    }

    await page.waitForTimeout(1000 / FPS);
    process.stdout.write(`\r  frame ${i + 1}/${TOTAL_FRAMES}`);
  }

  console.log('\nDone capturing frames.');
  await browser.close();
}

capture().catch(console.error);
