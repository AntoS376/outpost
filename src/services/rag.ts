import path from 'node:path';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { AiProvider } from './ai.js';
import type { Job } from './jobs.js';
import { dirSize, HttpError, readJson, writeJsonAtomic } from '../util.js';

export interface DocMeta {
  id: string;
  name: string;
  chars: number;
  chunks: number;
  added: number;
  /** Embedding model the stored vectors came from. */
  model: string;
  /** Whether texts were embedded with nomic's "search_document: " prefix. */
  prefixed: boolean;
  dims: number;
}
/** A document as listed: `current` is false when it was indexed with another model or format and needs re-indexing. */
export type DocInfo = DocMeta & { current: boolean };
export interface IndexInfo {
  chunks: number;
  maxChunks: number;
  bytes: number;
  stale: number;
}
export interface Hit {
  doc: string;
  text: string;
  score: number;
}
interface Manifest {
  version: 2;
  docs: DocMeta[];
}
interface Loaded {
  meta: DocMeta;
  texts: string[];
  /** chunks × dims unit vectors. */
  vecs: Float32Array;
}
/** The previous on-disk format: everything in one index.json. */
interface IndexV1 {
  embedModel: string;
  docs: { id: string; name: string; chars: number; chunks: number; added: number }[];
  chunks: { d: string; t: string; v: number[] }[];
}

const BATCH = 16;
/** Average new text per part (900-character parts overlapping by 150), used to explain the limit. */
const CHARS_PER_CHUNK = 750;
// .pdf arrives here already converted to text by services/pdf.ts.
const TEXT_EXTS = ['.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml'];

/** nomic-embed-text is trained with task prefixes and retrieves noticeably better with them. */
const usesPrefixes = (model: string) => /nomic-embed/i.test(model);
const DOC_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
  };
  for (const para of clean.split(/\n{2,}/)) {
    if (para.length > size) {
      push();
      cur = '';
      for (let i = 0; i < para.length; i += size - overlap) out.push(para.slice(i, i + size).trim());
      continue;
    }
    if (cur.length + para.length + 2 > size) {
      push();
      cur = cur.slice(-overlap) + '\n\n' + para;
    } else {
      cur = cur ? `${cur}\n\n${para}` : para;
    }
  }
  push();
  return out.filter(Boolean);
}

export function extractText(name: string, content: string): string {
  const ext = path.extname(name).toLowerCase();
  if (!TEXT_EXTS.includes(ext)) {
    throw new HttpError(415, `Unsupported file type "${ext || 'unknown'}". Use text, Markdown, CSV, JSON, HTML or PDF.`);
  }
  if (ext === '.html' || ext === '.htm' || ext === '.xml') {
    return content
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n');
  }
  return content;
}

function normalise(v: ArrayLike<number>, out: Float32Array, offset: number): void {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) out[offset + i] = v[i]! / n;
}

/** Vector files: a 4-byte little-endian dimension count, then float32 values. */
function vecHeader(dims: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(dims, 0);
  return b;
}
async function readVecs(file: string): Promise<{ dims: number; vecs: Float32Array } | null> {
  try {
    const buf = await fsp.readFile(file);
    const dims = buf.readUInt32LE(0);
    const usable = Math.floor((buf.length - 4) / 4) * 4;
    return { dims, vecs: new Float32Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + 4 + usable)) };
  } catch {
    return null;
  }
}
async function writeFileAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
const f32Bytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/**
 * Local vector store for "chat with my documents". Per document it keeps the text parts (JSON) and their
 * embeddings (binary float32), plus a small manifest, so adding or removing one document never rewrites the
 * others. Everything is held in memory for search; OUTPOST_RAG_MAX_CHUNKS bounds that.
 */
export class RagStore {
  private loaded: Promise<Map<string, Loaded>> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private dir: string;

  constructor(private cfg: Config, private ai: AiProvider) {
    this.dir = cfg.dirs.rag;
  }

  private textsFile(id: string): string {
    return path.join(this.dir, `${id}.texts.json`);
  }
  private vecsFile(id: string, model: string, prefixed: boolean): string {
    const key = createHash('sha1').update(`${model}|${prefixed}`).digest('hex').slice(0, 8);
    return path.join(this.dir, `${id}.${key}.f32`);
  }

  private isCurrent(m: DocMeta): boolean {
    return m.model === this.cfg.embedModel && m.prefixed === usesPrefixes(this.cfg.embedModel);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private load(): Promise<Map<string, Loaded>> {
    this.loaded ??= this.serial(() => this.readAll());
    return this.loaded;
  }

  private async readAll(): Promise<Map<string, Loaded>> {
    const manifest = (await readJson<Manifest | null>(path.join(this.dir, 'manifest.json'), null)) ?? (await this.migrateV1());
    const map = new Map<string, Loaded>();
    for (const meta of manifest.docs) {
      const texts = await readJson<string[] | null>(this.textsFile(meta.id), null);
      const v = await readVecs(this.vecsFile(meta.id, meta.model, meta.prefixed));
      if (!texts || !v || v.vecs.length !== texts.length * v.dims) {
        console.warn(`Document index: skipping "${meta.name}", its files are missing or damaged. Remove it and add it again.`);
        continue;
      }
      map.set(meta.id, { meta: { ...meta, dims: v.dims }, texts, vecs: v.vecs });
    }
    return map;
  }

  /** Converts the old single-file index (rag/index.json) to the per-document layout, then removes it. */
  private async migrateV1(): Promise<Manifest> {
    const oldFile = path.join(this.dir, 'index.json');
    const old = await readJson<IndexV1 | null>(oldFile, null);
    const manifest: Manifest = { version: 2, docs: [] };
    if (!old) return manifest;
    for (const d of old.docs) {
      const chunks = old.chunks.filter((c) => c.d === d.id);
      const dims = chunks[0]?.v.length ?? 0;
      if (!dims) continue;
      const vecs = new Float32Array(chunks.length * dims);
      chunks.forEach((c, i) => normalise(c.v, vecs, i * dims));
      const meta: DocMeta = { ...d, chunks: chunks.length, model: old.embedModel, prefixed: false, dims };
      await writeFileAtomic(this.textsFile(d.id), JSON.stringify(chunks.map((c) => c.t)));
      await writeFileAtomic(this.vecsFile(d.id, meta.model, false), Buffer.concat([vecHeader(dims), f32Bytes(vecs)]));
      manifest.docs.push(meta);
    }
    await writeJsonAtomic(path.join(this.dir, 'manifest.json'), manifest);
    await fsp.rm(oldFile, { force: true });
    return manifest;
  }

  private async saveManifest(map: Map<string, Loaded>): Promise<void> {
    const manifest: Manifest = { version: 2, docs: [...map.values()].map((d) => d.meta) };
    await writeJsonAtomic(path.join(this.dir, 'manifest.json'), manifest);
  }

  private async embedDocs(model: string, prefixed: boolean, texts: string[], onBatch: (vs: number[][]) => Promise<void> | void, signal?: AbortSignal) {
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error('Cancelled');
      const batch = texts.slice(i, i + BATCH).map((t) => (prefixed ? DOC_PREFIX + t : t));
      await onBatch(await this.ai.embed(model, batch));
    }
  }

  async list(): Promise<{ docs: DocInfo[]; embedModel: string; index: IndexInfo }> {
    const map = await this.load();
    const docs = [...map.values()].map((d) => ({ ...d.meta, current: this.isCurrent(d.meta) }));
    return {
      docs,
      embedModel: this.cfg.embedModel,
      index: {
        chunks: docs.reduce((n, d) => n + d.chunks, 0),
        maxChunks: this.cfg.ragMaxChunks,
        bytes: await dirSize(this.dir),
        stale: docs.filter((d) => !d.current).length,
      },
    };
  }

  add(name: string, rawText: string): Promise<DocMeta> {
    return this.load().then(() =>
      this.serial(async () => {
        const map = await this.load();
        const text = extractText(name, rawText);
        const texts = chunkText(text);
        if (texts.length === 0) throw new HttpError(400, 'The document has no readable text.');
        const id = createHash('sha1').update(name).digest('hex').slice(0, 10);
        const old = map.get(id); // re-adding a name replaces the old copy
        const used = [...map.values()].reduce((n, d) => n + d.meta.chunks, 0) - (old?.meta.chunks ?? 0);
        const max = this.cfg.ragMaxChunks;
        if (used + texts.length > max) {
          throw new HttpError(
            413,
            `"${name}" has ${texts.length} parts, but the document index has room for ${max - used} more ` +
              `(limit ${max} parts, about ${Math.round((max * CHARS_PER_CHUNK) / 1e5) / 10} million characters). ` +
              'Remove a document, or raise OUTPOST_RAG_MAX_CHUNKS in ~/.config/outpost/env.',
          );
        }
        const model = this.cfg.embedModel;
        const prefixed = usesPrefixes(model);
        let dims = 0;
        let vecs = new Float32Array(0);
        let n = 0;
        await this.embedDocs(model, prefixed, texts, (vs) => {
          if (!dims) {
            dims = vs[0]!.length;
            vecs = new Float32Array(texts.length * dims);
          }
          for (const v of vs) normalise(v, vecs, n++ * dims);
        });
        const meta: DocMeta = { id, name, chars: text.length, chunks: texts.length, added: Date.now(), model, prefixed, dims };
        await writeFileAtomic(this.textsFile(id), JSON.stringify(texts));
        const vecsFile = this.vecsFile(id, model, prefixed);
        await writeFileAtomic(vecsFile, Buffer.concat([vecHeader(dims), f32Bytes(vecs)]));
        await fsp.writeFile(path.join(this.cfg.dirs.docs, `${id}.txt`), text);
        if (old && this.vecsFile(id, old.meta.model, old.meta.prefixed) !== vecsFile) await fsp.rm(this.vecsFile(id, old.meta.model, old.meta.prefixed), { force: true });
        map.set(id, { meta, texts, vecs });
        await this.saveManifest(map);
        return meta;
      }),
    );
  }

  remove(id: string): Promise<boolean> {
    return this.load().then(() =>
      this.serial(async () => {
        const map = await this.load();
        const doc = map.get(id);
        if (!doc) return false;
        map.delete(id);
        await this.saveManifest(map);
        for (const f of await fsp.readdir(this.dir)) if (f.startsWith(`${id}.`)) await fsp.rm(path.join(this.dir, f), { force: true });
        await fsp.rm(path.join(this.cfg.dirs.docs, `${id}.txt`), { force: true });
        return true;
      }),
    );
  }

  /** Number of documents indexed with a different model or format than the current settings. */
  async staleCount(): Promise<number> {
    return [...(await this.load()).values()].filter((d) => !this.isCurrent(d.meta)).length;
  }

  /**
   * Re-embeds every stale document with the current model, reporting progress on `job`. Vectors are appended to a
   * .part file after each batch, so a cancelled or failed run continues where it stopped. A document switches over
   * only once all its parts are done; until then search keeps using its old vectors.
   */
  async reindex(job: Job, signal: AbortSignal): Promise<void> {
    const map = await this.load();
    const model = this.cfg.embedModel;
    const prefixed = usesPrefixes(model);
    const stale = [...map.values()].filter((d) => !this.isCurrent(d.meta));
    job.total = stale.reduce((n, d) => n + d.meta.chunks, 0);
    job.received = 0;
    for (const [i, doc] of stale.entries()) {
      const { id, name } = doc.meta;
      job.message = `${name} (${i + 1} of ${stale.length})`;
      const final = this.vecsFile(id, model, prefixed);
      const part = `${final}.part`;
      let dims = 0;
      let done = 0;
      try {
        const buf = await fsp.readFile(part);
        dims = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
        done = dims ? Math.floor((buf.length - 4) / (dims * 4)) : 0;
        await fsp.truncate(part, dims ? 4 + done * dims * 4 : 0); // drop any half-written vector
      } catch {
        /* nothing saved yet */
      }
      job.received += done;
      await this.embedDocs(
        model,
        prefixed,
        doc.texts.slice(done),
        async (vs) => {
          if (!dims) {
            dims = vs[0]!.length;
            await fsp.writeFile(part, vecHeader(dims));
          }
          const out = new Float32Array(vs.length * dims);
          vs.forEach((v, j) => normalise(v, out, j * dims));
          await fsp.appendFile(part, f32Bytes(out));
          job.received += vs.length;
        },
        signal,
      );
      await this.serial(async () => {
        if (map.get(id) !== doc) return void (await fsp.rm(part, { force: true })); // removed or replaced meanwhile
        await fsp.rename(part, final);
        const v = (await readVecs(final))!;
        map.set(id, { meta: { ...doc.meta, model, prefixed, dims: v.dims }, texts: doc.texts, vecs: v.vecs });
        await this.saveManifest(map);
        const oldFile = this.vecsFile(id, doc.meta.model, doc.meta.prefixed);
        if (oldFile !== final) await fsp.rm(oldFile, { force: true });
      });
    }
  }

  async search(query: string, k = 4): Promise<Hit[]> {
    const docs = [...(await this.load()).values()];
    if (docs.length === 0) return [];
    // Documents not yet re-indexed are searched with the model and format they were indexed with.
    const groups = new Map<string, Loaded[]>();
    for (const d of docs) {
      const key = `${d.meta.model}|${d.meta.prefixed}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    const hits: Hit[] = [];
    for (const group of groups.values()) {
      const { model, prefixed, dims } = group[0]!.meta;
      let q: Float32Array;
      try {
        const [qv] = await this.ai.embed(model, [prefixed ? QUERY_PREFIX + query : query]);
        if (qv!.length !== dims) continue;
        q = new Float32Array(dims);
        normalise(qv!, q, 0);
      } catch (e) {
        if (this.isCurrent(group[0]!.meta)) throw e;
        continue; // an old model that is gone: those documents wait for re-indexing
      }
      for (const d of group) {
        for (let c = 0; c < d.texts.length; c++) {
          let dot = 0;
          const off = c * dims;
          for (let i = 0; i < dims; i++) dot += q[i]! * d.vecs[off + i]!;
          hits.push({ doc: d.meta.name, text: d.texts[c]!, score: dot });
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
