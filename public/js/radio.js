import { $, esc, store, toast } from './core.js';
import { CODE, NATO } from './morse.js';
import { back } from './ready.js';

// NOAA Weather Radio: seven channels, all receive-only.
const NOAA = [
  ['WX1', '162.550'], ['WX2', '162.400'], ['WX3', '162.475'], ['WX4', '162.425'],
  ['WX5', '162.450'], ['WX6', '162.500'], ['WX7', '162.525'],
];

// FRS / GMRS channels 1–22 (MHz), with the power limits since 2017.
const FRS = [
  '462.5625', '462.5875', '462.6125', '462.6375', '462.6625', '462.6875', '462.7125',
  '467.5625', '467.5875', '467.6125', '467.6375', '467.6625', '467.6875', '467.7125',
  '462.5500', '462.5750', '462.6000', '462.6250', '462.6500', '462.6750', '462.7000', '462.7250',
];
const FRS_NOTE = { 1: 'Common calling channel', 3: 'Common preparedness calling channel', 20: 'Emergency and travel help (often tone 141.3)' };
const power = (n) => (n <= 7 ? ['2 W', '5 W'] : n <= 14 ? ['0.5 W', '0.5 W'] : ['2 W', '50 W']);

// Calling frequencies people listen on. Ham needs a licence to transmit, except to save a life.
const CALLING = [
  ['Ham 2 m', '146.520 MHz FM', 'National simplex calling frequency. The busiest one to try first.'],
  ['Ham 70 cm', '446.000 MHz FM', 'National simplex calling frequency'],
  ['Ham 6 m', '52.525 MHz FM', 'Simplex calling frequency'],
  ['Ham 1.25 m', '223.500 MHz FM', 'Simplex calling frequency'],
  ['Ham 10 m', '29.600 MHz FM', 'Simplex calling frequency'],
  ['CB 9', '27.065 MHz AM', 'Emergency channel. No licence needed.'],
  ['CB 19', '27.185 MHz AM', 'Highway and truckers. No licence needed.'],
  ['MURS 1–5', '151.820 · 151.880 · 151.940 · 154.570 · 154.600 MHz', 'No licence needed, 2 W'],
  ['Marine 16', '156.800 MHz FM', 'Distress, safety and calling on the water'],
];

const MAYDAY = [
  ['Pick a channel', 'GMRS 20, CB 9, ham 146.520 or marine 16. Listen first, then press and wait a second before you speak.'],
  ['Say “Mayday, Mayday, Mayday”', 'Only when a life is in danger right now. For urgent help that isn’t life or death, say “Pan-pan” three times instead.'],
  ['Say who you are, three times', '“This is …” with your name or call sign.'],
  ['Say where you are', 'Address, crossroads, landmarks, or coordinates. Be as exact as you can.'],
  ['Say what happened', 'Injury, fire, flood, lost, stranded…'],
  ['Say what you need', 'Medical help, rescue, water, transport.'],
  ['Say how many people', 'And anyone hurt, very young or very old.'],
  ['End with “Over” and listen', 'Release the button. Wait a minute or two. If nobody answers, repeat, or try another channel.'],
];

const CHAN_KEY = 'outpost.radioChannels';
const LOG_KEY = 'outpost.radioLog';
const TAB_KEY = 'outpost.radioTab';
const TABS = [
  ['channels', 'Channels'],
  ['mine', 'Your list'],
  ['log', 'Check-ins'],
  ['codes', 'Morse & phonetic'],
  ['mayday', 'Distress call'],
];
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const list = (key) => (Array.isArray(store.get(key, [])) ? store.get(key, []) : []);

/** Radio: emergency channels, quick references, your own channels and a check-in log. All built in, nothing to download. */
export async function viewRadio(root) {
  root.innerHTML = `<div class="titlebar"><div>${back}
      <p class="kicker">Field manual · Radio</p><h1>Radio</h1>
      <p class="lead">Emergency channels, Morse code, the phonetic alphabet and how to call for help, plus your own channels and a check-in log. Everything here works without the internet.</p></div></div>
    <div class="prep radio">
      <div class="prep-pills" role="group" aria-label="Show"></div>
      <div id="rbody"></div>
    </div>`;
  const pills = $('.prep-pills', root);
  const body = $('#rbody', root);
  let tab = TABS.some(([t]) => t === store.get(TAB_KEY, '')) ? store.get(TAB_KEY, '') : 'channels';
  let editing = null;

  const table = (head, rows) => `<div class="radio-scroll"><table class="radio-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr${r.hot ? ' class="hot"' : ''}>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  function channels() {
    return `<section class="card prep-kit"><div class="ptitle"><h2>NOAA Weather Radio</h2><span class="kicker">Listen only · 7 channels</span></div>
        <p class="muted small">Warnings and forecasts from the National Weather Service. Scan all seven; usually one or two come in where you are.</p>
        ${table(['Channel', 'MHz'], NOAA.map(([c, f]) => ({ cells: [c, f] })))}</section>
      <section class="card prep-kit"><div class="ptitle"><h2>FRS / GMRS walkie-talkies</h2><span class="kicker">Channels 1–22</span></div>
        <p class="muted small">FRS needs no licence. GMRS allows more power and repeaters, and needs an FCC licence (no exam). Highlighted rows are the ones people use for calling and emergencies.</p>
        ${table(['Ch', 'MHz', 'FRS', 'GMRS', 'Use'], FRS.map((f, i) => ({ hot: !!FRS_NOTE[i + 1], cells: [String(i + 1), f, ...power(i + 1), FRS_NOTE[i + 1] ?? ''] })))}</section>
      <section class="card prep-kit"><div class="ptitle"><h2>Calling frequencies</h2><span class="kicker">Ham · CB · MURS · Marine</span></div>
        <p class="muted small">Ham radio needs a licence to transmit, but anyone may use any radio to call for help when a life is in immediate danger.</p>
        ${table(['Service', 'Frequency', 'Note'], CALLING.map((r) => ({ cells: r })))}</section>`;
  }

  function mine() {
    const items = list(CHAN_KEY);
    const e = editing ? items.find((c) => c.id === editing) : null;
    const v = (k) => esc(e?.[k] ?? '');
    return `<section class="card prep-kit"><div class="ptitle"><h2>${e ? 'Edit channel' : 'Add a channel'}</h2><span class="kicker">Family or group</span></div>
        <form class="radio-form" id="chform">
          <label>Name<input name="name" required maxlength="60" placeholder="Family" value="${v('name')}"></label>
          <label>Channel or frequency<input name="freq" required maxlength="60" placeholder="GMRS 17, tone 12" value="${v('freq')}"></label>
          <label>Call sign<input name="call" maxlength="30" placeholder="Optional" value="${v('call')}"></label>
          <label class="wide">Note<input name="note" maxlength="200" placeholder="When to check in, who's on it…" value="${v('note')}"></label>
          <div class="wide"><button class="btn small primary" type="submit">${e ? 'Save' : 'Add'}</button>${e ? ' <button class="btn small" type="button" id="chcancel">Cancel</button>' : ''}</div>
        </form></section>
      <div class="ptitle"><h2>${items.length ? `${items.length} channel${items.length === 1 ? '' : 's'}` : 'No channels yet'}</h2></div>
      ${items.length
        ? `<ul class="prep-grid">${items.map((c) => `<li class="prep-card">
            <h3>${esc(c.name)}</h3>
            <p class="radio-freq">${esc(c.freq)}</p>
            ${c.call ? `<div class="rtags"><span class="rbadge cat">${esc(c.call)}</span></div>` : ''}
            ${c.note ? `<p>${esc(c.note)}</p>` : ''}
            <div class="ractions"><button class="btn small" type="button" data-edit="${esc(c.id)}">Edit</button>
              <button class="btn small danger" type="button" data-rmch="${esc(c.id)}">Remove</button></div></li>`).join('')}</ul>`
        : '<p class="muted">Add the channels your family or group agreed on, so everyone has them in one place.</p>'}
      <p class="muted small">Saved in this browser only.</p>`;
  }

  function log() {
    const items = list(LOG_KEY);
    const chans = list(CHAN_KEY);
    return `<section class="card prep-kit"><div class="ptitle"><h2>Log a check-in</h2><span class="kicker">Who · when · which channel</span></div>
        <form class="radio-form" id="logform">
          <label>Who<input name="who" required maxlength="60" placeholder="Name or call sign"></label>
          <label>Channel<input name="ch" maxlength="60" list="mychans" placeholder="GMRS 20"></label>
          <datalist id="mychans">${chans.map((c) => `<option value="${esc(c.name)} · ${esc(c.freq)}">`).join('')}</datalist>
          <label class="wide">Note<input name="note" maxlength="200" placeholder="All fine, heading north…"></label>
          <div class="wide"><button class="btn small primary" type="submit">Log it now</button></div>
        </form></section>
      <div class="ptitle"><h2>${items.length ? `${items.length} check-in${items.length === 1 ? '' : 's'}` : 'No check-ins yet'}</h2>
        ${items.length ? '<button class="btn small" type="button" id="logclear">Clear log</button>' : ''}</div>
      ${items.length
        ? `<ul class="radio-log">${items.map((l) => `<li>
            <time>${esc(new Date(l.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</time>
            <div class="grow"><strong>${esc(l.who)}</strong>${l.ch ? ` <span class="rbadge">${esc(l.ch)}</span>` : ''}${l.note ? `<span>${esc(l.note)}</span>` : ''}</div>
            <button class="btn small" type="button" data-rmlog="${esc(l.id)}" aria-label="Delete check-in">Delete</button></li>`).join('')}</ul>`
        : ''}
      <p class="muted small">Saved in this browser only.</p>`;
  }

  function codes() {
    const letters = Object.keys(NATO);
    return `<section class="card prep-kit"><div class="ptitle"><h2>Phonetic alphabet & Morse</h2><span class="kicker">NATO / ICAO · ITU</span></div>
        <p class="muted small">Spell names and call signs letter by letter so they survive a bad signal. SOS in Morse is <code>···−−−···</code>, sent as one run.</p>
        <ul class="radio-codes">${letters.map((k) => `<li><b>${esc(k)}</b><span>${esc(NATO[k])}</span><code>${esc(CODE[k].replaceAll('.', '·').replaceAll('-', '−'))}</code></li>`).join('')}</ul>
        <p class="muted small">Want to practise or send Morse with light and sound? Use the sender on the <a href="#emergency">Emergency</a> page.</p></section>`;
  }

  function mayday() {
    return `<section class="card prep-kit"><div class="ptitle"><h2>How to call for help</h2><span class="kicker">Mayday · voice</span></div>
        <ol class="radio-steps">${MAYDAY.map(([t, d]) => `<li><strong>${esc(t)}</strong><span>${esc(d)}</span></li>`).join('')}</ol>
        <p class="note-box">Example: “Mayday, Mayday, Mayday. This is Sam, Sam, Sam. Mayday, Sam. We are at the north trailhead of Pine Lake. One adult with a broken leg, cannot walk. Need medical rescue. Three people. Over.”</p>
        <p class="muted small">Save battery: call, then listen for a few minutes before calling again. A phone with no service can often still reach 911.</p></section>`;
  }

  const VIEWS = { channels, mine, log, codes, mayday };
  function paint() {
    pills.innerHTML = TABS.map(([t, label]) => `<button type="button" class="rpill" data-t="${esc(t)}" aria-pressed="${t === tab}">${esc(label)}</button>`).join('');
    body.innerHTML = VIEWS[tab]();
  }

  pills.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    tab = b.dataset.t;
    editing = null;
    store.set(TAB_KEY, tab);
    paint();
  });

  body.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries([...new FormData(e.target)].map(([k, val]) => [k, String(val).trim()]));
    if (e.target.id === 'chform') {
      if (!f.name || !f.freq) return;
      const items = list(CHAN_KEY);
      const entry = { name: f.name, freq: f.freq, call: f.call, note: f.note };
      const at = items.findIndex((c) => c.id === editing);
      if (at >= 0) items[at] = { ...items[at], ...entry };
      else items.push({ id: newId(), ...entry });
      store.set(CHAN_KEY, items);
      toast(at >= 0 ? 'Channel saved' : 'Channel added');
      editing = null;
    }
    if (e.target.id === 'logform') {
      if (!f.who) return;
      store.set(LOG_KEY, [{ id: newId(), who: f.who, ch: f.ch, note: f.note, at: Date.now() }, ...list(LOG_KEY)].slice(0, 500));
      toast('Check-in logged');
    }
    paint();
  });

  body.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.edit) {
      editing = t.dataset.edit;
      paint();
      $('#chform input', body)?.focus();
    } else if (t.id === 'chcancel') {
      editing = null;
      paint();
    } else if (t.dataset.rmch) {
      const c = list(CHAN_KEY).find((x) => x.id === t.dataset.rmch);
      if (!c || !confirm(`Remove ${c.name}?`)) return;
      store.set(CHAN_KEY, list(CHAN_KEY).filter((x) => x.id !== c.id));
      if (editing === c.id) editing = null;
      paint();
    } else if (t.dataset.rmlog) {
      store.set(LOG_KEY, list(LOG_KEY).filter((x) => x.id !== t.dataset.rmlog));
      paint();
    } else if (t.id === 'logclear' && confirm('Clear the whole check-in log?')) {
      store.set(LOG_KEY, []);
      paint();
    }
  });

  paint();
}
