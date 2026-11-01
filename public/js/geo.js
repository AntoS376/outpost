// Coordinates and sun times, offline. WGS84; UTM/MGRS by the USGS (Snyder) series; sun by NOAA's method.
// Tested against the mgrs and suncalc libraries.

const a = 6378137;
const f = 1 / 298.257223563;
const e2 = f * (2 - f);
const ep2 = e2 / (1 - e2);
const k0 = 0.9996;
const rad = Math.PI / 180;
const BANDS = 'CDEFGHJKLMNPQRSTUVWXX'; // 8° bands from 80°S; X stretches to 84°N
const COLS = ['STUVWXYZ', 'ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ', 'ABCDEFGH', 'JKLMNPQR']; // by zone % 6
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';

/** UTM zone, with the Norway and Svalbard exceptions. */
export function zoneOf(lat, lon) {
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
  if (lat >= 72 && lat < 84 && lon >= 0 && lon < 42) return lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37;
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}
const bandOf = (lat) => BANDS[Math.floor((lat + 80) / 8)];

/** Latitude/longitude → UTM. UTM covers 80°S to 84°N; polar areas (UPS) are not supported. */
export function toUTM(lat, lon, zone = zoneOf(lat, lon)) {
  if (lat < -80 || lat > 84) throw new Error('UTM covers 80°S to 84°N only.');
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * rad;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const t = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * s * s);
  const T = t * t;
  const C = ep2 * c * c;
  const A = c * (lon - lon0) * rad;
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing = k0 * (M + N * t * (A * A / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  return { zone, band: bandOf(lat), easting, northing };
}

/** UTM → latitude/longitude. */
function fromUTM(zone, northern, easting, northing) {
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = (northern ? northing : northing - 10000000) / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1);
  const c = Math.cos(p1);
  const N1 = a / Math.sqrt(1 - e2 * s * s);
  const T1 = Math.tan(p1) ** 2;
  const C1 = ep2 * c * c;
  const R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const D = (easting - 500000) / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = lon0 * rad + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return { lat: lat / rad, lon: lon / rad };
}

/** Latitude/longitude → MGRS, e.g. "17T PJ 30084 33438" (digits truncated, as the standard says). */
export function toMGRS(lat, lon, digits = 5) {
  const u = toUTM(lat, lon);
  const set = COLS[u.zone % 6];
  const col = set[Math.floor(u.easting / 100000) - 1];
  const row = ROWS[(Math.floor(u.northing / 100000) + (u.zone % 2 === 0 ? 5 : 0)) % 20];
  const cut = (v) => String(Math.floor((v % 100000) / 10 ** (5 - digits))).padStart(digits, '0');
  return `${u.zone}${u.band} ${col}${row} ${cut(u.easting)} ${cut(u.northing)}`;
}

/** MGRS → latitude/longitude of the centre of the square it names. */
export function fromMGRS(text) {
  const m = String(text).toUpperCase().replace(/\s+/g, '').match(/^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/);
  if (!m || m[5].length % 2) throw new Error('That is not an MGRS reference (e.g. 36S YC 35000 54000).');
  const zone = Number(m[1]);
  const band = m[2];
  const k = m[5].length / 2;
  const colIdx = COLS[zone % 6].indexOf(m[3]);
  let rowIdx = ROWS.indexOf(m[4]);
  if (zone < 1 || zone > 60 || colIdx < 0 || rowIdx < 0) throw new Error('That MGRS reference has letters that do not exist in that zone.');
  rowIdx = (rowIdx - (zone % 2 === 0 ? 5 : 0) + 20) % 20;
  const step = 10 ** (5 - k);
  const e = (colIdx + 1) * 100000 + (k ? Number(m[5].slice(0, k)) * step : 0) + step / 2;
  let n = rowIdx * 100000 + (k ? Number(m[5].slice(k)) * step : 0) + step / 2;
  const bandIdx = BANDS.indexOf(band);
  const southLat = -80 + bandIdx * 8;
  const northern = southLat >= 0;
  const minN = toUTM(southLat, (zone - 1) * 6 - 180 + 3, zone).northing;
  n += Math.floor(minN / 2000000) * 2000000;
  if (n + 100000 < minN) n += 2000000;
  return fromUTM(zone, northern, e, n);
}

const hemi = (v, pos, neg) => (v >= 0 ? pos : neg);
/** 33°53'37.7"N */
function toDMS(v, pos, neg) {
  const abs = Math.abs(v);
  let d = Math.floor(abs);
  let mins = Math.floor((abs - d) * 60);
  let s = Math.round(((abs - d) * 60 - mins) * 600) / 10;
  if (s >= 60) [s, mins] = [0, mins + 1];
  if (mins >= 60) [mins, d] = [0, d + 1];
  return `${d}°${String(mins).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${hemi(v, pos, neg)}`;
}
/** 33°53.628'N */
function toDDM(v, pos, neg) {
  const abs = Math.abs(v);
  const d = Math.floor(abs);
  return `${d}°${((abs - d) * 60).toFixed(3).padStart(6, '0')}'${hemi(v, pos, neg)}`;
}

/** Reads what people type: decimal, degrees-minutes(-seconds) with N/S/E/W, UTM ("36S 735000 3754000") or MGRS. */
export function parseCoords(input) {
  const s = String(input).trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) throw new Error('Type a position.');
  const mg = s.toUpperCase().replace(/\s+/g, '');
  if (/^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z][A-HJ-NP-V]\d*$/.test(mg)) return fromMGRS(mg);
  const utm = s.toUpperCase().match(/^(\d{1,2})\s?([C-HJ-NP-X])\s(\d{3,7}(?:\.\d+)?)\s?M?E?\s(\d{1,8}(?:\.\d+)?)\s?M?N?$/);
  if (utm) return fromUTM(Number(utm[1]), utm[2] >= 'N', Number(utm[3]), Number(utm[4]));
  // Two plain decimals: latitude then longitude.
  const dec = s.match(/^([-+]?\d+(?:\.\d+)?)\s([-+]?\d+(?:\.\d+)?)$/);
  if (dec) {
    const [lat, lon] = [Number(dec[1]), Number(dec[2])];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Latitude must be within 90° and longitude within 180°.');
    return { lat, lon };
  }
  const parts = [...s.matchAll(/([-+]?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′m]?\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|''|s)?\s*)?([NSEW])?/gi)].filter((p) => p[0].trim());
  if (parts.length !== 2) throw new Error('Could not read that. Try 33.8938, 35.5018 or 33°53\'38"N 35°30\'07"E or an MGRS/UTM reference.');
  const val = (p) => {
    const v = Math.abs(Number(p[1])) + (Number(p[2]) || 0) / 60 + (Number(p[3]) || 0) / 3600;
    const neg = p[1].startsWith('-') || /[SW]/i.test(p[4] ?? '');
    return { v: neg ? -v : v, axis: /[EW]/i.test(p[4] ?? '') ? 'lon' : /[NS]/i.test(p[4] ?? '') ? 'lat' : null };
  };
  let [x, y] = parts.map(val);
  if (x.axis === 'lon' || y.axis === 'lat') [x, y] = [y, x];
  if (Math.abs(x.v) > 90 || Math.abs(y.v) > 180) throw new Error('Latitude must be within 90° and longitude within 180°.');
  return { lat: x.v, lon: y.v };
}

/** All the ways to say a position. */
export function formats(lat, lon) {
  const out = {
    decimal: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    dms: `${toDMS(lat, 'N', 'S')} ${toDMS(lon, 'E', 'W')}`,
    ddm: `${toDDM(lat, 'N', 'S')} ${toDDM(lon, 'E', 'W')}`,
    utm: null,
    mgrs: null,
  };
  if (lat >= -80 && lat <= 84) {
    const u = toUTM(lat, lon);
    out.utm = `${u.zone}${u.band} ${Math.floor(u.easting)}mE ${Math.floor(u.northing)}mN`;
    out.mgrs = toMGRS(lat, lon);
  }
  return out;
}

/**
 * Sunrise, sunset, solar noon and civil twilight for a calendar day, by NOAA's method (about a minute's accuracy).
 * Returns Dates, or null fields with polar: 'day' | 'night' when the sun doesn't rise or set.
 */
export function sunTimes(year, month, day, lat, lon) {
  const event = (zenith, rising) => {
    let t = 720 - 4 * lon; // minutes after 00:00 UTC, refined twice
    for (let i = 0; i < 3; i++) {
      const jd = Date.UTC(year, month - 1, day) / 86400000 + 2440587.5 + t / 1440;
      const jc = (jd - 2451545) / 36525;
      const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
      const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
      const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
      const C = Math.sin(M * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * rad) * 0.000289;
      const omega = 125.04 - 1934.136 * jc;
      const app = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
      const obliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega * rad);
      const decl = Math.asin(Math.sin(obliq * rad) * Math.sin(app * rad));
      const y = Math.tan((obliq * rad) / 2) ** 2;
      const eqTime = 4 / rad * (y * Math.sin(2 * L0 * rad) - 2 * ecc * Math.sin(M * rad) + 4 * ecc * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * ecc * ecc * Math.sin(2 * M * rad));
      const noon = 720 - 4 * lon - eqTime;
      if (zenith === null) {
        t = noon;
        continue;
      }
      const cosH = Math.cos(zenith * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
      if (cosH > 1) return 'night';
      if (cosH < -1) return 'day';
      const H = Math.acos(cosH) / rad;
      t = rising ? noon - 4 * H : noon + 4 * H;
    }
    return new Date(Date.UTC(year, month - 1, day) + t * 60000);
  };
  const rise = event(90.833, true);
  const set = event(90.833, false);
  const polar = typeof rise === 'string' ? rise : null;
  const civil = (r) => event(96, r);
  const asDate = (v) => (v instanceof Date ? v : null);
  return { sunrise: asDate(rise), sunset: asDate(set), noon: event(null), dawn: asDate(civil(true)), dusk: asDate(civil(false)), polar };
}
