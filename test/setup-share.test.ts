import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, listen, tmpHome } from './helpers.js';

/** Wi-Fi sharing from the setup wizard: it needs an account, writes the settings file and asks for a restart. */
describe('setup: share on Wi-Fi', async () => {
  const home = await tmpHome();
  const envFile = path.join(home, 'settings', 'env');
  const made = await createApp(loadConfig({ OUTPOST_HOME: home, OUTPOST_ENV_FILE: envFile, OUTPOST_KIWIX_PORT: String(await freePort()) }));
  let restarts = 0;
  made.ctx.restart = () => (restarts++, true);
  const server = http.createServer(made.app);
  const base = `http://127.0.0.1:${await listen(server)}`;
  after(() => server.close());
  let cookie = '';
  const call = async (p: string, json?: unknown) => {
    const headers: Record<string, string> = { Origin: base };
    if (cookie) headers.Cookie = cookie;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method: json === undefined ? 'GET' : 'POST', headers, body: json === undefined ? undefined : JSON.stringify(json) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  it('starts unshared and refuses to share before an account exists', async () => {
    assert.equal((await call('/api/setup')).body.shared, false);
    const r = await call('/api/setup/share', { on: true });
    assert.equal(r.status, 409);
    assert.equal(fs.existsSync(envFile), false);
    assert.equal(restarts, 0);
  });

  it('shares once the admin account exists, writing a private settings file', async () => {
    assert.equal((await call('/api/users', { name: 'sam', password: 'correct horse', role: 'admin' })).status, 201);
    assert.equal((await call('/api/auth/login', { name: 'sam', password: 'correct horse' })).status, 200);
    const r = await call('/api/setup/share', { on: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { restarting: true });
    assert.equal(restarts, 1);
    assert.match(fs.readFileSync(envFile, 'utf8'), /^OUTPOST_HOST=0\.0\.0\.0$/m);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  });

  it('keeps other settings when switching back to this Mac only', async () => {
    fs.appendFileSync(envFile, 'OUTPOST_PORT=9090\n');
    assert.equal((await call('/api/setup/share', { on: false })).status, 200);
    const text = fs.readFileSync(envFile, 'utf8');
    assert.match(text, /^OUTPOST_HOST=127\.0\.0\.1$/m);
    assert.match(text, /^OUTPOST_PORT=9090$/m);
    assert.equal(text.match(/OUTPOST_HOST/g)?.length, 1);
  });

  it('is for signed-in admins only', async () => {
    cookie = '';
    assert.equal((await call('/api/setup/share', { on: true })).status, 401);
  });
});
