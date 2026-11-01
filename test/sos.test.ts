import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { SOS_SEND_GAP_MS, SOS_TTL_MS, SosBoard } from '../src/services/sos.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

describe('network SOS', () => {
  it('checks alerts, limits sending, and forgets them after 2 hours', () => {
    let now = 1_000_000;
    const board = new SosBoard(() => now);
    assert.throws(() => board.send('anna', { message: 'x'.repeat(281) }), /280 characters/);
    assert.throws(() => board.send('anna', { lat: 91, lon: 0 }), /latitude/);
    assert.throws(() => board.send('anna', { lat: 10 }), /longitude/);
    assert.throws(() => board.send('anna', { lat: 1, lon: 1, accuracy: -5 }), /Accuracy/);
    const a = board.send('anna', { message: '  Injured at   the north cabin ', lat: 33.9, lon: 35.5, accuracy: 12.4 });
    assert.equal(a.message, 'Injured at the north cabin');
    assert.equal(a.accuracy, 12);
    assert.throws(() => board.send('anna', {}), (e: any) => e.status === 429 && /seconds/.test(e.message), 'one per 30 seconds per person');
    now += 1000;
    const b = board.send('ben', {});
    assert.deepEqual([b.lat, b.lon, b.message], [null, null, ''], 'position and message are optional');
    now += SOS_SEND_GAP_MS;
    board.send('anna', { message: 'still here' });
    assert.deepEqual(board.list().map((x) => x.message), ['still here', '', 'Injured at the north cabin'], 'newest first');

    assert.throws(() => board.ack(a.id, 'anna'), /You sent/);
    board.ack(a.id, 'ben');
    board.ack(a.id, 'ben');
    assert.deepEqual(a.acks.map((k) => k.name), ['ben'], 'once per person');

    assert.throws(() => board.cancel(a.id, 'ben', false), (e: any) => e.status === 403);
    board.cancel(a.id, 'carl', true);
    assert.throws(() => board.ack(a.id, 'ben'), (e: any) => e.status === 404);

    now += SOS_TTL_MS - SOS_SEND_GAP_MS + 1;
    assert.deepEqual(board.list().map((x) => x.message), ['still here'], 'older alerts expired');
  });

  it('lets members send, answer and cancel their own, with nothing on disk', async () => {
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
      return { status: r.status, json: await r.json().catch(() => null), retry: r.headers.get('retry-after') };
    };
    try {
      assert.equal((await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' })).status, 201);
      await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
      await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
      await call('anna', '/api/users', 'POST', { name: 'cleo', password: 'tropical fish', role: 'member' });
      await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });
      await call('cleo', '/api/auth/login', 'POST', { name: 'cleo', password: 'tropical fish' });

      assert.equal((await call('nobody', '/api/sos')).status, 401);
      assert.equal((await call('nobody', '/api/sos', 'POST', {})).status, 401);
      assert.equal((await call('ben', '/api/sos', 'POST', { message: 'x'.repeat(300) })).status, 400);
      const sent = await call('ben', '/api/sos', 'POST', { message: 'Injured at the north cabin', lat: 33.9123, lon: 35.5321, accuracy: 9, name: 'anna' });
      assert.equal(sent.status, 201, 'members may send');
      assert.equal(sent.json.name, 'ben', 'the sender is whoever is signed in, whatever name is sent');
      const again = await call('ben', '/api/sos', 'POST', {});
      assert.equal(again.status, 429);
      assert.ok(Number(again.retry) > 0, 'says when to try again');
      const id = sent.json.id;

      const seen = (await call('anna', '/api/sos')).json.alerts;
      assert.deepEqual(seen.map((a: any) => [a.name, a.mine]), [['ben', false]]);
      assert.equal((await call('ben', '/api/sos')).json.alerts[0].mine, true);

      assert.equal((await call('cleo', `/api/sos/${id}/ack`, 'POST')).status, 200, 'members may answer');
      assert.deepEqual((await call('ben', '/api/sos')).json.alerts[0].acks.map((k: any) => k.name), ['cleo']);
      assert.equal((await call('cleo', `/api/sos/${id}`, 'DELETE')).status, 403, 'only the sender or an admin cancels');
      assert.equal((await call('cleo', `/api/sos/${id}/ack`, 'DELETE')).status, 403, 'nothing else under /api/sos is open to members');
      assert.equal((await call('ben', `/api/sos/${id}`, 'DELETE')).status, 200);
      assert.deepEqual((await call('anna', '/api/sos')).json.alerts, []);

      const cleos = (await call('cleo', '/api/sos', 'POST', { message: 'Lost near the river' })).json.id;
      assert.equal((await call('anna', `/api/sos/${cleos}`, 'DELETE')).status, 200, 'an admin may cancel anyone’s');
      assert.equal((await call('anna', `/api/sos/${cleos}`, 'DELETE')).status, 404);

      const onDisk = fs.readdirSync(h, { recursive: true }).map(String);
      for (const f of onDisk) {
        if (fs.statSync(`${h}/${f}`).isFile()) assert.doesNotMatch(fs.readFileSync(`${h}/${f}`, 'utf8'), /north cabin|near the river|35\.5321/, `${f} holds no SOS`);
      }
    } finally {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
