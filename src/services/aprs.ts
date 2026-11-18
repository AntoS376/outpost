/** An APRS station as Outpost shows it: the latest of what it sent, from direwolf's CSV log. */
export interface Station {
  /** The call sign, or an object's name ("N0CALL-9", "MEETING"). */
  key: string;
  /** Who sent it (an object's sender differs from its name). */
  call: string;
  /** What the symbol means: car, house, weather station… */
  kind: string;
  lat: number | null;
  lon: number | null;
  /** Knots, degrees and metres, as direwolf logs them. */
  speed: number | null;
  course: number | null;
  altitude: number | null;
  comment: string;
  lastSeen: number;
  count: number;
}

/** APRS calling frequencies: 144.800 MHz in Europe, Africa and the Middle East; 144.390 North America; 145.175 Australia; 144.640 China. */
export const APRS_FREQS = ['144.800M', '144.390M', '145.175M', '144.640M'] as const;
/** A station not heard for this long is dropped. */
export const STATION_STALE_MS = 2 * 3_600_000;
const MAX_STATIONS = 300;

// The common APRS symbols (primary table), by their code character.
const KINDS: Record<string, string> = {
  '>': 'car', k: 'truck', v: 'van', j: 'jeep', u: 'truck', '<': 'motorcycle', b: 'bicycle', '[': 'person', '-': 'house',
  _: 'weather station', '#': 'digipeater', '&': 'gateway', r: 'repeater', s: 'ship', Y: 'yacht', '^': 'aircraft', "'": 'aircraft',
  O: 'balloon', X: 'helicopter', a: 'ambulance', f: 'fire truck', '!': 'police', h: 'hospital', '+': 'Red Cross', y: 'house with antenna',
  '`': 'antenna', n: 'node', R: 'RV', U: 'bus', '=': 'train', p: 'rover', ';': 'campground', W: 'weather service',
};
export const kindOf = (symbol: string) => (symbol.length === 2 ? KINDS[symbol[1]!] ?? 'station' : 'station');

/** One CSV line into cells: commas outside quotes split; "" inside quotes is a quote. */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  out.push(cell);
  return out;
}

const num = (s: string | undefined) => {
  const n = s === undefined || s.trim() === '' ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Stations heard on APRS, from direwolf's CSV log (`-L`): the header names the columns; each later line is one packet. */
export class AprsBoard {
  private cols: Record<string, number> | null = null;
  private stations = new Map<string, Station>();
  private heard: number[] = [];

  constructor(private now: () => number = Date.now) {}

  add(line: string): void {
    const cells = csvCells(line.trim());
    if (!this.cols) {
      if (cells.includes('source')) this.cols = Object.fromEntries(cells.map((c, i) => [c, i]));
      return;
    }
    const get = (name: string) => cells[this.cols![name] ?? -1];
    const call = (get('source') ?? '').replace(/[^\w-]/g, '').slice(0, 12);
    if (!call) return;
    const now = this.now();
    this.heard.push(now);
    const key = (get('name') || call).replace(/[^\w .-]/g, '').trim().slice(0, 12) || call;
    let lat = num(get('latitude'));
    let lon = num(get('longitude'));
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) lat = lon = null;
    const old = this.stations.get(key);
    const kind = kindOf(get('symbol') ?? '');
    this.stations.set(key, {
      key,
      call,
      kind: kind !== 'station' ? kind : old?.kind ?? kind, // a status packet carries no symbol: keep the one it had
      lat: lat ?? old?.lat ?? null,
      lon: lon ?? old?.lon ?? null,
      speed: num(get('speed')) ?? (lat === null ? old?.speed ?? null : null),
      course: num(get('course')) ?? (lat === null ? old?.course ?? null : null),
      altitude: num(get('altitude')) ?? old?.altitude ?? null,
      comment: (get('comment') || get('status') || old?.comment || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200),
      lastSeen: now,
      count: (old?.count ?? 0) + 1,
    });
    if (this.stations.size > MAX_STATIONS) {
      const oldest = [...this.stations.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]!;
      this.stations.delete(oldest.key);
    }
  }

  /** Stations heard in the last two hours, most recent first, and packets heard in the last 10 minutes. */
  list() {
    const now = this.now();
    for (const [k, s] of this.stations) if (now - s.lastSeen > STATION_STALE_MS) this.stations.delete(k);
    this.heard = this.heard.filter((t) => now - t <= 10 * 60_000);
    return { stations: [...this.stations.values()].sort((a, b) => b.lastSeen - a.lastSeen), heard: this.heard.length };
  }

  clear(): void {
    this.cols = null;
    this.stations.clear();
    this.heard = [];
  }
}
