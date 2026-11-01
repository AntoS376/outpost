// Screenshots every page at desktop and phone widths, light and dark, using the installed Google Chrome.
//   node scripts/screenshots.mjs [baseUrl] [outDir]     (defaults: http://localhost:8080, ./screenshots)
// Set OUTPOST_USER / OUTPOST_PASSWORD if the server asks for a login. Exits 1 if a page logs an error.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const out = path.resolve(process.argv[3] ?? 'screenshots');
const pages = ['home', 'library', 'library/manage', 'ai', 'maps', 'education', 'notes', 'tools', 'apps', 'documents', 'guide', 'emergency', 'emergency/aid', 'emergency/location', 'emergency/card', 'emergency/kits', 'benchmark', 'updates', 'account', 'setup'];
const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
try {
  for (const scheme of ['light', 'dark']) {
    for (const [sizeName, viewport] of Object.entries(sizes)) {
      const ctx = await browser.newContext({
        viewport,
        colorScheme: scheme,
        isMobile: sizeName === 'phone',
        hasTouch: sizeName === 'phone',
        ...(process.env.OUTPOST_PASSWORD
          ? { httpCredentials: { username: process.env.OUTPOST_USER ?? 'outpost', password: process.env.OUTPOST_PASSWORD } }
          : {}),
      });
      const page = await ctx.newPage();
      let current = '';
      // Only Outpost's own scripts count; ZIM articles inside the reader ship their own (sometimes broken) JS.
      const own = (url) => url.startsWith(base) && !url.includes('/kiwix/');
      page.on('pageerror', (e) => problems.push(`${current}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && own(m.location().url ?? '') && problems.push(`${current}: ${m.text()}`));
      for (const name of pages) {
        current = `${name} (${sizeName}, ${scheme})`;
        await page.goto(`${base}/#${name}`, { waitUntil: 'networkidle' });
        if (name === 'maps') await page.waitForFunction(() => document.querySelector('#map canvas, #mapmsg:not([hidden])'), null, { timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(name === 'maps' || name === 'library' ? 2500 : 400);
        const file = path.join(out, `${name.replace('/', '-')}-${sizeName}-${scheme}.png`);
        await page.screenshot({ path: file });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) problems.push(`${current}: page scrolls sideways by ${overflow}px`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`Saved ${pages.length * 4} screenshots in ${out}`);
if (problems.length) {
  console.log(`Problems:\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
}
