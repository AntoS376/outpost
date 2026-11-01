import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { HttpError, resolveBin } from '../util.js';

const run = promisify(execFile);
const UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** URL of the newest Protomaps planet build, from their published build list. */
export async function latestPlanet(cfg: Config): Promise<string> {
  let builds: { key: string }[];
  try {
    const res = await fetch(cfg.mapBuildsUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    builds = (await res.json()) as { key: string }[];
  } catch {
    throw new HttpError(502, 'Could not reach Protomaps to find the latest world map. Check your internet connection.');
  }
  const key = builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort().at(-1);
  if (!key) throw new HttpError(502, 'Protomaps did not list any map builds.');
  return mapBase(cfg) + key;
}

/** Builds live on build.protomaps.com; a test build list served elsewhere points at its own host. */
function mapBase(cfg: Config): string {
  const u = new URL(cfg.mapBuildsUrl);
  return u.hostname === 'build-metadata.protomaps.dev' ? 'https://build.protomaps.com/' : `${u.origin}/`;
}

/** Size in bytes that `pmtiles extract` would write for this area, from a dry run (downloads only the index). */
export async function estimateExtract(cfg: Config, source: string, bbox: number[], maxzoom: number | null): Promise<number> {
  const bin = resolveBin(cfg.pmtilesBin);
  if (!bin) throw new HttpError(412, 'The pmtiles tool is not installed (brew install pmtiles).');
  const args = ['extract', source, '/dev/null', `--bbox=${bbox.join(',')}`, '--dry-run'];
  if (maxzoom !== null) args.push(`--maxzoom=${maxzoom}`);
  let out: string;
  try {
    const r = await run(bin, args, { timeout: 90_000 });
    out = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    throw new HttpError(502, `Could not estimate the map size: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 200)}`);
  }
  const m = out.match(/archive size of ([\d.]+) ?([kKMGT]?B)/);
  if (!m) throw new HttpError(502, 'pmtiles did not report a size for this area.');
  return Math.round(Number(m[1]) * (UNITS[m[2]!] ?? 1));
}
