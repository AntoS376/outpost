import { $, api, esc, installAddon, jsonBody, toast } from './core.js';

const FREQS = [['433.92M', '433.92 MHz · Europe, Africa and the Middle East'], ['868M', '868 MHz · Europe'], ['915M', '915 MHz · the Americas']];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** A sensor's readings as [label, value] pairs, in the order people look for them. */
function readings(r) {
  const out = [];
  if (r.temperature_C != null) out.push(['Temperature', `${r.temperature_C.toFixed(1)} °C`]);
  if (r.humidity != null) out.push(['Humidity', `${Math.round(r.humidity)} %`]);
  if (r.wind_avg_km_h != null) out.push(['Wind', `${Math.round(r.wind_avg_km_h)} km/h${r.wind_dir_deg != null ? ` from ${COMPASS[Math.round(r.wind_dir_deg / 45) % 8]}` : ''}${r.wind_max_km_h != null ? `, gusts ${Math.round(r.wind_max_km_h)}` : ''}`]);
  if (r.rain_rate_mm_h != null) out.push(['Rain now', `${r.rain_rate_mm_h} mm/h`]);
  if (r.rain_mm != null) out.push(['Rain total', `${r.rain_mm} mm`]);
  if (r.pressure_hPa != null) out.push(['Pressure', `${Math.round(r.pressure_hPa)} hPa`]);
  if (r.uv != null) out.push(['UV index', String(r.uv)]);
  if (r.light_lux != null) out.push(['Light', `${Math.round(r.light_lux).toLocaleString()} lux`]);
  if (r.moisture != null) out.push(['Soil moisture', `${Math.round(r.moisture)} %`]);
  return out;
}

/**
 * Sensors on the Radio page: start or stop rtl_433 on the RTL-SDR, choose the band, and a card per nearby sensor with
 * its latest readings. Passing cars' tyre sensors and buttons are only counted. Returns show() and stop().
 */
export function sensorsView(box, { onChange }) {
  box.innerHTML = `<div class="rx-planebar"><button type="button" class="btn primary rx-sensgo">Start sensors</button>
      <label class="rx-sensfreq"><select aria-label="Sensor band">${FREQS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
      <span class="rx-senscount" role="status"></span></div>
    <p class="rx-health small" role="status"></p>
    <ul class="prep-grid rx-sensors"></ul>
    <p class="muted small rx-sensnote"></p>
    <p class="muted small">Weather stations, outdoor thermometers, rain gauges and other household sensors send their readings every minute or so, and the RTL-SDR picks them up with no internet: yours, and your neighbours'. Only readings are shown, and nothing is kept once Outpost stops. Best with the antenna rods at about 17 cm, by a window.</p>`;
  const el = (s) => $(s, box);
  let r = { on: false, freq: '433.92M', sensors: [], tyres: 0, others: 0, heard: 0 };
  let timer = null;
  let stopped = false;
  let cardsHtml = '';

  function paint() {
    el('.rx-sensgo').textContent = r.on ? 'Stop sensors' : 'Start sensors';
    el('.rx-sensgo').setAttribute('aria-pressed', String(r.on));
    if (document.activeElement !== el('.rx-sensfreq select')) el('.rx-sensfreq select').value = r.freq;
    el('.rx-senscount').textContent = !r.on ? 'Off. Starting sensors pauses listening and scanning.' : r.sensors.length ? `${r.sensors.length} ${r.sensors.length === 1 ? 'sensor' : 'sensors'} heard` : 'Listening for sensors…';
    el('.rx-health').textContent = !r.on ? '' : r.heard ? `Heard ${r.heard} ${r.heard === 1 ? 'signal' : 'signals'} in the last 10 minutes.` : 'Nothing heard yet. Most sensors send every 30 to 60 seconds; give it a few minutes.';
    const html = r.sensors
      .map((s) => {
        const rows = readings(s.readings);
        const name = s.model.replace(/[-_]/g, ' ');
        const tags = [s.channel ? `channel ${s.channel}` : '', s.id ? `id ${s.id}` : ''].filter(Boolean).join(' · ');
        return `<li class="prep-card rx-sensor"><h3>${esc(name)}</h3>${tags ? `<p class="rmeta">${esc(tags)}</p>` : ''}
          <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
          <p class="muted small">${s.readings.battery_ok === 0 ? '<span class="warn-text">Battery low</span> · ' : ''}${esc(ago(s.lastSeen))}${s.rssi != null ? ` · signal ${s.rssi} dB` : ''}</p></li>`;
      })
      .join('');
    if (html !== cardsHtml) el('.rx-sensors').innerHTML = cardsHtml = html;
    el('.rx-sensnote').textContent = r.on
      ? [r.tyres ? `${r.tyres} tyre-pressure ${r.tyres === 1 ? 'signal' : 'signals'} from passing cars in the last 10 minutes (counted only, never listed).` : '', r.others ? `${r.others} other ${r.others === 1 ? 'device' : 'devices'} heard, such as remotes and doorbells (not shown).` : ''].filter(Boolean).join(' ')
      : '';
  }

  async function tick() {
    clearTimeout(timer);
    if (stopped) return;
    r = await api('/radio/sensors').catch(() => ({ ...r, on: false }));
    paint();
    timer = setTimeout(tick, r.on && !box.hidden ? 3000 : 8000);
  }

  async function start(freq) {
    const st = await api('/radio');
    if (!st.sensorsTool) {
      if (document.body.dataset.role === 'member') return toast('An admin can install the sensors decoder here.', 'error');
      await installAddon('radio', 'the sensors decoder', 'Installs rtl_433 with Homebrew: the free program that reads weather stations, thermometers and other sensors on 433 MHz.');
      return;
    }
    r = await api('/radio/sensors', jsonBody({ freq }));
  }

  box.addEventListener('change', async (e) => {
    if (!e.target.closest('.rx-sensfreq')) return;
    try {
      if (r.on) await start(e.target.value); // restarts on the new band
      else r.freq = e.target.value;
    } catch (err) {
      toast(err.message, 'error');
    }
    paint();
  });
  box.addEventListener('click', async (e) => {
    const go = e.target.closest('.rx-sensgo');
    if (!go) return;
    go.disabled = true;
    try {
      if (r.on) await api('/radio/sensors', { method: 'DELETE' });
      else await start(el('.rx-sensfreq select').value);
    } catch (err) {
      toast(err.message, 'error');
    }
    go.disabled = false;
    await tick();
    onChange();
  });

  void tick();
  return {
    show: () => void tick(),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
