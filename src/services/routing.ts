import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { PMTiles } from 'pmtiles';
import type { Config } from '../config.js';
import type { Job, JobManager } from './jobs.js';
import { FileSource } from './places.js';
import { ManagedProcess } from './process.js';
import { dirSize, HttpError, readJson, resolveBin, safeFileName, writeJsonAtomic } from '../util.js';

/**
 * Offline directions on Outpost's own map, by OSRM (https://project-osrm.org, BSD-2-Clause, from Homebrew).
 *
 * A map's .pmtiles file only draws roads; routing needs OpenStreetMap's road data itself. For each map an admin
 * picks one or more Geofabrik regions; Outpost downloads them, cuts them to the map's area with osmium, and prepares
 * OSRM data for car, foot and bicycle in ~/Outpost/routing/<map>/. osrm-routed then answers on 127.0.0.1 only,
 * started on the first request for a map and travel mode and stopped after a quiet spell.
 */

const run = promisify(execFile);

export const MODES = { car: 'car', foot: 'foot', bike: 'bicycle' } as const;
export type Mode = keyof typeof MODES;
const MODE_NAMES: Record<Mode, string> = { car: 'car', foot: 'walking', bike: 'cycling' };

/** osrm-routed for one map and mode stops after this long without a request. */
const IDLE_MS = 15 * 60_000;
/** The Geofabrik region list is fetched again after this long. */
const INDEX_MAX_AGE_MS = 7 * 86_400_000;
/** Extra road data kept around the map's edges (degrees), so routes near the edge aren't cut short. */
const MARGIN = 0.05;
const GRID = 24;
const MAX_REGIONS = 6;

export interface RoutingMeta {
  /** osrm-routed --version that prepared the data; another version can't read it. */
  osrm: string;
  regions: { id: string; name: string }[];
  /** When the road data was last updated on OpenStreetMap (ISO time), if the download says. */
  dataDate: string | null;
  built: number;
  bbox: [number, number, number, number];
}

interface GeoFeature {
  properties: { id: string; parent?: string; name: string; urls?: { pbf?: string } };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] } | null;
}
interface Region {
  id: string;
  parent: string | null;
  name: string;
  url: string;
  polys: number[][][][];
  box: [number, number, number, number];
}

export interface RouteStep {
  text: string;
  distance: number;
  duration: number;
  lon: number;
  lat: number;
}
export interface Route {
  mode: Mode;
  distance: number;
  duration: number;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  steps: RouteStep[];
}

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Inside the outline: inside an outer ring and none of its holes. */
export function inRegion(x: number, y: number, polys: number[][][][]): boolean {
  return polys.some((rings) => pointInRing(x, y, rings[0]!) && !rings.slice(1).some((hole) => pointInRing(x, y, hole)));
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

interface OsrmStep {
  name?: string;
  ref?: string;
  destinations?: string;
  distance: number;
  duration: number;
  maneuver: { type: string; modifier?: string; exit?: number; bearing_after?: number; location: [number, number] };
}

/** One OSRM step in plain English: "Turn left onto Emir Béchir", "At the roundabout, take the second exit". */
export function describeStep(s: OsrmStep): string {
  const { type, modifier, exit } = s.maneuver;
  const road = s.name && s.ref ? `${s.name} (${s.ref})` : s.name || s.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const toward = s.destinations ? ` towards ${s.destinations.replace(/^[^:]*:\s*/, '')}` : '';
  const dir = modifier && modifier !== 'straight' && modifier !== 'uturn' ? modifier : '';
  const nth = exit ? `${ORDINAL[exit - 1] ?? `number ${exit}`} exit` : 'exit';
  switch (type) {
    case 'depart':
      return `Head ${COMPASS[Math.round((s.maneuver.bearing_after ?? 0) / 45) % 8]}${road ? ` on ${road}` : ''}`;
    case 'arrive':
      return dir === 'left' || dir === 'right' ? `Arrive at your destination, on the ${dir}` : 'Arrive at your destination';
    case 'new name':
    case 'notification':
      return `Continue${onto || ' straight'}`;
    case 'continue':
      return dir ? `Keep ${dir.replace('slight ', '')}${road ? ` on ${road}` : ''}` : `Continue straight${road ? ` on ${road}` : ''}`;
    case 'merge':
      return `Merge${dir ? ` ${dir.replace('slight ', '')}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${dir ? ` on the ${dir.replace(/^(slight|sharp) /, '')}` : ''}${onto || toward}`;
    case 'off ramp':
      return `Take the exit${dir ? ` on the ${dir.replace(/^(slight|sharp) /, '')}` : ''}${toward || onto}`;
    case 'fork':
      return `Keep ${dir.replace(/^(slight|sharp) /, '') || 'straight'} at the fork${onto}`;
    case 'end of road':
      return `At the end of the road, turn ${dir.replace(/^(slight|sharp) /, '') || 'around'}${onto}`;
    case 'use lane':
      return dir ? `Keep ${dir.replace(/^(slight|sharp) /, '')}${road ? ` on ${road}` : ''}` : `Continue straight${road ? ` on ${road}` : ''}`;
    case 'roundabout':
    case 'rotary':
      return `At the roundabout, take the ${nth}${onto}`;
    case 'roundabout turn':
      return `At the roundabout, turn ${dir || 'straight'}${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Leave the roundabout${onto}`;
    default:
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      if (modifier === 'straight' || !dir) return `Go straight${onto}`;
      return `Turn ${dir}${onto}`;
  }
}

/** A free port on 127.0.0.1 for one osrm-routed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Server {
  proc: ManagedProcess;
  port: number;
  ready: Promise<void>;
  used: number;
}

export class RoutingService {
  private servers = new Map<string, Server>();
  private building = new Map<string, Job>();
  private version: { value: string | null; at: number } | null = null;
  private idleTimer: NodeJS.Timeout;

  constructor(private cfg: Config, private jobs: JobManager) {
    this.idleTimer = setInterval(() => this.stopIdle(), 60_000);
    this.idleTimer.unref();
  }

  private bin(name: string): string | null {
    return resolveBin(this.cfg.routing.osrmDir ? path.join(this.cfg.routing.osrmDir, name) : name);
  }

  /** OSRM's car/foot/bicycle profiles: as configured, or where Homebrew puts them next to the programs. */
  private profilesDir(): string | null {
    if (this.cfg.routing.profiles) return this.cfg.routing.profiles;
    const extract = this.bin('osrm-extract');
    if (!extract) return null;
    const dir = path.join(path.dirname(fs.realpathSync(extract)), '..', 'share', 'osrm', 'profiles');
    return fs.existsSync(path.join(dir, 'car.lua')) ? dir : null;
  }

  /** Which tools are installed, and OSRM's version (data prepared by another version must be prepared again). */
  async tools(): Promise<{ osrm: boolean; osmium: boolean; version: string | null }> {
    const osrm = ['osrm-extract', 'osrm-partition', 'osrm-customize', 'osrm-routed'].every((n) => this.bin(n)) && !!this.profilesDir();
    const osmium = !!resolveBin(this.cfg.routing.osmiumBin);
    if (!osrm) return { osrm, osmium, version: null };
    if (!this.version || Date.now() - this.version.at > 5 * 60_000) {
      const out = await run(this.bin('osrm-routed')!, ['--version'], { timeout: 10_000 }).then((r) => r.stdout.trim(), () => '');
      this.version = { value: out.split(/\s+/).at(-1) || null, at: Date.now() };
    }
    return { osrm, osmium, version: this.version.value };
  }

  private mapName(raw: string): string {
    const name = safeFileName(raw, ['.pmtiles']);
    if (!name) throw new HttpError(400, 'Invalid map name');
    return name;
  }
  private dir(map: string): string {
    return path.join(this.cfg.dirs.routing, map);
  }

  /** The map's own area, from its .pmtiles header. */
  async bounds(map: string): Promise<[number, number, number, number]> {
    const file = path.join(this.cfg.dirs.maps, map);
    const fh = await fsp.open(file).catch(() => {
      throw new HttpError(404, `No map called ${map}`);
    });
    try {
      const h = await new PMTiles(new FileSource(file, fh)).getHeader();
      return [h.minLon, h.minLat, h.maxLon, h.maxLat];
    } finally {
      await fh.close();
    }
  }

  async status(rawMap: string) {
    const map = this.mapName(rawMap);
    const meta = await readJson<RoutingMeta | null>(path.join(this.dir(map), 'meta.json'), null);
    const tools = await this.tools();
    const job = this.building.get(map);
    return {
      ready: !!meta && (!tools.version || meta.osrm === tools.version),
      outdated: !!meta && !!tools.version && meta.osrm !== tools.version,
      building: job?.status === 'running' || job?.status === 'queued' ? job.id : null,
      regions: meta?.regions ?? [],
      dataDate: meta?.dataDate ?? null,
      built: meta?.built ?? null,
      size: meta ? await dirSize(this.dir(map)) : 0,
      tools,
    };
  }

  /** Geofabrik's regions with their outlines, kept for a week in ~/Outpost/routing. */
  private async index(): Promise<Region[]> {
    const file = path.join(this.cfg.dirs.routing, 'geofabrik-index.json');
    const st = await fsp.stat(file).catch(() => null);
    let raw: { features: GeoFeature[] } | null = null;
    if (!st || Date.now() - st.mtimeMs > INDEX_MAX_AGE_MS) {
      try {
        const res = await fetch(this.cfg.routing.indexUrl, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = (await res.json()) as { features: GeoFeature[] };
        await fsp.mkdir(this.cfg.dirs.routing, { recursive: true });
        await writeJsonAtomic(file, raw);
      } catch {
        if (!st) throw new HttpError(502, "Couldn't reach Geofabrik for its list of regions. Check the internet connection.");
      }
    }
    raw ??= await readJson<{ features: GeoFeature[] }>(file, { features: [] });
    const host = new URL(this.cfg.routing.indexUrl).host;
    const regions: Region[] = [];
    for (const f of raw.features ?? []) {
      const url = f.properties?.urls?.pbf;
      if (!url || !f.geometry || !/^[\w-]+$/.test(f.properties.id)) continue;
      // Only ever download from where the list came from.
      if (new URL(url).host !== host) continue;
      const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
      const xs = polys.flatMap((p) => p[0]!.map((c) => c[0]!));
      const ys = polys.flatMap((p) => p[0]!.map((c) => c[1]!));
      regions.push({
        id: f.properties.id,
        parent: f.properties.parent ?? null,
        name: f.properties.name,
        url,
        polys,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
    }
    return regions;
  }

  /**
   * Regions that cover this map, how much of it each covers, and a suggestion: for every spot on a grid over the
   * map, the smallest region that holds it.
   */
  async regions(rawMap: string) {
    const map = this.mapName(rawMap);
    const [w, s, e, n] = await this.bounds(map);
    const all = await this.index();
    const overlap = all.filter((r) => r.box[0] <= e && r.box[2] >= w && r.box[1] <= n && r.box[3] >= s);
    const area = (r: Region) => (r.box[2] - r.box[0]) * (r.box[3] - r.box[1]);
    const cover = new Map<string, number>();
    const spots: Region[][] = [];
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const x = w + ((i + 0.5) / GRID) * (e - w);
        const y = s + ((j + 0.5) / GRID) * (n - s);
        const holders = overlap.filter((r) => inRegion(x, y, r.polys));
        for (const r of holders) cover.set(r.id, (cover.get(r.id) ?? 0) + 1);
        spots.push(holders);
      }
    }
    // Continents (huge downloads) only when no country or smaller region covers any of the map; spots that only a
    // continent holds are usually sea.
    const continents = !spots.some((h) => h.some((r) => r.parent));
    const best = new Map<string, number>();
    let held = 0;
    for (const holders of spots) {
      const pick = holders.filter((r) => continents || r.parent).sort((a, b) => area(a) - area(b))[0];
      if (!pick) continue;
      held++;
      best.set(pick.id, (best.get(pick.id) ?? 0) + 1);
    }
    const suggested = new Set([...best].filter(([, c]) => c >= held * 0.03).map(([id]) => id));
    const shown = overlap
      .filter((r) => suggested.has(r.id) || ((continents || r.parent) && (cover.get(r.id) ?? 0) >= GRID * GRID * 0.01))
      .sort((a, b) => Number(suggested.has(b.id)) - Number(suggested.has(a.id)) || (cover.get(b.id) ?? 0) - (cover.get(a.id) ?? 0))
      .slice(0, 15);
    const sizes = await Promise.all(
      shown.map((r) =>
        fetch(r.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) })
          .then((res) => (res.ok ? Number(res.headers.get('content-length')) || null : null))
          .catch(() => null),
      ),
    );
    return {
      bbox: [w, s, e, n],
      regions: shown.map((r, i) => ({
        id: r.id,
        name: r.name,
        cover: Math.round(((cover.get(r.id) ?? 0) / (GRID * GRID)) * 100),
        suggested: suggested.has(r.id),
        size: sizes[i],
      })),
    };
  }

  /** Runs one program as a step of a job, stopping it if the job is cancelled. */
  private exec(job: Job, bin: string, args: string[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const tail: string[] = [];
      const onData = (buf: Buffer) => {
        for (const l of buf.toString().split(/\r?\n/)) if (l.trim()) tail.push(l.trim());
        if (tail.length > 20) tail.splice(0, tail.length - 20);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const abort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', (err) => reject(err));
      child.once('exit', (code) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new Error('Cancelled'));
        else if (code === 0) resolve();
        else reject(new Error(`${path.basename(bin)} stopped with an error: ${tail.slice(-2).join(' | ').slice(0, 300)}`));
      });
      job.message ||= path.basename(bin);
    });
  }

  /** The road data's date, as Geofabrik stamps it. */
  private async dataDate(file: string): Promise<string | null> {
    const osmium = resolveBin(this.cfg.routing.osmiumBin);
    if (!osmium) return null;
    const out = await run(osmium, ['fileinfo', '-g', 'header.option.osmosis_replication_timestamp', file], { timeout: 30_000 }).then((r) => r.stdout.trim(), () => '');
    return /^\d{4}-\d\d-\d\dT/.test(out) ? out : null;
  }

  /** A profile that prefers English road names (the instructions are in English), then the local name. */
  private async profile(map: string, mode: Mode): Promise<string> {
    const dir = path.join(this.dir(map), 'profiles');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${MODES[mode]}.lua`);
    const base = this.profilesDir()!;
    await fsp.writeFile(
      file,
      `-- Written by Outpost: OSRM's ${MODES[mode]} profile, preferring English road names.\n` +
        `package.path = ${JSON.stringify(`${base}/?.lua`)} .. ';' .. package.path\n` +
        `local base = require(${JSON.stringify(MODES[mode])})\n` +
        `local process_way = base.process_way\n` +
        `base.process_way = function(profile, way, result, relations)\n` +
        `  process_way(profile, way, result, relations)\n` +
        `  local en = way:get_value_by_key('name:en')\n` +
        `  if en and en ~= '' then result.name = en end\n` +
        `end\n` +
        `return base\n`,
    );
    return file;
  }

  /**
   * Downloads the chosen regions (or reuses the road data already here when none are given) and prepares car,
   * foot and bicycle routing. The old data keeps answering until the new data is complete.
   */
  async build(rawMap: string, regionIds: string[] | null): Promise<Job> {
    const map = this.mapName(rawMap);
    const tools = await this.tools();
    if (!tools.osrm || !tools.osmium) {
      throw new HttpError(412, 'Directions need two free tools from Homebrew. In Terminal, run: brew install osrm-backend osmium-tool');
    }
    const current = this.building.get(map);
    if (current && (current.status === 'running' || current.status === 'queued')) throw new HttpError(409, 'Directions for this map are already being prepared.');
    const dir = this.dir(map);
    const regionFile = path.join(dir, 'region.osm.pbf');
    const old = await readJson<RoutingMeta | null>(path.join(dir, 'meta.json'), null);
    let chosen: Region[] = [];
    if (regionIds) {
      if (!Array.isArray(regionIds) || !regionIds.length || regionIds.length > MAX_REGIONS) throw new HttpError(400, `Choose from 1 to ${MAX_REGIONS} regions.`);
      const all = await this.index();
      chosen = regionIds.map((id) => {
        const r = all.find((x) => x.id === String(id));
        if (!r) throw new HttpError(400, `Geofabrik has no region called "${String(id).slice(0, 60)}".`);
        return r;
      });
    } else if (!(await fsp.stat(regionFile).catch(() => null))) {
      throw new HttpError(400, 'Choose the regions to download first.');
    }
    const bbox = await this.bounds(map);
    const job = this.jobs.startTask('routing', `Directions for ${map}`, async (job, signal) => {
      await fsp.mkdir(dir, { recursive: true });
      const temp: string[] = [];
      try {
        let regions = old?.regions ?? [];
        let dataDate = old?.dataDate ?? null;
        if (chosen.length) {
          const sources: string[] = [];
          for (const [i, r] of chosen.entries()) {
            job.message = `Downloading road data: ${r.name}${chosen.length > 1 ? ` (${i + 1} of ${chosen.length})` : ''}`;
            const dest = path.join(dir, `source-${r.id}.osm.pbf`);
            temp.push(dest);
            await this.jobs.download(job, r.url, dest, signal);
            sources.push(dest);
          }
          job.total = null;
          job.received = 0;
          dataDate = (await this.dataDate(sources[0]!)) ?? new Date().toISOString();
          let input = sources[0]!;
          if (sources.length > 1) {
            job.message = 'Joining the regions';
            input = path.join(dir, 'merged.osm.pbf');
            temp.push(input);
            await this.exec(job, resolveBin(this.cfg.routing.osmiumBin)!, ['merge', ...sources, '-o', input, '-O'], signal);
          }
          job.message = "Cutting the road data to this map's area";
          const [w, s, e, n] = bbox;
          const box = [Math.max(-180, w - MARGIN), Math.max(-90, s - MARGIN), Math.min(180, e + MARGIN), Math.min(90, n + MARGIN)];
          const cut = path.join(dir, 'region.new.osm.pbf');
          temp.push(cut);
          await this.exec(job, resolveBin(this.cfg.routing.osmiumBin)!, ['extract', '-b', box.join(','), input, '-o', cut, '-O'], signal);
          await fsp.rename(cut, regionFile);
          regions = chosen.map((r) => ({ id: r.id, name: r.name }));
        }
        const modes = Object.keys(MODES) as Mode[];
        for (const [i, mode] of modes.entries()) {
          job.message = `Preparing ${MODE_NAMES[mode]} directions (${i + 1} of ${modes.length})`;
          const work = path.join(dir, `${mode}.new`);
          temp.push(work);
          await fsp.rm(work, { recursive: true, force: true });
          await fsp.mkdir(work);
          const input = path.join(work, 'region.osm.pbf');
          await fsp.link(regionFile, input).catch(() => fsp.copyFile(regionFile, input));
          const graph = path.join(work, 'region.osrm');
          await this.exec(job, this.bin('osrm-extract')!, ['-p', await this.profile(map, mode), input], signal);
          await this.exec(job, this.bin('osrm-partition')!, [graph], signal);
          await this.exec(job, this.bin('osrm-customize')!, [graph], signal);
          await fsp.rm(input, { force: true });
        }
        job.message = 'Switching to the new directions';
        await this.stopMap(map);
        for (const mode of modes) {
          await fsp.rm(path.join(dir, mode), { recursive: true, force: true });
          await fsp.rename(path.join(dir, `${mode}.new`), path.join(dir, mode));
        }
        const fresh = await this.tools();
        await writeJsonAtomic(path.join(dir, 'meta.json'), { osrm: fresh.version ?? '', regions, dataDate, built: Date.now(), bbox } satisfies RoutingMeta);
        return 'Directions are ready for driving, walking and cycling';
      } finally {
        for (const t of temp) await fsp.rm(t, { recursive: true, force: true });
      }
    });
    this.building.set(map, job);
    return job;
  }

  async remove(rawMap: string): Promise<void> {
    const map = this.mapName(rawMap);
    const job = this.building.get(map);
    if (job) this.jobs.cancel(job.id);
    await this.stopMap(map);
    await fsp.rm(this.dir(map), { recursive: true, force: true });
  }

  /** Starts (or reuses) osrm-routed for one map and mode, and waits until it answers. */
  private async server(map: string, mode: Mode): Promise<Server> {
    const key = `${map}|${mode}`;
    const have = this.servers.get(key);
    if (have && have.proc.running) {
      have.used = Date.now();
      await have.ready;
      return have;
    }
    const bin = this.bin('osrm-routed');
    if (!bin) throw new HttpError(412, 'Directions need OSRM. In Terminal, run: brew install osrm-backend');
    const port = await freePort();
    const proc = new ManagedProcess(`osrm-routed ${key}`);
    proc.start(bin, ['--algorithm', 'mld', '--ip', '127.0.0.1', '--port', String(port), path.join(this.dir(map), mode, 'region.osrm')]);
    const ready = (async () => {
      const end = Date.now() + 60_000;
      for (;;) {
        const up = await fetch(`http://127.0.0.1:${port}/nearest/v1/x/0,0`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
        if (up) return;
        if (proc.state === 'crashed' || proc.restarts > 0 || Date.now() > end) {
          await proc.stop();
          this.servers.delete(key);
          throw new HttpError(503, `The directions engine didn't start: ${proc.logs.slice(-2).join(' | ').slice(0, 300) || 'no answer'}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const server = { proc, port, ready, used: Date.now() };
    this.servers.set(key, server);
    await ready;
    return server;
  }

  private async stopMap(map: string): Promise<void> {
    for (const [key, s] of this.servers) {
      if (key.startsWith(`${map}|`)) {
        this.servers.delete(key);
        await s.proc.stop();
      }
    }
  }

  private stopIdle(): void {
    for (const [key, s] of this.servers) {
      if (Date.now() - s.used > IDLE_MS) {
        this.servers.delete(key);
        void s.proc.stop();
      }
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.servers.values()].map((s) => s.proc.stop()));
    this.servers.clear();
  }

  /** A route between two points ([lon, lat]) on one map's roads. */
  async route(rawMap: string, rawMode: string, from: [number, number], to: [number, number]): Promise<Route> {
    const map = this.mapName(rawMap);
    if (!(rawMode in MODES)) throw new HttpError(400, 'Travel by car, foot or bike.');
    const mode = rawMode as Mode;
    for (const [lon, lat] of [from, to]) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw new HttpError(400, 'A point needs a longitude from -180 to 180 and a latitude from -90 to 90.');
      }
    }
    const st = await this.status(map);
    if (st.building && !st.ready) throw new HttpError(409, 'Directions for this map are still being prepared. See Transfers.');
    if (st.outdated) throw new HttpError(409, 'Directions for this map need preparing again after an update of the directions engine. An admin can do it on Maps.');
    if (!st.ready) throw new HttpError(409, "Directions aren't set up for this map yet. An admin can add them on Maps.");
    const server = await this.server(map, mode);
    const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
    let data: { code: string; message?: string; routes?: { distance: number; duration: number; geometry: { coordinates: number[][] }; legs: { steps: OsrmStep[] }[] }[] };
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/route/v1/x/${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`, { signal: AbortSignal.timeout(20_000) });
      data = (await res.json()) as typeof data;
    } catch {
      throw new HttpError(503, "The directions engine didn't answer. Try again in a moment.");
    }
    if (data.code === 'NoSegment') throw new HttpError(422, 'One of the points is too far from any road on this map.');
    if (data.code === 'NoRoute' || !data.routes?.length) throw new HttpError(404, `No ${MODE_NAMES[mode]} route found between these points on this map's roads.`);
    if (data.code !== 'Ok') throw new HttpError(502, `The directions engine said: ${String(data.message ?? data.code).slice(0, 200)}`);
    const r = data.routes[0]!;
    const round = (v: number) => Math.round(v * 1e5) / 1e5;
    return {
      mode,
      distance: Math.round(r.distance),
      duration: Math.round(r.duration),
      geometry: { type: 'LineString', coordinates: r.geometry.coordinates.map((c) => [round(c[0]!), round(c[1]!)] as [number, number]) },
      steps: r.legs.flatMap((l) => l.steps).map((s) => ({
        text: describeStep(s),
        distance: Math.round(s.distance),
        duration: Math.round(s.duration),
        lon: round(s.maneuver.location[0]),
        lat: round(s.maneuver.location[1]),
      })),
    };
  }

  /**
   * At startup: stop any osrm-routed left over from a crash, and prepare again (from the road data already here)
   * any map whose directions an updated OSRM can't read.
   */
  async resume(): Promise<void> {
    const root = this.cfg.dirs.routing;
    await run('/usr/bin/pkill', ['-f', `osrm-routed .*${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`]).catch(() => undefined);
    const tools = await this.tools();
    if (!tools.osrm || !tools.osmium || !tools.version) return;
    const names = await fsp.readdir(root).catch(() => [] as string[]);
    for (const name of names) {
      if (!safeFileName(name, ['.pmtiles'])) continue;
      const meta = await readJson<RoutingMeta | null>(path.join(root, name, 'meta.json'), null);
      const hasMap = await fsp.stat(path.join(this.cfg.dirs.maps, name)).catch(() => null);
      if (meta && hasMap && meta.osrm !== tools.version) await this.build(name, null).catch(() => undefined);
    }
  }
}
