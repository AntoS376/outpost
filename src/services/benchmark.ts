import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Config } from '../config.js';
import type { AiProvider } from './ai.js';
import type { Job } from './jobs.js';
import { detectHardware, type Hardware } from './hardware.js';
import { HttpError, readJson, writeJsonAtomic } from '../util.js';

const run = promisify(execFile);
const DISK_SCRIPT = fileURLToPath(new URL('../../scripts/disk-bench.pl', import.meta.url));
const AI_PROMPT = 'In about 150 words, explain how to make water safe to drink without any equipment.';

/** Workload sizes in MB. "quick" exists for tests; results from it are marked as such. */
const SIZES = {
  full: { hash: 512, compress: 64, multiHash: 256, memory: 2048, disk: 1024 },
  quick: { hash: 16, compress: 4, multiHash: 8, memory: 64, disk: 8 },
};

/**
 * Score references: round numbers, not measurements of any particular Mac. A metric that matches its reference
 * scores 1000; twice as fast scores 2000. The overall score is the geometric mean of the categories present.
 */
export const REFERENCE = {
  hashMBps: 2000,
  compressMBps: 50,
  multiHashMBps: 10000,
  diskWriteMBps: 2000,
  diskReadMBps: 2500,
  memoryMBps: 20000,
  tokensPerSec: 20,
};

/** A display name and hardware label of the user's choosing, saved with each result. Local only. */
export interface BuilderTag {
  name: string;
  hardware: string;
}

/** "Apple M3 Pro · 18 GB": the label used when none is set. */
export const detectedLabel = (h: Hardware) => `${h.cpu} · ${Math.round(h.memoryBytes / 2 ** 30)} GB`;

const clean = (s: unknown, max: number, field: string): string => {
  const v = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (v.length > max) throw new HttpError(400, `${field} can be at most ${max} characters`);
  return v;
};

export interface BenchmarkResult {
  id: string;
  at: number;
  quick: boolean;
  hardware: Hardware;
  memoryBytes: number;
  cores: number;
  metrics: {
    hashMBps: number;
    compressMBps: number;
    multiHashMBps: number;
    diskWriteMBps: number;
    diskReadMBps: number;
    /** False when the read figure may come from the memory cache (no Perl to bypass it). */
    diskUncached: boolean;
    memoryMBps: number;
  };
  ai: { provider: string; model: string; tokensPerSec: number; firstTokenMs: number; tokens: number } | null;
  categories: { cpu: number; disk: number; memory: number; ai: number | null };
  /** The Builder Tag when the benchmark ran. */
  tag: BuilderTag;
  score: number;
  notes: string[];
}

// Runs inside a worker thread so the server keeps answering while the CPU is busy.
// Data comes from a fixed-seed generator, so every Mac does exactly the same work.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
function data(bytes, text) {
  const b = Buffer.alloc(bytes);
  let x = 2463534242;
  const words = ['water', 'river', 'shelter', 'fire', 'map', 'north', 'bread', 'salt', 'rope', 'stone'];
  if (text) {
    let o = 0;
    while (o < bytes) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; o += b.write(words[(x >>> 0) % 10] + ' ', o); }
    return b;
  }
  for (let i = 0; i < bytes; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b.writeUInt32LE(x >>> 0, i); }
  return b;
}
const { task, mb } = workerData;
const t = process.hrtime.bigint();
if (task === 'hash') {
  const chunk = data(16 << 20);
  for (let i = 0; i < mb / 16; i++) crypto.createHash('sha256').update(chunk).digest();
} else if (task === 'compress') {
  const chunk = data(4 << 20, true);
  for (let i = 0; i < mb / 4; i++) zlib.deflateSync(chunk, { level: 6 });
} else if (task === 'memory') {
  const a = data(64 << 20), b = Buffer.alloc(64 << 20);
  for (let i = 0; i < mb / 64; i++) a.copy(b);
}
parentPort.postMessage(Number(process.hrtime.bigint() - t) / 1e9);
`;

function inWorker(task: string, mb: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { task, mb } });
    w.once('message', (seconds: number) => resolve(mb / seconds));
    w.once('error', reject);
  });
}

const round = (n: number) => Math.round(n * 10) / 10;
const geomean = (xs: number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);

export class Benchmark {
  private file: string;
  private stateFile: string;
  private current: Job | null = null;

  constructor(private cfg: Config, private ai: AiProvider) {
    this.file = path.join(cfg.home, 'benchmarks.json');
    this.stateFile = path.join(cfg.home, 'state.json');
  }

  /** The saved Builder Tag (hardware "" means use the detected label). */
  async tag(): Promise<BuilderTag> {
    const t = (await readJson<{ builderTag?: Partial<BuilderTag> }>(this.stateFile, {})).builderTag ?? {};
    return { name: t.name ?? '', hardware: t.hardware ?? '' };
  }

  async setTag(input: { name?: unknown; hardware?: unknown }): Promise<BuilderTag> {
    const tag = { name: clean(input.name, 40, 'Name'), hardware: clean(input.hardware, 60, 'Hardware label') };
    await writeJsonAtomic(this.stateFile, { ...(await readJson<Record<string, unknown>>(this.stateFile, {})), builderTag: tag });
    return tag;
  }

  async get(id: string): Promise<BenchmarkResult | null> {
    return (await this.history()).find((r) => r.id === id) ?? null;
  }

  history(): Promise<BenchmarkResult[]> {
    return readJson<BenchmarkResult[]>(this.file, []);
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.history();
    const left = all.filter((r) => r.id !== id);
    if (left.length === all.length) return false;
    await writeJsonAtomic(this.file, left);
    return true;
  }

  /** The job already running, if any; only one benchmark at a time, or they would slow each other down. */
  running(): Job | null {
    return this.current?.status === 'running' ? this.current : null;
  }

  track(job: Job): Job {
    this.current = job;
    return job;
  }

  async run(job: Job, signal: AbortSignal, opts: { quick: boolean; model?: string }): Promise<string> {
    const size = opts.quick ? SIZES.quick : SIZES.full;
    const notes: string[] = [];
    job.total = 6;
    job.received = 0;
    const step = (label: string) => {
      if (signal.aborted) throw new Error('Cancelled');
      job.message = label;
    };

    step('Reading the hardware');
    const hardware = await detectHardware();
    const saved = await this.tag();
    const tag = { name: saved.name, hardware: saved.hardware || detectedLabel(hardware) };
    job.received++;

    step('Processor: hashing and compression');
    const hashMBps = await inWorker('hash', size.hash);
    const compressMBps = await inWorker('compress', size.compress);
    job.received++;

    step(`Processor: all ${hardware.cores} cores`);
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: hardware.cores }, () => inWorker('hash', size.multiHash)));
    const multiHashMBps = (size.multiHash * hardware.cores) / (Number(process.hrtime.bigint() - t0) / 1e9);
    job.received++;

    step('Memory');
    const memoryMBps = await inWorker('memory', size.memory);
    job.received++;

    step(`Disk: writing and reading ${size.disk} MB in ${this.cfg.home}`);
    const disk = await this.disk(size.disk, notes);
    job.received++;

    step('AI');
    const ai = await this.aiSpeed(opts.model, signal, notes);
    job.received++;

    const r = (k: keyof typeof REFERENCE, v: number) => v / REFERENCE[k];
    const categories = {
      cpu: geomean([r('hashMBps', hashMBps), r('compressMBps', compressMBps), r('multiHashMBps', multiHashMBps)]),
      disk: geomean([r('diskWriteMBps', disk.write), r('diskReadMBps', disk.read)]),
      memory: r('memoryMBps', memoryMBps),
      ai: ai ? r('tokensPerSec', ai.tokensPerSec) : null,
    };
    const present = Object.values(categories).filter((v): v is number => v !== null);
    const result: BenchmarkResult = {
      id: randomUUID(),
      at: Date.now(),
      quick: opts.quick,
      hardware,
      memoryBytes: hardware.memoryBytes,
      cores: hardware.cores,
      metrics: {
        hashMBps: round(hashMBps),
        compressMBps: round(compressMBps),
        multiHashMBps: round(multiHashMBps),
        diskWriteMBps: round(disk.write),
        diskReadMBps: round(disk.read),
        diskUncached: disk.uncached,
        memoryMBps: round(memoryMBps),
      },
      ai,
      categories: {
        cpu: Math.round(categories.cpu * 1000),
        disk: Math.round(categories.disk * 1000),
        memory: Math.round(categories.memory * 1000),
        ai: categories.ai === null ? null : Math.round(categories.ai * 1000),
      },
      score: Math.round(geomean(present) * 1000),
      tag,
      notes,
    };
    await writeJsonAtomic(this.file, [result, ...(await this.history())].slice(0, 100));
    return `Score ${result.score}`;
  }

  /** Disk speed on the drive that holds ~/Outpost, bypassing the memory cache with Perl's F_NOCACHE when possible. */
  private async disk(mb: number, notes: string[]): Promise<{ write: number; read: number; uncached: boolean }> {
    const scratch = path.join(this.cfg.home, '.benchmark-disk.tmp');
    try {
      const { stdout } = await run('/usr/bin/perl', [DISK_SCRIPT, scratch, String(mb)], { timeout: 300_000 });
      const r = JSON.parse(stdout) as { write: number; read: number };
      return { ...r, uncached: true };
    } catch {
      notes.push('Perl was not available, so the disk read figure may include the memory cache and look faster than the disk is.');
      const chunk = Buffer.alloc(1 << 20, 7);
      let t = process.hrtime.bigint();
      const fd = fs.openSync(scratch, 'w');
      for (let i = 0; i < mb; i++) fs.writeSync(fd, chunk);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      const write = mb / (Number(process.hrtime.bigint() - t) / 1e9);
      t = process.hrtime.bigint();
      await fsp.readFile(scratch);
      const read = mb / (Number(process.hrtime.bigint() - t) / 1e9);
      return { write, read, uncached: false };
    } finally {
      await fsp.rm(scratch, { force: true });
    }
  }

  /**
   * Tokens per second with the configured AI server and a fixed prompt, after a warm-up request that loads the
   * model. Streamed pieces are counted as tokens: Ollama and llama.cpp send one token per piece.
   */
  private async aiSpeed(wanted: string | undefined, signal: AbortSignal, notes: string[]): Promise<BenchmarkResult['ai']> {
    const models = await this.ai.models();
    if (!models) {
      notes.push(`AI test skipped: ${this.ai.label} isn't answering at ${this.ai.url}.`);
      return null;
    }
    const chat = models.filter((m) => !m.embedding);
    const model = chat.find((m) => m.name === wanted)?.name ?? chat[0]?.name;
    if (!model) {
      notes.push('AI test skipped: no chat model is installed.');
      return null;
    }
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal.addEventListener('abort', stop);
    const timer = setTimeout(stop, 180_000);
    try {
      for await (const _ of await this.ai.chat(model, [{ role: 'user', content: 'Say OK.' }], ctrl.signal)) void _;
      const t0 = performance.now();
      let first = 0;
      let tokens = 0;
      for await (const _ of await this.ai.chat(model, [{ role: 'user', content: AI_PROMPT }], ctrl.signal)) {
        if (!tokens) first = performance.now();
        tokens++;
      }
      const seconds = (performance.now() - first) / 1000;
      if (tokens < 2 || seconds <= 0) {
        notes.push(`AI test skipped: ${model} answered with too little text to time.`);
        return null;
      }
      return { provider: this.ai.kind, model, tokensPerSec: round((tokens - 1) / seconds), firstTokenMs: Math.round(first - t0), tokens };
    } catch (e) {
      if (signal.aborted) throw e;
      notes.push(`AI test skipped: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
}
