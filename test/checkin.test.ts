import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { CHECKIN_TTL_MS, CheckinBoard } from '../src/services/checkin.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

describe("who's safe", () => {
  it('keeps one line per person, checks it, and forgets it after a day', () => {
    let now = 1_000_000;
    const board = new CheckinBoard(() => now);
    assert.throws(() => board.set('anna', { status: 'fine' }), /Status/);
    assert.throws(() => board.set('anna', { status: 'safe', note: 'x'.repeat(141) }), /140/);
    board.set('anna', { status: 'help', note: '  stuck   on the roof ' });
    now += 1000;
    board.set('ben', { status: 'safe' });
    now += 1000;
    const a = board.set('anna', { status: 'safe', note: 'down now' });
    assert.equal(a.note, 'down now');
    assert.deepEqual(board.list().map((l) => [l.name, l.status]), [['anna', 'safe'], ['ben', 'safe']], 'one line each, newest first');
    board.clear('ben');
    assert.deepEqual(board.list().map((l) => l.name), ['anna']);
    now += CHECKIN_TTL_MS + 1;
    assert.deepEqual(board.list(), []);
  });

  it('lets members set and clear their own line, shows who has not checked in, and writes nothing to disk', async () => {
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
      await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' });
      await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
      await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
      await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });

      assert.equal((await call('nobody', '/api/checkin')).status, 401);
      assert.equal((await call('ben', '/api/checkin/me', 'PUT', { status: 'nope' })).status, 400);
      const put = await call('ben', '/api/checkin/me', 'PUT', { status: 'help', note: 'Ankle hurt, at the north cabin', name: 'anna' });
      assert.equal(put.status, 200, 'members may check in');
      assert.equal(put.json.name, 'ben', 'the line is whoever is signed in, whatever name is sent');
      const seen = (await call('anna', '/api/checkin')).json;
      assert.deepEqual(seen.people.map((l: any) => [l.name, l.status]), [['ben', 'help']]);
      assert.deepEqual(seen.everyone.sort(), ['anna', 'ben'], 'everyone, so the page can show who has not checked in');
      assert.equal(seen.me, 'anna');
      assert.equal((await call('ben', '/api/checkin/anna', 'PUT', { status: 'safe' })).status, 403, 'nobody sets someone else’s line');
      assert.equal((await call('ben', '/api/checkin/me', 'DELETE')).status, 200);
      assert.deepEqual((await call('anna', '/api/checkin')).json.people, []);

      await call('ben', '/api/checkin/me', 'PUT', { status: 'safe', note: 'at the north cabin' });
      for (const f of fs.readdirSync(h, { recursive: true }).map(String)) {
        if (fs.statSync(`${h}/${f}`).isFile()) assert.doesNotMatch(fs.readFileSync(`${h}/${f}`, 'utf8'), /north cabin/, `${f} holds no check-in`);
      }

      // The incident log rides with the emergency card: times and text, checked.
      const log = [{ at: 1_700_000_000_000, text: 'Tourniquet on, left leg' }];
      assert.equal((await call('ben', '/api/emergency', 'PUT', { log })).status, 200);
      assert.deepEqual((await call('ben', '/api/emergency')).json.log, log);
      assert.equal((await call('ben', '/api/emergency', 'PUT', { log: [{ at: 'soon', text: 'x' }] })).status, 400);
      assert.equal((await call('ben', '/api/emergency', 'PUT', { log: [{ at: 1, text: 'x'.repeat(201) }] })).status, 400);

      // Saves of different parts at the same moment (two devices): none is lost, and the file stays whole.
      const card = { name: 'Ben', allergies: 'Penicillin' };
      const numbers = [{ name: 'Ambulance', number: '140' }];
      const kits = { checked: { gobag: ['water'] }, extra: {} };
      const many = [{ card }, { numbers }, { kits }, { log: [...log, { at: 1_700_000_100_000, text: 'Help arrived' }] }];
      const results = await Promise.all(many.map((part) => call('ben', '/api/emergency', 'PUT', part)));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
      const all = (await call('ben', '/api/emergency')).json;
      assert.equal(all.card.allergies, 'Penicillin');
      assert.deepEqual(all.numbers, numbers);
      assert.deepEqual(all.kits.checked.gobag, ['water']);
      assert.equal(all.log.length, 2, 'every part kept');
      assert.equal((await call('ben', '/api/emergency', 'PUT', { card: { bloodType: 'Z' } })).status, 400, 'a refused save doesn’t block the next');
      assert.equal((await call('ben', '/api/emergency', 'PUT', { numbers: [] })).status, 200);
    } finally {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
