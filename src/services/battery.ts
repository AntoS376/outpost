import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Battery {
  /** False on Macs without a battery (Mac mini, iMac, Mac Studio). */
  present: boolean;
  percent: number | null;
  /** True while plugged in and charging (or full on power). */
  plugged: boolean;
  charging: boolean;
  /** Minutes left (on battery) or until full (charging); null while macOS is still working it out. */
  minutes: number | null;
}

const NONE: Battery = { present: false, percent: null, plugged: false, charging: false, minutes: null };

/** Reads the output of `pmset -g batt`, for example:
 *  Now drawing from 'Battery Power'
 *   -InternalBattery-0 (id=123)	55%; discharging; 2:16 remaining present: true */
export function parseBatt(text: string): Battery {
  const line = text.split('\n').find((l) => l.includes('InternalBattery'));
  const pct = line?.match(/(\d{1,3})%/);
  if (!line || !pct) return NONE;
  const state = line.split(';')[1]?.trim() ?? '';
  const time = line.match(/(\d+):(\d{2}) remaining/);
  return {
    present: true,
    percent: Math.min(100, Number(pct[1])),
    plugged: /'AC Power'/.test(text),
    charging: state === 'charging',
    minutes: time ? Number(time[1]) * 60 + Number(time[2]) : null,
  };
}

let cache: { at: number; value: Battery } | null = null;

/** This Mac's battery, read at most every 20 seconds. */
export async function readBattery(): Promise<Battery> {
  if (process.platform !== 'darwin') return NONE;
  if (cache && Date.now() - cache.at < 20_000) return cache.value;
  const value = await run('pmset', ['-g', 'batt'], { timeout: 5000 }).then((r) => parseBatt(r.stdout), () => NONE);
  cache = { at: Date.now(), value };
  return value;
}
