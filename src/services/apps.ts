import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { formatBytes, HttpError, readJson, resolveBin } from '../util.js';
import type { Job, JobManager } from './jobs.js';
import { childEnv, ManagedProcess } from './process.js';

/** One app on the shelf: from the bundled catalog, or added by an admin with the custom app form. */
export interface AppSpec {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  license?: string;
  note?: string;
  /** Install command as an argument list, e.g. ["brew", "install", "filebrowser"]. Custom apps have none. */
  install?: string[];
  /**
   * Or: a release archive per chip, pinned by SHA-256, from which one program is unpacked into {home}/bin.
   * Used when a package manager's build is missing something (Homebrew's File Browser has no web pages).
   */
  download?: { arm64?: Pinned; x64?: Pinned; extract: string };
  /** Program name looked up in PATH, or a path (same placeholders as args). */
  bin: string;
  /** May use {port}, {prefix} (/apps/<id>), {data} (~/Outpost/apps/<id>) and {home} (~/Outpost). */
  args: string[];
  /** Folders to create before the first start (same placeholders). */
  folders?: string[];
  port: number;
  /** The app can live under /apps/<id>/ (it takes a base path), so Outpost serves it; otherwise link to its port. */
  prefix: boolean;
  /** Path that answers when the app is ready, relative to the prefix when there is one. */
  health?: string;
  /** What members may do through /apps/<id>/: "read" (look, download) or "write" (everything). Admins always may. */
  members: 'read' | 'write';
  custom?: boolean;
}

interface Pinned {
  url: string;
  sha256: string;
}

/** An app for phones and computers: links to its official pages, and installers Outpost can keep for offline use. */
export interface DeviceApp {
  id: string;
  name: string;
  what: string;
  license?: string;
  page: string;
  platforms: { label: string; link?: string; file?: Pinned & { size: number } }[];
}

/**
 * Downloads `url` to `dest`, hashing as it goes, and keeps it only if the SHA-256 matches. Refuses up front when
 * the disk is too full for `size`.
 */
async function fetchVerified(url: string, sha256: string, dest: string, job: Job, signal: AbortSignal, size?: number): Promise<void> {
  if (size) {
    const st = await fsp.statfs(path.dirname(dest));
    if (size > st.bavail * st.bsize) throw new Error(`Not enough space: this needs ${formatBytes(size)}, and ${formatBytes(st.bavail * st.bsize)} is free.`);
  }
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
  job.total = Number(res.headers.get('content-length')) || size || null;
  const hash = createHash('sha256');
  const part = `${dest}.part`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          hash.update(chunk);
          job.received += chunk.length;
          yield chunk;
        }
      },
      fs.createWriteStream(part),
    );
    const got = hash.digest('hex');
    if (got !== sha256.toLowerCase()) throw new Error(`The download doesn't match its fingerprint (SHA-256 ${got}), so it wasn't kept.`);
    await fsp.rename(part, dest);
  } finally {
    await fsp.rm(part, { force: true });
  }
}

const run = promisify(execFile);

interface CustomApp {
  id: string;
  name: string;
  command: string;
  port: number;
  prefix: boolean;
  health?: string;
}

interface SavedState {
  custom: CustomApp[];
  /** Apps that were running when last asked, so they come back when Outpost restarts. */
  running: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Splits a command line into arguments the way a shell would for quotes and backslashes, without running a shell. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (quote) throw new HttpError(400, 'The command has a quote that is never closed.');
  if (has || cur) out.push(cur);
  return out;
}

/** An argument list as one line you could paste into Terminal (shown in the confirmation dialog). */
export function showCommand(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The Apps shelf: installs (after confirmation), starts and stops local web apps, each bound to 127.0.0.1. */
export class AppsService {
  private catalog: AppSpec[] = [];
  private devices: DeviceApp[] = [];
  private saving = new Map<string, Job>();
  private state: SavedState = { custom: [], running: [] };
  private procs = new Map<string, ManagedProcess>();
  private installs = new Map<string, Job>();
  private file: string;

  constructor(private cfg: Config, private jobs: JobManager) {
    this.file = path.join(cfg.home, 'apps.json');
  }

  async load(): Promise<void> {
    const raw = await readJson<{ apps?: AppSpec[]; devices?: DeviceApp[] }>(this.cfg.appsFile, {});
    this.devices = (raw.devices ?? []).filter((d) => ID_RE.test(d?.id ?? '') && Array.isArray(d.platforms));
    this.catalog = (raw.apps ?? []).filter((a) => ID_RE.test(a?.id ?? '') && a.bin && Array.isArray(a.args) && Number.isInteger(a.port));
    const saved = await readJson<Partial<SavedState>>(this.file, {});
    this.state = { custom: saved.custom ?? [], running: saved.running ?? [] };
  }

  private async save(): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); // custom commands are admin-only
    await fsp.rename(tmp, this.file);
  }

  private fromCustom(c: CustomApp): AppSpec {
    const [bin = '', ...args] = splitCommand(c.command);
    return { id: c.id, name: c.name, description: 'Added with the custom app form.', bin, args, port: c.port, prefix: c.prefix, health: c.health, members: 'read', custom: true };
  }

  all(): AppSpec[] {
    return [...this.catalog, ...this.state.custom.map((c) => this.fromCustom(c))];
  }

  get(id: string): AppSpec | undefined {
    return this.all().find((a) => a.id === id);
  }

  private need(id: string): AppSpec {
    const app = this.get(id);
    if (!app) throw new HttpError(404, `There's no app called ${id}.`);
    return app;
  }

  private proc(id: string): ManagedProcess {
    let p = this.procs.get(id);
    if (!p) this.procs.set(id, (p = new ManagedProcess(`app:${id}`, 5000)));
    return p;
  }

  private fill(app: AppSpec, s: string): string {
    return s
      .replaceAll('{port}', String(app.port))
      .replaceAll('{prefix}', `/apps/${app.id}`)
      .replaceAll('{data}', path.join(this.cfg.home, 'apps', app.id))
      .replaceAll('{home}', this.cfg.home);
  }

  private binOf(app: AppSpec): string | null {
    return resolveBin(this.fill(app, app.bin));
  }

  /** The exact program and arguments a start runs: what the confirmation dialog shows. */
  startArgv(app: AppSpec): string[] {
    return [this.binOf(app) ?? this.fill(app, app.bin), ...app.args.map((a) => this.fill(app, a))];
  }

  installArgv(app: AppSpec): string[] | null {
    if (!app.install?.length) return null;
    const [bin, ...args] = app.install;
    return [resolveBin(bin!) ?? bin!, ...args];
  }

  private pinned(app: AppSpec): Pinned | null {
    return app.download?.[process.arch === 'arm64' ? 'arm64' : 'x64'] ?? null;
  }

  /** What an install does, in words or as a command: shown in the dialog, and what the admin must confirm. */
  installText(app: AppSpec): string | null {
    const pin = this.pinned(app);
    if (pin) return `Download ${pin.url}\nCheck its SHA-256 is ${pin.sha256}\nUnpack ${app.download!.extract} into ${path.join(this.cfg.home, 'bin')}`;
    const argv = this.installArgv(app);
    return argv ? showCommand(argv) : null;
  }

  private async ready(app: AppSpec): Promise<boolean> {
    const url = `http://127.0.0.1:${app.port}${app.prefix ? `/apps/${app.id}` : ''}${app.health ?? '/'}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async list(admin: boolean) {
    return Promise.all(
      this.all().map(async (app) => {
        const p = this.procs.get(app.id);
        const job = this.installs.get(app.id);
        const install = this.installText(app);
        return {
          id: app.id,
          name: app.name,
          description: app.description,
          homepage: app.homepage ?? null,
          license: app.license ?? null,
          note: app.note ?? null,
          custom: !!app.custom,
          port: app.port,
          url: app.prefix ? `/apps/${app.id}/` : null,
          installed: !!this.binOf(app),
          state: p?.state ?? 'stopped',
          ready: p?.running ? await this.ready(app) : false,
          installing: job && (job.status === 'running' || job.status === 'queued') ? job.id : null,
          ...(admin
            ? { logs: p?.logs.slice(-8) ?? [], commands: { install, start: showCommand(this.startArgv(app)) } }
            : {}),
        };
      }),
    );
  }

  /** `confirmed` must be the command the person saw, so nothing different runs if the catalog changed meanwhile. */
  private check(argv: string[], confirmed: unknown): void {
    if (confirmed !== showCommand(argv)) throw new HttpError(409, 'The command changed since you looked at it. Review it again.');
  }

  install(id: string, confirmed: unknown): Job {
    const app = this.need(id);
    const text = this.installText(app);
    if (!text) throw new HttpError(400, `${app.name} has no install step for this Mac. Install it yourself, then start it here.`);
    if (confirmed !== text) throw new HttpError(409, 'The command changed since you looked at it. Review it again.');
    const pin = this.pinned(app);
    const argv = this.installArgv(app);
    if (!pin && argv && !resolveBin(app.install![0]!)) throw new HttpError(409, `Can't find ${app.install![0]}. Install Homebrew from https://brew.sh first.`);
    const prev = this.installs.get(id);
    if (prev && (prev.status === 'running' || prev.status === 'queued')) return prev;
    const job = this.jobs.startTask('app-install', `Install ${app.name}`, (job, signal) =>
      pin ? this.fetchPinned(app, pin, job, signal) : this.runInstall(app, argv!, job, signal),
    );
    this.installs.set(id, job);
    return job;
  }

  private runInstall(app: AppSpec, argv: string[], job: Job, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), signal });
      const tail: string[] = [];
      const onData = (buf: Buffer) => {
        for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) tail.push(line.trim());
        tail.splice(0, Math.max(0, tail.length - 20));
        job.message = tail[tail.length - 1] ?? '';
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(`${app.name} is installed`);
        else reject(new Error(`The install stopped (exit code ${code}). Last message: ${tail[tail.length - 1] ?? 'none'}`));
      });
    });
  }

  /** Downloads a pinned archive, refuses it unless the SHA-256 matches, and unpacks the one program into {home}/bin. */
  private async fetchPinned(app: AppSpec, pin: Pinned, job: Job, signal: AbortSignal): Promise<string> {
    const work = path.join(this.cfg.home, 'apps', app.id, '.install');
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    try {
      job.message = 'Downloading';
      const archive = path.join(work, 'archive.tar.gz');
      await fetchVerified(pin.url, pin.sha256, archive, job, signal);
      job.message = 'Unpacking';
      const name = app.download!.extract;
      await run('/usr/bin/tar', ['-xzf', archive, '-C', work, name], { timeout: 60_000 });
      const binDir = path.join(this.cfg.home, 'bin');
      await fsp.mkdir(binDir, { recursive: true });
      await fsp.chmod(path.join(work, name), 0o755);
      await fsp.rename(path.join(work, name), path.join(binDir, path.basename(name)));
      return `${app.name} is installed`;
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }

  async start(id: string, confirmed: unknown, remember = true): Promise<void> {
    const app = this.need(id);
    const argv = this.startArgv(app);
    if (confirmed !== null) this.check(argv, confirmed);
    if (!this.binOf(app)) throw new HttpError(409, `${app.name} isn't installed yet (can't find ${this.fill(app, app.bin)}).`);
    const p = this.proc(id);
    if (p.running) return;
    await fsp.mkdir(path.join(this.cfg.home, 'apps', app.id), { recursive: true });
    for (const f of app.folders ?? []) await fsp.mkdir(this.fill(app, f), { recursive: true });
    p.start(argv[0]!, argv.slice(1));
    if (remember && !this.state.running.includes(id)) {
      this.state.running.push(id);
      await this.save();
    }
  }

  async stop(id: string): Promise<void> {
    this.need(id);
    await this.procs.get(id)?.stop();
    this.state.running = this.state.running.filter((r) => r !== id);
    await this.save();
  }

  /** Starts what was running when Outpost last stopped (each was confirmed when first started). */
  async resume(): Promise<void> {
    for (const id of this.state.running) if (this.get(id)) await this.start(id, null, false).catch(() => undefined);
  }

  /** Stops every app without forgetting which were on. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.values()].map((p) => p.stop()));
  }

  /** Where saved installers live: inside File Browser's folder, so any signed-in device can fetch them. */
  get installersDir(): string {
    return path.join(this.cfg.home, 'files', 'Installers');
  }

  private fileOf(id: string, index: unknown) {
    const d = this.devices.find((x) => x.id === id);
    const file = d?.platforms[Number(index)]?.file;
    if (!d || !file) throw new HttpError(404, 'There is no such installer in the catalog.');
    return { d, file, name: path.basename(new URL(file.url).pathname) };
  }

  /** What saving an installer does: shown in the dialog, and what the admin must confirm. */
  saveText(id: string, index: number): string {
    const { file, name } = this.fileOf(id, index);
    return `Download ${file.url}\nCheck its SHA-256 is ${file.sha256}\nSave it as ${path.join(this.installersDir, name)} (${formatBytes(file.size)})`;
  }

  listDevices(admin: boolean) {
    return this.devices.map((d) => ({
      id: d.id,
      name: d.name,
      what: d.what,
      license: d.license ?? null,
      page: d.page,
      platforms: d.platforms.map((p, i) => {
        if (!p.file) return { label: p.label, link: p.link ?? null };
        const name = path.basename(new URL(p.file.url).pathname);
        let saved = false;
        try {
          saved = fs.statSync(path.join(this.installersDir, name)).size === p.file.size;
        } catch {
          /* not saved */
        }
        const job = this.saving.get(`${d.id}/${i}`);
        return {
          label: p.label,
          link: p.link ?? null,
          file: name,
          size: p.file.size,
          saved,
          href: saved ? `/installers/${encodeURIComponent(name)}` : null,
          saving: job && (job.status === 'running' || job.status === 'queued') ? job.id : null,
          ...(admin ? { confirm: this.saveText(d.id, i) } : {}),
        };
      }),
    }));
  }

  saveInstaller(id: string, index: unknown, confirmed: unknown): Job {
    const { d, file, name } = this.fileOf(id, index);
    if (confirmed !== this.saveText(id, Number(index))) throw new HttpError(409, 'The download changed since you looked at it. Review it again.');
    const key = `${id}/${Number(index)}`;
    const prev = this.saving.get(key);
    if (prev && (prev.status === 'running' || prev.status === 'queued')) return prev;
    const job = this.jobs.startTask('app-install', `Save ${d.name} installer`, async (job, signal) => {
      await fsp.mkdir(this.installersDir, { recursive: true });
      await fetchVerified(file.url, file.sha256, path.join(this.installersDir, name), job, signal, file.size);
      return `Saved ${name}`;
    });
    this.saving.set(key, job);
    return job;
  }

  async addCustom(body: Record<string, unknown>): Promise<AppSpec> {
    const id = String(body.id ?? '').trim().toLowerCase();
    if (!ID_RE.test(id)) throw new HttpError(400, 'The short name uses 1–32 letters a–z, digits or "-", starting with a letter or digit.');
    if (this.get(id)) throw new HttpError(409, `There's already an app called ${id}.`);
    const name = String(body.name ?? '').trim().slice(0, 60) || id;
    const command = String(body.command ?? '').trim();
    if (!command || command.length > 1000) throw new HttpError(400, 'Enter the command that starts the app (up to 1000 characters).');
    if (!splitCommand(command).length) throw new HttpError(400, 'Enter the command that starts the app.');
    const port = Number(body.port);
    const taken = [this.cfg.port, this.cfg.kiwixPort, this.cfg.kolibri.port, this.cfg.kolibri.zipPort, 11434, ...this.all().map((a) => a.port)];
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, 'The port must be a whole number from 1024 to 65535.');
    if (taken.includes(port)) throw new HttpError(409, `Port ${port} is already used by Outpost or another app.`);
    const health = String(body.health ?? '').trim();
    if (health && !/^\/[\w\-./?=&%]*$/.test(health)) throw new HttpError(400, 'The ready check must be a path starting with "/".');
    const app: CustomApp = { id, name, command, port, prefix: body.prefix === true, ...(health ? { health } : {}) };
    this.state.custom.push(app);
    await this.save();
    return this.fromCustom(app);
  }

  async removeCustom(id: string): Promise<void> {
    const app = this.need(id);
    if (!app.custom) throw new HttpError(400, `${app.name} comes with Outpost and can't be removed from the shelf.`);
    await this.procs.get(id)?.stop();
    this.procs.delete(id);
    this.state.custom = this.state.custom.filter((c) => c.id !== id);
    this.state.running = this.state.running.filter((r) => r !== id);
    await this.save();
  }
}
