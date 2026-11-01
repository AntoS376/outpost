// Rebuilds the PDF fixtures with Google Chrome: node test/fixtures/make-pdfs.mjs
//   firstaid.pdf  two pages of real text
//   scanned.pdf   one page that is only a picture of text (no text layer), like a scan
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

await page.setContent(`<body style="font:14px Helvetica">
  <h1>Field first aid</h1>
  <h2>Burns</h2><p>Cool the burn under cool running water for 20 minutes. Do not use ice.</p>
  <div style="break-after:page"></div>
  <h2>Water</h2><p>Boil water for one minute. Above 2000 metres, boil it for three minutes.</p>
</body>`);
await page.pdf({ path: path.join(here, 'firstaid.pdf'), format: 'A6' });

await page.setContent(`<body style="margin:0"><canvas id="c" width="600" height="200"></canvas><img id="i"></body>`);
await page.evaluate(() => {
  const c = document.getElementById('c');
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 600, 200);
  g.fillStyle = '#000';
  g.font = '28px Helvetica';
  g.fillText('This page was scanned.', 20, 100);
  document.getElementById('i').src = c.toDataURL('image/jpeg', 0.6);
  c.remove();
});
await page.pdf({ path: path.join(here, 'scanned.pdf'), format: 'A6' });

await browser.close();
console.log('Wrote firstaid.pdf and scanned.pdf');
