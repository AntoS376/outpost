import fsp from 'node:fs/promises';
import path from 'node:path';
import { PMTiles, type Source } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Config } from '../config.js';
import type { Job, JobManager } from './jobs.js';
import { HttpError, readJson, writeJsonAtomic } from '../util.js';

/**
 * Place search for offline maps. Scans the "places" layer of a Protomaps .pmtiles file (checked on a real
 * extract: point features with name, name:<lang>, kind, kind_detail, population) and keeps the places inside the
 * map's bounds in <file>.places.json. These are cities, towns, villages and neighbourhoods, not street addresses.
 */

/** Deepest zoom scanned. Each zoom has 4x the tiles; places that first appear at 14+ are the very smallest. */
const MAX_SCAN_ZOOM = 13;

export interface Place {
  n: string; // name, in the local language
  en: string | null; // English name, when it differs
  k: string; // kind: country, region, locality, neighbourhood…
  d: string; // kind_detail: city, town, village, suburb…
  lon: number;
  lat: number;
  pop: number;
  alt: string[]; // other names (name:en, name:ar…)
}
/** Bumped when the stored fields change, so older indexes are rebuilt at startup. */
const INDEX_VERSION = 2;

interface IndexFile {
  version: number;
  /** Size and mtime of the .pmtiles when indexed, to notice when it changes. */
  size: number;
  mtime: number;
  built: number;
  count: number;
  places: Place[];
}
export interface SearchResult {
  /** Local name, e.g. "بيروت". */
  name: string;
  /** English name when the map has one and it differs, e.g. "Beirut". */
  en: string | null;
  kind: string;
  lon: number;
  lat: number;
  /** A sensible zoom to fly to for this kind of place. */
  zoom: number;
}

/** Reads byte ranges of a local .pmtiles file. */
export class FileSource implements Source {
  constructor(private file: string, private fh: fsp.FileHandle) {}
  getKey(): string {
    return this.file;
  }
  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer };
  }
}

const lon2x = (lon: number, z: number) => Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** z)));
const lat2y = (lat: number, z: number) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)));
};

/** Kinds of help nearby() looks for, from the map's "pois" layer (Protomaps kinds). */
export const HELP_KINDS = ['hospital', 'clinic', 'doctors', 'pharmacy', 'police', 'fire_station'];
/** How far nearby() looks, and how many of each kind it returns. */
export const HELP_RADIUS_KM = 10;
const HELP_PER_KIND = 3;

export interface Help {
  kind: string;
  name: string;
  en: string | null;
  lat: number;
  lon: number;
  km: number;
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** The nearest few of each kind within the radius, nearest first; the same place seen in two tiles counts once. */
export function nearestHelp(found: Omit<Help, 'km'>[], lat: number, lon: number): Help[] {
  const seen = new Set<string>();
  const perKind = new Map<string, number>();
  return found
    .map((f) => ({ ...f, km: Math.round(distanceKm(lat, lon, f.lat, f.lon) * 100) / 100 }))
    .filter((f) => f.km <= HELP_RADIUS_KM)
    .sort((a, b) => a.km - b.km)
    .filter((f) => {
      const key = `${f.kind}|${f.name}|${f.lat.toFixed(4)}|${f.lon.toFixed(4)}`;
      if (seen.has(key) || (perKind.get(f.kind) ?? 0) >= HELP_PER_KIND) return false;
      seen.add(key);
      perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + 1);
      return true;
    });
}

/** Lowercase, accents removed, punctuation as spaces: "Sainte-Dévote" → "sainte devote". */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s\-‐'’.,()]+/g, ' ').trim();
}

/** Edit distance with transpositions, giving up early once past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j]!, prev2[j - 2]! + 1);
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

const KIND_RANK: Record<string, number> = { country: 6, region: 5, city: 4, town: 3, village: 2, suburb: 2, hamlet: 1, locality: 1, neighbourhood: 1 };
const ZOOM: Record<string, number> = { country: 5, region: 7, city: 11, town: 13, village: 14, suburb: 14, hamlet: 15, locality: 15, neighbourhood: 15 };

/** How well one name matches the query (0 = not at all). */
function score(key: string, q: string): number {
  if (key === q) return 100;
  if (key.startsWith(q)) return 80;
  if (key.split(' ').some((w) => w.startsWith(q))) return 70;
  if (q.length >= 3 && key.includes(q)) return 50;
  // Typos only from 4 letters, and the first letter must match (otherwise "monte" finds "Fontevecchia").
  const max = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0;
  if (!max || key[0] !== q[0]) return 0;
  const d = Math.min(distance(key, q, max), distance(key.slice(0, q.length), q, max));
  return d <= max ? 40 - d * 10 : 0;
}

export class PlaceIndex {
  private cache = new Map<string, { mtime: number; places: (Place & { keys: string[] })[] }>();
  private building = new Map<string, Job>();

  constructor(private cfg: Config, private jobs: JobManager) {}

  private mapFile(name: string): string {
    return path.join(this.cfg.dirs.maps, name);
  }
  private indexFile(name: string): string {
    return `${this.mapFile(name)}.places.json`;
  }

  /** Starts (or returns the running) background job that indexes one map. */
  build(name: string): Job {
    const running = this.building.get(name);
    if (running && running.status === 'running') return running;
    const job = this.jobs.startTask('place-index', `Place search for ${name}`, (j, signal) => this.scan(name, j, signal));
    this.building.set(name, job);
    return job;
  }

  private async scan(name: string, job: Job, signal: AbortSignal): Promise<string> {
    const file = this.mapFile(name);
    const st = await fsp.stat(file);
    const fh = await fsp.open(file, 'r');
    try {
      const pm = new PMTiles(new FileSource(file, fh));
      let h: Awaited<ReturnType<PMTiles['getHeader']>>;
      try {
        h = await pm.getHeader();
      } catch {
        throw new Error(`${name} is not a readable map file, so it can't be searched. Download or extract it again.`);
      }
      const top = Math.min(h.maxZoom, MAX_SCAN_ZOOM);
      const ranges: [number, number, number, number, number][] = [];
      for (let z = h.minZoom; z <= top; z++) ranges.push([z, lon2x(h.minLon, z), lon2x(h.maxLon, z), lat2y(h.maxLat, z), lat2y(h.minLat, z)]);
      job.total = ranges.reduce((n, [, x0, x1, y0, y1]) => n + (x1 - x0 + 1) * (y1 - y0 + 1), 0);
      job.received = 0;
      const found = new Map<string, Place>();
      for (const [z, x0, x1, y0, y1] of ranges) {
        job.message = `Zoom ${z} of ${top}`;
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            if (signal.aborted) throw new Error('Cancelled');
            job.received++;
            const tile = await pm.getZxy(z, x, y); // already decompressed
            if (!tile) continue;
            const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.places;
            for (let i = 0; i < (layer?.length ?? 0); i++) {
              const f = layer!.feature(i);
              const p = f.properties;
              if (typeof p.name !== 'string' || !p.name) continue;
              const geom = f.toGeoJSON(x, y, z).geometry;
              if (geom.type !== 'Point') continue;
              const [lon, lat] = geom.coordinates as [number, number];
              // Low-zoom tiles cover far more than the extract; keep only what the map actually shows.
              if (lon < h.minLon || lon > h.maxLon || lat < h.minLat || lat > h.maxLat) continue;
              const d = String(p.kind_detail ?? p.kind ?? '');
              const key = `${p.name}|${d}|${lon.toFixed(2)}|${lat.toFixed(2)}`;
              if (found.has(key)) continue;
              const alt = [...new Set(Object.entries(p).filter(([k, v]) => k.startsWith('name:') && typeof v === 'string' && v !== p.name).map(([, v]) => String(v)))];
              const en = typeof p['name:en'] === 'string' && p['name:en'] !== p.name ? p['name:en'] : null;
              found.set(key, { n: p.name, en, k: String(p.kind ?? ''), d, lon: Math.round(lon * 1e5) / 1e5, lat: Math.round(lat * 1e5) / 1e5, pop: Number(p.population) || 0, alt });
            }
          }
        }
      }
      const places = [...found.values()];
      const index: IndexFile = { version: INDEX_VERSION, size: st.size, mtime: st.mtimeMs, built: Date.now(), count: places.length, places };
      await writeJsonAtomic(this.indexFile(name), index);
      this.cache.delete(name);
      return `${places.length.toLocaleString()} places can now be searched`;
    } finally {
      await fh.close();
    }
  }

  /** Indexes every map that has no index, or whose file changed since. Run at startup. */
  async ensureAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await fsp.readdir(this.cfg.dirs.maps)).filter((n) => n.toLowerCase().endsWith('.pmtiles'));
    } catch {
      return;
    }
    for (const name of names) {
      const st = await fsp.stat(this.mapFile(name)).catch(() => null);
      const idx = await readJson<Pick<IndexFile, 'version' | 'size' | 'mtime'> | null>(this.indexFile(name), null);
      if (st && (!idx || idx.version !== INDEX_VERSION || idx.size !== st.size || idx.mtime !== st.mtimeMs)) this.build(name);
    }
  }

  /** Number of indexed places, or null when there is no index yet. */
  async count(name: string): Promise<number | null> {
    return (await readJson<{ count?: number } | null>(this.indexFile(name), null))?.count ?? null;
  }

  isBuilding(name: string): boolean {
    return this.building.get(name)?.status === 'running';
  }

  async remove(name: string): Promise<void> {
    this.building.get(name) && this.jobs.cancel(this.building.get(name)!.id);
    this.cache.delete(name);
    await fsp.rm(this.indexFile(name), { force: true });
  }

  private async load(name: string) {
    const raw = await readJson<IndexFile | null>(this.indexFile(name), null);
    if (!raw) return null;
    const hit = this.cache.get(name);
    if (hit && hit.mtime === raw.built) return hit.places;
    const places = raw.places.map((p) => ({ ...p, keys: [...new Set([p.n, ...p.alt].map(normalize))] }));
    this.cache.set(name, { mtime: raw.built, places });
    return places;
  }

  /**
   * Hospitals, pharmacies, police and the like around a point, read straight from the map's most detailed tiles
   * (zoom 15 has them all; lower zooms only the biggest). About 500 small tiles for 10 km, so no index is kept.
   */
  async nearby(name: string, lat: number, lon: number): Promise<Help[]> {
    const file = this.mapFile(name);
    const fh = await fsp.open(file, 'r');
    try {
      const pm = new PMTiles(new FileSource(file, fh));
      const h = await pm.getHeader();
      const z = Math.min(15, h.maxZoom);
      const dLat = HELP_RADIUS_KM / 111;
      const dLon = HELP_RADIUS_KM / (111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
      const found: Omit<Help, 'km'>[] = [];
      for (let x = lon2x(lon - dLon, z); x <= lon2x(lon + dLon, z); x++) {
        for (let y = lat2y(lat + dLat, z); y <= lat2y(lat - dLat, z); y++) {
          const tile = await pm.getZxy(z, x, y);
          if (!tile) continue;
          const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.pois;
          for (let i = 0; i < (layer?.length ?? 0); i++) {
            const f = layer!.feature(i);
            const kind = String(f.properties.kind ?? '');
            if (!HELP_KINDS.includes(kind)) continue;
            const geom = f.toGeoJSON(x, y, z).geometry;
            if (geom.type !== 'Point') continue;
            const [plon, plat] = geom.coordinates as [number, number];
            const n = typeof f.properties.name === 'string' ? f.properties.name : '';
            const en = typeof f.properties['name:en'] === 'string' && f.properties['name:en'] !== n ? String(f.properties['name:en']) : null;
            found.push({ kind, name: n, en, lat: Math.round(plat * 1e5) / 1e5, lon: Math.round(plon * 1e5) / 1e5 });
          }
        }
      }
      return nearestHelp(found, lat, lon);
    } finally {
      await fh.close();
    }
  }

  async search(name: string, query: string, limit = 20): Promise<SearchResult[]> {
    const q = normalize(query);
    if (!q) throw new HttpError(400, 'Type a place name to search for');
    const places = await this.load(name);
    if (!places) {
      throw new HttpError(409, this.isBuilding(name) ? 'The place index for this map is still being built. Try again in a moment.' : 'This map has no place index yet.');
    }
    return places
      .map((p) => ({ p, s: Math.max(...p.keys.map((k) => score(k, q))) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (KIND_RANK[b.p.d] ?? 0) - (KIND_RANK[a.p.d] ?? 0) || b.p.pop - a.p.pop || a.p.n.localeCompare(b.p.n))
      .slice(0, limit)
      .map(({ p }) => ({ name: p.n, en: p.en ?? null, kind: p.d || p.k, lon: p.lon, lat: p.lat, zoom: ZOOM[p.d] ?? ZOOM[p.k] ?? 12 }));
  }
}
