import { $, $$, api, esc, installAddon, jsonBody, store, toast } from './core.js';
import { planesView } from './radio-planes.js';
import { sensorsView } from './radio-sensors.js';
import { aprsView } from './radio-aprs.js';

// NOAA Weather Radio: seven channels, all receive-only.
export const NOAA = [
  ['WX1', '162.550'], ['WX2', '162.400'], ['WX3', '162.475'], ['WX4', '162.425'],
  ['WX5', '162.450'], ['WX6', '162.500'], ['WX7', '162.525'],
];

// FRS / GMRS channels 1–22 (MHz).
export const FRS = [
  '462.5625', '462.5875', '462.6125', '462.6375', '462.6625', '462.6875', '462.7125',
  '467.5625', '467.5875', '467.6125', '467.6375', '467.6625', '467.6875', '467.7125',
  '462.5500', '462.5750', '462.6000', '462.6250', '462.6500', '462.6750', '462.7000', '462.7250',
];

// International marine VHF voice channels 1–28 and 60–88 (the ship frequency; MHz). Not 70 (digital distress
// calls) or 75–76 (guard channels around 16).
const MARINE = [...Array.from({ length: 28 }, (_, i) => [i + 1, 156.05 + i * 0.05]), ...Array.from({ length: 29 }, (_, i) => [i + 60, 156.025 + i * 0.05])]
  .filter(([c]) => ![70, 75, 76].includes(c));

// CB channels 1–40 (MHz). 23 sits between 25 and 26 on the dial, as on every CB set.
const CB = [26.965, 26.975, 26.985, 27.005, 27.015, 27.025, 27.035, 27.055, 27.065, 27.075, 27.085, 27.105, 27.115, 27.125, 27.135, 27.155, 27.165, 27.175, 27.185, 27.205,
  27.215, 27.225, 27.255, 27.235, 27.245, 27.265, 27.275, 27.285, 27.295, 27.305, 27.315, 27.325, 27.335, 27.345, 27.355, 27.365, 27.375, 27.385, 27.395, 27.405];

/** Bands: either named channels ([label, MHz]) or a range to tune through in steps (`whole`: scan all of it at once). */
const BANDS = [
  { id: 'cb', name: 'CB 27 MHz', short: 'CB', mode: 'am', ch: CB.map((f, i) => [`Ch ${i + 1}`, f]) },
  { id: 'pmr', name: 'PMR446', short: 'PMR446', mode: 'fm', ch: Array.from({ length: 16 }, (_, i) => [`Ch ${i + 1}`, 446.00625 + i * 0.0125]) },
  { id: 'frs', name: 'FRS / GMRS', short: 'FRS', mode: 'fm', ch: FRS.map((f, i) => [`Ch ${i + 1}`, Number(f)]) },
  { id: 'marine', name: 'Marine VHF', short: 'Marine', mode: 'fm', ch: MARINE.map(([c, f]) => [`Ch ${c}`, f]) },
  { id: 'noaa', name: 'NOAA weather', short: 'NOAA', mode: 'fm', ch: NOAA.map(([c, f]) => [c, Number(f)]) },
  { id: 'air', name: 'Airband', short: 'Air', mode: 'am', range: [118, 137], step: 0.025, whole: true },
  // Below 24 MHz the V3 samples the antenna directly: no scans there (rtl_power can't use that branch).
  { id: 'mw', name: 'AM radio', short: 'AM radio', mode: 'am', range: [0.531, 1.602], step: 0.009, direct: true, squelch: 0 }, // 9 kHz, as in Lebanon and Europe
  { id: 'sw', name: 'Shortwave', short: 'Shortwave', mode: 'am', range: [2.3, 24], step: 0.005, direct: true, squelch: 0 },
  { id: 'fmb', name: 'FM broadcast', short: 'FM radio', mode: 'wbfm', range: [87.5, 108], step: 0.1, whole: true }, // 0.1 MHz raster, as in Lebanon and most of the world
  // The whole range takes 75 s to sweep, so a scan covers the 30 MHz around the dial, at 0.1 MHz.
  { id: 'any', name: 'Any frequency', short: 'Tune', range: [0.5, 1766], step: 0.0125, span: 30, scanStep: 0.1 },
];
const MODES = [['am', 'AM'], ['fm', 'FM'], ['usb', 'USB'], ['lsb', 'LSB'], ['wbfm', 'Wide FM']];
const BAND_KEY = 'outpost.radioBand';
const VIEW_KEY = 'outpost.radioView';
const VOL_KEY = 'outpost.radioVolume';

const hz = (mhz) => Math.round(mhz * 1e6);
const mhzText = (h) => (h / 1e6).toFixed(h % 1000 ? 5 : 3).replace(/(\.\d{3}\d*?)0+$/, '$1');
/** Most bars drawn; a scan with more points shows each bar as the strongest of a few neighbours. */
const MAX_BARS = 210;
/** Below this the V3 uses direct sampling: listening works, scans don't. */
const DIRECT_HZ = 24_000_000;

/** What a scan covers: a band's channels, the whole band at its step, or `span` MHz around the dial at `scanStep`. */
function scanPlan(band, freq) {
  if (band.ch) {
    const fs = band.ch.map(([, f]) => hz(f));
    const sorted = fs.slice().sort((a, b) => a - b);
    const gap = Math.min(25_000, ...sorted.slice(1).map((f, i) => f - sorted[i]));
    return { freqs: fs, labels: band.ch.map(([l]) => l), width: Math.max(6_250, gap) };
  }
  const step = hz(band.scanStep ?? band.step);
  const hi = hz(band.range[1]);
  const lo = Math.max(hz(band.range[0]), DIRECT_HZ); // scans start at 24 MHz (see BANDS)
  const n = Math.min(band.whole ? Infinity : Math.round(hz(band.span) / step) + 1, Math.floor((hi - lo) / step) + 1);
  const start = Math.min(Math.max(lo, freq - Math.floor(n / 2) * step), hi - (n - 1) * step);
  const freqs = Array.from({ length: n }, (_, i) => start + i * step);
  return { freqs, labels: freqs.map((f) => `${mhzText(f)} MHz`), width: step };
}

/**
 * The frequency (MHz) a saved channel's text names: a number ("462.5625", "446 MHz") or a channel ("CB 19",
 * "GMRS 17", "PMR 3", "Marine 16", "WX2"). Null when it names neither.
 */
export function channelMhz(text) {
  const s = String(text);
  const num = s.match(/(\d{2,4}[.,]\d{1,5})|(\d{2,4})\s*MHz/i);
  const mhz = num ? Number((num[1] ?? num[2]).replace(',', '.')) : NaN;
  if (mhz >= 24 && mhz <= 1766) return mhz;
  const ch = s.match(/\b(CB|PMR(?:446)?|FRS|GMRS|Marine|WX|NOAA)\s*(?:ch(?:annel)?\.?\s*)?(\d{1,2})\b/i);
  if (!ch) return null;
  const id = { cb: 'cb', pmr: 'pmr', pmr446: 'pmr', frs: 'frs', gmrs: 'frs', marine: 'marine', wx: 'noaa', noaa: 'noaa' }[ch[1].toLowerCase()];
  const label = id === 'noaa' ? `WX${ch[2]}` : `Ch ${Number(ch[2])}`;
  return BANDS.find((b) => b.id === id)?.ch.find(([l]) => l === label)?.[1] ?? null;
}

const fits = (b, h) => (b.ch ? b.ch.some(([, f]) => hz(f) === h) : h >= hz(b.range[0]) && h <= hz(b.range[1]));

/**
 * Plays the receiver's audio on this device: 16-bit PCM over a streamed fetch, scheduled as short buffers. Works on
 * plain http too (no AudioWorklet), so phones on the Wi-Fi can listen.
 */
class Player {
  constructor(onEnd) {
    this.onEnd = onEnd;
    this.level = 0;
    this.lastAudio = 0;
  }

  /** Call from a tap: phones only allow sound that starts from one. */
  start(volume) {
    this.ac = new (window.AudioContext || window.webkitAudioContext)();
    this.gain = this.ac.createGain();
    this.gain.connect(this.ac.destination);
    this.setVolume(volume);
    this.ctrl = new AbortController();
    void this.run();
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.value = (v / 10) ** 2 * 1.5;
  }

  async run() {
    let rate = 24000;
    let at = 0;
    let carry = null;
    let pending = [];
    let count = 0;
    try {
      const res = await fetch('/api/radio/audio', { signal: this.ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      rate = Number(res.headers.get('x-sample-rate')) || rate;
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let bytes = value;
        if (carry) {
          bytes = new Uint8Array(carry.length + value.length);
          bytes.set(carry);
          bytes.set(value, carry.length);
        }
        const whole = bytes.length & ~1;
        carry = whole < bytes.length ? bytes.slice(whole) : null;
        pending.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole)));
        count += whole / 2;
        if (count < rate / 10) continue; // a tenth of a second per buffer
        const buf = this.ac.createBuffer(1, count, rate);
        const out = buf.getChannelData(0);
        let i = 0;
        let sum = 0;
        for (const part of pending) for (const s of part) sum += (out[i++] = s / 32768) ** 2;
        pending = [];
        count = 0;
        this.level = Math.sqrt(sum / out.length);
        this.lastAudio = performance.now();
        const now = this.ac.currentTime;
        if (at < now) at = now + 0.15;
        if (at - now > 0.8) continue; // fell behind: drop this piece rather than lag further
        const src = this.ac.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain);
        src.start(at);
        at += buf.duration;
      }
      this.end();
    } catch (e) {
      this.end(this.ctrl.signal.aborted ? null : e.message);
    }
  }

  end(error = null) {
    if (!this.ac) return;
    this.ctrl.abort();
    void this.ac.close();
    this.ac = null;
    this.onEnd(error);
  }

  /** True while sound came in the last moment; with squelch on, rtl_fm sends nothing while the channel is quiet. */
  get open() {
    return performance.now() - this.lastAudio < 400;
  }
}

// One player for the whole app: listening carries on when you leave the Radio page, with a small pill to stop it.
let onPlayerEnd = (error) => {
  if (error) toast(error, 'error');
  paintMini();
};
const player = new Player((error) => onPlayerEnd(error));
let nowPlaying = '';
let mini = null;

/** The "Radio · 100.500 MHz · Stop" pill, shown while this device plays the radio on any other page. */
function paintMini() {
  const show = !!player.ac && document.body.dataset.route !== 'radio';
  if (!mini && !show) return;
  if (!mini) {
    mini = document.createElement('div');
    mini.className = 'rx-mini';
    mini.setAttribute('role', 'status');
    mini.innerHTML = '<span></span><a href="#radio">Open</a><button type="button" class="btn small">Stop</button>';
    mini.querySelector('button').addEventListener('click', () => player.end());
    document.body.append(mini);
    new MutationObserver(paintMini).observe(document.body, { attributes: true, attributeFilter: ['data-route'] });
  }
  mini.hidden = !show;
  mini.querySelector('span').textContent = `Radio · ${nowPlaying}`;
}

/** The RTL-SDR receiver: bands, a frequency display, a tuning knob, mode, squelch and volume. */
export async function receiver(box) {
  let st = await api('/radio');
  let tuning = { ...st.tuning };
  let band = BANDS.find((b) => b.id === store.get(BAND_KEY, '') && fits(b, tuning.freq)) ?? BANDS.find((b) => fits(b, tuning.freq));
  let volume = Number(store.get(VOL_KEY, 6));
  let turn = 0; // knob angle for bands without fixed channels
  let saveTimer = null;
  let poll = null;
  let meter = null;
  let scanned = null; // { band, plan, levels, floor, at }
  let callsSeen = -1; // st.lastCall when the call log was last loaded
  let namesKey = JSON.stringify(st.names);
  // Planes and Sensors each take the dongle; the page opens on whichever is running.
  const busy = () => (st.planes ? 'planes' : st.sensors ? 'sensors' : st.aprs ? 'aprs' : null);
  const busyName = () => (busy() === 'aprs' ? 'APRS' : busy());
  let view = busy() ?? (['planes', 'sensors', 'aprs'].includes(store.get(VIEW_KEY, '')) ? store.get(VIEW_KEY, '') : 'listen');
  const views = { planes: { make: planesView, made: null }, sensors: { make: sensorsView, made: null }, aprs: { make: aprsView, made: null } }; // made the first time each is shown
  let setupNote = null;
  let recSince = null; // when the recording in progress started, for its timer
  onPlayerEnd = (error) => {
    clearInterval(meter);
    if (error) toast(error, 'error');
    paintListen();
    void refresh();
  };

  const playing = () => !!player.ac;
  const chIndex = () => band.ch?.findIndex(([, f]) => hz(f) === tuning.freq) ?? -1;

  box.innerHTML = `<section class="prep-kit rx" aria-label="Radio receiver">
      <div class="ptitle"><h2>Receiver</h2><div class="rx-head"><span class="kicker rx-dev"></span><button type="button" class="rx-power admin-only" role="switch" aria-label="Receiver"></button></div></div>
      <div class="seg rx-views" role="group" aria-label="Show"><button type="button" data-view="listen">Listen</button><button type="button" data-view="planes">Planes</button><button type="button" data-view="sensors">Sensors</button><button type="button" data-view="aprs">APRS</button></div>
      <div class="rx-setup"></div>
      <div class="rx-planes" data-pane="planes" hidden></div>
      <div class="rx-planes" data-pane="sensors" hidden></div>
      <div class="rx-planes" data-pane="aprs" hidden></div>
      <div class="rx-body">
        <div class="prep-pills rx-bands" role="group" aria-label="Band">${BANDS.map((b) => `<button type="button" class="rpill" data-band="${b.id}">${esc(b.name)}</button>`).join('')}</div>
        <div class="rx-lcd">
          <div class="rx-top">
            <label class="rx-freq"><input aria-label="Frequency in MHz" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="12"><small>MHz</small></label>
            <div class="rx-ch"><b></b><span></span><button type="button" class="rx-name">Name this</button></div>
          </div>
          <div class="rx-meter"><span>Level</span><div class="rx-seg" aria-hidden="true">${'<i></i>'.repeat(12)}</div><span class="rx-sq" role="status"></span></div>
        </div>
        <div class="rx-controls">
          <div class="rx-knobwrap">
            <svg class="rx-knob" viewBox="0 0 120 120" role="slider" tabindex="0" aria-label="Tuning knob">
              <circle cx="60" cy="60" r="56" class="k1"/><circle cx="60" cy="60" r="44" class="k2"/>
              <g class="rx-dial"><line x1="60" y1="22" x2="60" y2="36"/></g>
            </svg>
            <div class="rx-steps"><button type="button" class="btn small" data-step="-1" aria-label="Tune down">‹</button><span class="kicker">Tune</span><button type="button" class="btn small" data-step="1" aria-label="Tune up">›</button></div>
          </div>
          <div class="rx-side">
            <div class="rx-row"><span class="kicker">Mode</span><div class="prep-pills rx-modes" role="group" aria-label="Mode">${MODES.map(([m, l]) => `<button type="button" class="rpill" data-mode="${m}">${l}</button>`).join('')}</div></div>
            <label class="rx-row"><span class="kicker">Squelch</span><input type="range" class="rx-sqin" min="0" max="10" step="1"><output class="rx-sqv"></output></label>
            <label class="rx-row"><span class="kicker">Volume</span><input type="range" class="rx-vol" min="0" max="10" step="1"><output class="rx-volv"></output></label>
            <div class="rx-row rx-go"><button type="button" class="btn primary rx-listen"></button><button type="button" class="btn rx-rec" hidden>Record</button><span class="muted rx-who"></span></div>
          </div>
        </div>
        <div class="rx-scan">
          <div class="ptitle"><span class="kicker">Channel activity · tap a bar to tune</span><div class="rx-scanbtns"><button type="button" class="btn small rx-auto">Auto-scan</button><button type="button" class="btn small rx-scanbtn">Scan</button></div></div>
          <div class="rx-bars" role="group" aria-label="Channel activity"></div>
          <div class="rx-axis" aria-hidden="true"></div>
          <p class="muted small rx-scannote"></p>
          <p class="muted small rx-directnote" hidden>Below 24 MHz (AM radio and shortwave) the RTL-SDR samples the antenna directly: listening works, but scans don't, and there is no gain control. The small dipole hears little here; a long wire, 5 to 10 m, outdoors or along a window, hears far more. At night AM radio carries much further.</p>
        </div>
        <div class="rx-calls">
          <div class="ptitle"><span class="kicker">Calls heard · last 24 hours</span></div>
          <ul class="rx-calllist"></ul>
        </div>
        <p class="muted small">One receiver for everyone: tuning here changes it for everyone listening. Receive only, nothing is transmitted.</p>
      </div>
    </section>`;
  const el = (s) => $(s, box);
  const freqIn = el('.rx-freq input');
  const knob = el('.rx-knob');

  function paint() {
    const i = chIndex();
    if (document.activeElement !== freqIn) freqIn.value = mhzText(tuning.freq);
    freqIn.style.width = `${Math.max(6, freqIn.value.length) + 0.5}ch`;
    const named = st.names?.[tuning.freq];
    el('.rx-ch b').textContent = named ?? (i >= 0 ? band.ch[i][0] : band.id === 'mw' ? `${Math.round(tuning.freq / 1000)} kHz` : band.short);
    el('.rx-name').textContent = named ? 'Rename' : 'Name this';
    el('.rx-name').setAttribute('aria-label', `${named ? 'Rename' : 'Name'} ${mhzText(tuning.freq)} MHz`);
    nowPlaying = named ? `${named} · ${mhzText(tuning.freq)} MHz` : `${mhzText(tuning.freq)} MHz`;
    el('.rx-ch span').textContent = `${MODES.find(([m]) => m === tuning.mode)[1]} · ${band.name}`;
    for (const b of $$('[data-band]', box)) b.setAttribute('aria-pressed', String(b.dataset.band === band.id));
    for (const b of $$('[data-mode]', box)) b.setAttribute('aria-pressed', String(b.dataset.mode === tuning.mode));
    const sq = el('.rx-sqin');
    sq.value = tuning.squelch;
    sq.disabled = tuning.mode === 'wbfm';
    el('.rx-sqv').textContent = tuning.mode === 'wbfm' ? 'off' : tuning.squelch;
    el('.rx-vol').value = volume;
    el('.rx-volv').textContent = volume;
    const [lo, hi] = band.range ?? [0, 1];
    const angle = band.ch ? (band.ch.length > 1 ? (i / (band.ch.length - 1)) * 300 - 150 : 0) : band.whole ? ((tuning.freq / 1e6 - lo) / (hi - lo)) * 300 - 150 : turn;
    el('.rx-dial').setAttribute('transform', `rotate(${angle} 60 60)`);
    paintBars();
    knob.setAttribute('aria-valuetext', `${mhzText(tuning.freq)} MHz${i >= 0 ? `, ${band.ch[i][0]}` : ''}`);
  }

  /** The bars: the last scan if it still fits this band and window, else flat placeholders to scan. */
  function paintBars() {
    const inPlan = (p) => tuning.freq >= p.freqs[0] && tuning.freq <= p.freqs.at(-1);
    const plan = scanned && scanned.band === band.id && (band.ch || band.whole || inPlan(scanned.plan)) ? scanned.plan : scanPlan(band, tuning.freq);
    const result = scanned?.plan === plan ? scanned : null;
    const lift = (i) => (result?.levels[i] == null || result.floor == null ? null : result.levels[i] - result.floor);
    // More points than bars (airband, any frequency): each bar is the strongest of k neighbours, and tapping it tunes there.
    const k = Math.ceil(plan.freqs.length / MAX_BARS);
    const step = plan.freqs[1] - plan.freqs[0] || 0;
    const groups = [];
    for (let i = 0; i < plan.freqs.length; i += k) {
      const idx = Array.from({ length: Math.min(k, plan.freqs.length - i) }, (_, j) => i + j);
      const best = idx.reduce((b, j) => ((lift(j) ?? -Infinity) > (lift(b) ?? -Infinity) ? j : b));
      groups.push({ idx, best, up: lift(best) });
    }
    const bars = el('.rx-bars');
    bars.style.gridTemplateColumns = `repeat(${groups.length}, minmax(0, 1fr))`;
    bars.classList.toggle('dense', groups.length > 80);
    const [first, last] = [plan.freqs[0], plan.freqs.at(-1)];
    el('.rx-axis').innerHTML = band.ch ? '' : `<span>${mhzText(first)}</span><span>${mhzText(Math.round((first + last) / 2 / hz(band.step)) * hz(band.step))}</span><span>${mhzText(last)} MHz</span>`;
    bars.innerHTML = groups
      .map(({ idx, best, up }) => {
        const above = Math.max(0, up ?? 0);
        const many = idx.length > 1;
        const name = many ? `${mhzText(plan.freqs[idx[0]])}–${mhzText(plan.freqs[idx.at(-1)])} MHz` : `${plan.labels[best]}${st.names?.[plan.freqs[best]] ? ` · ${st.names[plan.freqs[best]]}` : ''}`;
        const label = `${name}${result ? (up == null ? ', no reading' : `, ${Math.round(above)} dB above the noise${many ? ` at ${mhzText(plan.freqs[best])}` : ''}`) : ''}`;
        const cur = many ? tuning.freq >= plan.freqs[idx[0]] - step / 2 && tuning.freq < plan.freqs[idx.at(-1)] + step / 2 : plan.freqs[best] === tuning.freq;
        return `<button type="button" class="${above >= 8 ? 'act' : ''}${cur ? ' cur' : ''}" data-tune="${plan.freqs[best]}" style="height:${Math.round(6 + Math.min(1, above / 30) * 58)}px" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
      })
      .join('');
    const busy = groups.filter((g) => (g.up ?? -1) >= 8).length;
    el('.rx-scannote').textContent = result
      ? `Scanned at ${new Date(result.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${busy ? `${busy} ${band.ch ? (busy === 1 ? 'channel' : 'channels') : busy === 1 ? 'frequency' : 'frequencies'} with a signal (green).` : 'nothing on air right then.'} Scan again any time; listeners hear a short gap.`
      : 'Scan to see which channels have a signal right now. Listeners hear a short gap while it runs.';
  }

  async function runScan() {
    const plan = scanPlan(band, tuning.freq);
    const btn = el('.rx-scanbtn');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      const r = await api('/radio/scan', jsonBody({ freqs: plan.freqs, width: plan.width }));
      scanned = { band: band.id, plan, ...r, at: Date.now() };
    } catch (e) {
      toast(e.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Scan';
    paintBars();
  }

  /** "Radio Liban · 100.500 MHz", "CB Ch 19" for a channel frequency, else "446.10000 MHz". */
  function channelName(freq) {
    let base = `${mhzText(freq)} MHz`;
    for (const b of BANDS) {
      const c = b.ch?.find(([, f]) => hz(f) === freq);
      if (c) base = `${b.short} ${c[0]}`;
    }
    return st.names?.[freq] ? `${st.names[freq]} · ${base}` : base;
  }

  async function loadCalls() {
    const { calls } = await api('/radio/calls').catch(() => ({ calls: [] }));
    el('.rx-calllist').innerHTML = calls.length
      ? calls.slice(0, 50).map((c) => `<li>
          <time>${esc(new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>
          <b>${esc(channelName(c.freq))}</b><span class="muted">${c.seconds} s</span>
          <audio controls preload="none" src="/api/radio/calls/${esc(c.id)}.wav" aria-label="Call on ${esc(channelName(c.freq))}"></audio>
          <span class="rx-callbtns"><button type="button" class="btn small" data-share="${esc(c.id)}">Share to Voice</button><button type="button" class="btn small danger admin-only" data-delcall="${esc(c.id)}">Delete</button></span></li>`).join('')
      : '<li class="muted">No calls yet. With squelch on, every call the receiver hears is kept here for 24 hours, while you listen or while it auto-scans.</li>';
  }

  function paintListen() {
    const dev = st.device;
    const ready = st.tools && dev === 'ok';
    const auto = el('.rx-auto');
    const canAuto = (band.mode ?? tuning.mode) !== 'wbfm';
    auto.textContent = st.autoscan ? 'Stop auto-scan' : 'Auto-scan';
    auto.setAttribute('aria-pressed', String(!!st.autoscan));
    auto.disabled = !st.autoscan && !canAuto;
    auto.title = canAuto ? 'Jump to whichever channel has someone talking, and log each call' : 'Auto-scan is for two-way radio, not FM broadcast';
    const direct = tuning.freq < DIRECT_HZ;
    el('.rx-scanbtn').disabled = !!st.autoscan || direct;
    if (direct && !st.autoscan) auto.disabled = true;
    el('.rx-directnote').hidden = !direct;
    if (st.lastCall !== callsSeen) {
      callsSeen = st.lastCall;
      void loadCalls();
    }
    el('.rx-listen').textContent = playing() ? 'Stop listening' : 'Listen on this device';
    el('.rx-listen').disabled = !ready && !playing();
    el('.rx-scan').hidden = !ready;
    el('.rx-who').textContent = st.listeners ? `${st.listeners} listening` : '';
    el('.rx-rec').hidden = !(st.on && !st.autoscan) && st.recording == null;
    const off = st.tools && !st.enabled;
    const sw = el('.rx-power');
    sw.hidden = !st.tools;
    sw.setAttribute('aria-checked', String(st.enabled));
    sw.textContent = st.enabled ? 'On' : 'Off';
    const lamp = !st.tools || off ? 'idle' : dev === 'ok' ? 'ok' : 'warn';
    el('.rx-dev').innerHTML = `<span class="lamp ${lamp}" aria-hidden="true"></span> ${!st.tools ? 'Tools not installed' : off ? 'Receiver off' : busy() ? `RTL-SDR · ${busyName()}` : dev === 'ok' ? (st.on ? 'RTL-SDR · on air' : 'RTL-SDR · ready') : dev === 'busy' ? 'RTL-SDR · in use elsewhere' : 'No RTL-SDR found'}`;
    const note = !st.tools
      ? `<p>Listen to CB, walkie-talkie, marine, weather and FM radio with an RTL-SDR USB receiver plugged into this Mac. It needs the free RTL-SDR tools first.</p>
         <p><button type="button" class="btn primary admin-only rx-install">Install the radio tools</button><span class="member-only muted">An admin can install them here.</span></p>`
      : busy() && !off && view === 'listen'
        ? `<p>The receiver is busy with ${busyName()}, so listening and scanning wait.</p><p><button type="button" class="btn small" data-view="${busy()}">Show ${busyName()}</button> <button type="button" class="btn small rx-stopside">Stop ${busyName()}</button></p>`
        : off
        ? '<p class="muted">The receiver is off: Outpost leaves the RTL-SDR alone, so another program (such as iNTERCEPT) can use it.<span class="member-only"> An admin can turn it on here.</span></p>'
        : st.error
        ? `<p class="error-text">${esc(st.error)}</p>`
        : dev === 'none'
          ? '<p class="muted">Plug the RTL-SDR straight into a USB port on this Mac (not through a hub or display adapter), then wait a moment.</p>'
          : dev === 'busy'
            ? '<p class="muted">Another program is using the RTL-SDR (for example iNTERCEPT or SDR++). Stop it to listen here.</p>'
            : '';
    // Rebuilt only when it changes, so its buttons don't vanish under a finger at every refresh.
    if (note !== setupNote) el('.rx-setup').innerHTML = setupNote = note;
    el('.rx-setup').hidden = !note;
    el('.rx-body').hidden = !st.tools || off || !!busy() || view !== 'listen';
    el('.rx-views').hidden = !st.tools || off;
    for (const b of $$('[data-view]', el('.rx-views'))) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    // Shown before the map is made or resized: a map measures its box, and a hidden one measures nothing.
    for (const [name, v] of Object.entries(views)) {
      const pane = el(`[data-pane="${name}"]`);
      const show = st.tools && !off && view === name;
      const wasHidden = pane.hidden;
      pane.hidden = !show;
      if (show && !v.made) v.made = v.make(pane, { onChange: () => void refresh() });
      else if (show && wasHidden) v.made.show();
    }
    paintMeter();
  }

  async function refresh() {
    clearTimeout(poll);
    st = await api('/radio').catch(() => st);
    if (box.isConnected) poll = setTimeout(refresh, st.autoscan ? 1000 : 3000); // follow auto-scan's hops closely
    recSince = st.recording == null ? null : Date.now() - st.recording * 1000;
    if (JSON.stringify(st.names) !== namesKey) {
      namesKey = JSON.stringify(st.names);
      paint();
      void loadCalls();
    }
    const changed = st.tuning.freq !== tuning.freq || st.tuning.mode !== tuning.mode || st.tuning.squelch !== tuning.squelch;
    if (changed && !saveTimer && document.activeElement !== freqIn) {
      tuning = { ...st.tuning };
      if (!fits(band, tuning.freq)) band = BANDS.find((b) => fits(b, tuning.freq));
      paint();
    }
    paintListen();
  }

  /** Shows the change at once and sends it a moment later, so turning the knob doesn't restart the receiver per click. */
  function set(next) {
    tuning = { ...tuning, ...next };
    paint();
    clearTimeout(saveTimer);
    const id = setTimeout(async () => {
      try {
        const saved = await api('/radio', jsonBody(tuning, 'PUT'));
        // A change made while this was saving wins; its own save follows.
        if (saveTimer === id) tuning = saved;
      } catch (e) {
        toast(e.message, 'error');
      }
      if (saveTimer === id) saveTimer = null;
    }, 300);
    saveTimer = id;
  }

  function step(n) {
    if (band.ch) {
      const i = chIndex();
      const at = i < 0 ? 0 : (i + n + band.ch.length) % band.ch.length;
      set({ freq: hz(band.ch[at][1]) });
    } else {
      // Sideband needs fine tuning to sound right: 1 kHz steps on USB and LSB.
      const stepHz = ['usb', 'lsb'].includes(tuning.mode) ? 1000 : hz(band.step);
      const f = Math.min(hz(band.range[1]), Math.max(hz(band.range[0]), tuning.freq + n * stepHz));
      turn = (turn + n * 12) % 360;
      set({ freq: f });
    }
  }

  /** "Listen" on one of your saved channels: tune there and start playing (the tap allows the sound). */
  function tuneTo(e) {
    const freq = hz(e.detail.mhz);
    if (!(freq >= hz(0.5) && freq <= hz(1766))) return toast('That channel has no frequency from 0.5 to 1766 MHz to tune to.', 'error');
    band = BANDS.find((b) => b.ch && fits(b, freq)) ?? BANDS.find((b) => b.id !== 'any' && fits(b, freq)) ?? BANDS.find((b) => b.id === 'any');
    store.set(BAND_KEY, band.id);
    set({ freq, mode: band.mode ?? (tuning.mode === 'wbfm' ? 'fm' : tuning.mode) });
    if (view !== 'listen') {
      view = 'listen';
      store.set(VIEW_KEY, view);
    }
    paintListen();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!playing() && st.tools && st.device === 'ok' && !busy() && st.enabled) {
      player.start(volume);
      meter = setInterval(paintMeter, 150);
      setTimeout(refresh, 800);
    }
  }

  function pickBand(id) {
    band = BANDS.find((b) => b.id === id);
    store.set(BAND_KEY, id);
    const freq = fits(band, tuning.freq) ? tuning.freq : hz(band.ch ? band.ch[0][1] : band.range[0]);
    // Broadcast stations never stop, and weak ones sit near the noise: a squelch left on from CB would mute them.
    set({ freq, mode: band.mode ?? tuning.mode, squelch: band.squelch ?? tuning.squelch });
  }

  function typedFreq() {
    const mhz = Number(freqIn.value.replace(',', '.'));
    if (!(mhz >= 0.5 && mhz <= 1766)) {
      toast('Type a frequency from 0.5 to 1766 MHz (AM radio is 0.531 to 1.602).', 'error');
      freqIn.value = mhzText(tuning.freq);
      return;
    }
    const freq = hz(mhz);
    const home = fits(band, freq) ? band : BANDS.find((b) => b.ch && fits(b, freq)) ?? BANDS.find((b) => fits(b, freq));
    const mode = home !== band && home.mode ? home.mode : tuning.mode;
    band = home;
    set({ freq, mode });
  }

  box.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.band) pickBand(t.dataset.band);
    else if (t.dataset.mode) set({ mode: t.dataset.mode });
    else if (t.dataset.step) step(Number(t.dataset.step));
    else if (t.dataset.tune) set({ freq: Number(t.dataset.tune) });
    else if (t.classList.contains('rx-scanbtn')) await runScan();
    else if (t.classList.contains('rx-name')) {
      const now = st.names?.[tuning.freq] ?? '';
      const name = prompt(`A name for ${mhzText(tuning.freq)} MHz, shown to everyone (leave empty to remove):`, now);
      if (name === null) return;
      try {
        st.names = (await api('/radio/names', jsonBody({ freq: tuning.freq, name }, 'PUT'))).names;
        namesKey = JSON.stringify(st.names);
        paint();
        void loadCalls();
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (t.classList.contains('rx-rec')) {
      t.disabled = true;
      try {
        if (recSince != null) {
          await api('/radio/record', { method: 'DELETE' });
          toast('Saved under Calls heard.');
        } else await api('/radio/record', { method: 'POST' });
      } catch (err) {
        toast(err.message, 'error');
      }
      t.disabled = false;
      await refresh();
    }
    else if (t.classList.contains('rx-auto')) {
      t.disabled = true;
      try {
        if (st.autoscan) await api('/radio/autoscan', { method: 'DELETE' });
        else {
          const plan = scanPlan(band, tuning.freq);
          await api('/radio/autoscan', jsonBody({ freqs: plan.freqs, width: plan.width, mode: band.mode ?? tuning.mode }));
          if (!playing()) toast('Auto-scan is on. Tap Listen to hear the calls it finds.');
        }
      } catch (err) {
        toast(err.message, 'error');
      }
      await refresh();
    } else if (t.dataset.share) {
      try {
        await api(`/radio/calls/${encodeURIComponent(t.dataset.share)}/voice`, { method: 'POST' });
        toast('Shared on the Voice channel.');
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (t.dataset.delcall && confirm('Delete this call?')) {
      await api(`/radio/calls/${encodeURIComponent(t.dataset.delcall)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      await loadCalls();
    }
    else if (t.classList.contains('rx-listen')) {
      if (playing()) player.end();
      else {
        player.start(volume);
        meter = setInterval(paintMeter, 150);
        setTimeout(refresh, 800);
      }
      paintListen();
    } else if (t.dataset.view) {
      view = t.dataset.view;
      store.set(VIEW_KEY, view);
      paintListen();
    } else if (t.classList.contains('rx-stopside')) {
      await api(`/radio/${busy()}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      await refresh();
    } else if (t.classList.contains('rx-power')) {
      const on = !st.enabled;
      if (!on && playing()) player.end();
      t.disabled = true;
      try {
        await api('/radio/power', jsonBody({ enabled: on }, 'PUT'));
        toast(on ? 'Receiver on.' : 'Receiver off. The RTL-SDR is free for other programs.');
      } catch (err) {
        toast(err.message, 'error');
      }
      t.disabled = false;
      await refresh();
    } else if (t.classList.contains('rx-install') && (await installAddon('radio', 'the radio tools', 'Installs librtlsdr, dump1090-fa, rtl_433 and direwolf with Homebrew: the free programs that let Outpost tune the RTL-SDR, show planes on a map, read nearby sensors and decode APRS (about 25 MB).'))) {
      const wait = setInterval(async () => {
        await refresh();
        if (st.tools || !box.isConnected) clearInterval(wait);
      }, 3000);
    }
  });
  freqIn.addEventListener('keydown', (e) => e.key === 'Enter' && freqIn.blur());
  freqIn.addEventListener('input', () => (freqIn.style.width = `${Math.max(6, freqIn.value.length) + 0.5}ch`));
  freqIn.addEventListener('change', typedFreq);
  el('.rx-sqin').addEventListener('change', (e) => set({ squelch: Number(e.target.value) }));
  el('.rx-vol').addEventListener('input', (e) => {
    volume = Number(e.target.value);
    store.set(VOL_KEY, volume);
    player.setVolume(volume);
    el('.rx-volv').textContent = volume;
  });

  // The knob: drag round it, scroll on it, or use the arrow keys.
  let drag = null;
  const angleAt = (e) => {
    const r = knob.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };
  knob.addEventListener('pointerdown', (e) => {
    drag = { a: angleAt(e) };
    knob.setPointerCapture(e.pointerId);
  });
  knob.addEventListener('pointermove', (e) => {
    if (!drag) return;
    let d = angleAt(e) - drag.a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    const n = Math.trunc(d / 15);
    if (n) {
      step(n);
      drag.a += n * 15;
    }
  });
  knob.addEventListener('pointerup', () => (drag = null));
  knob.addEventListener('pointercancel', () => (drag = null));
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    step(e.deltaY > 0 ? -1 : 1);
  }, { passive: false });
  knob.addEventListener('keydown', (e) => {
    const n = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (!n) return;
    e.preventDefault();
    step(n);
  });

  function paintMeter() {
    const open = playing() && player.open;
    const lit = open ? Math.min(12, Math.round(Math.sqrt(player.level) * 20)) : 0;
    $$('.rx-seg i', box).forEach((s, i) => s.classList.toggle('on', i < lit));
    const secs = recSince == null ? null : Math.min(60, Math.floor((Date.now() - recSince) / 1000));
    el('.rx-rec').textContent = secs == null ? 'Record' : `Stop recording · 0:${String(secs).padStart(2, '0')}`;
    el('.rx-rec').setAttribute('aria-pressed', String(secs != null));
    el('.rx-sq').textContent = st.autoscan ? (st.autoscan.on ? 'Auto-scan · stopped here' : 'Auto-scan · searching') : !playing() ? 'Not listening' : tuning.mode === 'wbfm' || tuning.squelch === 0 ? 'Squelch off' : open ? 'Squelch open' : 'Squelch closed';
  }

  paint();
  paintListen();
  paintMeter();
  poll = setTimeout(refresh, 3000);
  if (playing()) meter = setInterval(paintMeter, 150); // still playing from an earlier visit
  window.addEventListener('outpost:radio-tune', tuneTo);
  return () => {
    clearTimeout(poll);
    clearInterval(meter);
    window.removeEventListener('outpost:radio-tune', tuneTo);
    onPlayerEnd = (error) => {
      if (error) toast(error, 'error');
      paintMini();
    };
    paintMini(); // the radio keeps playing; offer a way to stop it from anywhere
    for (const v of Object.values(views)) v.made?.stop();
  };
}
