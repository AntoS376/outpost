import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, here, listen, makeExecutable, mockOllama, tmpHome, waitFor } from './helpers.js';

describe('field mode', () => {
  it('makes join QR codes offline', async () => {
    const { qrSvg } = await import('../client-src/qr.js');
    const svg = qrSvg('http://192.168.2.1:8080/join');
    assert.match(svg, /^<svg[^>]*viewBox/);
    assert.match(svg, /<path|<rect/);
    assert.notEqual(svg, qrSvg('http://192.168.2.2:8080/join'), 'different address, different code');
  });

  it('keeps the Mac awake only when an admin asks, comes back after a restart, and stops on request', async () => {
    const h = await tmpHome();
    const log = path.join(h, 'caffeinate.log');
    process.env.FAKE_CAFFEINATE_LOG = log;
    makeExecutable(path.join(here, 'fixtures', 'fake-caffeinate.mjs'), path.join(h, 'caffeinate'));
    const ollama = mockOllama();
    const op = await listen(ollama);
    const boot = async () => {
      const made = await createApp(
        loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, OUTPOST_CAFFEINATE_BIN: path.join(h, 'caffeinate') }),
      );
      const s = http.createServer(made.app);
      const base = `http://127.0.0.1:${await listen(s)}`;
      const put = (on: boolean, auth?: string) => fetch(`${base}/api/awake`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ on }) });
      const status = async () => (await (await fetch(`${base}/api/status`)).json()).listen.awake;
      const close = async () => {
        await made.ctx.awake.set(false, false);
        s.closeAllConnections();
        s.close();
      };
      return { put, status, close };
    };
    try {
      let app = await boot();
      assert.deepEqual(await app.status(), { available: true, on: false, state: 'stopped' });
      assert.equal((await app.put(true)).status, 200);
      await waitFor(async () => fs.existsSync(log));
      assert.equal(fs.readFileSync(log, 'utf8'), `-i -s -w ${process.pid}`, 'tied to Outpost, so it ends with it');
      assert.equal((await app.status()).on, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).keepAwake, true);

      await app.close();
      fs.rmSync(log);
      app = await boot();
      await waitFor(async () => fs.existsSync(log));
      assert.equal((await app.status()).on, true, 'back on after a restart');

      assert.equal((await app.put(false)).status, 200);
      assert.equal((await app.status()).on, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).keepAwake, false);
      await app.close();
    } finally {
      delete process.env.FAKE_CAFFEINATE_LOG;
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
