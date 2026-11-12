import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { Job, JobManager } from './jobs.js';
import { showCommand } from './apps.js';
import { childEnv } from './process.js';
import { HttpError } from '../util.js';

/** Optional add-ons an admin installs from their page, with the same scripts as from Terminal (pinned, safe to re-run). */
const INSTALLERS = {
  kolibri: { name: 'Kolibri', script: 'install-kolibri.sh', done: 'Kolibri is installed. Start it on the Education page.' },
  cyberchef: { name: 'CyberChef', script: 'fetch-cyberchef.sh', done: 'CyberChef is installed. Open it from Tools.' },
  mapfonts: { name: 'map fonts', script: 'fetch-map-assets.sh', done: 'Map fonts are installed. Maps now show place names.' },
} as const;

export type InstallerId = keyof typeof INSTALLERS;

export const isInstaller = (id: string): id is InstallerId => Object.hasOwn(INSTALLERS, id);

/** A script's output line as shown under Transfers: curl's progress bar ("#####   35.4%") becomes "Downloading: 35%". */
export function progressText(line: string): string {
  const bar = line.match(/^#+\s+(\d+(?:\.\d+)?)%$/);
  return bar ? `Downloading: ${Math.floor(Number(bar[1]))}%` : line.slice(0, 200);
}

export class InstallerService {
  private runs = new Map<InstallerId, Job>();

  /** `scripts`: where the install scripts are (tests pass stand-ins). */
  constructor(private cfg: Config, private jobs: JobManager, private scripts = fileURLToPath(new URL('../../scripts/', import.meta.url))) {}

  private argv(id: InstallerId): string[] {
    return [path.join(this.scripts, INSTALLERS[id].script)];
  }

  /** What the admin confirms, and the install in progress, if any. */
  status(id: InstallerId) {
    const job = this.runs.get(id);
    return { command: showCommand(this.argv(id)), job: job && (job.status === 'running' || job.status === 'queued') ? job : null };
  }

  /** Runs the script as a job once `confirmed` matches the command shown; a second request joins the running one. */
  start(id: InstallerId, confirmed: unknown): Job {
    const argv = this.argv(id);
    if (confirmed !== showCommand(argv)) throw new HttpError(409, 'The command changed since you looked at it. Review it again.');
    const running = this.status(id).job;
    if (running) return running;
    const { name, done } = INSTALLERS[id];
    const job = this.jobs.startTask('app-install', `Install ${name}`, (job, signal) =>
      new Promise<string>((resolve, reject) => {
        const env = { ...childEnv(), OUTPOST_HOME: this.cfg.home, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` };
        // Its own process group, so cancelling also stops the download or pip it started.
        const child = spawn(argv[0]!, [], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
        const stop = () => child.pid && process.kill(-child.pid, 'SIGTERM');
        signal.addEventListener('abort', stop, { once: true });
        const tail: string[] = [];
        const onData = (buf: Buffer) => {
          for (const line of buf.toString().split(/[\r\n]+/)) if (line.trim()) tail.push(line.trim());
          tail.splice(0, Math.max(0, tail.length - 20));
          job.message = progressText(tail.at(-1) ?? '');
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('error', reject);
        child.once('close', (code) => {
          signal.removeEventListener('abort', stop);
          if (code === 0) resolve(done);
          else reject(new Error(tail.findLast((l) => l.startsWith('Error:'))?.slice(7) ?? `The install stopped (exit code ${code}). Last message: ${tail.at(-1) ?? 'none'}`));
        });
      }),
    );
    this.runs.set(id, job);
    return job;
  }
}
