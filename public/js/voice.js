import { $, api, esc, toast } from './core.js';
import { MAX_SECONDS, canRecord, isNew, sentHere, playAllNew, play, remove, setCancelled, setMuted, snapshot, startRecording, stopRecording, turnOff, turnOn, voice } from './voice-core.js';

const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Voice: one shared channel of short voice messages. Hold to talk; everyone signed in can play them for 24 hours. */
export async function viewVoice(root) {
  root.innerHTML = `<div class="titlebar"><div><p class="kicker">Be ready · Voice</p><h1>Voice</h1>
      <p class="lead">Short voice messages for everyone on this Outpost, like a walkie-talkie that remembers. Hold the button, talk, let go to send. New messages play by themselves while voice is on. Messages stay for 24 hours.</p></div></div>
    <div class="voicegrid"><section class="card voicebox" id="vbox"></section>
      <section class="card voiceon"><h2>On the channel now</h2><ul class="voicepeople" id="vpeople"></ul>
        <p class="muted small">Anyone with Outpost open shows here. Those listening hear new messages as they arrive; the others see them, marked New, next time they look.</p></section></div>
    <section class="block"><div class="ptitle"><h2>Channel</h2><span class="kicker" id="vcount"></span></div>
      <p class="row" id="vtools"></p><ol class="voicelist" id="vlist"></ol></section>`;
  const box = $('#vbox', root);
  const listEl = $('#vlist', root);
  const isAdmin = document.body.dataset.role === 'admin';
  const secure = canRecord();
  const port = secure ? null : (await api('/status').catch(() => null))?.listen?.https?.port;
  let lastKey = '';

  function paint() {
    const s = snapshot();
    // The big button keeps its element while it is held, so only its label and state change during a recording.
    const key = `${secure}|${s.on}`;
    if (key !== lastKey) {
      lastKey = key;
      box.innerHTML = !secure
        ? `<p>Recording needs a secure connection. ${port ? `Open <a href="https://${esc(location.hostname)}:${port}/#voice">https://${esc(location.hostname)}:${port}</a>. First time on this device? <a href="/join">Set it up</a> (once per device).` : 'HTTPS is off on this Outpost; it turns on when Outpost is shared on the network.'} You can still play messages below.</p>`
        : s.on
          ? `<button class="voice-talk" type="button" id="talk"><span class="dot" aria-hidden="true"></span><span id="talklabel">Hold to talk</span></button>
             <p class="muted small">Slide off the button before letting go to cancel. Up to ${MAX_SECONDS} seconds. On a computer, hold the space bar on any page. The green band on Home and the mic button in the corner of other pages work the same way.</p>
             <p><button class="btn small" type="button" id="voiceoff">Turn off voice</button></p>`
          : `<p>Turn on voice to talk and to hear new messages as they arrive. Your browser asks to use the microphone; it records only while you hold the button.</p>
             <p><button class="btn primary" type="button" id="voiceon">Turn on voice</button></p>`;
    }
    const talk = $('#talk', root);
    if (talk) {
      const left = MAX_SECONDS - Math.floor((Date.now() - s.startedAt) / 1000);
      talk.classList.toggle('on', s.recording);
      talk.setAttribute('aria-label', s.recording ? 'Recording' : 'Hold to talk');
      $('#talklabel', root).textContent = !s.recording ? 'Hold to talk' : s.cancelled ? 'Let go to cancel' : left <= 10 ? `Recording… ${left} s left` : 'Recording… let go to send';
    }
    const me = document.body.dataset.user;
    $('#vpeople', root).innerHTML = s.online.length
      ? s.online
          .map((p) => `<li><span class="lamp ${p.listening ? 'ok' : 'idle'}" aria-hidden="true"></span><div class="grow"><strong>${esc(p.name === me ? `${p.name} (you)` : p.name)}</strong>
            <span class="muted small">${p.listening ? `listening${p.devices > 1 ? ` on ${p.listening} of ${p.devices} devices` : ''}` : `Outpost open, voice off${p.devices > 1 ? ` (${p.devices} devices)` : ''}`}</span></div></li>`)
          .join('')
      : '<li class="muted">No one yet.</li>';
    const unheard = s.messages.filter(isNew).length;
    $('#vcount', root).textContent = s.messages.length ? `${s.messages.length} in the last 24 hours` : '';
    $('#vtools', root).innerHTML = `${unheard ? `<button class="btn small primary" type="button" id="playnew">Play ${unheard} new</button>` : ''}
      <button class="btn small" type="button" id="mute" aria-pressed="${s.muted}">${s.muted ? 'Unmute new messages' : 'Mute new messages'}</button>`;
    listEl.innerHTML = s.messages.length
      ? s.messages
          .map((m) => `<li class="${isNew(m) ? 'new' : ''}${s.playing === m.id ? ' playing' : ''}"><button class="btn small" type="button" data-play="${esc(m.id)}" aria-label="Play ${esc(m.name)}'s message">${s.playing === m.id ? '♪' : '▶'}</button>
            <div class="grow"><strong>${esc(sentHere(m) ? 'You' : m.mine ? 'You (other device)' : m.name)}</strong><span class="muted"> · ${clock(m.at)} · ${m.seconds} s</span>${isNew(m) ? ' <span class="pill">New</span>' : ''}</div>
            ${m.mine || isAdmin ? `<button class="btn small danger" type="button" data-del="${esc(m.id)}">Delete</button>` : ''}</li>`)
          .join('')
      : '<li class="muted">No messages yet. Turn on voice and hold the button to send the first one.</li>';
  }

  box.addEventListener('click', (e) => {
    if (e.target.id === 'voiceon') turnOn();
    if (e.target.id === 'voiceoff') turnOff();
  });
  box.addEventListener('pointerdown', (e) => {
    const talk = e.target.closest('#talk');
    if (!talk) return;
    e.preventDefault();
    talk.setPointerCapture?.(e.pointerId);
    startRecording();
  });
  box.addEventListener('pointerup', (e) => e.target.closest('#talk') && stopRecording(false));
  box.addEventListener('pointercancel', () => stopRecording(true));
  box.addEventListener('pointermove', (e) => {
    const talk = $('#talk', root);
    if (!talk || !snapshot().recording) return;
    const r = talk.getBoundingClientRect();
    setCancelled(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  });
  box.addEventListener('contextmenu', (e) => e.target.closest('#talk') && e.preventDefault());
  $('#vtools', root).addEventListener('click', (e) => {
    if (e.target.id === 'playnew') playAllNew();
    if (e.target.id === 'mute') setMuted(!snapshot().muted);
  });
  listEl.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-play]');
    const del = e.target.closest('[data-del]');
    if (p) play(p.dataset.play);
    if (del && confirm('Delete this voice message for everyone?')) {
      try {
        await remove(del.dataset.del);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  voice.addEventListener('change', paint);
  paint();
  // Voice stays on when you leave this page; only this page's drawing stops.
  return () => voice.removeEventListener('change', paint);
}
