import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import path from 'node:path';
import { formatBytes, HttpError, resolveBin } from '../util.js';

export type JobKind = 'download' | 'map-extract' | 'reindex' | 'model-pull' | 'place-index' | 'benchmark' | 'app-install' | 'routing' | 'docker';
/** 'queued': waiting for a download slot. */
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Downloads beyond this many wait their turn, so a long list doesn't split the connection a dozen ways. */
const MAX_DOWNLOADS = 2;

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  received: number;
  total: number | null;
  message: string;
  error?: string;
  started: number;
  finished?: number;
}

type Cancel = () => void;

/** Tracks long-running downloads and map extractions so the UI can poll their progress. */
export class JobManager {
  private jobs = new Map<string, Job>();
  private cancels = new Map<string, Cancel>();
  private activeDownloads = 0;
  private waiting: Array<() => void> = [];

  constructor(private cfg: Config) {}

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.started - a.started);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): boolean {
    const c = this.cancels.get(id);
    if (!c) return false;
    c();
    return true;
  }

  clear(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running' || job.status === 'queued') return false;
    return this.jobs.delete(id);
  }

  private create(kind: JobKind, label: string): Job {
    const job: Job = { id: randomUUID(), kind, label, status: 'running', received: 0, total: null, message: '', started: Date.now() };
    this.jobs.set(job.id, job);
    // Keep the table small: drop the oldest finished jobs beyond 30.
    const finished = this.list().filter((j) => j.status !== 'running' && j.status !== 'queued');
    for (const old of finished.slice(30)) this.jobs.delete(old.id);
    return job;
  }

  private finish(job: Job, status: JobStatus, error?: string): void {
    job.status = status;
    job.finished = Date.now();
    if (error) job.error = error;
    this.cancels.delete(job.id);
  }

  /**
   * Runs `work` in the background as a job; `work` reports progress on the job and stops when `signal` aborts.
   * Whatever text it returns becomes the finished job's message (default "Complete").
   */
  startTask(kind: JobKind, label: string, work: (job: Job, signal: AbortSignal) => Promise<string | void>, cancelledMessage = 'Cancelled'): Job {
    const job = this.create(kind, label);
    const ctrl = new AbortController();
    this.cancels.set(job.id, () => ctrl.abort());
    void (async () => {
      try {
        job.message = (await work(job, ctrl.signal)) || 'Complete';
        this.finish(job, 'done');
      } catch (err) {
        if (ctrl.signal.aborted) {
          job.message = cancelledMessage;
          this.finish(job, 'cancelled');
        } else this.finish(job, 'error', err instanceof Error ? err.message : String(err));
      }
    })();
    return job;
  }

  /** The running job of this kind, if any. */
  running(kind: JobKind): Job | undefined {
    return this.list().find((j) => j.kind === kind && j.status === 'running');
  }

  /** Waits for one of the MAX_DOWNLOADS slots; the job shows as queued meanwhile. Rejects if cancelled first. */
  private downloadSlot(job: Job, signal: AbortSignal): Promise<void> {
    if (this.activeDownloads < MAX_DOWNLOADS) {
      this.activeDownloads++;
      return Promise.resolve();
    }
    job.status = 'queued';
    job.message = 'Waiting for another download to finish';
    return new Promise((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', onAbort);
        this.activeDownloads++;
        job.status = 'running';
        job.message = '';
        resolve();
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((w) => w !== go);
        reject(new Error('Cancelled'));
      };
      this.waiting.push(go);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseDownloadSlot(): void {
    this.activeDownloads--;
    this.waiting.shift()?.();
  }

  /** Resumable HTTP download into `${destPath}.part`, renamed to destPath when complete. Queued if two already run. */
  startDownload(url: string, destPath: string, label: string, onDone?: () => Promise<void> | void): Job {
    const job = this.create('download', label);
    const ctrl = new AbortController();
    this.cancels.set(job.id, () => ctrl.abort());
    let started = false;
    void (async () => {
      try {
        await this.downloadSlot(job, ctrl.signal);
        started = true;
        try {
          await this.runDownload(job, url, destPath, ctrl.signal);
        } finally {
          this.releaseDownloadSlot();
        }
        if (onDone) await onDone();
        job.message = 'Complete';
        this.finish(job, 'done');
      } catch (err) {
        if (ctrl.signal.aborted) {
          job.message = started ? 'Cancelled (partial file kept so you can resume)' : 'Cancelled before it started';
          this.finish(job, 'cancelled');
        } else {
          this.finish(job, 'error', err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return job;
  }

  /** Downloads into a task's own job (one step of a longer task), taking a download slot like any other download. */
  async download(job: Job, url: string, destPath: string, signal: AbortSignal): Promise<void> {
    await this.downloadSlot(job, signal);
    try {
      await this.runDownload(job, url, destPath, signal);
    } finally {
      this.releaseDownloadSlot();
    }
  }

  private async runDownload(job: Job, url: string, destPath: string, signal: AbortSignal): Promise<void> {
    const part = `${destPath}.part`;
    let start = 0;
    try {
      start = (await fsp.stat(part)).size;
    } catch {
      /* fresh download */
    }
    const headers: Record<string, string> = {};
    if (start > 0) headers.Range = `bytes=${start}-`;
    const res = await fetch(url, { headers, signal, redirect: 'follow' });
    if (res.status === 416 && start > 0) {
      // The .part file already holds the whole file.
      await fsp.rename(part, destPath);
      job.received = job.total = start;
      return;
    }
    if (!res.ok) throw new Error(`Server answered HTTP ${res.status}`);
    if (!res.body) throw new Error('Empty response body');
    let flags = 'a';
    if (start > 0 && res.status === 200) {
      start = 0; // server ignored our Range header: start over
      flags = 'w';
    }
    const len = Number(res.headers.get('content-length'));
    // Refuse up front rather than fill the disk and fail hours in.
    if (Number.isFinite(len) && len > 0) {
      const st = await fsp.statfs(path.dirname(destPath));
      const free = st.bavail * st.bsize;
      if (len > free) {
        await res.body.cancel().catch(() => undefined);
        throw new Error(`Not enough space: ${path.basename(destPath)} needs ${formatBytes(len)} but only ${formatBytes(free)} is free on this disk. Free up space or choose a smaller book.`);
      }
    }
    job.total = Number.isFinite(len) && len > 0 ? len + start : null;
    job.received = start;
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      job.received += chunk.length;
    });
    await pipeline(body, fs.createWriteStream(part, { flags }), { signal });
    await fsp.rename(part, destPath);
  }

  /** Runs `pmtiles extract <source> <out> --bbox=...` to carve a region out of a planet build. */
  startExtract(
    source: string,
    outPath: string,
    bbox: [number, number, number, number],
    maxzoom: number | null,
    label: string,
    onDone?: () => Promise<void> | void,
  ): Job {
    const bin = resolveBin(this.cfg.pmtilesBin);
    if (!bin) throw new HttpError(412, 'The pmtiles tool is not installed (brew install pmtiles).');
    const job = this.create('map-extract', label);
    const part = `${outPath}.part`;
    const args = ['extract', source, part, `--bbox=${bbox.join(',')}`];
    if (maxzoom !== null) args.push(`--maxzoom=${maxzoom}`);
    void fsp.rm(part, { force: true }).then(() => {
      const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let cancelled = false;
      this.cancels.set(job.id, () => {
        cancelled = true;
        child.kill('SIGTERM');
      });
      const tail: string[] = [];
      const onData = (buf: Buffer) => {
        const lines = buf.toString().split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
        if (lines.length) {
          job.message = lines[lines.length - 1]!.slice(0, 300);
          tail.push(...lines);
          if (tail.length > 20) tail.splice(0, tail.length - 20);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('error', (err) => this.finish(job, 'error', err.message));
      child.once('exit', async (code) => {
        if (cancelled) {
          await fsp.rm(part, { force: true });
          this.finish(job, 'cancelled');
        } else if (code === 0) {
          try {
            await fsp.rename(part, outPath);
            if (onDone) await onDone();
            job.message = 'Complete';
            this.finish(job, 'done');
          } catch (e) {
            this.finish(job, 'error', e instanceof Error ? e.message : String(e));
          }
        } else {
          await fsp.rm(part, { force: true });
          this.finish(job, 'error', `pmtiles exited with code ${code}: ${tail.slice(-3).join(' | ')}`);
        }
      });
    });
    return job;
  }
}
