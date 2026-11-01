import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, here, listen, mockOllama, tmpHome } from './helpers.js';

describe('light / dark / auto', () => {
  it('applies a dark choice everywhere a dark system would, and a light choice nowhere', () => {
    const css = fs.readFileSync(`${here}/../public/app.css`, 'utf8');
    let checked = 0;
    for (let at = css.indexOf('@media (prefers-color-scheme: dark) {'); at >= 0; at = css.indexOf('@media (prefers-color-scheme: dark) {', at + 1)) {
      const open = css.indexOf('{', at);
      let end = open + 1;
      for (let depth = 1; depth; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
      const sels = [...css.slice(open + 1, end - 1).matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim());
      for (const sel of sels) {
        checked++;
        for (const part of sel.split(',')) assert.match(part.trim(), /^:root:not\(\[data-theme="light"\]\)/, `"${part.trim()}" is skipped when Light is chosen`);
        const forced = sel.replaceAll(':root:not([data-theme="light"])', ':root[data-theme="dark"]');
        assert.ok(css.includes(`${forced} {`), `"${forced}" applies when Dark is chosen`);
      }
    }
    assert.ok(checked >= 8);
  });

  it('loads the choice before sign-in, and gives the book reader the same look', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, OUTPOST_PASSWORD: 'correct horse' }));
    const main = http.createServer(made.app);
    const content = http.createServer(made.content);
    const base = `http://127.0.0.1:${await listen(main)}`;
    const cbase = `http://127.0.0.1:${await listen(content)}`;
    const auth = { Authorization: `Basic ${Buffer.from(`${made.ctx.cfg.user}:correct horse`).toString('base64')}` };
    try {
      assert.equal((await fetch(`${base}/theme.js`)).status, 200, 'the sign-in page can use it too');
      const skin = async (theme?: string) =>
        (await fetch(`${cbase}/kiwix-skin.css`, { headers: { ...auth, ...(theme ? { Cookie: `outpost_theme=${theme}` } : {}) } })).text();
      const auto = await skin();
      assert.match(auto, /@media \(prefers-color-scheme: dark\)/, 'Auto follows the device');
      const dark = await skin('dark');
      assert.doesNotMatch(dark, /prefers-color-scheme/);
      assert.match(dark, /@media all \{\s*:root \{\s*--o-bg: #121512/);
      assert.match(dark, /color-scheme: dark;/);
      const light = await skin('light');
      assert.match(light, /@media not all/);
      assert.match(light, /color-scheme: light;/);
      assert.equal(await skin('<script>'), auto, 'anything else is Auto');
    } finally {
      for (const s of [main, content]) {
        s.closeAllConnections();
        s.close();
      }
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
