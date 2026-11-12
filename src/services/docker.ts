import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { Job, JobManager } from './jobs.js';
import { showCommand } from './apps.js';
import { childEnv } from './process.js';
import { HttpError, resolveBin } from '../util.js';

/**
 * Docker apps: an admin runs a container from the Apps page, through Docker Desktop or OrbStack (whichever installed
 * the docker command). Off unless OUTPOST_DOCKER=1. Outpost builds the whole `docker run` itself from a few checked
 * fields, so there is no way to pass --privileged, host networking, the Docker socket or a folder outside
 * ~/Outpost/containers/<name>/; the admin confirms the exact command first, and it runs with execFile (no shell).
 * Outpost lists and touches only containers it labelled com.outpost.managed=true.
 */

const run = promisify(execFile);
export const LABEL = 'com.outpost.managed=true';
const PREFIX = 'outpost-';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// [registry[:port]/]path[:tag][@sha256:digest], as Docker accepts, lower case.
const IMAGE_RE = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TARGET_RE = /^\/[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const FIELDS = new Set(['image', 'name', 'port', 'hostPort', 'env', 'folders']);
/** Words that mean someone is trying for more than the form offers. */
const REFUSED: [RegExp, string][] = [
  [/privileged/i, 'Outpost never runs containers with --privileged.'],
  [/^(network|net)$/i, "Outpost doesn't change a container's network (no host networking)."],
  [/^(cap|capadd|cap_add|caps|device|devices|pid|ipc|userns|securityopt|security_opt|volumes|volume|mounts|mount|args|command|extra)$/i, 'Outpost only takes the fields on its form.'],
];
/** Docker's closing hint after an error, which says nothing about what went wrong. */
const HELP_HINT = /^Run '[^']*--help' for more information/;
const PORT_TAKEN = /port is already allocated|address already in use/i;

/** True when something on this Mac already listens on 127.0.0.1:port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

const portTaken = (port: number) => `Port ${port} on this Mac is already in use by another program. Choose another port.`;

const DOCKER_HELP = [
  { name: 'Docker Desktop', url: 'https://www.docker.com/products/docker-desktop/' },
  { name: 'OrbStack', url: 'https://orbstack.dev/download' },
];

export interface DockerSpec {
  image: string;
  name: string;
  /** The port the app listens on inside the container. */
  port: number;
  /** The port on this Mac, bound to 127.0.0.1 only. */
  hostPort: number;
  env: { key: string; value: string }[];
  /** Folders under ~/Outpost/containers/<name>/ ("" for that folder itself), and where they appear inside. */
  folders: { folder: string; target: string; readOnly: boolean }[];
}

export interface Container {
  name: string;
  image: string;
  state: string;
  status: string;
  hostPort: number | null;
}

export class DockerService {
  private runs = new Map<string, Job>();

  constructor(private cfg: Config, private jobs: JobManager, private reservedPorts: () => number[]) {}

  get root(): string {
    return path.join(this.cfg.home, 'containers');
  }

  /** The docker command: as configured, on the PATH, or where Docker Desktop and OrbStack put it. */
  bin(): string | null {
    const found = resolveBin(this.cfg.docker.bin);
    if (found || this.cfg.docker.bin.includes('/')) return found;
    for (const p of [path.join(os.homedir(), '.docker', 'bin', 'docker'), '/Applications/Docker.app/Contents/Resources/bin/docker', path.join(os.homedir(), '.orbstack', 'bin', 'docker')]) {
      if (resolveBin(p)) return p;
    }
    return null;
  }

  private env(bin: string): NodeJS.ProcessEnv {
    // Docker Desktop's credential helpers sit next to the docker command.
    const env = childEnv();
    env.PATH = `${path.dirname(bin)}${path.delimiter}${env.PATH ?? ''}`;
    return env;
  }

  private async docker(args: string[], timeout = 30_000): Promise<string> {
    const bin = this.need();
    try {
      const r = await run(bin, args, { timeout, env: this.env(bin), maxBuffer: 4 * 1024 * 1024 });
      return `${r.stdout}`;
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new HttpError(502, `Docker said: ${String(err.stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
  }

  private need(): string {
    if (!this.cfg.docker.enabled) throw new HttpError(409, 'Docker apps are off. Turn them on under Apps, Docker apps.');
    const bin = this.bin();
    if (!bin) throw new HttpError(412, 'Docker isn\'t installed on this Mac. Install Docker Desktop or OrbStack, then reload.');
    return bin;
  }

  async status() {
    if (!this.cfg.docker.enabled) return { enabled: false, cli: null, running: false, engine: null, version: null, help: DOCKER_HELP };
    const bin = this.bin();
    if (!bin) return { enabled: true, cli: null, running: false, engine: null, version: null, help: DOCKER_HELP };
    const env = this.env(bin);
    const version = await run(bin, ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000, env }).then((r) => r.stdout.trim() || null, () => null);
    const context = await run(bin, ['context', 'show'], { timeout: 10_000, env }).then((r) => r.stdout.trim(), () => '');
    const engine = /orbstack/i.test(context) || bin.includes('.orbstack') ? 'OrbStack' : 'Docker Desktop';
    return { enabled: true, cli: bin, running: !!version, engine, version, help: DOCKER_HELP };
  }

  /** Checks a request and fills in defaults; anything not on the form is refused, with the reason. */
  check(body: Record<string, unknown>): DockerSpec {
    for (const key of Object.keys(body ?? {})) {
      const bad = REFUSED.find(([re]) => re.test(key));
      if (bad) throw new HttpError(400, bad[1]);
      if (!FIELDS.has(key)) throw new HttpError(400, `Outpost doesn't know the field "${key.slice(0, 40)}".`);
    }
    const image = String(body.image ?? '').trim();
    if (!image || image.length > 255 || !IMAGE_RE.test(image)) throw new HttpError(400, 'The image is a name like "nginx", "nginx:1.27" or "ghcr.io/owner/app:tag" (lower case).');
    if (/docker\.sock/i.test(image)) throw new HttpError(400, 'Outpost never gives a container the Docker socket.');
    const name = String(body.name ?? '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'The short name uses 1–32 letters a–z, digits or "-", starting with a letter or digit.');
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "The app's port inside the container is a whole number from 1 to 65535.");
    const hostPort = Number(body.hostPort);
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new HttpError(400, 'The port on this Mac is a whole number from 1024 to 65535.');
    if (this.reservedPorts().includes(hostPort)) throw new HttpError(409, `Port ${hostPort} is already used by Outpost or one of its apps.`);

    const env = Array.isArray(body.env) ? body.env : body.env == null ? [] : null;
    if (!env || env.length > 50) throw new HttpError(400, 'Up to 50 settings (environment variables).');
    const envOut = env.map((e: { key?: unknown; value?: unknown }) => {
      const key = String(e?.key ?? '').trim();
      const value = String(e?.value ?? '');
      if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `"${key.slice(0, 40)}" isn't a valid setting name (letters, digits and _, not starting with a digit).`);
      if (value.length > 4096 || /[\0\r\n]/.test(value)) throw new HttpError(400, `The value of ${key} must be one line of up to 4096 characters.`);
      return { key, value };
    });

    const folders = Array.isArray(body.folders) ? body.folders : body.folders == null ? [] : null;
    if (!folders || folders.length > 10) throw new HttpError(400, 'Up to 10 folders.');
    const targets = new Set<string>();
    const foldersOut = folders.map((f: { folder?: unknown; target?: unknown; readOnly?: unknown }) => {
      const folder = String(f?.folder ?? '').trim().replace(/\/+$/, '');
      if (folder.startsWith('/') || folder.startsWith('~')) throw new HttpError(400, `"${folder.slice(0, 60)}" must be a folder inside containers/${name}/, not a path on the Mac.`);
      const target = String(f?.target ?? '').trim().replace(/\/+$/, '');
      if (folder && (folder.split('/').some((p) => !p || p === '.' || p === '..' || !/^[\w .@+-]+$/.test(p)) || folder.length > 200)) {
        throw new HttpError(400, `"${folder.slice(0, 60)}" must be a folder inside containers/${name}/ (no "..").`);
      }
      if (!TARGET_RE.test(target) || target.length > 200) throw new HttpError(400, `"${target.slice(0, 60)}" must be a full path inside the container, like /data.`);
      if (/docker\.sock/i.test(folder + target) || /^\/(var\/)?run(\/|$)/.test(target)) throw new HttpError(400, 'Outpost never gives a container the Docker socket.');
      if (['/', '/proc', '/sys', '/dev', '/etc'].some((p) => target === p || target.startsWith(`${p}/`))) throw new HttpError(400, `Outpost doesn't put folders over ${target}.`);
      if (targets.has(target)) throw new HttpError(400, `Two folders both go to ${target}.`);
      targets.add(target);
      return { folder, target, readOnly: f?.readOnly === true };
    });
    return { image, name, port, hostPort, env: envOut, folders: foldersOut };
  }

  /** Where one container's folders live: always inside ~/Outpost/containers/<name>/. */
  private source(spec: DockerSpec, folder: string): string {
    return path.join(this.root, spec.name, folder);
  }

  /** The exact `docker run` arguments (after the docker command itself). */
  argv(spec: DockerSpec): string[] {
    const args = ['run', '--detach', '--name', PREFIX + spec.name, '--label', LABEL, '--label', `com.outpost.name=${spec.name}`, '--restart', 'unless-stopped'];
    args.push('--publish', `127.0.0.1:${spec.hostPort}:${spec.port}`);
    for (const e of spec.env) args.push('--env', `${e.key}=${e.value}`);
    for (const f of spec.folders) args.push('--mount', `type=bind,source=${this.source(spec, f.folder)},target=${f.target}${f.readOnly ? ',readonly' : ''}`);
    args.push(spec.image);
    return args;
  }

  /** What the admin sees and must confirm: the whole command as it would be typed. */
  async preview(body: Record<string, unknown>) {
    const spec = this.check(body);
    if (await portInUse(spec.hostPort)) throw new HttpError(409, portTaken(spec.hostPort));
    const bin = this.bin() ?? 'docker';
    return { command: showCommand([bin, ...this.argv(spec)]), url: `http://localhost:${spec.hostPort}/` };
  }

  /** Last line of defence: nothing in the arguments may widen what the container can reach. */
  private assertSafe(spec: DockerSpec, args: string[]): void {
    const root = path.join(fs.realpathSync(this.root), spec.name) + path.sep;
    for (const a of args) {
      if (/^--(privileged|network|net|pid|ipc|cap-add|device|security-opt|userns|volume)\b|^-v$/.test(a) || /docker\.sock/i.test(a)) {
        throw new HttpError(400, `Refused: ${a.slice(0, 60)}`);
      }
    }
    for (const f of spec.folders) {
      const real = fs.realpathSync(this.source(spec, f.folder)) + path.sep;
      if (!real.startsWith(root)) throw new HttpError(400, `"${f.folder}" leads outside containers/${spec.name}/.`);
      if (real.includes(',')) throw new HttpError(400, 'Folder paths may not contain commas.');
    }
  }

  /** Runs a confirmed `docker run` as a job (the image may need downloading first). */
  async start(body: Record<string, unknown>, confirmed: unknown): Promise<Job> {
    const bin = this.need();
    const spec = this.check(body);
    const args = this.argv(spec);
    if (confirmed !== showCommand([bin, ...args])) throw new HttpError(409, 'The command changed since you looked at it. Review it again.');
    if ((await this.list()).some((c) => c.name === spec.name)) throw new HttpError(409, `There's already a Docker app called ${spec.name}. Remove it first.`);
    const busy = this.runs.get(spec.name);
    if (busy?.status === 'running') throw new HttpError(409, `${spec.name} is already starting.`);
    if (await portInUse(spec.hostPort)) throw new HttpError(409, portTaken(spec.hostPort));
    await fsp.mkdir(path.join(this.root, spec.name), { recursive: true, mode: 0o700 });
    for (const f of spec.folders) await fsp.mkdir(this.source(spec, f.folder), { recursive: true });
    this.assertSafe(spec, args);
    const job = this.jobs.startTask('docker', `Docker app ${spec.name} (${spec.image})`, (job, signal) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env(bin) });
        const tail: string[] = [];
        const onData = (buf: Buffer) => {
          const lines = buf.toString().split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !HELP_HINT.test(l));
          if (lines.length) job.message = lines.at(-1)!.slice(0, 200);
          tail.push(...lines);
          if (tail.length > 20) tail.splice(0, tail.length - 20);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const abort = () => child.kill('SIGTERM');
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', reject);
        child.once('exit', (code) => {
          signal.removeEventListener('abort', abort);
          if (code === 0) return resolve(`Running. Open http://localhost:${spec.hostPort}/ on this Mac.`);
          const said = tail.slice(-2).join(' | ').replace(/docker: Error response from daemon: /g, '');
          const why = PORT_TAKEN.test(said) ? portTaken(spec.hostPort) : `docker run stopped with an error: ${said.slice(0, 300)}`;
          this.removeUnstarted(spec.name).then(() => reject(new Error(why)), () => reject(new Error(why)));
        });
      }),
    );
    this.runs.set(spec.name, job);
    return job;
  }

  /** Only the containers Outpost made (its label and name prefix); anything else on this Mac is left alone. */
  async list(): Promise<Container[]> {
    const out = await this.docker(['ps', '--all', '--no-trunc', '--filter', `label=${LABEL}`, '--format', '{{json .}}']);
    const list: Container[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      let c: { Names?: string; Image?: string; State?: string; Status?: string; Ports?: string; Labels?: string };
      try {
        c = JSON.parse(line);
      } catch {
        continue;
      }
      const full = String(c.Names ?? '');
      if (!full.startsWith(PREFIX) || !String(c.Labels ?? '').split(',').includes(LABEL)) continue;
      const port = String(c.Ports ?? '').match(/127\.0\.0\.1:(\d+)->/);
      list.push({ name: full.slice(PREFIX.length), image: String(c.Image ?? ''), state: String(c.State ?? ''), status: String(c.Status ?? ''), hostPort: port ? Number(port[1]) : null });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A failed `docker run` can leave its container made but never started; only Outpost's own is removed. */
  private async removeUnstarted(name: string): Promise<void> {
    if ((await this.list()).some((c) => c.name === name && c.state === 'created')) await this.docker(['rm', '--force', PREFIX + name], 60_000);
  }

  private async managed(name: string): Promise<string> {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'Invalid name');
    if (!(await this.list()).some((c) => c.name === name)) throw new HttpError(404, `Outpost has no Docker app called ${name}.`);
    return PREFIX + name;
  }

  async act(name: string, action: 'start' | 'stop' | 'remove'): Promise<void> {
    const id = await this.managed(name);
    if (action === 'start') await this.docker(['start', id]);
    if (action === 'stop') await this.docker(['stop', '--time', '10', id], 60_000);
    // Removing keeps its folder in ~/Outpost/containers/<name>/.
    if (action === 'remove') await this.docker(['rm', '--force', id], 60_000);
  }

  async logs(name: string): Promise<string> {
    const id = await this.managed(name);
    const bin = this.need();
    const r = await run(bin, ['logs', '--tail', '200', id], { timeout: 20_000, env: this.env(bin), maxBuffer: 4 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string }) => e);
    return `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-64 * 1024);
  }
}
