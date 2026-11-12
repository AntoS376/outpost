import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { HttpError, readJson, writeJsonAtomic } from '../util.js';
import { childEnv, ManagedProcess } from './process.js';

const run = promisify(execFile);
const INSTALL = './scripts/install-kolibri.sh';

export type KolibriState = 'not-installed' | 'python-missing' | 'stopped' | 'starting' | 'running' | 'crashed';

const executable = (p: string) => {
  try {
    fs.accessSync(p, fs.constants.X_OK); // follows symlinks, so a venv whose Python was removed fails here
    return true;
  } catch {
    return false;
  }
};

/** Runs Kolibri (offline courses) from ~/Outpost/kolibri-venv as a supervised child, served on loopback under /kolibri. */
export class KolibriService {
  // Kolibri shuts down cleanly in about 2 s; give it longer before forcing it.
  readonly proc = new ManagedProcess('kolibri', 15_000);
  private ready = false;
  private checking: Promise<void> | null = null;
  private stateFile: string;

  constructor(private cfg: Config) {
    this.stateFile = path.join(cfg.home, 'state.json');
  }

  private get bin(): string {
    return path.join(this.cfg.kolibri.venv, 'bin', 'kolibri');
  }

  /** Only what Kolibri needs: its data folder, loopback-only ports, the /kolibri prefix, and no LAN announcements. */
  private env(): NodeJS.ProcessEnv {
    return {
      KOLIBRI_HOME: this.cfg.kolibri.home,
      KOLIBRI_LISTEN_ADDRESS: '127.0.0.1',
      KOLIBRI_URL_PATH_PREFIX: '/kolibri/',
      KOLIBRI_ZIP_CONTENT_PORT: String(this.cfg.kolibri.zipPort),
      KOLIBRI_ZEROCONF_ENABLED: 'false',
    };
  }

  private installState(): 'not-installed' | 'python-missing' | null {
    if (!fs.existsSync(this.cfg.kolibri.venv) || !executable(this.bin)) return 'not-installed';
    if (!executable(path.join(this.cfg.kolibri.venv, 'bin', 'python'))) return 'python-missing';
    return null;
  }

  private async remember(on: boolean): Promise<void> {
    await writeJsonAtomic(this.stateFile, { ...(await readJson<Record<string, unknown>>(this.stateFile, {})), kolibri: on });
  }

  async start(): Promise<void> {
    const missing = this.installState();
    if (missing) throw new HttpError(409, this.explain(missing));
    if (this.proc.running) return;
    // A Kolibri left behind by an Outpost crash would hold the port; `kolibri stop` ends it via its pid file.
    await run(this.bin, ['stop'], { env: { ...childEnv(), ...this.env() }, timeout: 20_000 }).catch(() => undefined);
    this.ready = false;
    this.proc.start(this.bin, ['start', '--foreground', '--port', String(this.cfg.kolibri.port)], this.env());
    await this.remember(true);
  }

  async stop(remember = true): Promise<void> {
    await this.proc.stop();
    this.ready = false;
    if (remember) await this.remember(false);
  }

  /** Starts Kolibri at launch if it was running when Outpost last stopped. */
  async resume(): Promise<void> {
    const state = await readJson<{ kolibri?: boolean }>(this.stateFile, {});
    if (state.kolibri && !this.installState()) await this.start().catch(() => undefined);
  }

  private async check(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.cfg.kolibri.port}/kolibri/api/public/info/`, { signal: AbortSignal.timeout(1500) });
      this.ready = res.ok && ((await res.json()) as { application?: string }).application === 'kolibri';
    } catch {
      this.ready = false;
    }
  }

  private explain(state: KolibriState): string {
    switch (state) {
      case 'not-installed':
        return `Kolibri isn't installed. An admin can install it below, or run ${INSTALL} in Terminal in the Outpost folder (it gets a suitable Python with Homebrew if needed).`;
      case 'python-missing':
        return `Kolibri's Python is missing (a Homebrew upgrade can remove it). An admin can repair it below, or run ${INSTALL} again.`;
      case 'crashed':
        return `Kolibri stopped repeatedly. ${this.proc.logs.length ? `Last message: ${this.proc.logs.at(-1)}` : ''}`;
      case 'starting':
        return 'Kolibri is starting. The first start can take a minute.';
      default:
        return '';
    }
  }

  async status(): Promise<{ state: KolibriState; message: string; url: string; port: number; zipPort: number; logs: string[] }> {
    const missing = this.installState();
    let state: KolibriState;
    if (missing) state = missing;
    else if (this.proc.state === 'crashed') state = 'crashed';
    else if (!this.proc.running) state = 'stopped';
    else {
      this.checking ??= this.check().finally(() => (this.checking = null));
      await this.checking;
      state = this.ready ? 'running' : 'starting';
    }
    return { state, message: this.explain(state), url: '/kolibri/', port: this.cfg.kolibri.port, zipPort: this.cfg.kolibri.zipPort, logs: this.proc.logs.slice(-8) };
  }
}
