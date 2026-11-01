import path from 'node:path';
import type { Config } from '../config.js';
import { readJson, resolveBin, writeJsonAtomic } from '../util.js';
import { ManagedProcess } from './process.js';

/**
 * Keeps the Mac from going to sleep while Outpost serves, with macOS's own `caffeinate`. The display may still
 * turn off. `-w` ties it to Outpost's process, so it ends when Outpost does. Closing a laptop's lid still sleeps.
 */
export class KeepAwake {
  readonly proc = new ManagedProcess('caffeinate', 1000);
  private stateFile: string;

  constructor(private cfg: Config) {
    this.stateFile = path.join(cfg.home, 'state.json');
  }

  private bin(): string | null {
    return resolveBin(this.cfg.caffeinateBin);
  }

  status() {
    return { available: !!this.bin(), on: this.proc.running, state: this.proc.state };
  }

  private async remember(on: boolean): Promise<void> {
    await writeJsonAtomic(this.stateFile, { ...(await readJson<Record<string, unknown>>(this.stateFile, {})), keepAwake: on });
  }

  /** -i: no idle sleep; -s: no system sleep while on power; -w: only while Outpost runs. */
  async set(on: boolean, remember = true): Promise<void> {
    if (on && !this.proc.running) {
      const bin = this.bin();
      if (!bin) throw new Error("This Mac has no caffeinate, so Outpost can't keep it awake.");
      this.proc.start(bin, ['-i', '-s', '-w', String(process.pid)]);
    } else if (!on) await this.proc.stop();
    if (remember) await this.remember(on);
  }

  /** Back on at launch if it was on when Outpost last stopped. */
  async resume(): Promise<void> {
    if ((await readJson<{ keepAwake?: boolean }>(this.stateFile, {})).keepAwake) await this.set(true, false).catch(() => undefined);
  }
}
