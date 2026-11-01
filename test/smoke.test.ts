import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { foldersOverlap, loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { parseCatalog, parseCategories, parseLanguages } from '../src/services/catalog.js';
import { chunkText } from '../src/services/rag.js';
import { safeFileName } from '../src/util.js';
import { BIG, embedSeen, held, remoteCalls, embedStats, fakeEmbed, freePort, here, lastChatBody, listen, makeExecutable, mockFiles, mockOllama, mockOpenAi, openAiSeen, tmpHome, waitFor, CONTENT_PATH } from './helpers.js';

let base = '';
let contentServer: http.Server;
let contentUrl: string;
let home = '';
let filesBase = '';
let server: http.Server;
let ctxRef: Awaited<ReturnType<typeof createApp>>['ctx'];
const closers: Array<() => unknown> = [];

async function api(p: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const post = (p: string, body: unknown) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  home = await tmpHome();
  const bin = path.join(home, 'bin');
  await fsp.mkdir(bin);
  makeExecutable(path.join(here, 'fixtures/fake-kiwix.mjs'), path.join(bin, 'kiwix-serve'));
  makeExecutable(path.join(here, 'fixtures/fake-pmtiles.mjs'), path.join(bin, 'pmtiles'));
  const ollama = mockOllama();
  const ollamaPort = await listen(ollama);
  const files = mockFiles();
  const filesPort = await listen(files);
  filesBase = `http://127.0.0.1:${filesPort}`;
  closers.push(() => ollama.close(), () => files.close());
  const cfg = loadConfig({
    OUTPOST_HOME: path.join(home, 'data'),
    OUTPOST_KIWIX_BIN: path.join(bin, 'kiwix-serve'),
    OUTPOST_PMTILES_BIN: path.join(bin, 'pmtiles'),
    OUTPOST_KIWIX_PORT: String(await freePort()),
    OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
    OUTPOST_CATALOG_URL: `${filesBase}/catalog/v2`,
  });
  const { app, content, ctx } = await createApp(cfg);
  ctxRef = ctx;
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
  contentServer = http.createServer(content);
  contentUrl = `http://127.0.0.1:${await listen(contentServer)}`;
});

after(async () => {
  await ctxRef.kiwix.stop();
  server.close();
  contentServer.close();
  closers.forEach((c) => c());
  await fsp.rm(home, { recursive: true, force: true });
});

describe('helpers', () => {
  it('safeFileName blocks traversal and wrong extensions', () => {
    assert.equal(safeFileName('../../etc/passwd', ['.zim']), null);
    assert.equal(safeFileName('a/b/wiki.zim', ['.zim']), null);
    assert.equal(safeFileName('wiki.zim', ['.zim']), 'wiki.zim');
    assert.equal(safeFileName('.hidden.zim', ['.zim']), null);
    assert.equal(safeFileName('wiki.exe', ['.zim']), null);
  });
  it('parseCatalog extracts zim url (stripping .meta4), size and skips entries without a link', () => {
    const e = parseCatalog(`<feed><entry><title>T &amp; U</title><name>n</name><link type="application/x-zim" href="https://x.org/a/b.zim.meta4" length="99"/></entry><entry><title>x</title></entry></feed>`);
    assert.equal(e.length, 1);
    assert.equal(e[0]!.url, 'https://x.org/a/b.zim');
    assert.equal(e[0]!.size, 99);
    assert.equal(e[0]!.title, 'T & U');
    assert.equal(e[0]!.fileName, 'b.zim');
  });
  it('parseCatalog reads a real feed captured from opds.library.kiwix.org', () => {
    const xml = fs.readFileSync(new URL('./fixtures/kiwix-opds-sample.xml', import.meta.url), 'utf8');
    const e = parseCatalog(xml);
    assert.equal(e.length, 3);
    assert.deepEqual(e[0], {
      id: 'urn:uuid:bfa1e3b6-1ede-5d20-d4a8-c3a331c1b7e7',
      title: 'Medicine LibreTexts',
      name: 'libretexts.org_en_med', // the entry's own <name>, not <author> or <publisher>
      description: 'Medicine courses and bookshelves from LibreTexts.org',
      language: 'eng',
      size: 1192567808,
      url: 'https://lb.download.kiwix.org/zim/libretexts/libretexts.org_en_med_2025-01.zim',
      fileName: 'libretexts.org_en_med_2025-01.zim',
      updated: '2025-01-16T00:00:00Z',
      flavour: '',
      category: '',
      tags: 'medicine;_ftindex:no;_pictures:yes;_videos:yes;_details:yes',
      articleCount: 23171,
    });
    assert.equal(e[1]!.category, 'other');
    assert.equal(e[2]!.language.split(',')[0], 'eng');
  });
  it('parseCatalog returns nothing for an empty or malformed feed', () => {
    assert.deepEqual(parseCatalog('<feed></feed>'), []);
    assert.deepEqual(parseCatalog('not xml at all'), []);
  });
  it('foldersOverlap catches nesting regardless of case (macOS disks ignore case)', () => {
    assert.equal(foldersOverlap('/Users/a/outpost', '/Users/a/Outpost'), true);
    assert.equal(foldersOverlap('/Users/a/Outpost/src', '/Users/a/outpost'), true);
    assert.equal(foldersOverlap('/Users/a/Developer/outpost', '/Users/a/Outpost'), false);
    assert.equal(foldersOverlap('/Users/a/Outpost2', '/Users/a/Outpost'), false);
  });
  it('chunkText splits long text with bounded chunk size', () => {
    const chunks = chunkText(Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join('\n\n'));
    assert.ok(chunks.length > 5);
    assert.ok(chunks.every((c) => c.length <= 1200));
  });
});

describe('status', () => {
  it('reports services and storage', async () => {
    const { status, json } = await api('/api/status');
    assert.equal(status, 200);
    assert.equal(json.services.ai.reachable, true);
    assert.equal(json.services.education.state, 'not-installed');
    assert.equal(json.services.library.state, 'idle');
    assert.equal(json.binaries.pmtiles, true);
    assert.ok(json.storage.free > 0);
  });
});

describe('notes', () => {
  it('creates, edits, lists and deletes; rejects bad ids', async () => {
    const created = await post('/api/notes', { title: 'Water Plan' });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    assert.equal(id, 'water-plan');
    const put = await api(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '# Water Plan\n\nStore 4L/person/day' }) });
    assert.equal(put.status, 200);
    assert.equal((await api(`/api/notes/${id}`)).json.content.includes('4L'), true);
    assert.equal((await api('/api/notes')).json.notes[0].title, 'Water Plan');
    assert.equal((await api('/api/notes/..%2F..%2Fx')).status, 400);
    assert.equal((await api(`/api/notes/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(`/api/notes/${id}`)).status, 404);
  });
});

describe('library + downloads', () => {
  it('searches the catalog', async () => {
    const { status, json } = await api('/api/library/catalog?q=wiki&lang=eng');
    assert.equal(status, 200);
    assert.equal(json.entries.length, 1);
    assert.equal(json.entries[0].fileName, 'wikipedia_en_all_mini_2026-01.zim');
  });

  it('downloads a ZIM, starts the reader and proxies it', async () => {
    const { status, json } = await post('/api/jobs/download', { url: `${filesBase}/big.zim`, kind: 'zim' });
    assert.equal(status, 202);
    const job = await waitFor(async () => {
      const j = (await api('/api/jobs')).json.jobs.find((x: any) => x.id === json.job.id);
      return j.status !== 'running' ? j : false;
    });
    assert.equal(job.status, 'done', job.error);
    assert.equal((await fsp.stat(path.join(home, 'data/zim/big.zim'))).size, BIG.length);
    const page = await waitFor(async () => {
      const r = await fetch(`${contentUrl}/kiwix/`);
      return r.status === 200 ? r.text() : false;
    });
    assert.match(page, /FAKE KIWIX zims=1 path=\/kiwix\//);
    assert.ok(page.includes(`--attachToProcess=${process.pid}`), 'kiwix-serve must exit when Outpost does');
    assert.ok(page.includes('--address 127.0.0.1'), 'kiwix-serve must bind to loopback only');
    assert.equal((await api('/api/library')).json.files[0].name, 'big.zim');
  });

  it('resumes a partial download', async () => {
    const dest = path.join(home, 'data/zim/resume.zim');
    await fsp.writeFile(`${dest}.part`, BIG.subarray(0, 100_000));
    const { json } = await post('/api/jobs/download', { url: `${filesBase}/big.zim`, kind: 'zim', name: 'resume.zim' });
    await waitFor(async () => (await api('/api/jobs')).json.jobs.find((x: any) => x.id === json.job.id).status !== 'running');
    assert.deepEqual(await fsp.readFile(dest), BIG);
  });

  it('rejects bad download requests', async () => {
    assert.equal((await post('/api/jobs/download', { url: 'file:///etc/passwd', kind: 'zim' })).status, 400);
    assert.equal((await post('/api/jobs/download', { url: `${filesBase}/x.exe`, kind: 'zim' })).status, 400);
    assert.equal((await post('/api/jobs/download', { url: `${filesBase}/a.zim`, kind: 'bogus' })).status, 400);
  });

  it('reports failed downloads as error jobs', async () => {
    const { json } = await post('/api/jobs/download', { url: `${filesBase}/missing.zim`, kind: 'zim' });
    const job = await waitFor(async () => {
      const j = (await api('/api/jobs')).json.jobs.find((x: any) => x.id === json.job.id);
      return j.status !== 'running' ? j : false;
    });
    assert.equal(job.status, 'error');
    assert.match(job.error, /404/);
  });

  it('uploads and deletes a ZIM; reader stops when empty', async () => {
    for (const f of ['big.zim', 'resume.zim']) await api(`/api/library/${f}`, { method: 'DELETE' });
    const up = await api('/api/library/upload/mine.zim', { method: 'PUT', body: Buffer.from('zimdata') });
    assert.equal(up.status, 200);
    assert.equal((await api('/api/library')).json.files.length, 1);
    await api('/api/library/mine.zim', { method: 'DELETE' });
    const lib = (await api('/api/library')).json;
    assert.equal(lib.files.length, 0);
    assert.equal(lib.kiwix.state, 'idle');
    assert.equal((await fetch(`${contentUrl}/kiwix/`)).status, 503);
    assert.equal((await api('/api/library/..%2Fx.zim', { method: 'DELETE' })).status, 400);
  });
});

describe('maps', () => {
  it('extracts a region, serves it with Range, deletes it', async () => {
    const bad = await post('/api/maps/extract', { source: `${filesBase}/p.pmtiles`, name: 'x.pmtiles', bbox: [10, 10, 5, 20] });
    assert.equal(bad.status, 400);
    const { status, json } = await post('/api/maps/extract', { source: `${filesBase}/p.pmtiles`, name: 'city.pmtiles', bbox: [35.1, 33.0, 36.0, 34.0], maxzoom: 10 });
    assert.equal(status, 202);
    const job = await waitFor(async () => {
      const j = (await api('/api/jobs')).json.jobs.find((x: any) => x.id === json.job.id);
      return j.status !== 'running' ? j : false;
    });
    assert.equal(job.status, 'done', job.error);
    assert.equal((await api('/api/maps')).json.files[0].name, 'city.pmtiles');
    const ranged = await fetch(`${base}/api/maps/files/city.pmtiles`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.text()).length, 10);
    assert.equal((await fetch(`${base}/api/maps/files/..%2F..%2Fsecret.pmtiles`)).status, 400);
    assert.equal((await api('/api/maps/city.pmtiles', { method: 'DELETE' })).status, 200);
  });
});

describe('ai', () => {
  it('lists models and streams a pull', async () => {
    const m = (await api('/api/ai/models')).json;
    assert.equal(m.reachable, true);
    assert.equal(m.models[0].name, 'llama3.2:3b');
    assert.deepEqual(
      m.models.map((x: { name: string; embedding: boolean }) => [x.name, x.embedding]),
      [['llama3.2:3b', false], ['nomic-embed-text:latest', true], ['mxbai-embed-large:latest', true]],
    );
    const st = (await api('/api/status')).json;
    assert.equal(st.services.ai.models, 1, 'embedding models are not chat models');
    const res = await post('/api/ai/pull', { name: 'llama3.2:3b' });
    assert.match(typeof res.json === 'string' ? res.json : JSON.stringify(res.json), /success/);
    assert.equal((await post('/api/ai/pull', { name: 'bad name; rm -rf' })).status, 400);
  });

  it('indexes documents and injects the best excerpt into chat', async () => {
    const add = (name: string, text: string) => api(`/api/ai/docs?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
    assert.equal((await add('water.md', 'Boil water for three minutes to make it safe. Store water in clean containers.')).status, 201);
    assert.equal((await add('fire.md', 'Build a fire with tinder, kindling and fuel wood in a sheltered spot.')).status, 201);
    assert.equal((await add('photo.png', 'binary')).status, 415);
    assert.equal((await api('/api/ai/docs')).json.docs.length, 2);

    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:3b', useDocs: true, messages: [{ role: 'user', content: 'How long should I boil water?' }] }),
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].sources[0].doc, 'water.md');
    assert.equal(lines.map((l: any) => l.message?.content ?? '').join(''), 'Hello');
    // Instructions in the system message; excerpts in the latest question (small models follow that far better).
    assert.equal(lastChatBody.value.messages[0].role, 'system');
    assert.doesNotMatch(lastChatBody.value.messages[0].content, /Boil water/);
    const last = lastChatBody.value.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.match(last.content, /^Excerpts from my documents:[\s\S]*\(water\.md\)\nBoil water for three minutes[\s\S]*Question: How long should I boil water\?$/);

    const id = (await api('/api/ai/docs')).json.docs[0].id;
    assert.equal((await api(`/api/ai/docs/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api('/api/ai/docs')).json.docs.length, 1);
  });

  it('reads text from PDFs, refuses scans and non-PDFs', async () => {
    const pdf = (name: string, body: Uint8Array | string) =>
      api(`/api/ai/docs?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body });
    const fixture = (f: string) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

    const ok = await pdf('firstaid.pdf', fixture('firstaid.pdf'));
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.ok(ok.json.chars > 100);
    const res = await post('/api/ai/chat', { model: 'llama3.2:3b', useDocs: true, messages: [{ role: 'user', content: 'How long do I boil water above 2000 metres?' }] });
    assert.equal(JSON.parse(String(res.json).split('\n')[0] ?? JSON.stringify(res.json)).sources[0].doc, 'firstaid.pdf');
    assert.match(lastChatBody.value.messages.at(-1).content, /boil it for three\s+minutes/);

    const scan = await pdf('scan.pdf', fixture('scanned.pdf'));
    assert.equal(scan.status, 422);
    assert.match(scan.json.error, /^No text found\. This looks like a scanned PDF\./);

    const fake = await pdf('notes.pdf', 'just some text pretending');
    assert.equal(fake.status, 400);
    assert.match(fake.json.error, /isn't a readable PDF/);
    assert.ok(!(await api('/api/ai/docs')).json.docs.some((d: any) => d.name === 'scan.pdf' || d.name === 'notes.pdf'));
  });

  it('refuses PDFs over the size limit before reading them', async () => {
    const h = await tmpHome();
    const { app, ctx } = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OUTPOST_PDF_MAX_MB: '0.01' }));
    const s = http.createServer(app);
    try {
      const u = `http://127.0.0.1:${await listen(s)}`;
      const r = await fetch(`${u}/api/ai/docs?name=big.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: fs.readFileSync(new URL('./fixtures/firstaid.pdf', import.meta.url)) });
      assert.equal(r.status, 413);
      assert.match((await r.json()).error, /limit is 0\.01 MB.*OUTPOST_PDF_MAX_MB/);
    } finally {
      await ctx.kiwix.stop();
      s.closeAllConnections();
      s.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });

  it('chat without docs sends messages untouched', async () => {
    const res = await post('/api/ai/chat', { model: 'llama3.2:3b', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(lastChatBody.value.messages.length, 1);
    assert.equal((await post('/api/ai/chat', { model: '', messages: [] })).status, 400);
  });
});

/** An Outpost with its own data folder and fake Ollama, for tests that need a clean slate. */
async function isolatedApp(env: Record<string, string>, seed?: (h: string) => Promise<void>) {
  const h = await tmpHome();
  if (seed) await seed(h);
  const ollama = mockOllama();
  const op = await listen(ollama);
  const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, ...env }));
  const s = http.createServer(made.app);
  const u = `http://127.0.0.1:${await listen(s)}`;
  const cs = http.createServer(made.content);
  const cu = `http://127.0.0.1:${await listen(cs)}`;
  const call = async (p: string, init?: RequestInit) => {
    const r = await fetch((CONTENT_PATH.test(p) ? cu : u) + p, init);
    const t = await r.text();
    return { status: r.status, headers: r.headers, json: (() => { try { return JSON.parse(t); } catch { return t; } })() };
  };
  const close = async () => {
    await made.ctx.kiwix.stop();
    await made.ctx.kolibri.stop(false);
    s.closeAllConnections();
    s.close();
    cs.closeAllConnections();
    cs.close();
    ollama.close();
    await fsp.rm(h, { recursive: true, force: true });
  };
  return { h, call, close };
}

describe('document index', () => {
  const unit = (v: number[]) => {
    const n = Math.hypot(...v) || 1;
    return v.map((x) => Math.round((x / n) * 1e5) / 1e5);
  };
  const addDoc = (call: any, name: string, text: string) => call(`/api/ai/docs?name=${name}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
  const ask = (call: any, q: string) =>
    call('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3.2:3b', useDocs: true, messages: [{ role: 'user', content: q }] }) });
  const firstLine = (r: { json: any }) => (typeof r.json === 'string' ? JSON.parse(r.json.split('\n')[0]) : r.json);

  it('reports index size against a documented limit and refuses documents that would not fit', async () => {
    const app = await isolatedApp({ OUTPOST_RAG_MAX_CHUNKS: '3' });
    try {
      assert.equal((await addDoc(app.call, 'small.md', 'Boil water for three minutes.')).status, 201);
      const list = (await app.call('/api/ai/docs')).json;
      assert.equal(list.index.chunks, 1);
      assert.equal(list.index.maxChunks, 3);
      assert.ok(list.index.bytes > 0);
      assert.equal(list.docs[0].current, true);
      const big = Array.from({ length: 6 }, (_, i) => `Section ${i} ${'word '.repeat(170)}`).join('\n\n');
      const r = await addDoc(app.call, 'big.md', big);
      assert.equal(r.status, 413);
      assert.match(r.json.error, /room for 2 more.*OUTPOST_RAG_MAX_CHUNKS/);
      assert.equal((await app.call('/api/ai/docs')).json.docs.length, 1);
    } finally {
      await app.close();
    }
  });

  it('migrates the old single-file index, keeps it searchable, and re-indexes resumably', async () => {
    // An index written by the previous version: one JSON file, vectors without nomic's task prefixes.
    const texts = Array.from({ length: 40 }, (_, i) => (i === 7 ? 'Boil water for three minutes above 2000 metres.' : `Filler paragraph number ${i} about rope knots.`));
    const app = await isolatedApp({}, async (h) => {
      await fsp.mkdir(path.join(h, 'rag'), { recursive: true });
      await fsp.mkdir(path.join(h, 'docs'), { recursive: true });
      const v1 = {
        embedModel: 'nomic-embed-text',
        docs: [
          { id: 'aaaaaaaaaa', name: 'water.md', chars: 999, chunks: 40, added: 1 },
          { id: 'bbbbbbbbbb', name: 'fire.md', chars: 50, chunks: 1, added: 2 },
        ],
        chunks: [
          ...texts.map((t) => ({ d: 'aaaaaaaaaa', t, v: unit(fakeEmbed(t)) })),
          { d: 'bbbbbbbbbb', t: 'Build a fire with tinder.', v: unit(fakeEmbed('Build a fire with tinder.')) },
        ],
      };
      await fsp.writeFile(path.join(h, 'rag', 'index.json'), JSON.stringify(v1));
    });
    try {
      let list = (await app.call('/api/ai/docs')).json;
      assert.deepEqual(list.docs.map((d: any) => [d.name, d.chunks, d.current]), [['water.md', 40, false], ['fire.md', 1, false]]);
      assert.equal(list.index.stale, 2);
      assert.equal(list.index.chunks, 41);
      assert.ok(!fs.existsSync(path.join(app.h, 'rag', 'index.json')), 'old index file replaced');
      // Still searchable before re-indexing: the query is embedded the way those documents were.
      assert.equal(firstLine(await ask(app.call, 'How long to boil water above 2000 metres?')).sources[0].doc, 'water.md');

      // First attempt dies part-way (after 2 batches of 16).
      embedStats.inputs = 0;
      embedStats.failAfter = 32;
      let job = (await app.call('/api/ai/docs/reindex', { method: 'POST' })).json.job;
      assert.equal(job.kind, 'reindex');
      job = await waitFor(async () => {
        const j = (await app.call('/api/jobs')).json.jobs.find((x: any) => x.id === job.id);
        return j.status !== 'running' && j;
      });
      assert.equal(job.status, 'error');
      assert.match(job.error, /fake embed failure/);
      assert.equal(embedStats.inputs, 32);
      list = (await app.call('/api/ai/docs')).json;
      assert.equal(list.index.stale, 2, 'nothing switches over until a document is complete');

      // Second attempt resumes: only the 8 + 1 remaining parts are embedded.
      embedStats.failAfter = Infinity;
      job = (await app.call('/api/ai/docs/reindex', { method: 'POST' })).json.job;
      job = await waitFor(async () => {
        const j = (await app.call('/api/jobs')).json.jobs.find((x: any) => x.id === job.id);
        return j.status !== 'running' && j;
      });
      assert.equal(job.status, 'done', job.error);
      assert.equal(job.received, 41);
      assert.equal(embedStats.inputs, 41, 'each part embedded once (32 + 9)');
      list = (await app.call('/api/ai/docs')).json;
      assert.equal(list.index.stale, 0);
      assert.ok(list.docs.every((d: any) => d.current));
      assert.equal(firstLine(await ask(app.call, 'How long to boil water above 2000 metres?')).sources[0].doc, 'water.md');
      assert.ok(!fs.readdirSync(path.join(app.h, 'rag')).some((f) => f.endsWith('.part')), 'no partial files left');
      assert.equal((await app.call('/api/ai/docs/reindex', { method: 'POST' })).status, 409, 'nothing left to re-index');
    } finally {
      embedStats.failAfter = Infinity;
      await app.close();
    }
  });

  it('prefixes nomic-embed-text inputs as the model expects', async () => {
    const app = await isolatedApp({});
    try {
      await addDoc(app.call, 'a.md', 'Purify water with tablets.');
      await ask(app.call, 'water tablets?');
      const seen = embedSeen.slice(-2);
      assert.match(seen[0]!, /^search_document: Purify water/);
      assert.match(seen[1]!, /^search_query: water tablets/);
    } finally {
      await app.close();
    }
  });
});

describe('library browser', () => {
  it('parses the real language and category lists', () => {
    const langs = parseLanguages(fs.readFileSync(new URL('./fixtures/kiwix-languages.xml', import.meta.url), 'utf8'));
    assert.deepEqual(langs.find((l) => l.code === 'ara'), { code: 'ara', name: 'العربية', count: 438 });
    assert.deepEqual(langs.find((l) => l.code === 'eng'), { code: 'eng', name: 'English', count: 1309 });
    const cats = parseCategories(fs.readFileSync(new URL('./fixtures/kiwix-categories.xml', import.meta.url), 'utf8'));
    assert.ok(cats.includes('wikipedia') && cats.includes('iFixit') && cats.includes('stack_exchange'));
    assert.ok(!cats.includes('List of categories'));
  });

  it('filters by category and size, pages through results, and marks what is installed', async () => {
    const app = await isolatedApp({ OUTPOST_CATALOG_URL: `${filesBase}/catalog/v2` }, async (h) => {
      await fsp.mkdir(path.join(h, 'zim'), { recursive: true });
      await fsp.writeFile(path.join(h, 'zim', 'book_b_2026-01.zim'), 'x'); // this exact file
      await fsp.writeFile(path.join(h, 'zim', 'book_a_nopic_2025-06.zim'), 'x'); // an older copy
    });
    try {
      const r = await app.call('/api/library/catalog?category=fakecat&lang=&maxSize=5000&count=2');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.total, 3, 'books in the category before the size filter');
      assert.deepEqual(r.json.entries.map((e: any) => [e.name, e.flavour, e.installed, e.olderVersion]), [['book_a', 'nopic', false, 'book_a_nopic_2025-06.zim']]);
      assert.equal(r.json.nextStart, 2);
      assert.ok(r.json.free > 0);
      const page2 = await app.call('/api/library/catalog?category=fakecat&lang=&maxSize=5000&count=2&start=2');
      assert.deepEqual(page2.json.entries.map((e: any) => [e.name, e.installed]), [['book_b', true]]);
      assert.equal(page2.json.nextStart, null);
      assert.equal((await app.call('/api/library/catalog?maxSize=abc')).status, 400);
    } finally {
      await app.close();
    }
  });

  it('lists languages and categories from the catalog', async () => {
    const r = await api('/api/library/catalog/filters');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.languages.find((l: any) => l.code === 'fra').name, 'français');
    assert.ok(r.json.categories.includes('wikivoyage'));
  });

  it('refuses a download that will not fit before writing anything', async () => {
    const { json } = await post('/api/jobs/download', { url: `${filesBase}/huge.zim`, kind: 'zim' });
    const job = await waitFor(async () => {
      const j = (await api('/api/jobs')).json.jobs.find((x: any) => x.id === json.job.id);
      return j.status !== 'running' && j.status !== 'queued' && j;
    });
    assert.equal(job.status, 'error');
    assert.match(job.error, /^Not enough space: huge\.zim needs .* but only .* is free/);
    assert.ok(!fs.existsSync(path.join(home, 'data', 'zim', 'huge.zim.part')), 'no partial file left');
  });
});

describe('first-run setup', () => {
  const env = () => ({
    OUTPOST_CATALOG_URL: `${filesBase}/catalog/v2`,
    OUTPOST_COLLECTIONS_FILE: path.join(here, 'fixtures/collections.json'),
    OUTPOST_MAP_BUILDS_URL: `${filesBase}/builds.json`,
    OUTPOST_KIWIX_BIN: path.join(home, 'bin', 'kiwix-serve'),
    OUTPOST_PMTILES_BIN: path.join(home, 'bin', 'pmtiles'),
  });
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const settle = (call: any, ids: string[]) =>
    waitFor(async () => {
      const all = (await call('/api/jobs')).json.jobs;
      const jobs = ids.map((id) => all.find((j: any) => j.id === id)).filter(Boolean);
      return jobs.length === ids.length && jobs.every((j: any) => !['running', 'queued'].includes(j.status)) && jobs;
    }, 15_000);

  it('offers a Wikipedia size and a level per topic with live sizes, dropping books the catalog no longer has', async () => {
    const app = await isolatedApp(env());
    try {
      const r = await app.call('/api/setup');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.show, true, 'nothing installed yet');
      assert.deepEqual((await app.call('/api/setup/status')).json, { show: true });
      const basics = r.json.topics.find((t: any) => t.id === 'basics');
      assert.deepEqual(basics.levels.map((l: any) => l.id), ['basic', 'extended'], 'a level that adds nothing the catalog still has is hidden');
      const [basic, extended] = basics.levels;
      assert.deepEqual(basic.books.map((b: any) => [b.name, b.flavour, b.size, b.installed]), [['book_a', 'nopic', 3000, false]]);
      assert.deepEqual(extended.books.map((b: any) => [b.name, b.flavour, b.size]), [['book_a', 'nopic', 3000], ['book_b', '', 2000]], 'a level includes the ones before it');
      assert.deepEqual([basic.size, extended.size], [3000, 5000]);
      assert.ok(!r.json.topics.some((t: any) => t.id === 'gone'), 'a topic with no books left is hidden');
      assert.deepEqual(r.json.wikipedia.map((w: any) => [w.id, w.choice, w.name, w.flavour, w.size]), [['small', 'Small', 'book_a', 'maxi', 9000]]);
      assert.deepEqual(r.json.dropped, ['book_c (maxi)']);
      assert.deepEqual(r.json.models.map((m: any) => [m.name, m.installed]), [['tiny:1b', false], ['nomic-embed-text', true]]);
      assert.equal(r.json.canPullModels, true);
      assert.ok(r.json.free > 0);
    } finally {
      await app.close();
    }
  });

  it('estimates a map region with pmtiles --dry-run on the newest Protomaps build', async () => {
    const app = await isolatedApp(env());
    try {
      const r = await app.call('/api/setup/map-estimate', json({ bbox: [5.9, 45.8, 10.5, 47.8], maxzoom: 12 }));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.bytes, 12.5e6);
      assert.equal(r.json.source, `${filesBase}/20260101.pmtiles`);
      assert.equal((await app.call('/api/setup/map-estimate', json({ bbox: [10, 0, 5, 1] }))).status, 400);
    } finally {
      await app.close();
    }
  });

  it('queues the chosen books, map and models, refuses what will not fit, then stops offering itself', async () => {
    const app = await isolatedApp(env());
    try {
      assert.equal((await app.call('/api/setup/start', json({ topics: { nope: 'basic' } }))).status, 400);
      assert.equal((await app.call('/api/setup/start', json({ topics: { basics: 'everything' } }))).status, 400);
      assert.equal((await app.call('/api/setup/start', json({ topics: { gone: 'basic' } }))).status, 400, 'hidden topics cannot be chosen');
      assert.equal((await app.call('/api/setup/start', json({ wikipedia: 'gone' }))).status, 400);
      const huge = await app.call('/api/setup/start', json({ topics: { huge: 'basic' } }));
      assert.equal(huge.status, 507);
      assert.match(huge.json.error, /needs .* but only .* free/);

      const r = await app.call('/api/setup/start', json({ topics: { basics: 'extended' }, wikipedia: 'small', map: { preset: 'world' }, models: ['tiny:1b', 'nomic-embed-text'] }));
      assert.equal(r.status, 202, JSON.stringify(r.json));
      assert.deepEqual(r.json.jobs.map((j: any) => j.kind).sort(), ['download', 'download', 'download', 'map-extract', 'model-pull'], 'installed models are skipped');
      const done = await settle(app.call, r.json.jobs.map((j: any) => j.id));
      assert.ok(done.every((j: any) => j.status === 'done'), JSON.stringify(done));
      assert.deepEqual(fs.readdirSync(path.join(app.h, 'zim')).sort(), ['book_a_maxi_2026-01.zim', 'book_a_nopic_2026-01.zim', 'book_b_2026-01.zim']);
      assert.ok(fs.existsSync(path.join(app.h, 'maps', 'world.pmtiles')));
      assert.match(fs.readFileSync(path.join(app.h, 'maps', 'world.pmtiles'), 'utf8'), /20260101\.pmtiles --bbox=-180,-85,180,85 --maxzoom=6/);

      const after = (await app.call('/api/setup')).json;
      assert.equal(after.show, false, 'not shown once something is installed');
      assert.ok(after.topics.find((t: any) => t.id === 'basics').levels[1].books.every((b: any) => b.installed));
      assert.equal(after.wikipedia[0].installed, true);
      const again = await app.call('/api/setup/start', json({ topics: { basics: 'extended' }, wikipedia: 'small' }));
      assert.deepEqual(again.json.jobs, [], 'nothing downloads twice');
    } finally {
      await app.close();
    }
  });

  it('remembers when it was skipped', async () => {
    const app = await isolatedApp(env());
    try {
      assert.equal((await app.call('/api/setup/dismiss', { method: 'POST' })).status, 200);
      assert.equal((await app.call('/api/setup')).json.show, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.h, 'state.json'), 'utf8')).setupDismissed, true);
    } finally {
      await app.close();
    }
  });

  it('runs at most two downloads at a time; the rest wait their turn', async () => {
    const app = await isolatedApp(env());
    try {
      const ids: string[] = [];
      for (const n of [1, 2, 3]) ids.push((await app.call('/api/jobs/download', json({ url: `${filesBase}/hold/f${n}.zim`, kind: 'zim' }))).json.job.id);
      const status = async () => {
        const jobs = (await app.call('/api/jobs')).json.jobs;
        return ids.map((id) => jobs.find((j: any) => j.id === id).status);
      };
      await waitFor(async () => held.has('/hold/f1.zim') && held.has('/hold/f2.zim'));
      assert.deepEqual(await status(), ['running', 'running', 'queued']);
      held.get('/hold/f1.zim')!();
      await waitFor(async () => held.has('/hold/f3.zim'));
      assert.deepEqual(await status(), ['done', 'running', 'running']);
      held.get('/hold/f2.zim')!();
      held.get('/hold/f3.zim')!();
      await settle(app.call, ids);
    } finally {
      for (const release of held.values()) release();
      held.clear();
      await app.close();
    }
  });

  it('cancels a queued download without starting it', async () => {
    const app = await isolatedApp(env());
    try {
      const ids: string[] = [];
      for (const n of [4, 5, 6]) ids.push((await app.call('/api/jobs/download', json({ url: `${filesBase}/hold/f${n}.zim`, kind: 'zim' }))).json.job.id);
      await waitFor(async () => held.has('/hold/f4.zim') && held.has('/hold/f5.zim'));
      assert.equal((await app.call(`/api/jobs/${ids[2]}/cancel`, { method: 'POST' })).status, 200);
      held.get('/hold/f4.zim')!();
      held.get('/hold/f5.zim')!();
      const done = await settle(app.call, ids);
      assert.deepEqual(done.map((j: any) => j.status), ['done', 'done', 'cancelled']);
      assert.ok(!held.has('/hold/f6.zim'), 'never requested');
    } finally {
      for (const release of held.values()) release();
      held.clear();
      await app.close();
    }
  });
});

describe('ai: openai-compatible provider', () => {
  let url = '';
  let h = '';
  let srv: http.Server;
  let upstream: http.Server;
  let app2: Awaited<ReturnType<typeof createApp>>['ctx'];
  const KEY = 'sk-test-do-not-leak-123';
  const call = async (p: string, init?: RequestInit) => {
    const r = await fetch(url + p, init);
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const send = (p: string, body: unknown) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    h = await tmpHome();
    upstream = mockOpenAi();
    const port = await listen(upstream);
    const cfg = loadConfig({
      OUTPOST_HOME: h,
      OUTPOST_KIWIX_PORT: String(await freePort()),
      OUTPOST_AI_PROVIDER: 'openai-compatible',
      OUTPOST_AI_BASE_URL: `http://127.0.0.1:${port}/v1/`,
      OUTPOST_AI_API_KEY: KEY,
      OUTPOST_EMBED_MODEL: 'text-embedding-nomic-embed-text-v1.5',
    });
    const made = await createApp(cfg);
    app2 = made.ctx;
    srv = http.createServer(made.app);
    url = `http://127.0.0.1:${await listen(srv)}`;
  });
  after(async () => {
    await app2.kiwix.stop();
    srv.close();
    upstream.close();
    await fsp.rm(h, { recursive: true, force: true });
  });

  it('lists models, flags embedders, and never exposes the API key', async () => {
    const m = await call('/api/ai/models');
    assert.equal(m.status, 200);
    assert.equal(m.json.provider, 'openai-compatible');
    assert.equal(m.json.canManageModels, false);
    assert.deepEqual(m.json.models.map((x: any) => [x.name, x.embedding]), [['qwen2.5-7b-instruct', false], ['text-embedding-nomic-embed-text-v1.5', true]]);
    assert.equal(openAiSeen.auth, `Bearer ${KEY}`);
    const st = await call('/api/status');
    assert.equal(st.json.services.ai.provider, 'openai-compatible');
    assert.equal(st.json.services.ai.models, 1);
    for (const r of [m, st]) assert.ok(!r.text.includes(KEY), 'API key must never be returned');
  });

  it('streams chat as the same NDJSON the page reads from Ollama', async () => {
    const r = await send('/api/ai/chat', { model: 'qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], { sources: [] });
    assert.equal(lines.map((l: any) => l.message?.content ?? '').join(''), 'Hello');
    assert.equal(lines.at(-1).done, true);
    assert.equal(openAiSeen.chatBody.stream, true);
    const missing = await send('/api/ai/chat', { model: 'missing', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /not loaded/);
  });

  it('embeds documents through /v1/embeddings and grounds chat in them', async () => {
    const add = (name: string, text: string) => call(`/api/ai/docs?name=${name}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
    assert.equal((await add('water.md', 'Boil water for three minutes to make it safe.')).status, 201);
    assert.equal((await add('fire.md', 'Build a fire with tinder, kindling and fuel wood.')).status, 201);
    const r = await send('/api/ai/chat', { model: 'qwen2.5-7b-instruct', useDocs: true, messages: [{ role: 'user', content: 'How long should I boil water?' }] });
    assert.equal(JSON.parse(r.text.split('\n')[0]!).sources[0].doc, 'water.md');
    assert.match(openAiSeen.chatBody.messages.at(-1).content, /Boil water for three minutes/);
  });

  it('refuses model downloads and removal, which only Ollama supports', async () => {
    const pull = await send('/api/ai/pull', { name: 'llama3.2:3b' });
    assert.equal(pull.status, 409);
    assert.match(pull.json.error, /only work with Ollama/);
    assert.equal((await call('/api/ai/models/qwen2.5-7b-instruct', { method: 'DELETE' })).status, 409);
  });

  it('does not hide a chat model that also serves embeddings (one-model llama-server)', async () => {
    const { OpenAiCompatibleClient } = await import('../src/services/openai.js');
    const cfg = loadConfig({ OUTPOST_AI_PROVIDER: 'openai-compatible', OUTPOST_AI_BASE_URL: url.replace(/\/$/, '') + '/nowhere', OUTPOST_EMBED_MODEL: 'qwen2.5-7b-instruct' });
    const upstreamUrl = (await call('/api/ai/models')).json.url;
    const client = new OpenAiCompatibleClient({ ...cfg, ai: { ...cfg.ai, baseUrl: upstreamUrl } });
    const models = await client.models();
    assert.deepEqual(models?.map((m) => [m.name, m.embedding]), [['qwen2.5-7b-instruct', false], ['text-embedding-nomic-embed-text-v1.5', true]]);
  });

  it('rejects an unknown provider or a missing base URL at startup', () => {
    assert.throws(() => loadConfig({ OUTPOST_AI_PROVIDER: 'gpt' }), /OUTPOST_AI_PROVIDER/);
    assert.throws(() => loadConfig({ OUTPOST_AI_PROVIDER: 'openai-compatible' }), /OUTPOST_AI_BASE_URL/);
  });
});

describe('education (Kolibri)', () => {
  /** A fake Kolibri install: kolibri-venv/bin/{kolibri,python}. */
  const fakeVenv = (opts: { python?: boolean } = {}) => async (h: string) => {
    const bin = path.join(h, 'kolibri-venv', 'bin');
    await fsp.mkdir(bin, { recursive: true });
    makeExecutable(path.join(here, 'fixtures/fake-kolibri.mjs'), path.join(bin, 'kolibri'));
    if (opts.python !== false) makeExecutable(process.execPath, path.join(bin, 'python'));
  };
  const status = (call: any) => call('/api/education').then((r: any) => r.json);

  it('says how to install Kolibri when it is missing, or when its Python has gone', async () => {
    const st = (await api('/api/education')).json;
    assert.equal(st.state, 'not-installed');
    assert.match(st.message, /\.\/scripts\/install-kolibri\.sh/);
    assert.equal((await post('/api/education/start', {})).status, 409);
    assert.equal((await fetch(`${contentUrl}/kolibri/`)).status, 503);

    const app = await isolatedApp({}, fakeVenv({ python: false }));
    try {
      const s = await status(app.call);
      assert.equal(s.state, 'python-missing');
      assert.match(s.message, /Python .*install-kolibri\.sh again/);
    } finally {
      await app.close();
    }
  });

  it('starts Kolibri on loopback behind /kolibri, proxies every method, and stops it', async () => {
    const kport = await freePort();
    const zport = await freePort();
    const app = await isolatedApp({ OUTPOST_KOLIBRI_PORT: String(kport), OUTPOST_KOLIBRI_ZIP_PORT: String(zport) }, fakeVenv());
    try {
      assert.equal((await status(app.call)).state, 'stopped');
      assert.equal((await app.call('/api/education/start', { method: 'POST' })).status, 200);
      await waitFor(async () => (await status(app.call)).state === 'running');
      assert.ok(fs.readFileSync(path.join(app.h, 'kolibri', 'stop-calls'), 'utf8').includes('stop'), 'a leftover Kolibri is stopped first');

      const echo = await app.call('/kolibri/api/echo?x=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic b3V0cG9zdDpzZWNyZXQ=' }, body: '{"a":1}' });
      assert.equal(echo.status, 200);
      assert.equal(echo.json.method, 'POST');
      assert.equal(echo.json.url, '/kolibri/api/echo?x=1');
      assert.equal(echo.json.body, '{"a":1}');
      assert.equal(echo.json.authorization, null, 'the Outpost login is not forwarded');
      assert.match(echo.json.host, /^127\.0\.0\.1:\d+$/, 'Host is the address the browser used, so Kolibri builds links back through Outpost');
      assert.deepEqual(echo.json.env, { listen: '127.0.0.1', prefix: '/kolibri/', zip: String(zport), zeroconf: 'false', home: path.join(app.h, 'kolibri') });
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.h, 'state.json'), 'utf8')).kolibri, true, 'remembered for next launch');

      assert.equal((await app.call('/api/education/stop', { method: 'POST' })).status, 200);
      assert.equal((await status(app.call)).state, 'stopped');
      assert.equal((await app.call('/kolibri/')).status, 503);
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.h, 'state.json'), 'utf8')).kolibri, false);
    } finally {
      await app.close();
    }
  });

  it('starts Kolibri again on launch if it was running before', async () => {
    const app = await isolatedApp({ OUTPOST_KOLIBRI_PORT: String(await freePort()), OUTPOST_KOLIBRI_ZIP_PORT: String(await freePort()) }, async (h) => {
      await fakeVenv()(h);
      await fsp.writeFile(path.join(h, 'state.json'), JSON.stringify({ kolibri: true }));
    });
    try {
      await waitFor(async () => (await status(app.call)).state === 'running');
    } finally {
      await app.close();
    }
  });
});

describe('reader port in use', () => {
  it('says plainly when another program holds the reader port', async () => {
    const blocker = http.createServer();
    const port = await listen(blocker);
    const app = await isolatedApp({ OUTPOST_KIWIX_BIN: path.join(home, 'bin', 'kiwix-serve'), OUTPOST_KIWIX_PORT: String(port) }, async (h) => {
      await fsp.mkdir(path.join(h, 'zim'), { recursive: true });
      await fsp.writeFile(path.join(h, 'zim', 'a.zim'), 'x');
    });
    try {
      const k = await waitFor(async () => {
        const lib = (await app.call('/api/library')).json.kiwix;
        return lib.hint && lib;
      });
      assert.match(k.hint, new RegExp(`Port ${port} is already in use.*another copy of Outpost`));
    } finally {
      blocker.close();
      await app.close();
    }
  });
});

describe('map place search', () => {
  // test/fixtures/monaco-places.pmtiles: zooms 10-13 of a real Protomaps extract of Monaco (© OpenStreetMap contributors).
  const fixture = () => fs.readFileSync(new URL('./fixtures/monaco-places.pmtiles', import.meta.url));
  const indexJob = (call: any, label: string) =>
    waitFor(async () => {
      const j = (await call('/api/jobs')).json.jobs.find((x: any) => x.kind === 'place-index' && x.label.includes(label));
      return j && j.status !== 'running' && j;
    }, 15_000);
  const names = (r: any) => r.json.results.map((x: any) => x.name);

  it('indexes the places layer of an added map in the background, inside the map bounds only', async () => {
    const app = await isolatedApp({});
    try {
      assert.equal((await app.call('/api/maps/upload/monaco.pmtiles', { method: 'PUT', body: fixture() })).status, 200);
      const job = await indexJob(app.call, 'monaco.pmtiles');
      assert.equal(job.status, 'done', job.error);
      assert.equal(job.message, '15 places can now be searched');
      assert.equal(job.total, 7, 'one progress step per tile scanned (zooms 10-13 here)');
      const idx = JSON.parse(fs.readFileSync(path.join(app.h, 'maps', 'monaco.pmtiles.places.json'), 'utf8'));
      assert.equal(idx.count, 15, 'places from the big low-zoom tiles that fall outside Monaco are left out');
      for (const k of ['n', 'k', 'd', 'lon', 'lat', 'alt']) assert.ok(k in idx.places[0], `index entries have ${k}`);
      const listed = (await app.call('/api/maps')).json.files[0];
      assert.equal(listed.places, 15);

      // Search: prefix, diacritics, typos, other-language names; never more than 20.
      const q = (text: string) => app.call(`/api/maps/search?file=monaco.pmtiles&q=${encodeURIComponent(text)}`);
      const monte = await q('monte');
      assert.equal(monte.status, 200);
      assert.deepEqual(names(monte), ['Monte-Carlo'], 'no fuzzy noise such as Fontvieille (Italian: Fontevecchia)');
      assert.deepEqual(Object.keys(monte.json.results[0]).sort(), ['en', 'kind', 'lat', 'lon', 'name', 'zoom']);
      assert.equal(monte.json.results[0].en, null, 'no separate English name when it is the same');
      const beau = (await q('بوسولاي')).json.results[0];
      assert.equal(beau.name, 'Beausoleil');
      assert.equal(names(await q('Monte Carlo'))[0], 'Monte-Carlo');
      assert.equal(names(await q('devote'))[0], 'Ravin de Sainte-Dévote');
      assert.equal(names(await q('fontveille'))[0], 'Fontvieille', 'one-letter typo');
      assert.equal(names(await q('بوسولاي'))[0], 'Beausoleil', 'Arabic name');
      assert.equal(names(await q('monaco'))[0], 'Monaco', 'the town ranks above Monaco-Ville');
      const la = await q('la');
      assert.ok(la.json.results.length >= 5 && la.json.results.length <= 20);
      assert.equal((await q('zzzzqqq')).json.results.length, 0);
      assert.equal((await q('')).status, 400);
      assert.equal((await app.call('/api/maps/search?file=nope.pmtiles&q=x')).status, 404);
      assert.equal((await app.call('/api/maps/search?file=..%2Fstate.json&q=x')).status, 400);

      assert.equal((await app.call('/api/maps/monaco.pmtiles', { method: 'DELETE' })).status, 200);
      assert.ok(!fs.existsSync(path.join(app.h, 'maps', 'monaco.pmtiles.places.json')), 'index removed with its map');
    } finally {
      await app.close();
    }
  });

  it('indexes maps that have no index yet when Outpost starts', async () => {
    const app = await isolatedApp({}, async (h) => {
      await fsp.mkdir(path.join(h, 'maps'), { recursive: true });
      await fsp.writeFile(path.join(h, 'maps', 'old.pmtiles'), fixture());
    });
    try {
      assert.equal((await indexJob(app.call, 'old.pmtiles')).status, 'done');
      assert.equal(names(await app.call('/api/maps/search?file=old.pmtiles&q=larvotto'))[0], 'Larvotto');
    } finally {
      await app.close();
    }
  });

  it('reports a damaged map file as a failed index job, not a crash', async () => {
    const app = await isolatedApp({});
    try {
      await app.call('/api/maps/upload/broken.pmtiles', { method: 'PUT', body: 'not a map' });
      const job = await indexJob(app.call, 'broken.pmtiles');
      assert.equal(job.status, 'error');
      assert.match(job.error, /broken\.pmtiles .*not a readable map/);
      const s = await app.call('/api/maps/search?file=broken.pmtiles&q=x');
      assert.equal(s.status, 409);
      assert.match(s.json.error, /no place index/);
    } finally {
      await app.close();
    }
  });
});

describe('benchmark', () => {
  const finished = (call: any, id: string) =>
    waitFor(async () => {
      const j = (await call('/api/jobs')).json.jobs.find((x: any) => x.id === id);
      return j.status !== 'running' && j;
    }, 30_000);

  it('measures CPU, disk, memory and AI, scores it, and keeps a history', async () => {
    const app = await isolatedApp({});
    try {
      const start = await app.call('/api/benchmark/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quick: true }) });
      assert.equal(start.status, 202, JSON.stringify(start.json));
      const again = await app.call('/api/benchmark/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"quick":true}' });
      assert.equal(again.json.job.id, start.json.job.id, 'one run at a time');
      const job = await finished(app.call, start.json.job.id);
      assert.equal(job.status, 'done', job.error);
      assert.match(job.message, /^Score \d+/);

      const { history, hardware } = (await app.call('/api/benchmark')).json;
      assert.equal(history.length, 1);
      const r = history[0];
      for (const k of ['hashMBps', 'compressMBps', 'multiHashMBps', 'diskWriteMBps', 'diskReadMBps', 'memoryMBps']) assert.ok(r.metrics[k] > 0, `${k} measured`);
      assert.equal(r.metrics.diskUncached, true, 'disk read bypassed the memory cache');
      assert.ok(r.memoryBytes > 0 && r.cores > 0);
      assert.equal(r.ai.model, 'llama3.2:3b', 'first chat model, skipping embedders');
      assert.ok(r.ai.tokensPerSec > 0 && r.ai.firstTokenMs >= 0);
      assert.ok(Number.isInteger(r.score) && r.score > 0);
      assert.equal(r.quick, true);
      assert.ok(hardware.cpu && hardware.memoryBytes > 0, 'hardware detected');
      assert.ok(!fs.readdirSync(app.h).some((f) => f.startsWith('.benchmark')), 'scratch file removed');
      assert.ok(JSON.parse(fs.readFileSync(path.join(app.h, 'benchmarks.json'), 'utf8')).length === 1);

      assert.equal((await app.call(`/api/benchmark/${r.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await app.call('/api/benchmark')).json.history.length, 0);
    } finally {
      await app.close();
    }
  });

  it('saves a Builder Tag with each result and exports a result as JSON, without any network', async () => {
    const app = await isolatedApp({});
    try {
      const json = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const empty = (await app.call('/api/benchmark/tag')).json;
      assert.equal(empty.name, '');
      assert.match(empty.detected, /^.+ · \d+ GB$/, 'chip and memory from sysctl');
      assert.equal((await app.call('/api/benchmark/tag', json({ name: 'x'.repeat(41), hardware: '' }))).status, 400);
      assert.equal((await app.call('/api/benchmark/tag', json({ name: 'Sam\u0007', hardware: '' }))).json.name, 'Sam', 'control characters dropped');
      assert.equal((await app.call('/api/benchmark/tag', json({ name: 'Sam', hardware: '' }))).status, 200);

      const start = await app.call('/api/benchmark/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"quick":true}' });
      assert.equal((await finished(app.call, start.json.job.id)).status, 'done');
      const r = (await app.call('/api/benchmark')).json.history[0];
      assert.deepEqual(r.tag, { name: 'Sam', hardware: empty.detected }, 'blank label falls back to the detected hardware');

      // Changing the tag later doesn't rewrite past results.
      await app.call('/api/benchmark/tag', json({ name: 'Someone else', hardware: 'Mac on a boat' }));
      assert.equal((await app.call('/api/benchmark')).json.history[0].tag.name, 'Sam');

      const exp = await app.call(`/api/benchmark/${r.id}/export.json`);
      assert.equal(exp.status, 200);
      assert.match(exp.headers.get('content-disposition') ?? '', /^attachment; filename="outpost-benchmark-\d{4}-\d{2}-\d{2}-\d+\.json"$/);
      assert.equal(exp.json.outpost.version, '0.1.0');
      assert.equal(exp.json.result.score, r.score);
      assert.equal(exp.json.result.tag.name, 'Sam');
      assert.equal((await app.call('/api/benchmark/nope/export.json')).status, 404);
    } finally {
      await app.close();
    }
  });

  it('still scores the machine when no AI server is running', async () => {
    const app = await isolatedApp({ OLLAMA_URL: 'http://127.0.0.1:9' });
    try {
      const start = await app.call('/api/benchmark/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"quick":true}' });
      const job = await finished(app.call, start.json.job.id);
      assert.equal(job.status, 'done', job.error);
      const r = (await app.call('/api/benchmark')).json.history[0];
      assert.equal(r.ai, null);
      assert.match(r.notes.join(' '), /AI test skipped/);
      assert.ok(r.score > 0);
    } finally {
      await app.close();
    }
  });
});

describe('update checker', () => {
  const env = () => ({
    OUTPOST_CATALOG_URL: `${filesBase}/catalog/v2`,
    OUTPOST_GITHUB_API: filesBase,
    OUTPOST_OLLAMA_REGISTRY: filesBase,
    OUTPOST_UPDATE_REPO: 'someone/outpost',
  });
  const seed = async (h: string) => {
    await fsp.mkdir(path.join(h, 'zim'), { recursive: true });
    await fsp.writeFile(path.join(h, 'zim', 'book_a_nopic_2025-06.zim'), 'old edition'); // catalog has 2026-01
    await fsp.writeFile(path.join(h, 'zim', 'book_b_2026-01.zim'), 'current'); // catalog has the same
    await fsp.writeFile(path.join(h, 'zim', 'mybook.zim'), 'not from the catalog');
  };
  const json = (method: string, body?: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  it('is off by default and then contacts nothing', async () => {
    remoteCalls.github = remoteCalls.registry = 0;
    const app = await isolatedApp(env(), seed);
    try {
      const st = (await app.call('/api/updates')).json;
      assert.equal(st.enabled, false);
      assert.equal(st.results, null);
      const r = await app.call('/api/updates/check', json('POST'));
      assert.equal(r.status, 409);
      assert.match(r.json.error, /Turn on update checks first/);
      assert.deepEqual(remoteCalls, { github: 0, registry: 0 });
    } finally {
      await app.close();
    }
  });

  it('when turned on, finds a newer Outpost, newer book editions and newer models, and only reports them', async () => {
    const app = await isolatedApp(env(), seed);
    try {
      const on = await app.call('/api/updates', json('PUT', { enabled: true }));
      assert.equal(on.status, 200);
      const st = await waitFor(async () => {
        const s = (await app.call('/api/updates')).json;
        return s.results && !s.checking && s;
      });
      assert.ok(st.lastCheck > 0);
      const r = st.results;
      assert.deepEqual(r.outpost, { current: '0.1.0', latest: '0.2.0', newer: true, url: 'https://github.com/someone/outpost/releases/tag/v0.2.0' });
      assert.deepEqual(r.books.map((b: any) => [b.file, b.newFile]), [['book_a_nopic_2025-06.zim', 'book_a_nopic_2026-01.zim']], 'only books with a newer edition');
      assert.equal(r.books[0].size, 3000);
      assert.deepEqual(r.models.map((m: any) => m.name), ['llama3.2:3b'], 'nomic-embed-text is current; unknown models are skipped: ' + JSON.stringify(r.notes));
      assert.ok(Array.isArray(r.notes));

      // One click downloads; nothing is replaced or deleted.
      const dl = await app.call('/api/updates/download', json('POST', { kind: 'book', file: 'book_a_nopic_2025-06.zim' }));
      assert.equal(dl.status, 202, JSON.stringify(dl.json));
      assert.equal(dl.json.job.kind, 'download');
      const done = await waitFor(async () => {
        const j = (await app.call('/api/jobs')).json.jobs.find((x: any) => x.id === dl.json.job.id);
        return j.status !== 'running' && j.status !== 'queued' && j;
      });
      assert.equal(done.status, 'done', done.error);
      assert.ok(fs.existsSync(path.join(app.h, 'zim', 'book_a_nopic_2026-01.zim')), 'new edition downloaded');
      assert.ok(fs.existsSync(path.join(app.h, 'zim', 'book_a_nopic_2025-06.zim')), 'old edition kept until you remove it');

      const pull = await app.call('/api/updates/download', json('POST', { kind: 'model', name: 'llama3.2:3b' }));
      assert.equal(pull.status, 202);
      assert.equal(pull.json.job.kind, 'model-pull');
      assert.equal((await app.call('/api/updates/download', json('POST', { kind: 'book', file: 'book_b_2026-01.zim' }))).status, 404, 'only offered updates can be downloaded');
      assert.equal((await app.call('/api/updates/download', json('POST', { kind: 'book', url: 'http://evil.example/x.zim' }))).status, 400);

      assert.equal((await app.call('/api/updates', json('PUT', { enabled: false }))).json.enabled, false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.h, 'state.json'), 'utf8')).updates.enabled, false);
    } finally {
      await app.close();
    }
  });

  it('compares versions as numbers, not text', async () => {
    const { isNewer } = await import('../src/services/updates.js');
    assert.equal(isNewer('0.10.0', '0.9.9'), true);
    assert.equal(isNewer('v1.0.0', '0.9'), true);
    assert.equal(isNewer('0.1.0', '0.1.0'), false);
    assert.equal(isNewer('0.1.0', '0.2.0'), false);
  });

  it('says plainly when no release source is set', async () => {
    const app = await isolatedApp({ ...env(), OUTPOST_UPDATE_REPO: '' }, seed);
    try {
      await app.call('/api/updates', json('PUT', { enabled: true }));
      const st = await waitFor(async () => {
        const s = (await app.call('/api/updates')).json;
        return s.results && !s.checking && s;
      });
      assert.equal(st.results.outpost, null);
      assert.match(st.results.notes.join(' '), /OUTPOST_UPDATE_REPO/);
    } finally {
      await app.close();
    }
  });
});

describe('CyberChef', () => {
  it('explains how to install it when it is missing', async () => {
    const r = await fetch(`${base}/tools/cyberchef/`);
    assert.equal(r.status, 404);
    assert.match(await r.text(), /\.\/scripts\/fetch-cyberchef\.sh/);
    assert.equal((await api('/api/status')).json.tools.cyberchef, null);
  });

  it('serves an installed copy under /tools/cyberchef/ and nothing outside it', async () => {
    const app = await isolatedApp({}, async (h) => {
      const dir = path.join(h, 'assets', 'cyberchef');
      await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'index.html'), '<title>CyberChef</title>CHEF');
      await fsp.writeFile(path.join(dir, 'assets', 'main.js'), 'console.log(1)');
      await fsp.writeFile(path.join(dir, 'VERSION'), 'v11.5.0\n');
      await fsp.writeFile(path.join(h, 'state.json'), '{"secret":true}');
    });
    try {
      const page = await app.call('/tools/cyberchef/');
      assert.equal(page.status, 200);
      assert.match(page.json, /CHEF/);
      assert.equal((await app.call('/tools/cyberchef/assets/main.js')).status, 200);
      for (const p of ['/tools/cyberchef/..%2F..%2Fstate.json', '/tools/cyberchef/%2e%2e/%2e%2e/state.json']) {
        const r = await app.call(p);
        assert.ok(r.status === 404 || r.status === 403, `${p} -> ${r.status}`);
        assert.ok(!String(r.json).includes('secret'));
      }
      assert.equal((await app.call('/api/status')).json.tools.cyberchef, 'v11.5.0');
    } finally {
      await app.close();
    }
  });

  it('is behind the sign-in like everything else', async () => {
    const h = await tmpHome();
    await fsp.mkdir(path.join(h, 'assets', 'cyberchef'), { recursive: true });
    await fsp.writeFile(path.join(h, 'assets', 'cyberchef', 'index.html'), 'CHEF');
    const { app, ctx } = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_PASSWORD: 'pw', OUTPOST_KIWIX_PORT: String(await freePort()) }));
    const s = http.createServer(app);
    try {
      const u = `http://127.0.0.1:${await listen(s)}`;
      assert.equal((await fetch(`${u}/tools/cyberchef/`)).status, 401);
      assert.equal((await fetch(`${u}/tools/cyberchef/`, { headers: { Authorization: 'Basic ' + Buffer.from('outpost:pw').toString('base64') } })).status, 200);
    } finally {
      await ctx.kiwix.stop();
      s.closeAllConnections();
      s.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});

describe('auth', () => {
  it('requires credentials when a password is set', async () => {
    const h = await tmpHome();
    const cfg = loadConfig({ OUTPOST_HOME: h, OUTPOST_PASSWORD: 'secret', OUTPOST_USER: 'me', OUTPOST_KIWIX_PORT: String(await freePort()) });
    const { app, ctx } = await createApp(cfg);
    const s = http.createServer(app);
    const url = `http://127.0.0.1:${await listen(s)}`;
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    const good = 'Basic ' + Buffer.from('me:secret').toString('base64');
    const bad = 'Basic ' + Buffer.from('me:wrong').toString('base64');
    assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: bad } })).status, 401);
    assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: good } })).status, 200);
    await ctx.kiwix.stop();
    s.close();
    await fsp.rm(h, { recursive: true, force: true });
  });
});
