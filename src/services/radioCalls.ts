import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, readJson, writeJsonAtomic } from '../util.js';

export interface RadioCall {
  id: string;
  /** When the call started (ms since epoch). */
  at: number;
  /** Hz. */
  freq: number;
  mode: string;
  seconds: number;
}

/** Calls are kept this long, like voice messages. */
export const CALL_TTL_MS = 24 * 3_600_000;
/** At most this many calls; the oldest go first. */
export const CALL_MAX = 300;
const ID_RE = /^[0-9a-f-]{36}$/;

/** 16-bit mono PCM wrapped as a WAV file, so every browser plays it and Voice accepts it. */
export function wavFile(pcm: Buffer, rate: number): Buffer {
  const data = pcm.subarray(0, pcm.length & ~1);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** The receiver's call log: each transmission heard with squelch on, as a WAV in {home}/radio-calls with an index. */
export class CallLog {
  private index: RadioCall[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private dir: string, private now: () => number = Date.now) {}

  private get indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  fileOf(id: string): string {
    if (!ID_RE.test(id)) throw new HttpError(404, 'No such call.');
    return path.join(this.dir, `${id}.wav`);
  }

  /** Calls from the last 24 hours, newest first. */
  list(): Promise<RadioCall[]> {
    return this.serial(async () => (await this.prune()).slice().reverse());
  }

  async add(call: Omit<RadioCall, 'id'>, wav: Buffer): Promise<RadioCall> {
    return this.serial(async () => {
      const list = await this.prune();
      const entry: RadioCall = { id: randomUUID(), ...call };
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(this.fileOf(entry.id), wav, { mode: 0o600 });
      list.push(entry);
      for (const old of list.splice(0, Math.max(0, list.length - CALL_MAX))) await fsp.rm(this.fileOf(old.id), { force: true });
      await writeJsonAtomic(this.indexFile, list);
      return entry;
    });
  }

  async read(id: string): Promise<Buffer> {
    return fsp.readFile(this.fileOf(id)).catch(() => {
      throw new HttpError(404, 'No such call.');
    });
  }

  async remove(id: string): Promise<void> {
    await this.serial(async () => {
      const list = await this.prune();
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) throw new HttpError(404, 'No such call.');
      list.splice(i, 1);
      await fsp.rm(this.fileOf(id), { force: true });
      await writeJsonAtomic(this.indexFile, list);
    });
  }

  /** Drops calls older than 24 hours, file and all. Runs inside serial(). */
  private async prune(): Promise<RadioCall[]> {
    this.index ??= await readJson<RadioCall[]>(this.indexFile, []);
    const cutoff = this.now() - CALL_TTL_MS;
    const old = this.index.filter((c) => c.at < cutoff);
    if (old.length) {
      for (const c of old) await fsp.rm(this.fileOf(c.id), { force: true });
      this.index.splice(0, this.index.length, ...this.index.filter((c) => c.at >= cutoff));
      await writeJsonAtomic(this.indexFile, this.index);
    }
    return this.index;
  }
}
