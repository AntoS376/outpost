import { $, api, esc, installAddon, jsonBody, toast } from './core.js';
import { mountRadioMap } from './radio-map.js';

const PLANE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.6 6.4L21 13v2l-7.4-2.2-.6 5.2 2.5 1.8V21L12 20l-3.5 1v-1.2l2.5-1.8-.6-5.2L3 15v-2l7.4-4.6z"/></svg>';

// Airlines by the ICAO code that starts a flight's call sign (MEA322 is Middle East Airlines): the ones over Lebanon
// and the eastern Mediterranean most, and the big international carriers.
const AIRLINES = {
  MEA: 'Middle East Airlines', RJA: 'Royal Jordanian', THY: 'Turkish Airlines', PGT: 'Pegasus', AJT: 'AJet', SXS: 'SunExpress',
  UAE: 'Emirates', ETD: 'Etihad', QTR: 'Qatar Airways', SVA: 'Saudia', FDB: 'flydubai', ABY: 'Air Arabia', KNE: 'flynas',
  FAD: 'flyadeal', JZR: 'Jazeera Airways', KAC: 'Kuwait Airways', GFA: 'Gulf Air', OMA: 'Oman Air', IAW: 'Iraqi Airways',
  SYR: 'Syrian Air', MSR: 'EgyptAir', NIA: 'Nile Air', RAM: 'Royal Air Maroc', TAR: 'Tunisair', DAH: 'Air Algérie',
  CYP: 'Cyprus Airways', TUS: 'TUS Airways', AEE: 'Aegean', OAL: 'Olympic Air', ELY: 'El Al', ISR: 'Israir', AIZ: 'Arkia',
  AFR: 'Air France', TVF: 'Transavia France', DLH: 'Lufthansa', EWG: 'Eurowings', BAW: 'British Airways', VIR: 'Virgin Atlantic',
  KLM: 'KLM', TRA: 'Transavia', ITY: 'ITA Airways', SWR: 'Swiss', AUA: 'Austrian', BEL: 'Brussels Airlines', IBE: 'Iberia',
  VLG: 'Vueling', RYR: 'Ryanair', WZZ: 'Wizz Air', EZY: 'easyJet', LOT: 'LOT Polish', CSA: 'Czech Airlines', ROT: 'TAROM',
  AFL: 'Aeroflot', SDM: 'Rossiya', UIA: 'Ukraine International', AZE: 'Azerbaijan Airlines', IRA: 'Iran Air', PIA: 'PIA',
  AIC: 'Air India', ETH: 'Ethiopian', KQA: 'Kenya Airways', SIA: 'Singapore Airlines', CPA: 'Cathay Pacific', CCA: 'Air China',
  CES: 'China Eastern', CSN: 'China Southern', UAL: 'United', AAL: 'American', DAL: 'Delta', ACA: 'Air Canada',
  FDX: 'FedEx', UPS: 'UPS', DHK: 'DHL', BCS: 'DHL', GTI: 'Atlas Air', CLX: 'Cargolux', RRR: 'Royal Air Force', RCH: 'US Air Force',
};
const airline = (flight) => (/^[A-Z]{3}\d/.test(flight) ? AIRLINES[flight.slice(0, 3)] ?? '' : '');

// Colour by altitude: warm near the ground, cool at cruising height (feet).
const ALT_STOPS = [[0, '#d9480f'], [4000, '#f08c00'], [10000, '#2f9e44'], [20000, '#1c7ed6'], [30000, '#5f3dc4'], [40000, '#a61e4d']];
const GROUND = '#8f8c85';
function altColour(alt) {
  if (alt === 'ground' || alt == null) return GROUND;
  const i = ALT_STOPS.findIndex(([a]) => alt < a);
  if (i === 0) return ALT_STOPS[0][1];
  if (i < 0) return ALT_STOPS.at(-1)[1];
  const [[a0, c0], [a1, c1]] = [ALT_STOPS[i - 1], ALT_STOPS[i]];
  const t = (alt - a0) / (a1 - a0);
  const rgb = (c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
  return `rgb(${rgb(c0).map((v, k) => Math.round(v + (rgb(c1)[k] - v) * t)).join(',')})`;
}
const ALT_EXPR = ['interpolate', ['linear'], ['get', 'alt'], ...ALT_STOPS.flat()];

const ft = (a) => (a === 'ground' ? 'on the ground' : a == null ? '' : `${Math.round(a).toLocaleString()} ft · ${Math.round(a * 0.3048).toLocaleString()} m`);
const kn = (s) => (s == null ? '' : `${Math.round(s)} kn · ${Math.round(s * 1.852)} km/h`);
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];
const rad = Math.PI / 180;
function kmAndBearing(from, to) {
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h));
  const y = Math.sin(dLon) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos(dLon);
  return { km, bearing: ((Math.atan2(y, x) / rad) + 360) % 360 };
}
/** A circle of `km` around a point, as a closed line of 72 points. */
function ring(site, km) {
  return Array.from({ length: 73 }, (_, i) => {
    const b = i * 5 * rad;
    const d = km / 6371;
    const lat = Math.asin(Math.sin(site.lat * rad) * Math.cos(d) + Math.cos(site.lat * rad) * Math.sin(d) * Math.cos(b));
    const lon = site.lon * rad + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(site.lat * rad), Math.cos(d) - Math.sin(site.lat * rad) * Math.sin(lat));
    return [lon / rad, lat / rad];
  });
}
const RINGS = [50, 100, 200];
const TRAIL_MS = 5 * 60_000;
const name = (p) => p.flight || p.hex.toUpperCase();

/**
 * Planes on the Radio page: start or stop the decoder (dump1090 on the RTL-SDR), the aircraft on an offline map with
 * trails, rings round the receiver and a details card, and a list. Returns show() for when its box becomes visible
 * again (the map has to measure itself) and stop().
 */
export function planesView(box, { onChange }) {
  box.innerHTML = `<div class="rx-planebar"><button type="button" class="btn primary rx-planego">Start planes</button><span class="rx-planecount" role="status"></span>
      <button type="button" class="btn small admin-only rx-site">Set receiver location</button></div>
    <p class="rx-health small" role="status"></p>
    <div class="rx-planegrid">
      <div class="rx-planemap"><div class="rx-mapel" role="region" aria-label="Map of planes"></div><p class="rx-nomap muted" hidden></p>
        <div class="rx-card" hidden></div>
        <div class="rx-legend" aria-label="Colours by altitude"><i></i><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>40k ft</span></div></div>
      <div class="rx-planeside"><div class="radio-scroll"><table class="radio-table rx-planelist"><thead><tr><th>Flight</th><th>Altitude</th><th class="rx-dist">Distance</th><th>Speed</th></tr></thead><tbody></tbody></table></div>
        <p class="muted small rx-unplaced"></p></div>
    </div>
    <p class="muted small">Aircraft send their position, height and call sign on 1090 MHz; the RTL-SDR picks them up with no internet. Best with both antenna rods at about 7 cm, upright, by a window. A red label is an emergency.</p>`;
  const el = (s) => $(s, box);
  let map = null;
  let mod = null;
  const marks = new Map(); // hex → marker
  const trails = new Map(); // hex → [[lon, lat, alt, ms]]
  let siteMark = null;
  let ringLabels = [];
  let fitted = false;
  let timer = null;
  let stopped = false;
  let picking = false;
  let selected = null;
  let siteKey = '';
  let listHtml = '';
  let r = { on: false, site: null, planes: [], unplaced: [], rate: null, rssi: null };

  async function mount() {
    const made = await mountRadioMap(el('.rx-mapel'), el('.rx-nomap'));
    if (!made) return;
    if (stopped) return made.map.remove();
    ({ map, mod } = made);
    map.once('load', () => {
      map.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'rings', type: 'line', source: 'rings', paint: { 'line-color': '#6b6a62', 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } });
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'trails', type: 'line', source: 'trails', paint: { 'line-color': ALT_EXPR, 'line-width': 2.5, 'line-opacity': 0.75 }, layout: { 'line-cap': 'round' } });
      drawSite();
      draw();
      if (r.site && !r.planes.length) map.jumpTo({ center: [r.site.lon, r.site.lat], zoom: 7 });
    });
    map.on('click', async (e) => {
      if (!picking) return;
      picking = false;
      map.getCanvas().style.cursor = '';
      try {
        const { site } = await api('/radio/site', jsonBody({ lat: e.lngLat.lat, lon: e.lngLat.lng }, 'PUT'));
        r.site = site;
        toast('Receiver location saved. Distances and rings now count from there.');
        drawSite();
        draw();
      } catch (err) {
        toast(err.message, 'error');
      }
      paintBar();
    });
  }

  /** The antenna's dot and the 50, 100 and 200 km rings round it. */
  function drawSite() {
    if (!map?.getSource('rings')) return;
    siteMark?.remove();
    for (const m of ringLabels) m.remove();
    ringLabels = [];
    const s = r.site;
    map.getSource('rings').setData({ type: 'FeatureCollection', features: s ? RINGS.map((km) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring(s, km) } })) : [] });
    if (!s) return;
    const dot = document.createElement('div');
    dot.className = 'rx-sitedot';
    dot.title = 'This receiver';
    siteMark = new mod.maplibregl.Marker({ element: dot }).setLngLat([s.lon, s.lat]).addTo(map);
    ringLabels = RINGS.map((km) => {
      const tag = document.createElement('div');
      tag.className = 'rx-ringtag';
      tag.textContent = `${km} km`;
      return new mod.maplibregl.Marker({ element: tag }).setLngLat(ring(s, km)[0]).addTo(map);
    });
  }

  function draw() {
    const now = Date.now();
    for (const p of r.planes) {
      const t = trails.get(p.hex) ?? [];
      const last = t.at(-1);
      if (!last || last[0] !== p.lon || last[1] !== p.lat) t.push([p.lon, p.lat, p.alt === 'ground' ? 0 : p.alt ?? 0, now]);
      trails.set(p.hex, t.filter((x) => now - x[3] < TRAIL_MS));
    }
    for (const [hex, t] of trails) if (!t.length || now - t.at(-1)[3] > 60_000) trails.delete(hex);
    if (!map) return;
    for (const [hex, m] of marks) {
      if (!r.planes.some((p) => p.hex === hex)) {
        m.remove();
        marks.delete(hex);
      }
    }
    for (const p of r.planes) {
      let m = marks.get(p.hex);
      if (!m) {
        const dot = document.createElement('div');
        dot.className = 'plane';
        dot.innerHTML = `${PLANE}<span></span>`;
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          select(p.hex);
        });
        m = new mod.maplibregl.Marker({ element: dot }).setLngLat([p.lon, p.lat]).addTo(map);
        marks.set(p.hex, m);
      } else m.setLngLat([p.lon, p.lat]);
      const dot = m.getElement();
      dot.classList.toggle('emergency', p.emergency);
      dot.classList.toggle('sel', p.hex === selected);
      const svg = dot.querySelector('svg');
      svg.style.transform = `rotate(${p.track ?? 0}deg)`;
      svg.style.fill = altColour(p.alt);
      dot.querySelector('span').textContent = `${name(p)}${p.alt === 'ground' ? ' · ground' : p.alt != null ? ` · ${(Math.round(p.alt / 100) * 100).toLocaleString()} ft` : ''}`;
      dot.title = `${name(p)}, tap for details`;
    }
    if (map.getSource('trails')) {
      const features = [];
      for (const t of trails.values()) for (let i = 1; i < t.length; i++) features.push({ type: 'Feature', properties: { alt: t[i][2] }, geometry: { type: 'LineString', coordinates: [t[i - 1].slice(0, 2), t[i].slice(0, 2)] } });
      map.getSource('trails').setData({ type: 'FeatureCollection', features });
    }
    // The first time planes show up, bring them (and the receiver) into view.
    if (!fitted && r.planes.length) {
      fitted = true;
      const pts = [...r.planes, ...(r.site ? [r.site] : [])];
      const lons = pts.map((p) => p.lon);
      const lats = pts.map((p) => p.lat);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 9 });
    }
  }

  const where = (p) => (r.site ? kmAndBearing(r.site, p) : null);

  function select(hex, fly = false) {
    selected = hex;
    const p = r.planes.find((x) => x.hex === hex);
    if (p && fly && map) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 9) });
    paintCard();
    paintList();
    draw();
  }

  /** The selected plane's details, over the map. */
  function paintCard() {
    const card = el('.rx-card');
    const p = r.planes.find((x) => x.hex === selected);
    card.hidden = !selected;
    if (!selected) return;
    if (!p) {
      card.innerHTML = `<button type="button" class="rx-cardx" aria-label="Close">×</button><strong>${esc(selected.toUpperCase())}</strong><p class="muted">Out of range: no position in the last minute.</p>`;
      return;
    }
    const w = where(p);
    const climb = p.climb == null ? '' : Math.abs(p.climb) < 200 ? 'level' : `${p.climb > 0 ? '↑ climbing' : '↓ descending'} ${Math.abs(Math.round(p.climb / 50) * 50).toLocaleString()} ft/min`;
    const squawk = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' }[p.squawk];
    const rows = [
      ['Altitude', `${ft(p.alt)}${climb ? `, ${climb}` : ''}`],
      ['Speed', kn(p.speed)],
      ['Heading', p.track != null ? `${Math.round(p.track)}° ${compass(p.track)}` : ''],
      ['From here', w ? `${w.km.toFixed(w.km < 10 ? 1 : 0)} km ${compass(w.bearing)}` : ''],
      ['Squawk', p.squawk ? `${p.squawk}${squawk ? ` · ${squawk}` : ''}` : ''],
      ['Signal', p.rssi != null ? `${p.rssi.toFixed(1)} dB` : ''],
      ['Heard', `${p.seen} s ago`],
      ['Aircraft id', p.hex.toUpperCase()],
    ].filter(([, v]) => v);
    card.innerHTML = `<button type="button" class="rx-cardx" aria-label="Close">×</button>
      <strong${p.emergency ? ' class="error-text"' : ''}>${esc(name(p))}</strong>${airline(p.flight) ? `<span class="muted">${esc(airline(p.flight))}</span>` : ''}
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }

  function paintBar() {
    el('.rx-planego').textContent = r.on ? 'Stop planes' : 'Start planes';
    el('.rx-planego').setAttribute('aria-pressed', String(r.on));
    el('.rx-planecount').textContent = !r.on ? 'Off. Starting planes pauses listening and scanning.' : r.planes.length ? `${r.planes.length} ${r.planes.length === 1 ? 'plane' : 'planes'} on the map` : 'Listening for planes…';
    el('.rx-site').textContent = picking ? 'Tap the map where the antenna is' : r.site ? 'Move receiver location' : 'Set receiver location';
    el('.rx-site').disabled = !map;
    // Health: a silent antenna shows here before any plane would.
    const health = el('.rx-health');
    health.className = 'rx-health small';
    if (!r.on) health.textContent = '';
    else if (r.rate === null) health.textContent = 'Starting: counting what the antenna hears…';
    else if (r.rate === 0) {
      health.classList.add('warn-text');
      health.textContent = 'Not hearing anything yet. Check the antenna: both rods about 7 cm, upright, by a window, as high as you can.';
    } else health.textContent = `Hearing ${r.rate.toLocaleString()} messages a minute${r.rssi != null ? ` · strongest signal ${r.rssi.toFixed(1)} dB` : ''}`;
  }

  function paintList() {
    el('.rx-dist').hidden = !r.site;
    const rows = r.planes
      .map((p) => ({ p, w: where(p) }))
      .sort((a, b) => b.p.emergency - a.p.emergency || (a.w && b.w ? a.w.km - b.w.km : name(a.p).localeCompare(name(b.p))));
    const html = rows.length
      ? rows
          .map(({ p, w }) => `<tr class="${p.emergency ? 'hot' : ''}${p.hex === selected ? ' sel' : ''}"><td><button type="button" class="linkbtn" data-plane="${esc(p.hex)}">${esc(name(p))}</button>${airline(p.flight) ? `<small>${esc(airline(p.flight))}</small>` : ''}</td><td>${esc(p.alt === 'ground' ? 'ground' : p.alt != null ? `${Math.round(p.alt).toLocaleString()} ft` : '')}</td>${r.site ? `<td>${w ? `${Math.round(w.km)} km ${compass(w.bearing)}` : ''}</td>` : ''}<td>${p.speed != null ? `${Math.round(p.speed)} kn` : ''}</td></tr>`)
          .join('')
      : `<tr><td colspan="4" class="muted">${r.on ? 'No planes with a position yet.' : 'Planes are off.'}</td></tr>`;
    if (html !== listHtml) el('.rx-planelist tbody').innerHTML = listHtml = html; // only when something changed
    el('.rx-unplaced').textContent = r.on && r.unplaced.length
      ? `Also heard, no position yet: ${r.unplaced.map((u) => u.flight || u.hex.toUpperCase()).join(', ')}. They appear on the map once their position comes through.`
      : '';
  }

  async function tick() {
    clearTimeout(timer);
    if (stopped) return;
    r = await api('/radio/planes').catch(() => ({ ...r, on: false, planes: [], unplaced: [] }));
    if (JSON.stringify(r.site) !== siteKey) {
      siteKey = JSON.stringify(r.site);
      drawSite(); // set from another device, or first read
    }
    draw();
    paintBar();
    paintList();
    if (selected) paintCard();
    timer = setTimeout(tick, r.on && !box.hidden ? 2000 : 6000);
  }

  // A row answers on touch-down: the list is redrawn every couple of seconds, and a tap spanning a redraw is lost.
  box.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-plane]');
    if (row) select(row.dataset.plane, true);
  });
  box.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-plane]');
    if (row) return e.detail === 0 && select(row.dataset.plane, true); // Enter or Space on the row's button
    if (e.target.closest('.rx-cardx')) return select(null);
    if (e.target.closest('.rx-site')) {
      picking = !picking;
      if (map) map.getCanvas().style.cursor = picking ? 'crosshair' : '';
      if (picking) toast('Tap the map where the antenna is.');
      return paintBar();
    }
    const go = e.target.closest('.rx-planego');
    if (!go) return;
    go.disabled = true;
    try {
      const st = await api('/radio');
      if (st.planes) await api('/radio/planes', { method: 'DELETE' });
      else if (!st.planesTool) {
        if (document.body.dataset.role === 'member') toast('An admin can install the planes decoder here.', 'error');
        else await installAddon('radio', 'the planes decoder', 'Installs dump1090-fa with Homebrew: the free program that turns aircraft signals (ADS-B, 1090 MHz) into positions on the map.');
      } else {
        await api('/radio/planes', { method: 'POST' });
        fitted = false;
        trails.clear();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    go.disabled = false;
    await tick();
    onChange();
  });

  void mount().then(paintBar);
  void tick();
  return {
    show() {
      map?.resize();
      void tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      map?.remove();
    },
  };
}
