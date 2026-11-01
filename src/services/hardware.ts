import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Hardware {
  /** e.g. "Apple M3 Pro" */
  cpu: string;
  /** Apple's model identifier, e.g. "Mac15,6" (not the marketing name). */
  model: string | null;
  memoryBytes: number;
  cores: number;
  /** Apple Silicon performance and efficiency cores, when macOS reports them. */
  perfCores: number | null;
  effCores: number | null;
  os: string;
}

async function sysctl(key: string): Promise<string | null> {
  try {
    return (await run('/usr/sbin/sysctl', ['-n', key], { timeout: 3000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Reads the chip, memory and core counts from macOS (sysctl), falling back to Node's view elsewhere. */
export async function detectHardware(): Promise<Hardware> {
  const [brand, model, mem, ncpu, perf, eff, osVersion] = await Promise.all([
    sysctl('machdep.cpu.brand_string'),
    sysctl('hw.model'),
    sysctl('hw.memsize'),
    sysctl('hw.ncpu'),
    sysctl('hw.perflevel0.physicalcpu'),
    sysctl('hw.perflevel1.physicalcpu'),
    run('/usr/bin/sw_vers', ['-productVersion'], { timeout: 3000 }).then((r) => r.stdout.trim(), () => null),
  ]);
  return {
    cpu: brand ?? os.cpus()[0]?.model ?? 'Unknown processor',
    model,
    memoryBytes: Number(mem) || os.totalmem(),
    cores: Number(ncpu) || os.cpus().length,
    perfCores: perf ? Number(perf) : null,
    effCores: eff ? Number(eff) : null,
    os: osVersion ? `macOS ${osVersion}` : `${os.type()} ${os.release()}`,
  };
}
