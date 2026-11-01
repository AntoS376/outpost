import { $, api, esc } from './core.js';
import { formats, parseCoords, sunTimes } from './geo.js';
import { spell } from './morse.js';

const time = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
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
    <section class="block"><h2>Sun</h2>
      <div class="row noprint"><div><label for="sday">Date</label><input id="sday" type="date" value="${iso(today)}"></div></div>
      <div id="sun"><p class="muted">Choose a position first.</p></div></section>`;

  let here = null;
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
    $('#sun', body).innerHTML = `<dl class="readout sun">
        <div><dt>First light (civil dawn)</dt><dd>${time(s.dawn)} <span class="muted">${utc(s.dawn)}</span></dd></div>
        <div><dt>Sunrise</dt><dd>${time(s.sunrise)} <span class="muted">${utc(s.sunrise)}</span></dd></div>
        <div><dt>Sun highest</dt><dd>${time(s.noon)} <span class="muted">${utc(s.noon)}</span></dd></div>
        <div><dt>Sunset</dt><dd>${time(s.sunset)} <span class="muted">${utc(s.sunset)}</span></dd></div>
        <div><dt>Last light (civil dusk)</dt><dd>${time(s.dusk)} <span class="muted">${utc(s.dusk)}</span></dd></div>
        <div><dt>Daylight</dt><dd>${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min</dd></div></dl>
      <p class="muted" style="font-size:13px">Times are in this device's time zone (${esc(tz)}) and UTC, to about a minute. Hills and buildings shift what you see.</p>`;
  }

  async function lookup(text) {
    sessionStorage.setItem('em.pos', text);
    msg.textContent = '';
    try {
      const p = parseCoords(text);
      return show(p.lat, p.lon);
    } catch (err) {
      const file = (() => {
        try {
          return JSON.parse(localStorage.getItem('outpost.map') ?? '""');
        } catch {
          return '';
        }
      })();
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
  });
  if ($('#pos', body).value) lookup($('#pos', body).value);
}
