import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { downloadOf, filterItems, groupOf, parseCatalog } from '../src/services/ready.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

const fixture = path.join(import.meta.dirname, 'fixtures');
const sample = async () => JSON.parse(await fsp.readFile(path.join(fixture, 'ready_gov_catalog.json'), 'utf8'));

describe('preparedness catalog', () => {
  it('reads the catalog shapes and keeps only safe file names and https links', async () => {
    const cat = parseCatalog(await sample());
    assert.equal(cat.items.length, 7, 'the item without a title is skipped');
    const by = Object.fromEntries(cat.items.map((it) => [it.id, it]));
    assert.equal(by['family-plan']!.file, 'family_plan.pdf');
    assert.equal(by['family-plan']!.group, 'plans');
    assert.equal(by.flood!.file, 'flood.pdf', 'a path is reduced to its name');
    assert.equal(by.quake!.file, null, 'not a PDF');
    assert.deepEqual(by.quake!.tags, ['shaking', 'drop cover hold']);
    assert.equal(by.kids!.group, 'youth');
    assert.equal(by.kids!.source, null, 'only https links are kept');
    assert.equal(by['flood-2']!.title, 'Flood duplicate', 'repeated ids get a suffix');
    const biz = cat.items.find((it) => it.title.startsWith('Business'))!;
    assert.equal(biz.group, 'business');
    assert.equal(biz.source, 'https://www.ready.gov/business');
    assert.equal(cat.items.find((it) => it.title === 'Pets and animals')!.group, 'specialized');
    assert.deepEqual(cat.categories.find((c) => c.name === 'Hazards'), { name: 'Hazards', group: 'hazards', count: 3 });
    assert.deepEqual(parseCatalog([{ title: 'Only one' }]).items.map((it) => it.category), ['Other']);
    assert.deepEqual(parseCatalog(null).items, []);
    assert.deepEqual(parseCatalog('nonsense').items, []);
  });

  it('groups and filters', async () => {
    assert.equal(groupOf('Hazard information sheets'), 'hazards');
    assert.equal(groupOf('Misc', ['teen']), 'youth');
    assert.equal(groupOf('Misc', [], 'Business'), 'business');
    assert.equal(groupOf('Misc'), null);
    const { items } = parseCatalog(await sample());
    assert.deepEqual(filterItems(items, { group: 'hazards' }).map((it) => it.id), ['flood', 'quake', 'flood-2']);
    assert.deepEqual(filterItems(items, { q: 'FLOOD after' }).map((it) => it.id), ['flood'], 'every word must match');
    assert.deepEqual(filterItems(items, { group: 'youth', q: 'flood' }), []);
    assert.equal(filterItems(items, { q: '  ' }).length, items.length);
  });

  it('accepts download links only over https from ready.gov or fema.gov, and only PDFs', () => {
    assert.equal(downloadOf({ download: 'https://www.ready.gov/a/b.pdf' }), 'https://www.ready.gov/a/b.pdf');
    assert.equal(downloadOf({ pdf_url: 'https://fema.gov/x.PDF' }), 'https://fema.gov/x.PDF');
    assert.equal(downloadOf({ download: 'http://www.ready.gov/a.pdf' }), null);
    assert.equal(downloadOf({ download: 'https://evil.example/a.pdf' }), null);
    assert.equal(downloadOf({ download: 'https://ready.gov.evil.example/a.pdf' }), null);
    assert.equal(downloadOf({ download: 'https://me@www.ready.gov/a.pdf' }), null);
    assert.equal(downloadOf({ download: 'https://www.ready.gov:8443/a.pdf' }), null);
    assert.equal(downloadOf({ download: 'https://www.ready.gov/a.html' }), null);
    assert.equal(downloadOf({ download: 'not a url' }), null);
  });

  it('serves only listed PDFs from docs/ready, to signed-in people', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
    const s = http.createServer(made.app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    let cookie = '';
    const call = async (p: string, method = 'GET', json?: unknown) => {
      const r = await fetch(base + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return r;
    };
    try {
      const ready = path.join(h, 'docs', 'ready');
      assert.equal((await call('/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' })).status, 201);
      await call('/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });

      const builtin = (await (await call('/api/ready')).json()) as { builtin: boolean; items: { download: string; file: string; have: boolean }[] };
      assert.equal(builtin.builtin, true, 'no catalog file: the list that ships with Outpost');
      assert.equal(builtin.items.length, 45);
      assert.ok(builtin.items.every((it) => it.download.startsWith('https://www.ready.gov/') && it.file.endsWith('.pdf') && !it.have));
      assert.equal((await call('/api/ready/pull', 'POST', {})).status, 400, 'say which');
      assert.equal((await call('/api/ready/pull', 'POST', { ids: ['nope'] })).status, 404);
      assert.equal((await call('/api/ready/pull', 'POST', { ids: [1] })).status, 400);
      await fsp.copyFile(path.join(fixture, 'ready_gov_catalog.json'), path.join(h, 'ready_gov_catalog.json'));
      assert.equal((await call('/api/ready/file/flood.pdf')).status, 404, 'listed but not downloaded');
      await fsp.mkdir(ready, { recursive: true });
      await fsp.copyFile(path.join(fixture, 'firstaid.pdf'), path.join(ready, 'flood.pdf'));
      await fsp.copyFile(path.join(fixture, 'firstaid.pdf'), path.join(ready, 'unlisted.pdf'));
      await fsp.writeFile(path.join(h, 'secret.pdf'), '%PDF-1.4 secret');
      await fsp.symlink(path.join(h, 'secret.pdf'), path.join(ready, 'kids.pdf'));

      const list = (await (await call('/api/ready')).json()) as { found: boolean; items: { id: string; have: boolean; size: number | null }[] };
      assert.equal(list.found, true);
      const flood = list.items.find((it) => it.id === 'flood')!;
      assert.equal(flood.have, true);
      assert.ok(flood.size! > 0);
      assert.equal(list.items.find((it) => it.id === 'family-plan')!.have, false);
      const pulled = await call('/api/ready/pull', 'POST', { ids: ['flood', 'family-plan'] });
      assert.equal(pulled.status, 202);
      assert.deepEqual(await pulled.json(), { jobs: [] }, 'already here, or no download link');

      const open = await call('/api/ready/file/flood.pdf');
      assert.equal(open.status, 200);
      assert.equal(open.headers.get('content-type'), 'application/pdf');
      assert.match(open.headers.get('content-disposition')!, /^inline; filename="flood.pdf"/);
      assert.equal((await open.arrayBuffer()).byteLength, flood.size);
      const dl = await call('/api/ready/file/flood.pdf?download=1');
      assert.match(dl.headers.get('content-disposition')!, /^attachment; filename="flood.pdf"/);
      await dl.arrayBuffer();

      assert.equal((await call('/api/ready/file/unlisted.pdf')).status, 404, 'not in the catalog');
      assert.equal((await call('/api/ready/file/kids.pdf')).status, 404, 'a link pointing out of docs/ready');
      assert.equal((await call('/api/ready/file/..%2Fsecret.pdf')).status, 400);
      assert.equal((await call('/api/ready/file/..%2F..%2Fready_gov_catalog.json')).status, 400);
      assert.equal((await call('/api/ready/file/flood.txt')).status, 400, 'PDFs only');
      assert.notEqual((await call('/api/ready/file/flood.pdf', 'DELETE')).status, 200, 'read-only');

      cookie = '';
      assert.equal((await call('/api/ready')).status, 401, 'signed-out people get nothing');
      assert.equal((await call('/api/ready/pull', 'POST', { all: true })).status, 401);
      assert.equal((await call('/api/ready/file/flood.pdf')).status, 401);
    } finally {
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
