import { $, api, esc } from './core.js';
import { formats, parseCoords, sunTimes } from './geo.js';
import { spell } from './morse.js';

const time = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
const HELP = { hospital: ['Hospitals', 'hospital'], clinic: ['Clinics', 'clinic'], doctors: ['Doctors', 'doctor'], pharmacy: ['Pharmacies', 'pharmacy'], police: ['Police', 'police station'], fire_station: ['Fire stations', 'fire station'] };
const mapFile = () => {
  try {
    return JSON.parse(localStorage.getItem('outpost.map') ?? '""');
  } catch {
    return '';
  }
};

/**
 * A horizontal sun clock for a latitude: hour lines at tan(a) = sin(latitude) · tan(15° per hour from noon), the
 * noon line towards the pole. South of the equator the dial is mirrored (the noon line points south).
 */
export function sundial(lat) {
  const cx = 210;
  const cy = 222;
  const r = 178;
  const side = lat < 0 ? -1 : 1;
  const sinLat = Math.sin((Math.abs(lat) * Math.PI) / 180);
  let lines = '';
  for (let h = 6; h <= 18; h++) {
    const a = h === 6 || h === 18 ? Math.sign(h - 12) * (Math.PI / 2) : Math.atan(sinLat * Math.tan(((h - 12) * 15 * Math.PI) / 180));
    const x = side * Math.sin(a);
    const y = Math.cos(a);
    lines += `<line x1="${cx}" y1="${cy}" x2="${(cx + r * x).toFixed(1)}" y2="${(cy - r * y).toFixed(1)}" ${h === 12 ? 'stroke-width="3"' : ''}/>`;
    lines += `<text x="${(cx + (r + 16) * x).toFixed(1)}" y="${(cy - (r + 16) * y + 5).toFixed(1)}">${h}</text>`;
  }
  return `<svg class="sundial" viewBox="0 0 420 250" role="img" aria-label="Sun clock hour lines for latitude ${Math.abs(lat).toFixed(1)}°">
    <path d="M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}" class="rim"/>${lines}
    <polygon points="${cx - 7},${cy} ${cx + 7},${cy} ${cx},${cy - r * 0.62}" class="gnomon"/>
    <text x="${cx + 14}" y="${cy - r * 0.4}" class="note" text-anchor="start">stick</text>
    <text x="${cx}" y="16" class="pole">${lat < 0 ? 'S' : 'N'} ↑</text></svg>`;
}
const utc = (d) => (d ? `${d.toISOString().slice(11, 16)} UTC` : '');

/** Location: say where you are in every common format, and when the light comes and goes. */
export async function locationView(body) {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem('outpost.mapCenter') ?? 'null');
    } catch {
      return null;
    }
  })();
  body.innerHTML = `<p class="muted" style="max-width:70ch">Phones can't share GPS with Outpost over a home network (browsers only allow it over HTTPS), so type a position, search a place on your offline map, or use where the map was last centred.</p>
    <form id="where" class="row noprint"><div class="grow"><label for="pos">Position or place</label><input id="pos" autocomplete="off" placeholder="33.8938, 35.5018 · 33°53'38&quot;N 35°30'07&quot;E · 36S YC 35000 54000 · Beirut" value="${esc(sessionStorage.getItem('em.pos') ?? '')}"></div>
      <button class="btn primary" type="submit">Show</button>${saved ? '<button class="btn" type="button" id="usemap">Use the map’s centre</button>' : ''}</form>
    <p id="posmsg" class="muted" role="status"></p>
    <section class="block" id="out" hidden></section>
    <section class="block" id="help" hidden></section>
    <section class="block"><h2>Sun</h2>
      <div class="row noprint"><div><label for="sday">Date</label><input id="sday" type="date" value="${iso(today)}"></div></div>
      <div id="sun"><p class="muted">Choose a position first.</p></div></section>`;

  let here = null;
  let nearby = [];
  const msg = $('#posmsg', body);

  function show(lat, lon, label) {
    here = { lat, lon };
    const f = formats(lat, lon);
    const rows = [
      ['Decimal degrees', f.decimal],
      ['Degrees, minutes, seconds', f.dms],
      ['Degrees and decimal minutes', f.ddm],
      ['UTM', f.utm ?? 'Not defined this close to the poles'],
      ['MGRS (military grid)', f.mgrs ?? 'Not defined this close to the poles'],
    ];
    $('#out', body).hidden = false;
    $('#out', body).innerHTML = `<h2>${label ? esc(label) : 'This position'}</h2>
      <dl class="readout">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${f.mgrs ? `<p class="spellout"><span class="muted">Say it on a radio:</span> ${esc(spell(f.mgrs.replace(/\s+/g, ' ')))}</p>` : ''}
      <p class="noprint"><a class="btn" href="#maps" id="tomap">Show on map</a></p>`;
    sun();
    help();
  }

  /** Hospitals, pharmacies, police and fire stations near the position, from the offline map. */
  async function help() {
    const box = $('#help', body);
    box.hidden = false;
    const file = mapFile();
    if (!file) return void (box.innerHTML = '<h2>Nearest help</h2><p class="muted">Open a map in Maps first to see hospitals, pharmacies, police and fire stations near here.</p>');
    box.innerHTML = '<h2>Nearest help</h2><p class="muted">Looking on your map…</p>';
    let found;
    try {
      found = (await api(`/maps/nearby?file=${encodeURIComponent(file)}&lat=${here.lat}&lon=${here.lon}`)).results;
    } catch (err) {
      return void (box.innerHTML = `<h2>Nearest help</h2><p class="note-box">${esc(err.message)}</p>`);
    }
    nearby = found;
    const groups = Object.entries(HELP).map(([kind, [label, one]]) => {
      const items = found.map((h, i) => [h, i]).filter(([h]) => h.kind === kind);
      return items.length ? `<h3>${label}</h3><ul class="helplist">${items.map(([h, i]) => `<li><span><b>${esc(h.en ?? h.name) || `Unnamed ${one}`}</b>${h.en && h.name ? ` <span class="muted">${esc(h.name)}</span>` : ''}
          <span class="helpkm">${h.km < 1 ? `${Math.round(h.km * 1000)} m` : `${h.km.toFixed(1)} km`}</span></span>
          <span class="row noprint"><button class="btn small primary" type="button" data-dir="${i}">Directions</button><button class="btn small" type="button" data-fly="${i}">Map</button></span></li>`).join('')}</ul>` : '';
    }).join('');
    box.innerHTML = `<h2>Nearest help</h2>${groups || '<p class="muted">Nothing found within 10 km on this map.</p>'}
      <p class="muted" style="font-size:13px">From your map ${esc(file)} (OpenStreetMap), within 10 km as the crow flies. A place may have moved or closed: call ahead if you can.</p>`;
  }

  function sun() {
    if (!here) return;
    const [y, m, d] = $('#sday', body).value.split('-').map(Number);
    const s = sunTimes(y, m, d, here.lat, here.lon);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (s.polar) {
      $('#sun', body).innerHTML = `<p class="decoded">${s.polar === 'day' ? 'The sun does not set on this day.' : 'The sun does not rise on this day.'}</p>`;
      return;
    }
    const hours = (s.sunset - s.sunrise) / 3600000;
    // Sun time is 12:00 when the sun is highest; the clock says s.noon then, so that difference turns one into the other.
    const off = Math.round((s.noon.getHours() * 60 + s.noon.getMinutes() + s.noon.getSeconds() / 60) - 720);
    const span = `${Math.floor(Math.abs(off) / 60) ? `${Math.floor(Math.abs(off) / 60)} h ` : ''}${Math.abs(off) % 60} min`;
    const fix = off === 0 ? 'On this date it matches the clock.' : `On this date, ${off > 0 ? 'add' : 'take away'} ${span} for clock time (the sun is highest at ${time(s.noon)} by the clock).`;
    const pole = here.lat < 0 ? 'south' : 'north';
    $('#sun', body).innerHTML = `<dl class="readout sun">
        <div><dt>First light (civil dawn)</dt><dd>${time(s.dawn)} <span class="muted">${utc(s.dawn)}</span></dd></div>
        <div><dt>Sunrise</dt><dd>${time(s.sunrise)} <span class="muted">${utc(s.sunrise)}</span></dd></div>
        <div><dt>Sun highest</dt><dd>${time(s.noon)} <span class="muted">${utc(s.noon)}</span></dd></div>
        <div><dt>Sunset</dt><dd>${time(s.sunset)} <span class="muted">${utc(s.sunset)}</span></dd></div>
        <div><dt>Last light (civil dusk)</dt><dd>${time(s.dusk)} <span class="muted">${utc(s.dusk)}</span></dd></div>
        <div><dt>Daylight</dt><dd>${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min</dd></div></dl>
      <p class="muted" style="font-size:13px">Times are in this device's time zone (${esc(tz)}) and UTC, to about a minute. Hills and buildings shift what you see.</p>
      <h3>Make a sun clock</h3>
      <div class="sunclock">${sundial(here.lat)}
        <ol>
          <li>Copy this dial onto card, board or flat ground (or print this page). It is drawn for latitude ${Math.abs(here.lat).toFixed(1)}° ${here.lat < 0 ? 'S' : 'N'}, where you are.</li>
          <li>Find true ${pole}: push a stick upright, mark the tip of its shadow, wait 15 minutes and mark it again. The line from the first mark to the second runs west to east; ${pole} is at right angles to it, on the side ${here.lat < 0 ? 'towards' : 'away from'} the midday sun.</li>
          <li>Lay the dial flat and level, with the 12 line pointing to true ${pole}.</li>
          <li>Stand a stick or a triangle of card on the 12 line at the centre, slanting up towards ${pole} at ${Math.round(Math.abs(here.lat))}°, your latitude.</li>
          <li>Its shadow falls on the sun time. ${fix}</li>
        </ol>${Math.abs(here.lat) < 10 ? '<p class="muted small">Near the equator the hour lines bunch up around noon, so this dial reads poorly; watch where an upright stick’s shadow points instead.</p>' : ''}</div>`;
  }

  async function lookup(text) {
    sessionStorage.setItem('em.pos', text);
    msg.textContent = '';
    try {
      const p = parseCoords(text);
      return show(p.lat, p.lon);
    } catch (err) {
      const file = mapFile();
      if (/\d/.test(text) || !file) return void (msg.innerHTML = `<span class="error-text">${esc(err.message)}</span>`);
      try {
        const r = (await api(`/maps/search?file=${encodeURIComponent(file)}&q=${encodeURIComponent(text)}`)).results[0];
        if (!r) return void (msg.textContent = `No place called “${text}” on your map ${file}. Try coordinates instead.`);
        show(r.lat, r.lon, r.en ? `${r.en} (${r.name})` : r.name);
        msg.textContent = `Found on your map ${file}: the centre of ${r.en || r.name}, a ${r.kind}.`;
      } catch (e2) {
        msg.innerHTML = `<span class="error-text">${esc(e2.message)}</span>`;
      }
    }
  }

  body.addEventListener('submit', (e) => {
    e.preventDefault();
    lookup($('#pos', body).value);
  });
  body.addEventListener('change', (e) => e.target.id === 'sday' && sun());
  body.addEventListener('click', (e) => {
    if (e.target.id === 'usemap' && saved) {
      $('#pos', body).value = `${saved.lat.toFixed(5)}, ${saved.lon.toFixed(5)}`;
      lookup($('#pos', body).value);
    }
    if (e.target.id === 'tomap' && here) sessionStorage.setItem('outpost.flyTo', JSON.stringify(here));
    const pick = nearby[e.target.dataset?.dir ?? e.target.dataset?.fly];
    if (pick) {
      const label = pick.en ?? pick.name ?? '';
      if (e.target.dataset.dir !== undefined) sessionStorage.setItem('outpost.directionsTo', JSON.stringify({ lat: pick.lat, lon: pick.lon, label }));
      else sessionStorage.setItem('outpost.flyTo', JSON.stringify({ lat: pick.lat, lon: pick.lon }));
      location.hash = '#maps';
    }
  });
  if ($('#pos', body).value) lookup($('#pos', body).value);
  else if (saved) {
    // Nothing typed yet: start from where the map was last centred, so the sun times, sun clock and help show at once.
    $('#pos', body).value = `${saved.lat.toFixed(5)}, ${saved.lon.toFixed(5)}`;
    await lookup($('#pos', body).value);
    msg.textContent = 'Showing where the map was last centred. Type another position or place to change it.';
  }
}
