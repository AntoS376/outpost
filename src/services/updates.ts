import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { AiProvider } from './ai.js';
import { findBook } from './catalog.js';
import { OllamaClient } from './ollama.js';
import { HttpError, listFiles, OUTPOST_VERSION, readJson, writeJsonAtomic } from '../util.js';

/**
 * Opt-in update checks (off by default). When on, once a day it asks GitHub for Outpost's latest release, the Kiwix
 * catalog for newer editions of installed books, and Ollama's registry for newer versions of installed models. It
 * only reports; downloads start when someone clicks, and nothing is ever replaced or deleted. No identifiers are sent.
 */

export interface UpdateResults {
  checked: number;
  outpost: { current: string; latest: string; newer: boolean; url: string } | null;
  books: { file: string; newFile: string; title: string; size: number | null; url: string }[];
  models: { name: string }[];
  notes: string[];
}
interface UpdateState {
  enabled: boolean;
  lastCheck: number | null;
  results: UpdateResults | null;
}

const DAY = 86_400_000;
/** "<name>[_<flavour>]_<YYYY-MM>.zim", as the Kiwix catalog names its files. */
const ZIM_NAME = /^(.+?)(?:_(maxi|nopic|mini))?_(\d{4}-\d{2})\.zim$/;

const semver = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
export function isNewer(latest: string, current: string): boolean {
  const [a, b] = [semver(latest), semver(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export class UpdateChecker {
  private stateFile: string;
  private running: Promise<UpdateResults> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private cfg: Config, private ai: AiProvider) {
    this.stateFile = path.join(cfg.home, 'state.json');
  }

  private async state(): Promise<UpdateState> {
    const s = (await readJson<{ updates?: Partial<UpdateState> }>(this.stateFile, {})).updates ?? {};
    return { enabled: s.enabled === true, lastCheck: s.lastCheck ?? null, results: s.results ?? null };
  }

  private async save(patch: Partial<UpdateState>): Promise<UpdateState> {
    const all = await readJson<Record<string, unknown>>(this.stateFile, {});
    const next = { ...(await this.state()), ...patch };
    await writeJsonAtomic(this.stateFile, { ...all, updates: next });
    return next;
  }

  async status(): Promise<UpdateState & { checking: boolean; repo: string }> {
    return { ...(await this.state()), checking: !!this.running, repo: this.cfg.updates.repo };
  }

  /** Turning it on checks straight away; turning it off stops all checks (results stay until the next check). */
  async setEnabled(on: boolean): Promise<void> {
    await this.save({ enabled: on });
    if (on) void this.check().catch(() => undefined);
  }

  /** Checks now. Refused while turned off, so nothing is contacted unless someone opted in. */
  async check(): Promise<UpdateResults> {
    if (!(await this.state()).enabled) throw new HttpError(409, 'Turn on update checks first.');
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  /** Hourly tick: checks when on and the last check is a day old. */
  startSchedule(): void {
    const tick = async () => {
      const s = await this.state();
      if (s.enabled && (!s.lastCheck || Date.now() - s.lastCheck > DAY)) await this.check().catch(() => undefined);
    };
    this.timer = setInterval(() => void tick(), 3600_000);
    this.timer.unref();
    setTimeout(() => void tick(), 60_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async results(): Promise<UpdateResults | null> {
    return (await this.state()).results;
  }

  private async run(): Promise<UpdateResults> {
    const notes: string[] = [];
    const [outpost, books, models] = await Promise.all([this.checkOutpost(notes), this.checkBooks(notes), this.checkModels(notes)]);
    const results: UpdateResults = { checked: Date.now(), outpost, books, models, notes };
    await this.save({ lastCheck: results.checked, results });
    return results;
  }

  private async checkOutpost(notes: string[]): Promise<UpdateResults['outpost']> {
    const repo = this.cfg.updates.repo;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      notes.push('Outpost itself was not checked: set OUTPOST_UPDATE_REPO (e.g. "you/outpost") in ~/.config/outpost/env to the GitHub repository you install from.');
      return null;
    }
    try {
      const res = await fetch(`${this.cfg.updates.githubApi}/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) {
        notes.push(`${repo} has no published releases on GitHub yet.`);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json()) as { tag_name: string; html_url: string };
      const latest = r.tag_name.replace(/^v/, '');
      return { current: OUTPOST_VERSION, latest, newer: isNewer(latest, OUTPOST_VERSION), url: r.html_url };
    } catch (e) {
      notes.push(`Couldn't reach GitHub to check for a new Outpost (${(e as Error).message}).`);
      return null;
    }
  }

  private async checkBooks(notes: string[]): Promise<UpdateResults['books']> {
    const files = (await listFiles(this.cfg.dirs.zim, '.zim')).map((f) => f.name);
    const found: UpdateResults['books'] = [];
    let failed = 0;
    const queue = files.map((f) => [f, f.match(ZIM_NAME)] as const).filter(([, m]) => m);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [file, m] = next;
        const [, name, flavour = '', date] = m!;
        try {
          const entry = await findBook(this.cfg, name!, flavour);
          const newDate = entry?.fileName.match(ZIM_NAME)?.[3];
          if (entry && newDate && newDate > date! && !files.includes(entry.fileName)) {
            found.push({ file, newFile: entry.fileName, title: entry.title, size: entry.size, url: entry.url });
          }
        } catch {
          failed++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (failed) notes.push(`Couldn't check ${failed} book${failed === 1 ? '' : 's'}: the Kiwix catalog didn't answer.`);
    return found.sort((a, b) => a.file.localeCompare(b.file));
  }

  private async checkModels(notes: string[]): Promise<UpdateResults['models']> {
    if (!(this.ai instanceof OllamaClient)) return [];
    const installed = await this.ai.digests();
    if (!installed) {
      notes.push("Models were not checked: Ollama isn't answering.");
      return [];
    }
    const newer: UpdateResults['models'] = [];
    for (const { name, digest } of installed) {
      // "llama3.2:3b" (Ollama's library) or "user/model:tag". Models from other hosts have three parts
      // (hf.co/user/model) and aren't checked. A dot alone means nothing: "llama3.2" has one.
      const [repo, tag = 'latest'] = name.split(':');
      const parts = repo!.split('/');
      if (parts.length > 2) continue;
      const ref = parts.length === 1 ? `library/${repo}` : repo;
      try {
        const res = await fetch(`${this.cfg.updates.registry}/v2/${ref}/manifests/${tag}`, {
          headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) continue; // removed upstream or private: nothing to offer
        // Ollama's local digest is the sha256 of the manifest it pulled (checked on a real install).
        const remote = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
        if (remote !== digest) newer.push({ name });
      } catch {
        notes.push(`Couldn't reach Ollama's registry to check ${name}.`);
      }
    }
    return newer;
  }
}
