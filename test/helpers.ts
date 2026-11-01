import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const here = path.dirname(fileURLToPath(import.meta.url));

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 60));
  }
}

export async function tmpHome(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'outpost-test-'));
}

export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

/** Deterministic bag-of-words "embedding" so similar texts score high. */
export function fakeEmbed(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
    v[h] += 1;
  }
  return v;
}

export const lastChatBody: { value: any } = { value: null };
/** Counts texts the fake Ollama embedded successfully; set failAfter to make it fail once that many are done. */
export const embedStats = { inputs: 0, failAfter: Infinity };
/** Every text the fake Ollama was asked to embed, in order. */
export const embedSeen: string[] = [];

export function mockOllama(): http.Server {
  return http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url === '/api/ps') {
      res.setHeader('Content-Type', 'application/json');
      return void res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b', size: 3_000_000_000, size_vram: 3_000_000_000 }] }));
    }
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      return void res.end(JSON.stringify({
          models: [
            { name: 'llama3.2:3b', size: 2_000_000_000, capabilities: ['completion', 'tools'], digest: 'a'.repeat(64) },
            { name: 'nomic-embed-text:latest', size: 274_000_000, capabilities: ['embedding'], digest: createHash('sha256').update(SAME_MANIFEST).digest('hex') },
            { name: 'mxbai-embed-large:latest', size: 670_000_000, details: { family: 'bert' } }, // older Ollama: no capabilities
          ],
        }));
    }
    if (req.url === '/api/embed') {
      res.setHeader('Content-Type', 'application/json');
      if (embedStats.inputs + (body.input as string[]).length > embedStats.failAfter) {
        res.statusCode = 500;
        return void res.end(JSON.stringify({ error: 'fake embed failure' }));
      }
      embedStats.inputs += (body.input as string[]).length;
      embedSeen.push(...(body.input as string[]));
      return void res.end(JSON.stringify({ embeddings: (body.input as string[]).map(fakeEmbed) }));
    }
    if (req.url === '/api/chat') {
      lastChatBody.value = body;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Hel' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'lo' }, done: false }) + '\n');
      return void res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    }
    if (req.url === '/api/pull') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ status: 'pulling', total: 100, completed: 50 }) + '\n');
      return void res.end(JSON.stringify({ status: 'success' }) + '\n');
    }
    res.statusCode = 404;
    res.end('{}');
  });
}

export const openAiSeen: { auth: string | undefined; chatBody: any } = { auth: undefined, chatBody: null };

/** Stand-in for LM Studio / llama.cpp server: OpenAI-style /v1 routes with SSE chat streaming. */
export function mockOpenAi(): http.Server {
  return http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    openAiSeen.auth = req.headers.authorization;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      return void res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-7b-instruct', object: 'model' }, { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' }] }));
    }
    if (req.url === '/v1/embeddings') {
      if (body.model !== 'text-embedding-nomic-embed-text-v1.5') {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ error: { message: `model '${body.model}' not found` } }));
      }
      // Out of order on purpose: clients must sort by index.
      const data = (body.input as string[]).map((t, index) => ({ object: 'embedding', index, embedding: fakeEmbed(t) })).reverse();
      return void res.end(JSON.stringify({ object: 'list', data }));
    }
    if (req.url === '/v1/chat/completions') {
      openAiSeen.chatBody = body;
      if (body.model === 'missing') {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ error: { message: 'Model "missing" is not loaded' } }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`);
      res.write(delta('Hel'));
      res.write(delta('lo'));
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return void res.end('data: [DONE]\n\n');
    }
    res.statusCode = 404;
    res.end('{}');
  });
}

/** What the fake GitHub API and Ollama registry were asked, to prove when nothing is contacted. */
export const remoteCalls = { github: 0, registry: 0 };
/** The registry manifest the fake nomic-embed-text was installed from (so it is up to date). */
export const SAME_MANIFEST = '{"layers":[{"digest":"sha256:same"}]}';

export const BIG = Buffer.alloc(300_000, 'abcdefghij');

/** Downloads under /hold/ stay open until released here (to test the download queue). */
export const held = new Map<string, () => void>();

/** Fake catalog books for name lookups: name, flavour, size. book_a comes in two flavours; book_c is absent. */
const FAKE_BOOKS: [string, string, number, string][] = [
  ['book_a', 'nopic', 3000, 'fakecat'],
  ['book_a', 'maxi', 9000, 'fakecat'],
  ['book_b', '', 2000, 'fakecat'],
  ['book_huge', '', 9e15, 'other'],
];
const fakeEntry = (base: string, [n, f, size, cat]: [string, string, number, string]) =>
  `<entry><id>urn:uuid:${n}-${f}</id><title>${n} title</title><updated>2026-01-01T00:00:00Z</updated><name>${n}</name><flavour>${f}</flavour><category>${cat}</category><language>eng</language>
<link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="${base}/zim/${n}${f ? `_${f}` : ''}_2026-01.zim.meta4" length="${size}"/></entry>`;

/** File server with Range support + a fake Kiwix OPDS catalog + Protomaps build list. */
export function mockFiles(): http.Server {
  return http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const name = u.searchParams.get('name');
    if (u.pathname === '/catalog/v2/entries' && name) {
      res.setHeader('Content-Type', 'application/atom+xml');
      const base = `http://${req.headers.host}`;
      const entries = FAKE_BOOKS.filter(([n]) => n === name).map((b) => fakeEntry(base, b));
      return void res.end(`<?xml version="1.0"?><feed>${entries.join('')}</feed>`);
    }
    // Browsing without a search: category filter and paging, like the real catalog.
    if (u.pathname === '/catalog/v2/entries' && !u.searchParams.get('q')) {
      res.setHeader('Content-Type', 'application/atom+xml');
      const cat = u.searchParams.get('category');
      const all = FAKE_BOOKS.filter((b) => !cat || b[3] === cat);
      const start = Number(u.searchParams.get('start') ?? 0);
      const count = Number(u.searchParams.get('count') ?? 10);
      const page = all.slice(start, start + count).map((b) => fakeEntry(`http://${req.headers.host}`, b));
      return void res.end(`<?xml version="1.0"?><feed><totalResults>${all.length}</totalResults><startIndex>${start}</startIndex>${page.join('')}</feed>`);
    }
    if (u.pathname === '/catalog/v2/languages' || u.pathname === '/catalog/v2/categories') {
      res.setHeader('Content-Type', 'application/atom+xml');
      return void res.end(fs.readFileSync(path.join(here, 'fixtures', `kiwix-${u.pathname.split('/').pop()}.xml`)));
    }
    if (u.pathname === '/huge.zim') {
      res.setHeader('Content-Length', '9000000000000000'); // claims 9 PB, then sends nothing
      res.flushHeaders();
      return;
    }
    // Fake GitHub releases API.
    if (u.pathname === '/repos/someone/outpost/releases/latest') {
      remoteCalls.github++;
      res.setHeader('Content-Type', 'application/json');
      return void res.end(JSON.stringify({ tag_name: 'v0.2.0', name: 'Outpost 0.2.0', html_url: 'https://github.com/someone/outpost/releases/tag/v0.2.0', published_at: '2026-10-01T00:00:00Z' }));
    }
    // Fake Ollama registry: llama3.2:3b has a newer manifest; nomic-embed-text is the same as installed.
    if (u.pathname.startsWith('/v2/')) {
      remoteCalls.registry++;
      if (u.pathname === '/v2/library/llama3.2/manifests/3b') return void res.end('{"layers":[{"digest":"sha256:newer"}]}');
      if (u.pathname === '/v2/library/nomic-embed-text/manifests/latest') return void res.end(SAME_MANIFEST);
      res.statusCode = 404;
      return void res.end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
    }
    if (u.pathname === '/builds.json') {
      res.setHeader('Content-Type', 'application/json');
      return void res.end(JSON.stringify([{ key: '20251231.pmtiles' }, { key: '20260101.pmtiles' }]));
    }
    if (u.pathname.startsWith('/zim/') && u.pathname.endsWith('.zim')) {
      res.setHeader('Content-Length', 1000);
      return void res.end(Buffer.alloc(1000, 'z'));
    }
    if (u.pathname.startsWith('/hold/')) {
      res.setHeader('Content-Length', 10);
      res.write('12345');
      return void held.set(u.pathname, () => res.end('67890'));
    }
    if (req.url?.startsWith('/catalog/v2/entries')) {
      res.setHeader('Content-Type', 'application/atom+xml');
      return void res.end(`<?xml version="1.0"?><feed>
<entry><title>Wikipedia (English) &amp; more</title><id>urn:uuid:1</id><updated>2026-01-01T00:00:00Z</updated>
<summary>All articles</summary><language>eng</language><name>wikipedia_en_all_mini</name>
<author><name>Wikipedia</name></author>
<link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="http://localhost/zim/wikipedia_en_all_mini_2026-01.zim.meta4" length="1234567"/>
</entry>
<entry><title>No acquisition link</title><id>urn:uuid:2</id></entry></feed>`);
    }
    if (req.url === '/big.zim') {
      const range = req.headers.range?.match(/bytes=(\d+)-/);
      res.setHeader('Accept-Ranges', 'bytes');
      if (range) {
        const start = Number(range[1]);
        if (start >= BIG.length) {
          res.statusCode = 416;
          return void res.end();
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${BIG.length - 1}/${BIG.length}`);
        res.setHeader('Content-Length', BIG.length - start);
        return void res.end(BIG.subarray(start));
      }
      res.setHeader('Content-Length', BIG.length);
      return void res.end(BIG);
    }
    res.statusCode = 404;
    res.end('nope');
  });
}

export function makeExecutable(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
}

/** Paths Outpost serves on its content address (books, Education, apps), not its own. */
export const CONTENT_PATH = /^\/(kiwix|kolibri|apps)(\/|$|\?)/;
