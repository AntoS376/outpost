import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { GpuMonitor, parseIoreg } from '../src/services/gpu.js';
import { freePort, here, listen, makeExecutable, mockOllama, tmpHome } from './helpers.js';

describe('GPU gauge', () => {
  it("reads macOS's GPU statistics, and says when there are none", () => {
    const fake = execFileSync(process.execPath, [`${here}/fixtures/fake-ioreg.mjs`], { env: { ...process.env, FAKE_GPU_BUSY: '73' } }).toString();
    assert.deepEqual(parseIoreg(fake), { available: true, chip: 'Apple M3 Pro', cores: 18, busy: 73, memoryUsed: 961003520 });
    assert.deepEqual(parseIoreg(''), { available: false, chip: null, cores: null, busy: null, memoryUsed: null });
    assert.equal(parseIoreg('"Device Utilization %"=140').busy, 100, 'kept within 0–100');
  });

  it('asks macOS at most about once a second, however many pages are watching', async () => {
    const h = await tmpHome();
    try {
      const bin = path.join(h, 'ioreg');
      makeExecutable(`${here}/fixtures/fake-ioreg.mjs`, bin);
      process.env.FAKE_IOREG_COUNT = path.join(h, 'count');
      const gpu = new GpuMonitor(bin, 500);
      const readings = await Promise.all([gpu.read(), gpu.read(), gpu.read()]);
      await gpu.read();
      assert.ok(readings.every((r) => r.busy === 32 && r.memoryTotal > 0));
      assert.equal(fs.readFileSync(process.env.FAKE_IOREG_COUNT, 'utf8').length, 1);
      await new Promise((r) => setTimeout(r, 550));
      await gpu.read();
      assert.equal(fs.readFileSync(process.env.FAKE_IOREG_COUNT, 'utf8').length, 2);
      const missing = await new GpuMonitor(path.join(h, 'no-ioreg')).read();
      assert.equal(missing.available, false, 'no ioreg: no gauge, no error');
    } finally {
      delete process.env.FAKE_IOREG_COUNT;
      await fsp.rm(h, { recursive: true, force: true });
    }
  });

  it('shows everyone signed in the GPU and the loaded model', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const bin = path.join(h, 'ioreg');
    makeExecutable(`${here}/fixtures/fake-ioreg.mjs`, bin);
    const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, OUTPOST_IOREG_BIN: bin }));
    const s = http.createServer(made.app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    const cookies: Record<string, string> = {};
    const call = async (who: string, p: string, method = 'GET', json?: unknown) => {
      const r = await fetch(base + p, { method, headers: { ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) cookies[who] = set.split(';')[0]!;
      return { status: r.status, json: await r.json().catch(() => null), cache: r.headers.get('cache-control') };
    };
    try {
      await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' });
      await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
      await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
      await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });
      assert.equal((await call('nobody', '/api/ai/gpu')).status, 401);
      const r = await call('ben', '/api/ai/gpu');
      assert.equal(r.status, 200);
      assert.equal(r.cache, 'no-store');
      assert.equal(r.json.gpu.busy, 32);
      assert.equal(r.json.gpu.chip, 'Apple M3 Pro');
      assert.deepEqual(r.json.loaded, [{ name: 'llama3.2:3b', size: 3_000_000_000, onGpu: 3_000_000_000 }]);
    } finally {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
