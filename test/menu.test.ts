import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const nav = html.slice(html.indexOf('<nav class="rail"'), html.indexOf('</nav>'));

it('puts every main page in the menu once, under its heading, with five phone tabs plus More', () => {
  const pages = [...app.matchAll(/(\w+): view\w+/g)].map((m) => m[1]!);
  // Reached from elsewhere (Home, Tools, the account name, the setup guide link), not from the menu.
  const elsewhere = new Set(['setup', 'benchmark', 'account', 'updates', 'guide']);
  const inMenu = [...nav.matchAll(/data-route="(\w+)"/g)].map((m) => m[1]!);
  assert.deepEqual([...inMenu].sort(), pages.filter((p) => !elsewhere.has(p)).sort(), 'each main page once');
  assert.deepEqual([...nav.matchAll(/<p class="railsec">([^<]+)<\/p>/g)].map((m) => m[1]), ['Know', 'Ask and find', 'Be ready', 'Keep']);
  const tabs = [...nav.matchAll(/data-route="(\w+)" data-tab/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['emergency', 'home', 'library', 'ai', 'maps'], 'the phone bar');
  assert.match(nav, /id="more-btn"[^>]*aria-controls="moresheet"/);
  assert.match(html, /<div class="moresheet" id="moresheet" role="dialog" aria-label="All sections" hidden><\/div>/);
});
