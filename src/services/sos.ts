import { randomUUID } from 'node:crypto';
import { HttpError } from '../util.js';

export interface SosAlert {
  id: string;
  name: string;
  /** What the sender typed, if anything ("Injured at the north cabin"). */
  message: string;
  /** Where the sender was, if their device knew (accuracy in metres). */
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  /** When it was sent (ms since epoch). */
  at: number;
  /** Who said "I'm coming", and when. */
  acks: { name: string; at: number }[];
}

/** An alert goes away by itself after this long. */
export const SOS_TTL_MS = 2 * 3_600_000;
/** One person may send at most one alert this often. */
export const SOS_SEND_GAP_MS = 30_000;
export const SOS_MESSAGE_MAX = 280;

/**
 * The SOS board: calls for help from people signed in to this Outpost, shown to everyone. Kept in memory only (never
 * written to disk, no history), and each alert disappears after 2 hours or when its sender (or an admin) cancels it.
 */
export class SosBoard {
  private alerts = new Map<string, SosAlert>();
  private lastSent = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  send(name: string, body: Record<string, unknown>): SosAlert {
    const message = String(body.message ?? '').replace(/\s+/g, ' ').trim();
    if (message.length > SOS_MESSAGE_MAX) throw new HttpError(400, `Keep the message to ${SOS_MESSAGE_MAX} characters or fewer.`);
    let lat: number | null = null;
    let lon: number | null = null;
    let accuracy: number | null = null;
    if (body.lat != null || body.lon != null) {
      lat = Number(body.lat);
      lon = Number(body.lon);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        throw new HttpError(400, 'A position needs a latitude from -90 to 90 and a longitude from -180 to 180.');
      }
      accuracy = Number(body.accuracy ?? 0);
      if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000) throw new HttpError(400, 'Accuracy must be from 0 to 100,000 metres.');
      accuracy = Math.round(accuracy);
    }
    const now = this.now();
    const last = this.lastSent.get(name);
    if (last != null && now - last < SOS_SEND_GAP_MS) {
      const wait = Math.ceil((SOS_SEND_GAP_MS - (now - last)) / 1000);
      throw Object.assign(new HttpError(429, `You just sent an SOS. You can send another in ${wait} seconds.`), { retryAfter: wait });
    }
    this.lastSent.set(name, now);
    const alert: SosAlert = { id: randomUUID(), name, message, lat, lon, accuracy, at: now, acks: [] };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  /** "I'm coming": once per person per alert; the sender can't answer their own. */
  ack(id: string, name: string): SosAlert {
    const a = this.get(id);
    if (a.name === name) throw new HttpError(400, "You sent this SOS; others answer it.");
    if (!a.acks.some((k) => k.name === name)) a.acks.push({ name, at: this.now() });
    return a;
  }

  /** Only the sender or an admin may call an alert off. */
  cancel(id: string, name: string, admin: boolean): void {
    const a = this.get(id);
    if (a.name !== name && !admin) throw new HttpError(403, 'Only the person who sent this SOS, or an admin, can cancel it.');
    this.alerts.delete(id);
  }

  /** Active alerts, newest first, expired ones dropped as it goes. */
  list(): SosAlert[] {
    const cutoff = this.now() - SOS_TTL_MS;
    for (const [id, a] of this.alerts) if (a.at < cutoff) this.alerts.delete(id);
    for (const [name, t] of this.lastSent) if (t < this.now() - SOS_SEND_GAP_MS) this.lastSent.delete(name);
    return [...this.alerts.values()].sort((a, b) => b.at - a.at);
  }

  private get(id: string): SosAlert {
    this.list();
    const a = this.alerts.get(id);
    if (!a) throw new HttpError(404, 'That SOS is over: it was cancelled or has expired.');
    return a;
  }
}
