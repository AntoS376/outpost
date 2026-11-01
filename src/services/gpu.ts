import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GpuReading {
  /** false when macOS doesn't report a GPU this way (Intel Macs, other systems). */
  available: boolean;
  /** e.g. "Apple M3 Pro" */
  chip: string | null;
  cores: number | null;
  /** How busy the GPU is, 0–100 %. */
  busy: number | null;
  /** Memory the GPU is using right now, in bytes (Apple Silicon shares it with the rest of the Mac). */
  memoryUsed: number | null;
  /** All the Mac's memory, which the GPU shares. */
  memoryTotal: number;
  at: number;
}

const num = (text: string, key: string): number | null => {
  const m = text.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}"\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};

/**
 * Reads what `ioreg -c IOAccelerator` says about the GPU: its performance statistics ("Device Utilization %",
 * "In use system memory"), chip name and core count. No administrator rights needed, unlike powermetrics.
 */
export function parseIoreg(text: string): Omit<GpuReading, 'memoryTotal' | 'at'> {
  const busy = num(text, 'Device Utilization %');
  const chip = text.match(/"model"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  return {
    available: busy !== null,
    chip,
    cores: num(text, 'gpu-core-count'),
    busy: busy === null ? null : Math.max(0, Math.min(100, busy)),
    memoryUsed: num(text, 'In use system memory'),
  };
}

/** The GPU's current state, read at most about once a second however many pages ask. */
export class GpuMonitor {
  private last: GpuReading | null = null;
  private pending: Promise<GpuReading> | null = null;

  constructor(private ioregBin = '/usr/sbin/ioreg', private maxAgeMs = 800) {}

  read(): Promise<GpuReading> {
    if (this.last && Date.now() - this.last.at < this.maxAgeMs) return Promise.resolve(this.last);
    this.pending ??= run(this.ioregBin, ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 })
      .then((r) => parseIoreg(r.stdout), () => parseIoreg(''))
      .then((g) => (this.last = { ...g, memoryTotal: os.totalmem(), at: Date.now() }))
      .finally(() => (this.pending = null));
    return this.pending;
  }
}
