import { $, esc } from './core.js';
import { canRecord, sentHere, setCancelled, snapshot, startRecording, stopRecording, turnOn, voice } from './voice-core.js';

const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';

/** The green Voice band on Home: who is listening, what is new, and Hold to talk without leaving the page. */
export function voiceBand() {
  const band = document.createElement('div');
  band.className = 'voiceband';
  band.innerHTML = `<span class="vbicon">${MIC}</span>
    <a class="vbtitle" href="#voice"><strong>Voice channel</strong><span>Hold to talk · everyone hears</span></a>
    <span class="vbstatus" aria-live="polite"></span>
    <span class="vbact"></span>
    <a class="vbopen" href="#voice">Open</a>`;
  const act = $('.vbact', band);
  const status = $('.vbstatus', band);
  const secure = canRecord();
  let lastKey = '';

  function paint() {
    const s = snapshot();
    const key = `${secure}|${s.on}`;
    if (key !== lastKey) {
      lastKey = key;
      act.innerHTML = !secure
        ? '<small>Recording needs the secure address. Open to see how.</small>'
        : s.on
          ? '<button class="vbtalk" type="button"><span class="dot" aria-hidden="true"></span><span class="vblabel">Hold to talk</span></button>'
          : '<button class="vbtalk" type="button" data-on>Turn on voice</button>';
    }
    const talk = $('.vbtalk:not([data-on])', act);
    if (talk) {
      talk.classList.toggle('rec', s.recording);
      $('.vblabel', talk).textContent = !s.recording ? 'Hold to talk' : s.cancelled ? 'Let go to cancel' : 'Recording…';
    }
    const listening = s.online.reduce((n, p) => n + p.listening, 0);
    const last = s.messages.at(-1);
    const bits = [
      s.unheard ? `<b>${s.unheard} new</b>` : '',
      `${listening} listening`,
      last ? `Last: ${esc(sentHere(last) ? 'you' : last.name)} ${clock(last.at)}` : 'No messages yet',
    ];
    status.innerHTML = bits.filter(Boolean).map((b) => `<span>${b}</span>`).join('<i aria-hidden="true">·</i>');
  }

  band.addEventListener('click', (e) => e.target.closest('[data-on]') && turnOn());
  band.addEventListener('pointerdown', (e) => {
    const talk = e.target.closest('.vbtalk:not([data-on])');
    if (!talk) return;
    e.preventDefault();
    talk.setPointerCapture?.(e.pointerId);
    startRecording();
  });
  band.addEventListener('pointerup', (e) => e.target.closest('.vbtalk') && stopRecording(false));
  band.addEventListener('pointercancel', () => stopRecording(true));
  band.addEventListener('pointermove', (e) => {
    const talk = $('.vbtalk', band);
    if (!talk || !snapshot().recording) return;
    const r = talk.getBoundingClientRect();
    setCancelled(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  });
  band.addEventListener('contextmenu', (e) => e.target.closest('.vbtalk') && e.preventDefault());

  voice.addEventListener('change', paint);
  paint();
  return { band, stop: () => voice.removeEventListener('change', paint) };
}
