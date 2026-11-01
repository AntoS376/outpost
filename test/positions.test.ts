import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { POSITION_TTL_MS, PositionBoard } from '../src/services/positions.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

describe('group map', () => {
  it('keeps one fresh position per person, checks it, and forgets it after 15 minutes', () => {
    let now = 1_000_000;
    const board = new PositionBoard(() => now);
    assert.throws(() => board.set('anna', { lat: 91, lon: 0 }), /latitude/);
    assert.throws(() => board.set('anna', { lat: 'x', lon: 0 }), /latitude/);
    assert.throws(() => board.set('anna', { lat: 0, lon: 181 }), /longitude/);
    assert.throws(() => board.set('anna', { lat: 0, lon: 0, accuracy: -1 }), /Accuracy/);
    board.set('anna', { lat: 33.8938, lon: 35.5018, accuracy: 12.4 });
    board.set('anna', { lat: 33.9, lon: 35.5, accuracy: 8 });
    board.set('ben', { lat: 34, lon: 35.6 });
    assert.deepEqual(board.list().map((p) => [p.name, p.lat, p.accuracy]), [['anna', 33.9, 8], ['ben', 34, 0]]);
    now += POSITION_TTL_MS - 1;
    board.set('ben', { lat: 34, lon: 35.6 });
    now += 2;
    assert.deepEqual(board.list().map((p) => p.name), ['ben'], "anna's went stale");
    board.remove('ben');
    assert.deepEqual(board.list(), []);
  });

  it('lets each signed-in person share only their own place, members included, with nothing on disk', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
    const s = http.createServer(made.app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    const cookies: Record<string, string> = {};
    const call = async (who: string, p: string, method = 'GET', json?: unknown) => {
      const r = await fetch(base + p, { method, headers: { ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) cookies[who] = set.split(';')[0]!;
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    try {
      assert.equal((await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' })).status, 201);
      await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
      await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
      await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });

      assert.equal((await call('nobody', '/api/positions')).status, 401);
      assert.equal((await call('nobody', '/api/positions/me', 'PUT', { lat: 1, lon: 1 })).status, 401);
      assert.equal((await call('ben', '/api/positions/me', 'PUT', { lat: 33.9, lon: 35.5, accuracy: 9, name: 'anna' })).status, 200, 'members may share');
      assert.equal((await call('ben', '/api/positions/me', 'PUT', { lat: 200, lon: 0 })).status, 400);
      await call('anna', '/api/positions/me', 'PUT', { lat: 34, lon: 35.6, accuracy: 20 });

      const seen = (await call('anna', '/api/positions')).json.positions;
      assert.deepEqual(
        seen.map((p: any) => [p.name, p.me]),
        [['anna', true], ['ben', false]],
        "ben's entry is his, whatever name he sends",
      );
      assert.equal((await call('ben', '/api/positions/me', 'DELETE')).status, 200);
      assert.deepEqual((await call('ben', '/api/positions')).json.positions.map((p: any) => p.name), ['anna']);

      const onDisk = fs.readdirSync(h, { recursive: true }).map(String);
      for (const f of onDisk) if (fs.statSync(`${h}/${f}`).isFile()) assert.doesNotMatch(fs.readFileSync(`${h}/${f}`, 'utf8'), /35\.6|33\.9/, `${f} holds no position`);
    } finally {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
