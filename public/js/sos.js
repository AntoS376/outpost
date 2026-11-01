import { $, api, esc, jsonBody, toast } from './core.js';

/*
 * Network SOS: a call for help that every signed-in screen shows at once, as a banner on top of the page with an
 * alarm. The server keeps alerts in memory only; this module sends them, polls for them and shows them.
 */

// Where this device last knew it was (from Locate me on Maps, or from the SOS dialog), for the alert and distances.
let myPos = null;
/** Maps calls this on every fix while Locate me is on. */
export function rememberPos(p) {
  myPos = p ? { lat: p.lat, lon: p.lon, accuracy: p.accuracy, at: Date.now() } : null;
}
const freshPos = () => (myPos && Date.now() - myPos.at < 10 * 60_000 ? myPos : null);

const metres = (a, b) => {
  const rad = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(x));
};
const far = (m) => (m < 1000 ? `${Math.round(m)} m away` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km away`);
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

function askPosition() {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 12_000 },
    );
  });
}

/** The Send SOS dialog: an optional message and, when this device can tell, where you are. */
export function openSosDialog() {
  const fix = freshPos();
  const canAsk = window.isSecureContext && !!navigator.geolocation;
  const where = fix
    ? `<label class="check"><input type="checkbox" id="sos-pos" checked> Include where I am (from Locate me, give or take ${Math.round(fix.accuracy)} m)</label>`
    : canAsk
      ? `<label class="check"><input type="checkbox" id="sos-pos" checked> Include where I am (your browser may ask first)</label>`
      : `<p class="muted small">Your position can't be added from this connection. Open Outpost's secure address (https) to include it, or say where you are in the message.</p>`;
  const dlg = document.createElement('dialog');
  dlg.className = 'cmd-dialog sos-dialog';
  dlg.innerHTML = `<form method="dialog"><h2>Send SOS to everyone?</h2>
    <p>Everyone signed in to this Outpost sees an alarm with your name${fix || canAsk ? ' and position' : ''}, on every page, until you cancel it. It ends by itself after 2 hours.</p>
    <div class="field"><label for="sos-msg">Message (optional)</label>
      <textarea id="sos-msg" maxlength="280" rows="2" placeholder="e.g. Injured at the north cabin"></textarea></div>
    ${where}
    <p class="muted small">This reaches people on this Outpost only, not emergency services. If you can, call your local emergency number too.</p>
    <div class="row"><button class="btn" value="no">Cancel</button><button class="btn sosgo" value="yes" id="sos-go">Send SOS</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', async () => {
    const yes = dlg.returnValue === 'yes';
    const message = $('#sos-msg', dlg).value;
    const withPos = $('#sos-pos', dlg)?.checked;
    dlg.remove();
    if (!yes) return;
    let pos = withPos ? freshPos() : null;
    if (withPos && !pos && canAsk) {
      toast('Finding where you are…');
      pos = await askPosition();
      if (pos) rememberPos(pos);
      else toast("Couldn't find your position; sending without it.", 'error');
    }
    try {
      await api('/sos', jsonBody({ message, ...(pos ? { lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy } : {}) }));
      toast('SOS sent to everyone on this Outpost.');
    } catch (err) {
      toast(err.message, 'error');
    }
    poll();
  });
  dlg.showModal();
  $('#sos-msg', dlg).focus();
}

/* ---------- the banner and the alarm, on every page ---------- */
let alerts = [];
let shown = '';
let timer = null;
// Alerts this device stopped the alarm for (kept for this tab only).
const silenced = new Set(JSON.parse(sessionStorage.getItem('outpost.sosSilenced') ?? '[]'));
const saveSilenced = () => sessionStorage.setItem('outpost.sosSilenced', JSON.stringify([...silenced]));

let audio = null;
let ringing = null;
/** Two-tone alarm, like a siren, every 1.6 s until silenced. */
function ring(on) {
  if (!on) {
    clearInterval(ringing);
    ringing = null;
    return;
  }
  if (ringing) return;
  try {
    audio ??= new AudioContext();
  } catch {
    return;
  }
  const beep = () => {
    if (audio.state === 'suspended') audio.resume().catch(() => undefined);
    [880, 660, 880, 660].forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.22;
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.21);
    });
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([300, 120, 300]);
  };
  beep();
  ringing = setInterval(beep, 1600);
}
// Browsers only play sound after the person has touched the page; the first touch lets a waiting alarm be heard.
document.addEventListener('pointerdown', () => audio?.state === 'suspended' && audio.resume().then(render, () => undefined));

function render() {
  const bar = $('#sosbar');
  if (!bar) return;
  const pos = freshPos();
  const html = alerts
    .map((a) => {
      const meta = [esc(ago(a.at))];
      if (a.lat != null && pos && !a.mine) meta.push(far(metres(pos, a)));
      if (a.lat == null) meta.push('no position sent');
      const msg = a.message ? `<q>${esc(a.message)}</q>` : '';
      const map = a.lat != null ? `<button class="btn small" type="button" data-sos-map="${esc(a.id)}">Show on map</button>` : '';
      const route = a.lat != null && !a.mine ? `<button class="btn small" type="button" data-sos-route="${esc(a.id)}">Directions</button>` : '';
      if (a.mine) {
        const heard = a.acks.length ? `On their way: ${a.acks.map((k) => `<b>${esc(k.name)}</b> (${esc(ago(k.at))})`).join(', ')}` : 'Nobody has answered yet.';
        return `<div class="sosalert mine" role="alert"><div class="sosmain"><strong>Your SOS is out</strong> <span class="sosmeta">${meta.join(' · ')}</span>${msg}
          <span class="sosacks">${heard}</span></div>
          <div class="sosacts">${map}<button class="btn small" type="button" data-sos-cancel="${esc(a.id)}">Cancel SOS</button></div></div>`;
      }
      const coming = a.acked;
      const others = a.acks;
      return `<div class="sosalert" role="alert"><div class="sosmain"><strong>SOS from ${esc(a.name)}</strong> <span class="sosmeta">${meta.join(' · ')}</span>${msg}
          ${others.length ? `<span class="sosacks">On their way: ${others.map((k) => esc(k.name)).join(', ')}</span>` : ''}</div>
          <div class="sosacts">${map}${route}${coming ? '<span class="sosok">You said you’re coming</span>' : `<button class="btn small go" type="button" data-sos-ack="${esc(a.id)}">I’m coming</button>`}
          <button class="btn small admin-only" type="button" data-sos-cancel="${esc(a.id)}">Cancel</button></div></div>`;
    })
    .join('');
  const loud = alerts.some((a) => !a.mine && !silenced.has(a.id) && !a.acked);
  ring(loud);
  const muted = loud && audio?.state !== 'running';
  const out = html + (loud ? `<div class="soshush">${muted ? '<span>Tap anywhere on the page to turn the alarm sound on.</span>' : ''}<button class="btn small" type="button" data-sos-hush>Silence alarm</button></div>` : '');
  if (out !== shown) {
    bar.innerHTML = out;
    shown = out;
  }
  bar.hidden = !alerts.length;
  document.title = document.title.replace(/^SOS · /, '');
  if (alerts.some((a) => !a.mine)) document.title = `SOS · ${document.title}`;
}

async function poll() {
  try {
    alerts = (await api('/sos')).alerts;
    // Forget silenced alerts that are over.
    for (const id of silenced) if (!alerts.some((a) => a.id === id)) silenced.delete(id);
    saveSilenced();
  } catch {
    /* server restarting or shut down: keep what we have, try again next tick */
  }
  render();
}

/** Starts checking for alerts every few seconds, on every page. */
export function startSosWatch() {
  const bar = $('#sosbar');
  bar.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.sosAck) {
        await api(`/sos/${encodeURIComponent(t.dataset.sosAck)}/ack`, { method: 'POST' });
        silenced.add(t.dataset.sosAck);
        toast('They can see you’re on your way.');
      }
      if (t.dataset.sosCancel) {
        if (!confirm('Cancel this SOS for everyone?')) return;
        await api(`/sos/${encodeURIComponent(t.dataset.sosCancel)}`, { method: 'DELETE' });
        toast('SOS cancelled.');
      }
      if (t.dataset.sosHush != null) for (const a of alerts) silenced.add(a.id);
      if (t.dataset.sosRoute) {
        const a = alerts.find((x) => x.id === t.dataset.sosRoute);
        if (a) {
          sessionStorage.setItem('outpost.directionsTo', JSON.stringify({ lat: a.lat, lon: a.lon, label: `${a.name} (SOS)` }));
          if (location.hash.startsWith('#maps')) window.dispatchEvent(new Event('outpost:directions'));
          else location.hash = '#maps';
        }
      }
      if (t.dataset.sosMap) {
        const a = alerts.find((x) => x.id === t.dataset.sosMap);
        if (a) {
          sessionStorage.setItem('outpost.flyTo', JSON.stringify({ lat: a.lat, lon: a.lon, label: `SOS: ${a.name}` }));
          if (location.hash.startsWith('#maps')) window.dispatchEvent(new Event('outpost:flyto'));
          else location.hash = '#maps';
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    saveSilenced();
    poll();
  });
  poll();
  timer ??= setInterval(poll, 4000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());
}
