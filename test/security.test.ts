import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { hostAllowed } from '../src/auth.js';
import { MAX_NOTES } from '../src/services/notes.js';
import { MAX_CHATS } from '../src/services/chats.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

/** A raw request, so the Host header is exactly what a browser would send (fetch doesn't let you set it). */
function raw(port: number, method: string, p: string, host: string, body?: unknown) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json' } }, (r) => {
      let text = '';
      r.on('data', (d) => (text += d));
      r.on('end', () => resolve({ status: r.statusCode!, headers: r.headers, text }));
    });
    q.on('error', reject);
    if (body) q.write(JSON.stringify(body));
    q.end();
  });
}

describe('security', () => {
  it('only answers to names this Mac really has', () => {
    for (const h of ['127.0.0.1:8080', 'localhost:8080', 'LOCALHOST', '[::1]:8080', '192.168.1.53:8443', 'my-mac.local:8080', `${os.hostname()}:8080`, 'outpost.example.org']) {
      assert.equal(hostAllowed(h, ['outpost.example.org']), true, h);
    }
    for (const h of ['evil.example:8080', 'evil.example', '127.0.0.1.evil.example', 'localhost.evil.example', '', undefined]) {
      assert.equal(hostAllowed(h, ['outpost.example.org']), false, String(h));
    }
  });

  describe('a fresh Outpost on this Mac (no sign-in)', () => {
    let h: string;
    let port: number;
    let s: http.Server;
    let ollama: http.Server;
    let home: string;
    before(async () => {
      h = await tmpHome();
      ollama = mockOllama();
      const op = await listen(ollama);
      const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
      home = made.ctx.cfg.home;
      s = http.createServer(made.app);
      port = await listen(s);
    });
    after(async () => {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    });

    it('refuses a web page that rebinds its own domain to this Mac (it could otherwise run commands)', async () => {
      const evil = `evil.example:${port}`;
      const add = await raw(port, 'POST', '/api/apps', evil, { id: 'pwn', name: 'pwn', command: '/usr/bin/true', port: 18999 });
      assert.equal(add.status, 421);
      assert.equal((await raw(port, 'GET', '/api/notes', evil)).status, 421);
      assert.equal((await raw(port, 'GET', '/api/emergency', evil)).status, 421);
      assert.equal((await raw(port, 'GET', '/', evil)).status, 421);
      assert.equal((await raw(port, 'GET', '/api/apps', `127.0.0.1:${port}`)).status, 200, 'its real address still works');
      assert.equal((await raw(port, 'GET', '/api/apps', `localhost:${port}`)).status, 200);
    });

    it("can't be framed by another site (no clickjacking onto Run it)", async () => {
      for (const p of ['/', '/api/status', '/login.html']) {
        const r = await raw(port, 'GET', p, `127.0.0.1:${port}`);
        assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN', p);
        assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'self'/, p);
      }
    });

    it('keeps the data folder private to its owner', () => {
      assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    });

    it('serves saved installers only as downloads, never as pages', async () => {
      const dir = path.join(home, 'files', 'Installers');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'trap.html'), '<script>alert(1)</script>');
      const r = await raw(port, 'GET', '/installers/trap.html', `127.0.0.1:${port}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-disposition'], 'attachment');
      assert.equal(r.headers['content-security-policy'], 'sandbox');
    });

    it('caps how many notes and saved conversations one person can keep', async () => {
      const notes = path.join(home, 'notes', 'outpost');
      const chats = path.join(home, 'chats', 'outpost');
      await fsp.mkdir(notes, { recursive: true });
      await fsp.mkdir(chats, { recursive: true });
      for (let i = 0; i < MAX_NOTES; i++) await fsp.writeFile(path.join(notes, `n${i}.md`), '# n');
      for (let i = 0; i < MAX_CHATS; i++) await fsp.writeFile(path.join(chats, `c${i}.json`), '{}');
      const note = await raw(port, 'POST', '/api/notes', `127.0.0.1:${port}`, { title: 'one more' });
      assert.equal(note.status, 409);
      const chat = await raw(port, 'PUT', '/api/chats/new-one', `127.0.0.1:${port}`, { messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(chat.status, 409);
      const edit = await raw(port, 'PUT', '/api/chats/c1', `127.0.0.1:${port}`, { messages: [{ role: 'user', content: 'still fine' }] });
      assert.equal(edit.status, 200, 'editing an existing conversation still works');
    });
  });
});

describe('shutdown', () => {
  it('lets only an admin stop Outpost, after answering', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
    let stops = 0;
    made.ctx.requestShutdown = () => void stops++;
    const s = http.createServer(made.app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    const cookies: Record<string, string> = {};
    const call = async (who: string, p: string, method = 'GET', json?: unknown) => {
      const r = await fetch(base + p, { method, headers: { ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) cookies[who] = set.split(';')[0]!;
      return r.status;
    };
    try {
      assert.equal(await call('owner', '/api/shutdown', 'POST'), 200, 'open mode: this Mac is the admin');
      await new Promise((r) => setTimeout(r, 450));
      assert.equal(stops, 1, 'stopped once the answer was sent');

      await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' });
      await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
      await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
      await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });
      assert.equal(await call('nobody', '/api/shutdown', 'POST'), 401);
      assert.equal(await call('ben', '/api/shutdown', 'POST'), 403, 'members cannot shut Outpost down');
      await new Promise((r) => setTimeout(r, 450));
      assert.equal(stops, 1);
      assert.equal(await call('anna', '/api/shutdown', 'POST'), 200);
      await new Promise((r) => setTimeout(r, 450));
      assert.equal(stops, 2);
    } finally {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});

describe('library look', () => {
  it("adds Outpost's stylesheet to the reader's own pages only, never to book articles", async () => {
    const { kiwixProxy } = await import('../src/proxy.js');
    const seen: Record<string, string | undefined> = {};
    const kiwix = http.createServer((req, res) => {
      seen[req.url!] = req.headers['accept-encoding'] as string | undefined;
      res.setHeader('Content-Type', req.url!.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8');
      res.end('<html><head><title>t</title></head><body>page</body></html>');
    });
    const kp = await listen(kiwix);
    const express = (await import('express')).default;
    const app = express();
    app.use('/kiwix', kiwixProxy(kp));
    const s = http.createServer(app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    try {
      const get = async (p: string) => (await fetch(base + p, { headers: { 'Accept-Encoding': 'gzip' } })).text();
      for (const p of ['/kiwix/', '/kiwix/viewer', '/kiwix/search?pattern=x']) {
        assert.match(await get(p), /<link rel="stylesheet" href="\/kiwix-skin.css"><\/head>/, p);
      }
      assert.equal(seen['/kiwix/'], undefined, 'asked uncompressed so it can be edited');
      for (const p of ['/kiwix/content/wikipedia_en/A/Water', '/kiwix/skin/logo.png']) {
        assert.doesNotMatch(await get(p), /kiwix-skin/, p);
      }
      assert.equal(seen['/kiwix/content/wikipedia_en/A/Water'], 'gzip', 'articles pass through untouched');
    } finally {
      s.close();
      kiwix.close();
    }
  });
});

describe('content address', () => {
  it('serves books, Education and apps only on their own origin, framed only by Outpost', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
    const s = http.createServer(made.app);
    const cs = http.createServer(made.content);
    const port = await listen(s);
    const cport = await listen(cs);
    try {
      // Outpost's own address no longer serves them: it forwards GETs to the content address and refuses the rest.
      for (const p of ['/kiwix/', '/kolibri/', '/apps/files/']) {
        const r = await raw(port, 'GET', p, `127.0.0.1:${port}`);
        assert.equal(r.status, 302, p);
        assert.equal(r.headers.location, `http://127.0.0.1:8090${p}`, p);
      }
      assert.equal((await raw(port, 'POST', '/apps/files/api/x', `127.0.0.1:${port}`)).status, 404);
      // The content address serves only them, and may be framed only by Outpost's own pages.
      const lib = await raw(cport, 'GET', '/kiwix/', `127.0.0.1:${cport}`);
      assert.equal(lib.status, 503, 'reader not running in this test, but served here');
      assert.equal(lib.headers['content-security-policy'], 'frame-ancestors http://127.0.0.1:8080 https://127.0.0.1:8443');
      assert.equal(lib.headers['x-frame-options'], undefined);
      assert.equal((await raw(cport, 'GET', '/api/notes', `127.0.0.1:${cport}`)).headers.location, 'http://127.0.0.1:8080/', 'no Outpost API here');
      assert.equal((await raw(cport, 'GET', '/kiwix/', `evil.example:${cport}`)).status, 421, 'same host check');
      // A page on the content address can't change things on Outpost: its Origin differs, so Outpost refuses.
      const cross = await new Promise<number>((resolve, reject) => {
        const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/apps', headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${cport}`, 'Content-Type': 'application/json' } }, (r) => {
          r.resume();
          resolve(r.statusCode!);
        });
        q.on('error', reject);
        q.end(JSON.stringify({ id: 'x', name: 'x', command: 'x', port: 18990 }));
      });
      assert.equal(cross, 403);
    } finally {
      s.close();
      cs.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
