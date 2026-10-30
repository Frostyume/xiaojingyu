#!/usr/bin/env node
/** Renders assets/diagrams/*.html into the PNGs embedded by the READMEs. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'assets', 'diagrams');

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install it with `npm install --no-save playwright`, or set PLAYWRIGHT_MODULE.');
}

const { chromium } = loadPlaywright();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(x => existsSync(x));

const jobs = [
  { html: 'message-flow.html', png: 'message-flow.png', lang: 'zh', width: 1600, height: 700 },
  { html: 'message-flow.html', png: 'message-flow.en.png', lang: 'en', width: 1600, height: 700 },
  { html: 'architecture.html', png: 'architecture.png', lang: 'zh', width: 1600, height: 760 },
  { html: 'architecture.html', png: 'architecture.en.png', lang: 'en', width: 1600, height: 760 },
  { html: 'scenes.html', png: 'scenes.png', lang: 'zh', width: 1600, height: 900 },
  { html: 'scenes.html', png: 'scenes.en.png', lang: 'en', width: 1600, height: 900 },
  { html: 'deploy.html', png: 'deploy.png', lang: 'zh', width: 1600, height: 780 },
  { html: 'deploy.html', png: 'deploy.en.png', lang: 'en', width: 1600, height: 780 }
];

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const scale = Number(process.env.DIAGRAM_SCALE || 1.5);
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: scale });
    const url = pathToFileURL(join(outDir, job.html)).href + `?lang=${job.lang}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(150);
    const body = await page.evaluate(() => ({
      width: Math.ceil(document.body.scrollWidth),
      height: Math.ceil(document.body.scrollHeight)
    }));
    await page.setViewportSize({ width: Math.max(job.width, body.width), height: Math.max(job.height, body.height) });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(outDir, job.png), fullPage: true });
    console.log(`rendered ${job.png} (${job.lang})`);
    await page.close();
  }
} finally {
  await browser.close();
}
