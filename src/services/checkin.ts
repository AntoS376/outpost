import { HttpError } from '../util.js';

export const CHECKIN_STATUSES = ['safe', 'help', 'coming'] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];
export const CHECKIN_TTL_MS = 24 * 3_600_000;
export const CHECKIN_NOTE_MAX = 140;

export interface CheckIn {
  name: string;
  /** I'm safe, I need help, or I'm on my way. */
  status: CheckinStatus;
  note: string;
  at: number;
}

/**
 * "Who's safe": one line per person signed in to this Outpost, shown to everyone. Kept in memory only, like the SOS
 * board, and each line goes away after 24 hours or when its person clears it.
 */
export class CheckinBoard {
  private lines = new Map<string, CheckIn>();

  constructor(private now: () => number = Date.now) {}

  set(name: string, body: Record<string, unknown>): CheckIn {
    const status = body.status as CheckinStatus;
    if (!CHECKIN_STATUSES.includes(status)) throw new HttpError(400, `Status must be one of ${CHECKIN_STATUSES.join(', ')}.`);
    const note = String(body.note ?? '').replace(/\s+/g, ' ').trim();
    if (note.length > CHECKIN_NOTE_MAX) throw new HttpError(400, `Keep the note to ${CHECKIN_NOTE_MAX} characters or fewer.`);
    const line = { name, status, note, at: this.now() };
    this.lines.set(name, line);
    return line;
  }

  clear(name: string): void {
    this.lines.delete(name);
  }

  /** Current lines, newest first, expired ones dropped as it goes. */
  list(): CheckIn[] {
    const cutoff = this.now() - CHECKIN_TTL_MS;
    for (const [name, l] of this.lines) if (l.at < cutoff) this.lines.delete(name);
    return [...this.lines.values()].sort((a, b) => b.at - a.at);
  }
}
