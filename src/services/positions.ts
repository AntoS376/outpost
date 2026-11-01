import { HttpError } from '../util.js';

export interface Position {
  name: string;
  lat: number;
  lon: number;
  /** Metres, as the device reported it. */
  accuracy: number;
  /** When the device last sent it (ms since epoch). */
  at: number;
}

/** A position stops being shown after this long without an update. */
export const POSITION_TTL_MS = 15 * 60_000;

/**
 * The group map: where the people who chose to share are, right now. Kept in memory only (never written to disk,
 * no history), one entry per account, dropped after 15 minutes without an update or when its owner stops sharing.
 */
export class PositionBoard {
  private byName = new Map<string, Position>();

  constructor(private now: () => number = Date.now) {}

  set(name: string, body: Record<string, unknown>): Position {
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const accuracy = Number(body.accuracy ?? 0);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new HttpError(400, 'A position needs a latitude from -90 to 90 and a longitude from -180 to 180.');
    }
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000) throw new HttpError(400, 'Accuracy must be from 0 to 100,000 metres.');
    const p = { name, lat, lon, accuracy: Math.round(accuracy), at: this.now() };
    this.byName.set(name, p);
    return p;
  }

  remove(name: string): void {
    this.byName.delete(name);
  }

  /** Everyone still fresh, oldest dropped as it goes. */
  list(): Position[] {
    const cutoff = this.now() - POSITION_TTL_MS;
    for (const [name, p] of this.byName) if (p.at < cutoff) this.byName.delete(name);
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
