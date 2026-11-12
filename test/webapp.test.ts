import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

/** Outpost with an account, so only public paths answer before sign-in. */
async function setup(env: Record<string, string> = {}) {
  const h = await tmpHome();
  const ollama = mockOllama();
  const op = await listen(ollama);
  const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, ...env }));
  const s = http.createServer(made.app);
  const base = `http://127.0.0.1:${await listen(s)}`;
  await fetch(`${base}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'anna', password: 'correct horse', role: 'admin' }) });
  return {
    base,
    close: async () => {
      await made.ctx.kiwix.stop();
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    },
  };
}

/** A PNG's width and height, from its header. */
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

describe('adding Outpost to a home screen or the Dock', () => {
  it('serves the manifest and its icons before sign-in, at the sizes it claims', async () => {
    const t = await setup();
    try {
      assert.equal((await fetch(`${t.base}/api/notes`)).status, 401, 'signed out');
      const r = await fetch(`${t.base}/manifest.webmanifest`);
      assert.equal(r.status, 200, 'phones fetch the manifest without the sign-in cookie');
      assert.match(r.headers.get('content-type') ?? '', /manifest\+json/);
      const fav = await fetch(`${t.base}/favicon.ico`);
      assert.equal(fav.status, 200, 'the root icon browsers look for, before sign-in');
      assert.match(fav.headers.get('content-type') ?? '', /image\/png/);
      assert.equal(pngSize(Buffer.from(await fav.arrayBuffer())).join('x'), '64x64', 'the current tab icon');
      const m = await r.json();
      assert.equal(m.name, 'Outpost');
      assert.equal(m.start_url, '/');
      assert.equal(m.display, 'standalone');
      assert.ok(m.icons.some((i: { purpose: string }) => i.purpose === 'maskable'), 'a maskable icon for Android');
      for (const icon of [...m.icons, { src: '/img/app-180.png?v=2', sizes: '180x180' }]) {
        const res = await fetch(t.base + icon.src);
        assert.equal(res.status, 200, icon.src);
        assert.equal(pngSize(Buffer.from(await res.arrayBuffer())).join('x'), icon.sizes, icon.src);
      }
    } finally {
      await t.close();
    }
  });

  it('links the manifest and the iPhone icon from every page a phone opens first', async () => {
    const t = await setup();
    try {
      for (const p of ['/login.html', '/join']) {
        const html = await (await fetch(t.base + p)).text();
        assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/, p);
        assert.match(html, /<link rel="apple-touch-icon" href="\/img\/app-180.png\?v=2">/, p);
        assert.match(html, /<meta name="apple-mobile-web-app-title" content="Outpost">/, p);
      }
      const index = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
      assert.match(index, /<link rel="manifest" href="\/manifest.webmanifest">/);
      assert.match(index, /<link rel="apple-touch-icon" href="\/img\/app-180.png\?v=2">/);
      assert.match(index, /viewport-fit=cover/, 'installed on an iPhone, the page can keep its bars clear of the rounded corners');
    } finally {
      await t.close();
    }
  });

  it('shows how to add it on iPhone, Android and Mac, from the secure address when there is one', async () => {
    for (const https of ['1', '0']) {
      const t = await setup({ OUTPOST_HOST: '0.0.0.0', OUTPOST_HTTPS: https, OUTPOST_PASSWORD: 'x' });
      try {
        const html = await (await fetch(`${t.base}/join`)).text();
        assert.match(html, /Add Outpost to your home screen/, `https=${https}`);
        for (const step of ['Add to Home Screen', 'Install app', 'Add to Dock']) assert.match(html, new RegExp(step), `${step}, https=${https}`);
        if (https === '1') assert.match(html, /4\. Add Outpost to your home screen<\/h2>\s*<p>Open Outpost at <b>https:\/\/127\.0\.0\.1:\d+\/<\/b> first/);
        else assert.match(html, /installs Outpost as an app only over its secure address/);
        if (https === '1') {
          assert.match(html, /data-check="https:\/\/127\.0\.0\.1:\d+\/healthz"/, 'checks on the device whether it trusts Outpost');
          assert.match(html, /Installing isn't enough on its own/, 'iPhone: the trust switch is spelled out');
        }
        assert.match(html, /Icon blank, or a letter instead of the tower\?/);
      } finally {
        await t.close();
      }
    }
  });
});
