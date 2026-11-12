import { $, $$, api, toast } from './core.js';
import { encodeWav } from './wav.js';

/**
 * Voice messages for the whole app: the microphone, recorder, player and channel live here once, so voice keeps
 * working while you move between pages. The Voice page and the floating mic button both use this module.
 */
export const MAX_SECONDS = 60;
const POLL_MS = 3_000;
const HEARD_KEY = 'outpost.voiceHeard';
const SENT_KEY = 'outpost.voiceSent';
const DEVICE_KEY = 'outpost.deviceId';
const MUTE_KEY = 'outpost.voiceMuted';

export const voice = new EventTarget();
const state = {
  messages: [],
  on: false,
  recording: false,
  cancelled: false,
  playing: null,
  startedAt: 0,
  muted: read(MUTE_KEY, false),
  online: [],
};
let stream = null;
let ctx = null;
let chunks = [];
let tick = null;
let queue = [];
let source = null;
let heard = loadHeard();
// What this device sent: only those are "mine" here, so your messages from another device (or someone sharing
// your account) still play and count as new.
const sent = new Set(read(SENT_KEY, []));
/** A random id this device keeps, so the channel can tell your phone and your Mac apart. */
const device = (() => {
  let id = read(DEVICE_KEY, null);
  if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id)) {
    id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    write(DEVICE_KEY, id);
  }
  return id;
})();
/** Sends in flight: until the reply names the new clip, your account's own clips aren't queued to play. */
let sending = 0;

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: remembered for this visit only */
  }
}

/** What this device has already played: the time before which everything counts as heard, and ids heard since. */
function loadHeard() {
  const h = read(HEARD_KEY, null);
  return h && typeof h.since === 'number' && Array.isArray(h.ids) ? { since: h.since, ids: new Set(h.ids) } : null;
}
function saveHeard() {
  write(HEARD_KEY, { since: heard.since, ids: [...heard.ids].slice(-300) });
}
function markHeard(id) {
  heard.ids.add(id);
  saveHeard();
}

export const sentHere = (m) => sent.has(m.id);
export const isNew = (m) => !sentHere(m) && heard && m.at > heard.since && !heard.ids.has(m.id);
const changed = () => voice.dispatchEvent(new Event('change'));
export const snapshot = () => ({ ...state, unheard: state.messages.filter(isNew).length, paused: state.on && ctx?.state !== 'running' });

/** Walkie-talkie chirps: up when recording starts, down when it stops, a double blip for an incoming message. */
function chirp(kind) {
  if (!ctx) return;
  const notes = { start: [[880, 1320]], stop: [[1320, 880]], incoming: [[1046, 1046], [1318, 1318]] }[kind];
  notes.forEach(([from, to], i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime + i * 0.1;
    o.frequency.setValueAtTime(from, t);
    o.frequency.linearRampToValueAtTime(to, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.1);
  });
}

export const canRecord = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

/** Asks for the microphone once (a tap), which also lets this page play sound without another tap (iPhones). */
export async function turnOn() {
  if (state.on) return true;
  // Made and started inside the tap itself, before anything is awaited: Safari and iPhones only let a page play
  // sound later (new messages arriving on their own) if its audio started during a tap.
  ctx = new AudioContext();
  unlock();
  ctx.onstatechange = () => {
    changed();
    if (ctx?.state === 'running') {
      queue = state.messages.filter(isNew).map((m) => m.id);
      playNext();
    }
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await ctx.audioWorklet.addModule('/js/voice-worklet.js');
    const node = new AudioWorkletNode(ctx, 'outpost-recorder');
    node.port.onmessage = (e) => state.recording && chunks.push(e.data);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node).connect(silent).connect(ctx.destination);
    state.on = true;
    changed();
    playNext();
    return true;
  } catch (err) {
    turnOff();
    toast(err?.name === 'NotAllowedError' ? 'Microphone access was refused. Allow it for this site in the browser settings, then try again.' : `The microphone didn't start: ${err?.message ?? err}`, 'error');
    return false;
  }
}

/** Starts the audio from a tap: a silent sound is what iPhones need before they allow any more. */
function unlock() {
  if (!ctx) return;
  ctx.resume();
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  s.connect(ctx.destination);
  s.start();
}

/** Stops the clip that is playing without counting it as heard. */
function stopPlayback() {
  state.playing = null;
  source?.stop();
}

export function turnOff() {
  stopRecording(true);
  queue = [];
  stopPlayback();
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close().catch(() => {});
  stream = ctx = source = null;
  state.on = false;
  state.playing = null;
  changed();
}

export function setMuted(muted) {
  state.muted = muted;
  write(MUTE_KEY, muted);
  if (muted) {
    queue = [];
    stopPlayback();
  } else playNext();
  changed();
}

export function startRecording() {
  if (!state.on || state.recording) return;
  unlock();
  stopPlayback(); // talking interrupts whatever is playing; it stays unheard if it hadn't finished
  chunks = [];
  state.cancelled = false;
  state.recording = true;
  state.startedAt = Date.now();
  chirp('start');
  tick = setInterval(() => {
    if (Date.now() - state.startedAt >= MAX_SECONDS * 1000) stopRecording(false);
    else changed();
  }, 250);
  changed();
}

export function setCancelled(cancelled) {
  if (state.recording && state.cancelled !== cancelled) {
    state.cancelled = cancelled;
    changed();
  }
}

export async function stopRecording(discard) {
  if (!state.recording) return;
  state.recording = false;
  clearInterval(tick);
  chirp('stop');
  const send = !discard && !state.cancelled;
  const clip = send ? encodeWav(chunks, ctx.sampleRate) : null;
  chunks = [];
  changed();
  if (send) {
    try {
      sending++;
      const m = await api('/voice', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: clip });
      sent.add(m.id);
      write(SENT_KEY, [...sent].slice(-300));
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      sending--;
      queue = state.messages.filter(isNew).map((m) => m.id);
    }
  }
  playNext();
}

/** Plays one clip now (a tap on ▶), through the unlocked audio when voice is on, otherwise a plain audio element. */
export async function play(id, { chirpFirst = false } = {}) {
  stopPlayback();
  const url = `/api/voice/${encodeURIComponent(id)}.wav`;
  if (ctx && ctx.state !== 'running') {
    // A tap (▶) may start it now; arriving on its own, a message waits, still New, for the next tap anywhere.
    unlock();
    await Promise.race([new Promise((r) => setTimeout(r, 400)), ctx.resume().catch(() => {})]);
    if (ctx.state !== 'running') {
      changed();
      return;
    }
  }
  state.playing = id;
  changed();
  try {
    if (ctx) {
      const data = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      if (chirpFirst) {
        chirp('incoming');
        await new Promise((r) => setTimeout(r, 260));
      }
      await new Promise((resolve) => {
        source = ctx.createBufferSource();
        source.buffer = data;
        source.connect(ctx.destination);
        source.onended = () => {
          if (state.playing === id) markHeard(id);
          resolve();
        };
        source.start();
      });
    } else {
      const a = new Audio(url);
      await a.play();
      await new Promise((r) => (a.onended = r));
      markHeard(id);
    }
  } catch (err) {
    toast(`Couldn't play it: ${err.message}`, 'error');
  }
  source = null;
  if (state.playing === id) state.playing = null;
  changed();
}

/** New messages from others, one after another, while voice is on and not muted, and not while you are talking. */
async function playNext() {
  if (!state.on || state.muted || state.recording || state.playing) return;
  queue = queue.filter((id) => state.messages.some((m) => m.id === id && isNew(m)));
  const id = queue.shift();
  if (!id) return;
  await play(id, { chirpFirst: true });
  playNext();
}

export function playAllNew() {
  queue = state.messages.filter(isNew).map((m) => m.id);
  if (!state.on) {
    // Without the unlocked audio, play just the first; the rest wait for another tap or for voice to be turned on.
    const first = queue.shift();
    if (first) play(first);
    return;
  }
  playNext();
}

export async function remove(id) {
  await api(`/voice/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.messages = state.messages.filter((m) => m.id !== id);
  changed();
}

export async function refresh() {
  try {
    const after = state.messages.at(-1)?.id;
    const q = new URLSearchParams({ device, on: state.on ? '1' : '0', ...(after ? { after } : {}) });
    const { messages: fresh, online } = await api(`/voice?${q}`);
    state.online = online ?? [];
    // If the last one we had was deleted or expired, the server sends the whole channel: take it as it is.
    state.messages = fresh.some((f) => state.messages.some((m) => m.id === f.id)) ? fresh : state.messages.concat(fresh);
    // First time on this device: what is already there counts as heard, so it doesn't all play at once.
    if (!heard) {
      heard = { since: Math.max(Date.now(), ...state.messages.map((m) => m.at)), ids: new Set() };
      saveHeard();
    }
    for (const m of fresh) if (isNew(m) && !(sending && m.mine) && !queue.includes(m.id)) queue.push(m.id);
    changed();
    playNext();
  } catch {
    /* the next poll tries again */
  }
}

/** The mic button in the corner of every page, and the New counts on the menu. Started once, after sign-in. */
export function startVoice() {
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'voicefab';
  fab.className = 'voicefab';
  fab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg><b class="vbadge" hidden></b>`;
  document.body.append(fab);

  fab.addEventListener('click', () => {
    if (state.on) return;
    if (!canRecord()) location.hash = '#voice';
    else turnOn();
  });
  fab.addEventListener('pointerdown', (e) => {
    if (!state.on) return;
    e.preventDefault();
    fab.setPointerCapture?.(e.pointerId);
    startRecording();
  });
  fab.addEventListener('pointerup', () => state.on && stopRecording(false));
  fab.addEventListener('pointercancel', () => stopRecording(true));
  fab.addEventListener('pointermove', (e) => {
    if (!state.recording) return;
    const r = fab.getBoundingClientRect();
    const out = 24;
    setCancelled(e.clientX < r.left - out || e.clientX > r.right + out || e.clientY < r.top - out || e.clientY > r.bottom + out);
  });
  fab.addEventListener('contextmenu', (e) => e.preventDefault());

  // Browsers pause a page's sound (an iPhone app back from the background, say) until the next tap: any tap or key
  // in Outpost starts it again, and whatever arrived meanwhile plays.
  const wake = () => state.on && ctx && ctx.state !== 'running' && unlock();
  document.addEventListener('pointerdown', wake, true);
  document.addEventListener('keydown', wake, true);

  // Space bar to talk, anywhere in Outpost, once voice is on (not while typing).
  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || !state.on || typing()) return;
    e.preventDefault();
    startRecording();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !state.recording) return;
    e.preventDefault();
    stopRecording(false);
  });

  const paint = () => {
    const s = snapshot();
    const left = MAX_SECONDS - Math.floor((Date.now() - s.startedAt) / 1000);
    fab.classList.toggle('on', s.on);
    fab.classList.toggle('rec', s.recording);
    fab.classList.toggle('cancel', s.recording && s.cancelled);
    fab.classList.toggle('paused', s.paused && !s.recording);
    fab.title = !s.on ? 'Turn on voice' : s.paused && !s.recording ? 'Tap to hear new messages' : s.recording ? (s.cancelled ? 'Let go to cancel' : left <= 10 ? `${left} s left: let go to send` : 'Let go to send') : 'Hold to talk';
    fab.setAttribute('aria-label', fab.title);
    for (const b of [fab.querySelector('.vbadge'), ...$$('.navbadge')]) {
      b.hidden = !s.unheard;
      b.textContent = s.unheard > 9 ? '9+' : String(s.unheard);
    }
  };
  for (const a of $$('.rail a[data-route="voice"], #more-btn')) {
    if (!a.querySelector('.navbadge')) a.insertAdjacentHTML('beforeend', '<b class="navbadge" hidden></b>');
  }
  voice.addEventListener('change', paint);
  paint();
  refresh();
  setInterval(refresh, POLL_MS);
}
