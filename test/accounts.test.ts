import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, here, listen, makeExecutable, mockOllama, tmpHome, CONTENT_PATH } from './helpers.js';

/** An Outpost on a fresh data folder, with a cookie-keeping client per signed-in person. */
async function start(env: Record<string, string> = {}, seed?: (h: string) => Promise<void>, home?: string) {
  const h = home ?? (await tmpHome());
  if (seed) await seed(h);
  const ollama = mockOllama();
  const op = await listen(ollama);
  const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, ...env }));
  const s = http.createServer(made.app);
  const base = `http://127.0.0.1:${await listen(s)}`;
  const cs = http.createServer(made.content);
  const contentUrl = `http://127.0.0.1:${await listen(cs)}`;
  const client = (cookie = '') => {
    const c = {
      cookie,
      async call(p: string, init: RequestInit & { json?: unknown } = {}) {
        const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
        if (c.cookie && !headers.Cookie) headers.Cookie = c.cookie;
        if (init.json !== undefined) headers['Content-Type'] = 'application/json';
        const r = await fetch((CONTENT_PATH.test(p) ? contentUrl : base) + p, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: 'manual' });
        const set = r.headers.get('set-cookie');
        if (set) c.cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
        const t = await r.text();
        let json: any = t;
        try {
          json = JSON.parse(t);
        } catch {
          /* text */
        }
        return { status: r.status, headers: r.headers, json };
      },
      async login(name: string, password: string) {
        return c.call('/api/auth/login', { method: 'POST', json: { name, password } });
      },
    };
    return c;
  };
  const close = async (keep = false) => {
    await made.ctx.kiwix.stop();
    await made.ctx.kolibri.stop(false);
    s.closeAllConnections();
    s.close();
    cs.closeAllConnections();
    cs.close();
    ollama.close();
    if (!keep) await fsp.rm(h, { recursive: true, force: true });
  };
  return { h, base, client, close };
}

describe('accounts', () => {
  let app: Awaited<ReturnType<typeof start>>;
  before(async () => {
    app = await start({}, async (h) => {
      // Notes written before accounts existed: flat files in ~/Outpost/notes.
      await fsp.mkdir(path.join(h, 'notes'), { recursive: true });
      await fsp.writeFile(path.join(h, 'notes', 'water-plan.md'), '# Water plan\n\nBoil for one minute.');
      await fsp.writeFile(path.join(h, 'notes', 'contacts.md'), '# Contacts\n');
    });
  });
  after(() => app.close());

  it('starts open on loopback: you are the admin, and old notes move into your folder', async () => {
    const me = await app.client().call('/api/auth/me');
    assert.deepEqual(me.json, { mode: 'open', user: { name: 'outpost', role: 'admin' } });
    assert.deepEqual((await app.client().call('/api/notes')).json.notes.map((n: any) => n.id).sort(), ['contacts', 'water-plan']);
    assert.ok(fs.existsSync(path.join(app.h, 'notes', 'outpost', 'water-plan.md')), 'moved into notes/<user>/');
    assert.ok(!fs.existsSync(path.join(app.h, 'notes', 'water-plan.md')));
  });

  it('creating the first account turns on sign-in and hands existing notes to that admin', async () => {
    const open = app.client();
    assert.equal((await open.call('/api/users', { method: 'POST', json: { name: 'anna', password: 'short', role: 'admin' } })).status, 400, 'passwords need 8+ characters');
    assert.equal((await open.call('/api/users', { method: 'POST', json: { name: 'anna', password: 'correct horse', role: 'member' } })).status, 400, 'the first account must be an admin');
    const made = await open.call('/api/users', { method: 'POST', json: { name: 'Anna', password: 'correct horse', role: 'admin' } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.deepEqual(made.json, { name: 'anna', role: 'admin' }, 'names are lowercased');

    assert.equal((await app.client().call('/api/status')).status, 401, 'now everyone signs in');
    assert.equal((await app.client().call('/api/auth/me')).json.mode, 'accounts');
    const anna = app.client();
    assert.equal((await anna.login('anna', 'correct horse')).status, 200);
    assert.deepEqual((await anna.call('/api/notes')).json.notes.map((n: any) => n.id).sort(), ['contacts', 'water-plan'], 'no note lost');
    assert.match(fs.readFileSync(path.join(app.h, 'notes', 'anna', 'water-plan.md'), 'utf8'), /Boil for one minute/);

    const st = fs.statSync(path.join(app.h, 'users.json'));
    assert.equal(st.mode & 0o777, 0o600, 'users.json readable by its owner only');
    const raw = fs.readFileSync(path.join(app.h, 'users.json'), 'utf8');
    assert.ok(!raw.includes('correct horse'), 'no plain password on disk');
    assert.match(raw, /"hash":\s*"scrypt\$/);
  });

  it('signs in with an HttpOnly, SameSite=Strict cookie and signs out', async () => {
    const c = app.client();
    const wrong = await c.login('anna', 'wrong password');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'Name or password is incorrect.');
    assert.equal((await c.login('nobody', 'whatever1')).json.error, 'Name or password is incorrect.', 'same answer for unknown names');
    const ok = await c.login('anna', 'correct horse');
    const cookie = ok.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^outpost_session=[A-Za-z0-9_-]{40,};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.deepEqual((await c.call('/api/auth/me')).json.user, { name: 'anna', role: 'admin' });
    assert.equal((await c.call('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await c.call('/api/status')).status, 401);
  });

  it('sends a browser that is not signed in to the login page, which itself loads', async () => {
    const page = await app.client().call('/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login.html');
    assert.equal((await app.client().call('/login.html')).status, 200);
    assert.equal((await app.client().call('/app.css')).status, 200);
    assert.equal((await app.client().call('/healthz')).status, 200);
  });

  it('refuses state changes from another site (Origin check)', async () => {
    const anna = app.client();
    await anna.login('anna', 'correct horse');
    const r = await anna.call('/api/notes', { method: 'POST', json: { title: 'x' }, headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
  });

  describe('members', () => {
    let admin: ReturnType<typeof app.client>;
    let ben: ReturnType<typeof app.client>;
    before(async () => {
      admin = app.client();
      await admin.login('anna', 'correct horse');
      assert.equal((await admin.call('/api/users', { method: 'POST', json: { name: 'ben', password: 'ben-password', role: 'member' } })).status, 201);
      ben = app.client();
      assert.equal((await ben.login('ben', 'ben-password')).status, 200);
    });

    it('may read, chat, keep their own notes and chats, and change their own password', async () => {
      assert.equal((await ben.call('/api/status')).status, 200);
      assert.equal((await ben.call('/api/library')).status, 200);
      assert.equal((await ben.call('/api/notes', { method: 'POST', json: { title: 'Ben secret' } })).status, 201);
      const chat = await ben.call('/api/ai/chat', { method: 'POST', json: { model: 'llama3.2:3b', messages: [{ role: 'user', content: 'hi' }] } });
      assert.equal(chat.status, 200);
      const saved = await ben.call('/api/chats/first', { method: 'PUT', json: { title: 'First chat', model: 'llama3.2:3b', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello' }] } });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      assert.deepEqual((await ben.call('/api/chats')).json.chats.map((c: any) => [c.id, c.title]), [['first', 'First chat']]);
      assert.equal((await ben.call('/api/chats/first')).json.messages.length, 2);
      assert.equal((await ben.call('/api/auth/password', { method: 'PUT', json: { current: 'wrong-one', password: 'new-ben-pass' } })).status, 401);
      assert.equal((await ben.call('/api/auth/password', { method: 'PUT', json: { current: 'ben-password', password: 'new-ben-pass' } })).status, 200);
      assert.equal((await app.client().login('ben', 'new-ben-pass')).status, 200);
    });

    it('cannot change anything else: every other mutating route answers 403', async () => {
      const routes: [string, string, unknown?][] = [
        ['POST', '/api/library/restart'],
        ['DELETE', '/api/library/x.zim'],
        ['PUT', '/api/library/upload/x.zim', 'data'],
        ['POST', '/api/jobs/download', { url: 'http://example.com/a.zim', kind: 'zim' }],
        ['POST', '/api/jobs/abc/cancel'],
        ['DELETE', '/api/jobs/abc'],
        ['POST', '/api/maps/extract', {}],
        ['PUT', '/api/maps/upload/x.pmtiles', 'data'],
        ['DELETE', '/api/maps/x.pmtiles'],
        ['POST', '/api/maps/x.pmtiles/index'],
        ['POST', '/api/ai/pull', { name: 'x' }],
        ['DELETE', '/api/ai/models/x'],
        ['POST', '/api/ai/docs?name=a.md', 'text'],
        ['DELETE', '/api/ai/docs/abc'],
        ['POST', '/api/ai/docs/reindex'],
        ['POST', '/api/setup/start', {}],
        ['POST', '/api/setup/dismiss'],
        ['POST', '/api/setup/map-estimate', {}],
        ['POST', '/api/education/start'],
        ['POST', '/api/education/stop'],
        ['POST', '/api/benchmark/start', {}],
        ['PUT', '/api/benchmark/tag', {}],
        ['DELETE', '/api/benchmark/abc'],
        ['POST', '/api/users', { name: 'eve', password: 'eve-password', role: 'admin' }],
        ['PUT', '/api/users/anna', { role: 'member' }],
        ['DELETE', '/api/users/anna'],
        ['POST', '/api/something-new-later'],
      ];
      for (const [method, p, body] of routes) {
        const r = await ben.call(p, typeof body === 'string' ? { method, body } : { method, json: body ?? {} });
        assert.equal(r.status, 403, `${method} ${p} -> ${r.status}`);
        assert.match(r.json.error, /Only an admin can do that/);
      }
      assert.equal((await ben.call('/api/users')).status, 403, 'nor list accounts');
    });

    it('keeps each person’s notes and chats to themselves', async () => {
      const annaNotes = (await admin.call('/api/notes')).json.notes.map((n: any) => n.id);
      assert.ok(!annaNotes.includes('ben-secret'));
      assert.equal((await admin.call('/api/notes/ben-secret')).status, 404);
      assert.deepEqual((await admin.call('/api/chats')).json.chats, []);
      assert.equal((await admin.call('/api/chats/first')).status, 404);
      assert.ok(fs.existsSync(path.join(app.h, 'notes', 'ben', 'ben-secret.md')));
      assert.ok(fs.existsSync(path.join(app.h, 'chats', 'ben', 'first.json')));
    });

    it('keeps each person’s emergency card private, in an owner-only file', async () => {
      const card = { card: { name: 'Ben', bloodType: 'O+', allergies: 'Penicillin', contacts: [{ name: 'Mum', relation: 'mother', phone: '+961 1 234 567' }], meetingPoints: ['Church steps'] }, kits: { checked: { gobag: ['water', 'radio'] }, extra: { car: ['Tow rope'] } } };
      const put = await ben.call('/api/emergency', { method: 'PUT', json: card });
      assert.equal(put.status, 200, JSON.stringify(put.json));
      const mine = (await ben.call('/api/emergency')).json;
      assert.equal(mine.card.allergies, 'Penicillin');
      assert.deepEqual(mine.kits.checked.gobag, ['water', 'radio']);
      assert.deepEqual(mine.kits.extra.car, ['Tow rope']);
      assert.equal((await admin.call('/api/emergency')).json.card.allergies, '', 'an admin does not see another person’s card');
      assert.equal(fs.statSync(path.join(app.h, 'emergency', 'ben.json')).mode & 0o777, 0o600);
      assert.equal((await ben.call('/api/emergency', { method: 'PUT', json: { card: { bloodType: 'Z' } } })).status, 400);
      assert.equal((await ben.call('/api/emergency', { method: 'PUT', json: { card: { allergies: 'x'.repeat(501) } } })).status, 400);
      assert.equal((await ben.call('/api/emergency', { method: 'PUT', json: { kits: { checked: { boat: ['x'] } } } })).status, 400);
    });

    it('lets an admin manage accounts but never remove or demote the last admin', async () => {
      const list = (await admin.call('/api/users')).json.users;
      assert.deepEqual(list.map((u: any) => [u.name, u.role]), [['anna', 'admin'], ['ben', 'member']]);
      assert.ok(!JSON.stringify(list).includes('scrypt'), 'hashes never leave the server');
      assert.equal((await admin.call('/api/users/anna', { method: 'PUT', json: { role: 'member' } })).status, 409);
      assert.equal((await admin.call('/api/users/anna', { method: 'DELETE' })).status, 409);
      assert.equal((await admin.call('/api/users/ben', { method: 'PUT', json: { password: 'reset-by-admin' } })).status, 200);
      assert.equal((await app.client().login('ben', 'reset-by-admin')).status, 200);
      assert.equal((await admin.call('/api/users/nobody', { method: 'DELETE' })).status, 404);
    });
  });

  it('rejects user names that could reach outside their folder', async () => {
    const admin = app.client();
    await admin.login('anna', 'correct horse');
    for (const name of ['../evil', '..', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(33), 'nul\u0000l', 'café']) {
      const r = await admin.call('/api/users', { method: 'POST', json: { name, password: 'password123', role: 'member' } });
      assert.equal(r.status, 400, `${JSON.stringify(name)} -> ${r.status}`);
    }
    assert.equal((await app.client().login('../anna', 'correct horse')).status, 401);
    assert.ok(!fs.existsSync(path.join(app.h, 'evil')) && !fs.existsSync(path.join(app.h, '..', 'evil')));
  });

  it('slows down guessing: after 5 failures a name is locked for a while', async () => {
    const admin = app.client();
    await admin.login('anna', 'correct horse');
    await admin.call('/api/users', { method: 'POST', json: { name: 'carol', password: 'carol-password', role: 'member' } });
    const c = app.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.login('carol', `guess-${i}xx`)).status, 401);
    const locked = await c.login('carol', 'carol-password');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.match(locked.json.error, /Too many attempts/);
  });

  it('keeps sessions across a restart', async () => {
    const c = app.client();
    await c.login('anna', 'correct horse');
    await app.close(true);
    app = await start({}, undefined, app.h);
    const again = app.client(c.cookie);
    assert.equal((await again.call('/api/auth/me')).json.user.name, 'anna');
  });
});

describe('bootstrap admin from the settings file', () => {
  it('signs in with OUTPOST_USER/OUTPOST_PASSWORD, by form or Basic auth, alongside accounts', async () => {
    const app = await start({ OUTPOST_USER: 'boss', OUTPOST_PASSWORD: 'env-password' });
    try {
      assert.equal((await app.client().call('/api/auth/me')).json.mode, 'password');
      const c = app.client();
      assert.equal((await c.login('boss', 'env-password')).status, 200);
      assert.deepEqual((await c.call('/api/auth/me')).json.user, { name: 'boss', role: 'admin' });
      const basic = { Authorization: 'Basic ' + Buffer.from('boss:env-password').toString('base64') };
      assert.equal((await app.client().call('/api/status', { headers: basic })).status, 200);
      assert.equal((await c.call('/api/users', { method: 'POST', json: { name: 'boss', password: 'another-pass', role: 'admin' } })).status, 409, 'that name is taken by the settings file');
      assert.equal((await c.call('/api/users', { method: 'POST', json: { name: 'dana', password: 'dana-password', role: 'admin' } })).status, 201);
      assert.equal((await app.client().call('/api/auth/me')).json.mode, 'accounts');
      assert.equal((await app.client().login('boss', 'env-password')).status, 200, 'still works once accounts exist');
    } finally {
      await app.close();
    }
  });
});

describe('proxies and the session cookie', () => {
  it('never forwards the Outpost session to Kolibri', async () => {
    const kport = await freePort();
    const app = await start({ OUTPOST_KOLIBRI_PORT: String(kport), OUTPOST_KOLIBRI_ZIP_PORT: String(await freePort()) }, async (h) => {
      const bin = path.join(h, 'kolibri-venv', 'bin');
      await fsp.mkdir(bin, { recursive: true });
      makeExecutable(path.join(here, 'fixtures/fake-kolibri.mjs'), path.join(bin, 'kolibri'));
      makeExecutable(process.execPath, path.join(bin, 'python'));
    });
    try {
      const open = app.client();
      await open.call('/api/users', { method: 'POST', json: { name: 'anna', password: 'correct horse', role: 'admin' } });
      const anna = app.client();
      await anna.login('anna', 'correct horse');
      await anna.call('/api/education/start', { method: 'POST' });
      for (let i = 0; i < 100 && (await anna.call('/api/education')).json.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));
      const echo = await anna.call('/kolibri/api/echo', { headers: { Cookie: `${anna.cookie}; kolibri=keep-me` } });
      assert.equal(echo.status, 200);
      assert.equal(echo.json.cookie, 'kolibri=keep-me', 'Kolibri still gets its own cookies');
    } finally {
      await app.close();
    }
  });
});
