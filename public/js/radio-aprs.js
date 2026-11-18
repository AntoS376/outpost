import { $, api, esc, installAddon, jsonBody, toast } from './core.js';
import { mountRadioMap } from './radio-map.js';

const FREQS = [['144.800M', '144.800 MHz · Europe, Africa and the Middle East'], ['144.390M', '144.390 MHz · North America'], ['145.175M', '145.175 MHz · Australia'], ['144.640M', '144.640 MHz · China']];
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const rad = Math.PI / 180;
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
function away(from, to) {
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h));
  const b = (Math.atan2(Math.sin(dLon) * Math.cos(to.lat * rad), Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos(dLon)) / rad + 360) % 360;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km ${COMPASS[Math.round(b / 22.5) % 16]}`;
}

/**
 * APRS on the Radio page: start or stop the decoder (rtl_fm into direwolf), choose the frequency, and the stations heard,
 * on an offline map and in a list with their latest message. Returns show() and stop().
 */
export function aprsView(box, { onChange }) {
  box.innerHTML = `<div class="rx-planebar"><button type="button" class="btn primary rx-aprsgo">Start APRS</button>
      <label class="rx-sensfreq"><select aria-label="APRS frequency">${FREQS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
      <span class="rx-aprscount" role="status"></span></div>
    <p class="rx-health small" role="status"></p>
    <div class="rx-planegrid">
      <div class="rx-planemap"><div class="rx-mapel" role="region" aria-label="Map of APRS stations"></div><p class="rx-nomap muted" hidden></p></div>
      <div class="rx-planeside"><div class="radio-scroll"><table class="radio-table rx-aprslist"><thead><tr><th>Station</th><th>Message</th><th>Heard</th></tr></thead><tbody></tbody></table></div></div>
    </div>
    <p class="muted small">APRS is how licensed radio amateurs share where they are, the weather and short messages, on one shared frequency. Digipeaters on hilltops relay it, so stations far away come through. Listening needs no licence. Best with both antenna rods at about 50 cm, upright, by a window.</p>`;
  const el = (s) => $(s, box);
  let r = { on: false, freq: '144.800M', site: null, stations: [], heard: 0 };
  let map = null;
  let mod = null;
  const marks = new Map(); // station key → marker
  let siteMark = null;
  let fitted = false;
  let timer = null;
  let stopped = false;
  let listHtml = '';

  async function mount() {
    const made = await mountRadioMap(el('.rx-mapel'), el('.rx-nomap'));
    if (!made) return;
    if (stopped) return made.map.remove();
    ({ map, mod } = made);
    map.once('load', draw);
  }

  function draw() {
    if (!map) return;
    const placed = r.stations.filter((s) => s.lat != null);
    for (const [key, m] of marks) {
      if (!placed.some((s) => s.key === key)) {
        m.remove();
        marks.delete(key);
      }
    }
    for (const s of placed) {
      let m = marks.get(s.key);
      if (!m) {
        const dot = document.createElement('div');
        dot.className = 'aprs-dot';
        dot.innerHTML = '<i></i><span></span>';
        m = new mod.maplibregl.Marker({ element: dot }).setLngLat([s.lon, s.lat]).addTo(map);
        marks.set(s.key, m);
      } else m.setLngLat([s.lon, s.lat]);
      const dot = m.getElement();
      dot.querySelector('span').textContent = s.key;
      dot.title = [s.key, s.kind, s.comment, s.speed ? `${Math.round(s.speed * 1.852)} km/h` : '', s.altitude != null ? `${Math.round(s.altitude)} m` : '', ago(s.lastSeen)].filter(Boolean).join(' · ');
    }
    siteMark?.remove();
    siteMark = null;
    if (r.site) {
      const dot = document.createElement('div');
      dot.className = 'rx-sitedot';
      dot.title = 'This receiver';
      siteMark = new mod.maplibregl.Marker({ element: dot }).setLngLat([r.site.lon, r.site.lat]).addTo(map);
    }
    if (!fitted && placed.length) {
      fitted = true;
      const pts = [...placed, ...(r.site ? [r.site] : [])];
      const lons = pts.map((p) => p.lon);
      const lats = pts.map((p) => p.lat);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 11 });
    }
  }

  function paint() {
    el('.rx-aprsgo').textContent = r.on ? 'Stop APRS' : 'Start APRS';
    el('.rx-aprsgo').setAttribute('aria-pressed', String(r.on));
    if (document.activeElement !== el('.rx-sensfreq select')) el('.rx-sensfreq select').value = r.freq;
    el('.rx-aprscount').textContent = !r.on ? 'Off. Starting APRS pauses listening and scanning.' : r.stations.length ? `${r.stations.length} ${r.stations.length === 1 ? 'station' : 'stations'} heard` : 'Listening for stations…';
    el('.rx-health').textContent = !r.on ? '' : r.heard ? `Heard ${r.heard} ${r.heard === 1 ? 'packet' : 'packets'} in the last 10 minutes.` : 'Nothing heard yet. Stations usually send every few minutes; where APRS is little used, it can stay quiet for a long time.';
    const html = r.stations.length
      ? r.stations
          .map((s) => `<tr><td><button type="button" class="linkbtn" data-station="${esc(s.key)}">${esc(s.key)}</button><small>${esc(s.kind)}${s.call !== s.key ? ` · by ${esc(s.call)}` : ''}${r.site && s.lat != null ? ` · ${away(r.site, s)}` : ''}</small></td><td>${esc(s.comment)}</td><td>${esc(ago(s.lastSeen))}</td></tr>`)
          .join('')
      : `<tr><td colspan="3" class="muted">${r.on ? 'No stations yet.' : 'APRS is off.'}</td></tr>`;
    if (html !== listHtml) el('.rx-aprslist tbody').innerHTML = listHtml = html;
  }

  async function tick() {
    clearTimeout(timer);
    if (stopped) return;
    r = await api('/radio/aprs').catch(() => ({ ...r, on: false }));
    draw();
    paint();
    timer = setTimeout(tick, r.on && !box.hidden ? 3000 : 8000);
  }

  async function start(freq) {
    const st = await api('/radio');
    if (!st.aprsTool) {
      if (document.body.dataset.role === 'member') return toast('An admin can install the APRS decoder here.', 'error');
      await installAddon('radio', 'the APRS decoder', 'Installs direwolf with Homebrew: the free program that decodes APRS, the positions and messages radio amateurs send on 144.800 MHz.');
      return;
    }
    r = await api('/radio/aprs', jsonBody({ freq }));
    fitted = false;
  }

  // Rows answer on touch-down: the list is redrawn as stations come in, and a tap spanning a redraw is lost.
  box.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-station]');
    const s = row && r.stations.find((x) => x.key === row.dataset.station);
    if (s?.lat != null && map) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 11) });
  });
  box.addEventListener('change', async (e) => {
    if (!e.target.closest('.rx-sensfreq')) return;
    try {
      if (r.on) await start(e.target.value); // restarts on the new frequency
      else r.freq = e.target.value;
    } catch (err) {
      toast(err.message, 'error');
    }
    paint();
  });
  box.addEventListener('click', async (e) => {
    const go = e.target.closest('.rx-aprsgo');
    if (!go) return;
    go.disabled = true;
    try {
      if (r.on) await api('/radio/aprs', { method: 'DELETE' });
      else await start(el('.rx-sensfreq select').value);
    } catch (err) {
      toast(err.message, 'error');
    }
    go.disabled = false;
    await tick();
    onChange();
  });

  void mount();
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
