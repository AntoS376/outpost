import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from '../config.js';
import { listFiles, resolveBin } from '../util.js';
import path from 'node:path';

export type ProcState = 'stopped' | 'starting' | 'running' | 'crashed';

/** Outpost's environment minus its secrets, for the programs it starts. */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OUTPOST_PASSWORD;
  delete env.OUTPOST_AI_API_KEY;
  return env;
}

/** Supervises one long-running child process: restart with backoff, bounded log tail. */
export class ManagedProcess {
  state: ProcState = 'stopped';
  logs: string[] = [];
  restarts = 0;
  private child: ChildProcess | null = null;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private crashTimes: number[] = [];
  private spec: { bin: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;

  /** `stopGraceMs`: how long to wait after SIGTERM before SIGKILL. */
  constructor(public readonly name: string, private stopGraceMs = 3000) {}

  get running(): boolean {
    return this.state === 'running' || this.state === 'starting';
  }

  /** `env` is added to a copy of Outpost's environment with its own secrets removed. */
  start(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
    this.spec = { bin, args, env: { ...childEnv(), ...env } };
    this.stopping = false;
    this.launch();
  }

  private launch(): void {
    if (!this.spec) return;
    this.state = 'starting';
    const child = spawn(this.spec.bin, this.spec.args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.spec.env });
    this.child = child;
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) this.logs.push(line);
      if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('spawn', () => {
      if (this.child === child) this.state = 'running';
    });
    child.once('error', (err) => {
      this.logs.push(`spawn error: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      this.logs.push(`exited (code=${code}, signal=${signal})`);
      const now = Date.now();
      this.crashTimes = this.crashTimes.filter((t) => now - t < 60_000);
      this.crashTimes.push(now);
      if (this.crashTimes.length > 5) {
        this.state = 'crashed';
        return;
      }
      this.restarts++;
      const delay = Math.min(30_000, 1000 * 2 ** (this.crashTimes.length - 1));
      this.state = 'starting';
      this.timer = setTimeout(() => this.launch(), delay);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), this.stopGraceMs);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.child = null;
    this.state = 'stopped';
  }
}

export type KiwixReason = 'no-content' | 'no-binary' | null;

/** Runs kiwix-serve over every ZIM in the library folder and restarts it when the set changes. */
export class KiwixService {
  readonly proc = new ManagedProcess('kiwix-serve');
  reason: KiwixReason = 'no-content';
  zimCount = 0;
  private key = '';
  private chain: Promise<void> = Promise.resolve();

  constructor(private cfg: Config) {}

  /** Serialised so overlapping triggers (two downloads finishing together) can't race. */
  sync(): Promise<void> {
    this.chain = this.chain.then(() => this.doSync()).catch(() => undefined);
    return this.chain;
  }

  private async doSync(): Promise<void> {
    const files = (await listFiles(this.cfg.dirs.zim, '.zim')).map((f) => path.join(this.cfg.dirs.zim, f.name));
    this.zimCount = files.length;
    if (files.length === 0) {
      await this.proc.stop();
      this.key = '';
      this.reason = 'no-content';
      return;
    }
    const bin = resolveBin(this.cfg.kiwixBin);
    if (!bin) {
      this.reason = 'no-binary';
      return;
    }
    this.reason = null;
    const key = files.join('|');
    if (key === this.key && this.proc.running) return;
    await this.proc.stop();
    this.proc.start(bin, [
      '--port',
      String(this.cfg.kiwixPort),
      '--address',
      '127.0.0.1',
      '--urlRootLocation=/kiwix',
      '--blockexternal',
      '--threads',
      '4',
      // Exit if Outpost dies, so a crash never leaves an orphan holding the port.
      `--attachToProcess=${process.pid}`,
      // One damaged ZIM should not stop the whole library from starting.
      '--skipInvalid',
      ...files,
    ]);
    this.key = key;
  }

  /** A plain explanation for the commonest failure, when kiwix-serve's own message is cryptic. */
  private hint(): string | null {
    if (this.proc.logs.some((l) => l.includes('Unable to instantiate the HTTP daemon'))) {
      return `Port ${this.cfg.kiwixPort} is already in use, probably by another copy of Outpost or kiwix-serve (for example \`npm run dev\` left running). Quit it, then restart the reader. Or set OUTPOST_KIWIX_PORT to a free port.`;
    }
    return null;
  }

  status() {
    return {
      state: this.reason ? 'idle' : this.proc.state,
      hint: this.reason ? null : this.hint(),
      reason: this.reason,
      zims: this.zimCount,
      restarts: this.proc.restarts,
      logs: this.proc.logs.slice(-8),
    };
  }

  stop(): Promise<void> {
    return this.proc.stop();
  }
}
