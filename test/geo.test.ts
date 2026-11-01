import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mgrs from 'mgrs';
import * as SunCalc from 'suncalc';
// @ts-expect-error plain browser module without types
import { formats, fromMGRS, parseCoords, sunTimes, toMGRS, toUTM, zoneOf } from '../public/js/geo.js';

// Deterministic pseudo-random points, so a failure can be reproduced.
function* points(n: number) {
  let x = 123456789;
  const r = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) yield { lat: -79.9 + r() * 163.8, lon: -180 + r() * 359.999 };
}
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  return Math.hypot(x, (b.lat - a.lat) * k) * 6371000;
};

describe('coordinates', () => {
  it('matches a published UTM example and exact cases', () => {
    // CN Tower, Toronto, often quoted as 17T 630084 4833438. Its position is usually given to 4 decimals (about ±5 m),
    // so this only checks the neighbourhood; the 3,000-point comparison below is the precise test.
    const cn = toUTM(43.6426, -79.3871);
    assert.equal(`${cn.zone}${cn.band}`, '17T');
    assert.ok(Math.abs(cn.easting - 630084) < 10 && Math.abs(cn.northing - 4833438) < 10, JSON.stringify(cn));
    assert.equal(toMGRS(43.6426, -79.3871).slice(0, 7), '17T PJ ');
    const eq = toUTM(0, 3);
    assert.deepEqual([eq.zone, eq.band, Math.round(eq.easting), Math.round(eq.northing)], [31, 'N', 500000, 0]);
    assert.equal(zoneOf(60, 5), 32, 'Norway exception');
    assert.equal(zoneOf(78, 15), 33, 'Svalbard exception');
  });

  it('agrees with the mgrs library on 3,000 points worldwide, both ways', () => {
    for (const p of points(3000)) {
      const ours = toMGRS(p.lat, p.lon).replace(/\s/g, '');
      const ref = mgrs.forward([p.lon, p.lat], 5);
      assert.equal(ours.slice(0, -10), ref.slice(0, -10), `grid at ${p.lat},${p.lon}: ${ours} vs ${ref}`);
      const de = Math.abs(Number(ours.slice(-10, -5)) - Number(ref.slice(-10, -5)));
      const dn = Math.abs(Number(ours.slice(-5)) - Number(ref.slice(-5)));
      assert.ok(Math.min(de, 100000 - de) <= 1 && Math.min(dn, 100000 - dn) <= 1, `digits at ${p.lat},${p.lon}: ${ours} vs ${ref}`);
      const back = fromMGRS(ref);
      const [lon, lat] = mgrs.toPoint(ref);
      assert.ok(metres(back, { lat, lon }) < 2, `back from ${ref}: ${JSON.stringify(back)} vs ${lat},${lon}`);
      assert.ok(metres(back, p) < 2, 'round trip within a metre-square');
    }
  });

  it('reads the ways people write positions', () => {
    const near = (s: string, lat: number, lon: number, tol = 1) => {
      const r = parseCoords(s);
      assert.ok(metres(r, { lat, lon }) < tol, `${s} -> ${JSON.stringify(r)}`);
    };
    near('33.8938, 35.5018', 33.8938, 35.5018);
    near('-33.8568 151.2153', -33.8568, 151.2153);
    near('33°53\'37.7"N 35°30\'06.5"E', 33.893806, 35.501806, 2);
    near('35 30.108 E, 33 53.628 N', 33.8938, 35.5018, 2);
    near('40.6892 S 74.0445 W', -40.6892, -74.0445);
    near(formats(33.8938, 35.5018).mgrs, 33.8938, 35.5018, 2);
    near(formats(33.8938, 35.5018).utm.replace(/m[EN]/g, ''), 33.8938, 35.5018, 2);
    assert.throws(() => parseCoords('somewhere nice'), /Could not read/);
    assert.throws(() => parseCoords('95, 10'), /within 90/);
  });
});

describe('sun times', () => {
  it('agrees with suncalc within two minutes', () => {
    const cases: [number, number, number, number, number][] = [
      [33.8938, 35.5018, 2026, 10, 30],
      [51.5074, -0.1278, 2026, 6, 21],
      [-33.8688, 151.2093, 2026, 12, 21],
      [64.1466, -21.9426, 2026, 3, 20],
      [0, 0, 2026, 9, 23],
    ];
    for (const [lat, lon, y, m, d] of cases) {
      const ours = sunTimes(y, m, d, lat, lon);
      const ref = SunCalc.getTimes(new Date(Date.UTC(y, m - 1, d, 12) - lon * 240000), lat, lon);
      for (const [k, rk] of [['sunrise', 'sunrise'], ['sunset', 'sunset'], ['noon', 'solarNoon'], ['dawn', 'dawn'], ['dusk', 'dusk']] as const) {
        const diff = Math.abs(ours[k].getTime() - (ref as any)[rk].getTime()) / 60000;
        assert.ok(diff < 2, `${k} at ${lat},${lon} ${y}-${m}-${d}: off by ${diff.toFixed(1)} min`);
      }
    }
  });

  it('says when the sun never rises or never sets', () => {
    assert.equal(sunTimes(2026, 12, 21, 69.65, 18.96).polar, 'night', 'Tromsø in December');
    assert.equal(sunTimes(2026, 6, 21, 69.65, 18.96).polar, 'day', 'Tromsø in June');
  });
});
