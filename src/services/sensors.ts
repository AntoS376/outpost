/** A sensor rtl_433 has heard: a weather station, thermometer, rain gauge and the like, with its latest readings. */
export interface Sensor {
  key: string;
  model: string;
  /** The channel switch some sensors have (1–3), and the id the sensor picks (often new after a battery change). */
  channel: string | null;
  id: string | null;
  /** Latest value of each measurement, in metric units (see READINGS). */
  readings: Record<string, number>;
  /** Signal in dB, from rtl_433's level meter. */
  rssi: number | null;
  lastSeen: number;
  count: number;
}

/** Frequencies sensors use: 433.92 MHz in Europe, Africa and the Middle East; 868 MHz in Europe; 915 MHz in the Americas. */
export const SENSOR_FREQS = ['433.92M', '868M', '915M'] as const;
/** A sensor not heard for this long is dropped. */
export const SENSOR_STALE_MS = 30 * 60_000;
/** Tyre sensors are counted over this window, never listed: their fixed ids would track the cars that pass. */
export const TYRE_WINDOW_MS = 10 * 60_000;
const MAX_SENSORS = 100;

/** The measurements shown, each from rtl_433's field names, converted to one metric unit. */
const READINGS: [string, string[], (v: number, field: string) => number][] = [
  ['temperature_C', ['temperature_C', 'temperature_F'], (v, f) => (f.endsWith('_F') ? ((v - 32) * 5) / 9 : v)],
  ['humidity', ['humidity'], (v) => v],
  ['pressure_hPa', ['pressure_hPa', 'pressure_kPa'], (v, f) => (f.endsWith('kPa') ? v * 10 : v)],
  ['wind_avg_km_h', ['wind_avg_km_h', 'wind_avg_m_s', 'wind_avg_mi_h'], (v, f) => (f.endsWith('m_s') ? v * 3.6 : f.endsWith('mi_h') ? v * 1.609 : v)],
  ['wind_max_km_h', ['wind_max_km_h', 'wind_max_m_s', 'wind_max_mi_h'], (v, f) => (f.endsWith('m_s') ? v * 3.6 : f.endsWith('mi_h') ? v * 1.609 : v)],
  ['wind_dir_deg', ['wind_dir_deg'], (v) => v],
  ['rain_mm', ['rain_mm', 'rain_in'], (v, f) => (f.endsWith('_in') ? v * 25.4 : v)],
  ['rain_rate_mm_h', ['rain_rate_mm_h', 'rain_rate_in_h'], (v, f) => (f.endsWith('_in_h') ? v * 25.4 : v)],
  ['uv', ['uv', 'uvi'], (v) => v],
  ['light_lux', ['light_lux'], (v) => v],
  ['moisture', ['moisture'], (v) => v],
  ['battery_ok', ['battery_ok'], (v) => v],
];

/**
 * What the receiver has heard on the sensor band: sensors with measurements (listed, latest reading each), tyre
 * sensors from passing cars (counted only) and other devices such as remotes and doorbells (counted only).
 */
export class SensorBoard {
  private sensors = new Map<string, Sensor>();
  private tyres: number[] = [];
  private others = new Set<string>();
  private heard: number[] = [];

  constructor(private now: () => number = Date.now) {}

  /** One line of `rtl_433 -F json`. Lines that aren't JSON objects are ignored. */
  add(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.model !== 'string') return;
    const now = this.now();
    this.heard.push(now);
    const model = m.model.slice(0, 60);
    if (m.type === 'TPMS' || /tpms/i.test(model)) {
      this.tyres.push(now);
      return;
    }
    const readings: Record<string, number> = {};
    for (const [name, fields, convert] of READINGS) {
      const field = fields.find((f) => typeof m[f] === 'number' && Number.isFinite(m[f]));
      if (field) readings[name] = Math.round(convert(m[field] as number, field) * 10) / 10;
    }
    const channel = m.channel != null ? String(m.channel).slice(0, 8) : null;
    const id = m.id != null ? String(m.id).slice(0, 16) : null;
    const key = [model, channel ?? '', id ?? ''].join('|');
    // Only devices that measure something are listed; a button press says nothing worth showing about a neighbour.
    if (!Object.keys(readings).some((k) => k !== 'battery_ok')) {
      this.others.add(key);
      return;
    }
    const old = this.sensors.get(key);
    const rssi = typeof m.rssi === 'number' && Number.isFinite(m.rssi) ? Math.round(m.rssi * 10) / 10 : null;
    this.sensors.set(key, { key, model, channel, id, readings: { ...old?.readings, ...readings }, rssi, lastSeen: now, count: (old?.count ?? 0) + 1 });
    if (this.sensors.size > MAX_SENSORS) {
      const oldest = [...this.sensors.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]!;
      this.sensors.delete(oldest.key);
    }
  }

  /** Sensors heard in the last 30 minutes (most recent first), and the counts. */
  list() {
    const now = this.now();
    for (const [k, s] of this.sensors) if (now - s.lastSeen > SENSOR_STALE_MS) this.sensors.delete(k);
    this.tyres = this.tyres.filter((t) => now - t <= TYRE_WINDOW_MS);
    this.heard = this.heard.filter((t) => now - t <= TYRE_WINDOW_MS);
    return {
      sensors: [...this.sensors.values()].sort((a, b) => b.lastSeen - a.lastSeen),
      tyres: this.tyres.length,
      others: this.others.size,
      heard: this.heard.length,
    };
  }

  clear(): void {
    this.sensors.clear();
    this.tyres = [];
    this.others.clear();
    this.heard = [];
  }
}
