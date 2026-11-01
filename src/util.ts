import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Outpost's own version, from package.json. */
export const OUTPOST_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Returns the file name if it is a plain name (no directory parts) with an allowed extension, else null.
 * Anything containing a path separator is rejected rather than "cleaned", so traversal attempts fail loudly.
 */
export function safeFileName(input: string, allowedExts: string[]): string | null {
  const raw = String(input ?? '').trim();
  const base = path.basename(raw);
  if (base !== raw) return null;
  if (!/^[\w][\w.\- ()]{0,200}$/.test(base)) return null;
  const lower = base.toLowerCase();
  return allowedExts.some((e) => lower.endsWith(e)) ? base : null;
}

const EXTRA_BIN_DIRS = [
  path.join((process.env.OUTPOST_HOME ?? path.join(os.homedir(), 'Outpost')).replace(/^~(?=$|\/)/, os.homedir()), 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

/** Finds an executable by name in PATH plus the usual Homebrew dirs (launchd has a minimal PATH). */
export function resolveBin(name: string): string | null {
  const candidates: string[] = [];
  if (name.includes('/')) candidates.push(name);
  else {
    const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_BIN_DIRS];
    for (const d of dirs) if (d) candidates.push(path.join(d, name));
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** "4.2 GB", "310 MB": for messages. */
export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export interface FileInfo {
  name: string;
  size: number;
  mtime: number;
}

export async function listFiles(dir: string, ext: string): Promise<FileInfo[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: FileInfo[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(ext)) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* removed meanwhile */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bytes in a folder, including its subfolders (notes and chats have one folder per person). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const name of await fsp.readdir(dir)) {
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (st.isFile()) total += st.size;
        else if (st.isDirectory()) total += await dirSize(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

export function fileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(path.basename(new URL(url).pathname));
  } catch {
    return '';
  }
}

/** Validates a map area: [west, south, east, north] in degrees. */
export function parseBbox(raw: unknown): [number, number, number, number] {
  const bbox = Array.isArray(raw) ? raw.map(Number) : [];
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) throw new HttpError(400, 'bbox must be [minLon, minLat, maxLon, maxLat]');
  const [w, s, e, n] = bbox as [number, number, number, number];
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new HttpError(400, 'bbox is out of range or inverted');
  return [w, s, e, n];
}

/** Validates an optional map detail level; null means full detail. */
export function parseMaxzoom(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const z = Number(raw);
  if (!Number.isInteger(z) || z < 0 || z > 15) throw new HttpError(400, 'maxzoom must be an integer 0–15');
  return z;
}

export function assertHttpUrl(raw: unknown): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http(s) URLs are allowed');
  return u;
}
