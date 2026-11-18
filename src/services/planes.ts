import { HttpError } from '../util.js';

/** An aircraft as Outpost shows it, from dump1090's aircraft.json. */
export interface Plane {
  /** ICAO 24-bit address, the aircraft's fixed id ("4b1805"). */
  hex: string;
  /** Call sign as broadcast ("MEA322"), or "" when not heard yet. */
  flight: string;
  lat: number;
  lon: number;
  /** Feet above sea level, or "ground". */
  alt: number | 'ground' | null;
  /** Knots over the ground. */
  speed: number | null;
  /** Degrees from north, the way it is going. */
  track: number | null;
  /** Feet per minute: up when positive, down when negative. */
  climb: number | null;
  squawk: string;
  /** 7500 hijack, 7600 radio failure, 7700 emergency. */
  emergency: boolean;
  /** Seconds since its position was last heard. */
  seen: number;
  /** Signal strength in dBFS (0 is the loudest; -30 is faint). */
  rssi: number | null;
}

/** An aircraft heard recently, but whose position hasn't come through. */
export type Unplaced = Pick<Plane, 'hex' | 'flight' | 'alt'>;

/** What one read of aircraft.json says. */
export interface AircraftFile {
  planes: Plane[];
  unplaced: Unplaced[];
  /** dump1090's running total of messages decoded, and the file's time (s since epoch), for a rate. */
  messages: number | null;
  now: number | null;
  /** The strongest signal among aircraft heard in the last minute. */
  rssi: number | null;
}

/** Where the antenna is, for distances on the map (and so dump1090 can place planes from one message). */
export interface Site {
  lat: number;
  lon: number;
}

/** A position older than this is dropped rather than shown where the plane no longer is. */
export const PLANE_STALE_S = 60;
const EMERGENCY = ['7500', '7600', '7700'];
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const hexOf = (a: Record<string, unknown>) => String(a.hex ?? '').replace(/[^0-9a-f~]/gi, '').slice(0, 8);
const flightOf = (a: Record<string, unknown>) => (typeof a.flight === 'string' ? a.flight.trim().replace(/[^\w-]/g, '').slice(0, 8) : '');
const altOf = (a: Record<string, unknown>) => (a.alt_baro === 'ground' ? 'ground' : num(a.alt_baro));

/** Reads dump1090's aircraft.json: planes with a recent position, and those heard lately without one. Malformed entries are skipped. */
export function readAircraft(raw: unknown): AircraftFile {
  const file = (raw ?? {}) as { aircraft?: unknown; messages?: unknown; now?: unknown };
  const out: AircraftFile = { planes: [], unplaced: [], messages: num(file.messages), now: num(file.now), rssi: null };
  if (!Array.isArray(file.aircraft)) return out;
  for (const a of file.aircraft as Record<string, unknown>[]) {
    if (!a || typeof a !== 'object') continue;
    const seen = num(a.seen);
    const rssi = num(a.rssi);
    if (rssi !== null && (seen === null || seen <= PLANE_STALE_S)) out.rssi = out.rssi === null ? rssi : Math.max(out.rssi, rssi);
    const lat = num(a.lat);
    const lon = num(a.lon);
    const seenPos = num(a.seen_pos);
    if (lat === null || lon === null || seenPos === null || seenPos > PLANE_STALE_S || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      if (seen !== null && seen <= PLANE_STALE_S && hexOf(a)) out.unplaced.push({ hex: hexOf(a), flight: flightOf(a), alt: altOf(a) });
      continue;
    }
    const squawk = typeof a.squawk === 'string' ? a.squawk.slice(0, 4) : '';
    out.planes.push({
      hex: hexOf(a),
      flight: flightOf(a),
      lat,
      lon,
      alt: altOf(a),
      speed: num(a.gs),
      track: num(a.track),
      climb: num(a.baro_rate) ?? num(a.geom_rate),
      squawk,
      emergency: EMERGENCY.includes(squawk) || (typeof a.emergency === 'string' && a.emergency !== 'none'),
      seen: Math.round(seenPos),
      rssi,
    });
  }
  return out;
}

/** Checks a receiver location: a latitude and longitude, or null to forget it. */
export function validSite(body: Record<string, unknown>): Site | null {
  if (body.lat === null && body.lon === null) return null;
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, 'Send a latitude from -90 to 90 and a longitude from -180 to 180, or both as null.');
  }
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

/** Messages a minute from two reads of the running total, at least 5 s apart; null until there are two. */
export function messageRate(samples: { now: number; messages: number }[]): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.now - first.now < 5) return null;
  return Math.max(0, Math.round(((last.messages - first.messages) / (last.now - first.now)) * 60));
}
