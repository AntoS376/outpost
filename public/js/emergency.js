import { $, esc } from './core.js';
import { decode, encode, NATO, SOS, spell, timeline, unitMs } from './morse.js';
import { cardView, numbersView } from './emergency-kit.js';
import { locationView } from './emergency-location.js';
import { firstAidView } from './firstaid.js';
import { openSosDialog } from './sos.js';
import { mountCheckin } from './checkin.js';

/** Well-established channels only; regions and status are stated, and rules differ by country. */
const RADIO = [
  ['Marine distress, safety and calling', 'VHF channel 16 · 156.800 MHz', 'Worldwide, at sea', 'International distress channel (ITU Radio Regulations).'],
  ['Aviation emergency', '121.500 MHz', 'Worldwide, aircraft', 'International aeronautical emergency frequency (ITU, ICAO).'],
  ['Rescue beacons (EPIRB, PLB, ELT)', '406 MHz', 'Worldwide', 'Satellite distress beacons (Cospas-Sarsat). Only beacons send here; you cannot talk on it.'],
  ['CB radio emergency', 'CB channel 9 · 27.065 MHz', 'United States (also used elsewhere)', 'Reserved for emergencies and travellers needing help (FCC rules).'],
  ['GMRS / FRS travel and emergency', 'Channel 20 · 462.675 MHz', 'United States', 'An informal convention, not an official emergency channel.'],
  ['Amateur 2 m calling', '146.520 MHz', 'United States (Region 2)', 'National simplex calling frequency. Normally needs an amateur licence.'],
  ['Amateur 70 cm calling', '446.000 MHz', 'United States', 'National simplex calling frequency. Normally needs an amateur licence.'],
  ['PMR446 licence-free radio', '446.0–446.2 MHz, channels 1–16', 'Europe and many other countries', 'No official emergency channel: agree one with your group in advance.'],
];

/** The international survivors' ground-to-air code (ICAO Annex 12): letter, meaning, and how to draw it on an 80×80 tile. */
const GROUND = [
  ['V', 'Need help', '<polyline points="20,15 40,65 60,15"/>'],
  ['X', 'Need medical help', '<path d="M18 15 62 65M62 15 18 65"/>'],
  ['N', 'No', '<polyline points="20,65 20,15 60,65 60,15"/>'],
  ['Y', 'Yes', '<path d="M20 15 40 40 60 15M40 40v25"/>'],
  ['↑', 'Went this way', '<path d="M40 65V15M24 31 40 15l16 16"/>'],
];

/** The pinned bar is clear where it sits, and gets the page colour only while pinned over scrolled content. */
function shadeWhenPinned(root) {
  const bar = $('.em-nav', root);
  const above = bar.previousElementSibling;
  const gap = bar.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
  const check = () => {
    if (!bar.isConnected) return document.removeEventListener('scroll', check, true);
    bar.classList.toggle('pinned', bar.getBoundingClientRect().top - above.getBoundingClientRect().bottom > gap + 1);
  };
  document.addEventListener('scroll', check, { capture: true, passive: true });
}

export async function viewEmergency(root, sub) {
  if (sub === 'kits') return location.replace('#ready'); // the kits moved to Preparedness
  const tab = ['aid', 'card', 'location', 'numbers'].includes(sub) ? sub : 'signal';
  // The section tabs and Print, pinned under the top bar while the page scrolls.
  const nav = `<nav class="em-nav row noprint" aria-label="Emergency sections"><div class="seg">${[['signal', 'Signal', ''], ['numbers', 'Numbers', '/numbers'], ['aid', 'First aid', '/aid'], ['location', 'Location', '/location'], ['card', 'My card', '/card']].map(([id, label, path]) => `<a href="#emergency${path}" ${tab === id ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</div>
    <button class="btn em-print" type="button">Print this page</button></nav>`;
  if (tab !== 'signal') {
    root.innerHTML = `<div class="titlebar"><div><h1>Emergency</h1>
      <p class="lead">${{ numbers: 'Who to call for police, ambulance and fire, one tap each.', card: 'Who you are and who to call, for whoever helps you.', location: 'Say exactly where you are, in the format the other person uses.', aid: 'What to do first, while help is on the way.' }[tab]}</p></div></div>${nav}<div id="embody"><p class="muted">Loading…</p></div>`;
    root.querySelector('.em-print').addEventListener('click', () => window.print());
    shadeWhenPinned(root);
    const body = $('#embody', root);
    return ({ numbers: numbersView, card: cardView, location: locationView, aid: firstAidView }[tab])(body);
  }
  root.innerHTML = `<div class="titlebar"><div><h1>Emergency</h1>
      <p class="lead">Signal, spell and talk clearly when other ways fail. Everything here works with no connection.</p></div>
      </div>
    ${nav}

    <section class="block em-net noprint"><h2>Call for help on this network</h2>
      <p class="muted" style="max-width:70ch">Sets off an alarm on every screen signed in to this Outpost, with your name, your message and where you are. Others can answer “I’m coming” and you see who is on the way.</p>
      <p><button class="btn sosgo" type="button" id="netsos">Send SOS to everyone</button></p>
    </section>

    <section class="block em-safe noprint" id="safe"></section>

    <section class="block em-sos noprint"><h2>Signal with sound and light</h2>
      <button class="btn sos" type="button" id="sos" aria-pressed="false"><b>SOS</b><span>Send · · · — — — · · · until stopped</span></button>
      <div class="row em-opts"><label class="check"><input type="checkbox" id="snd" checked><span>Sound</span></label>
        <label class="check"><input type="checkbox" id="lgt" checked><span>Screen light</span></label>
        <div><label for="wpm">Speed</label><select id="wpm"><option value="6">Slow (6 words/min)</option><option value="12" selected>Normal (12 words/min)</option><option value="20">Fast (20 words/min)</option></select></div></div>
      <p class="muted" style="font-size:13px">Screen light fills the whole screen; turn the brightness up and point the screen where you need to be seen. Tap anywhere or press Esc to stop.</p>
    </section>

    <section class="block"><h2>Send a message in Morse</h2>
      <div class="field"><label for="msg">Message</label><input id="msg" value="Help needed" autocomplete="off"></div>
      <p class="morse" id="msgcode" aria-live="polite"></p>
      <p class="noprint"><button class="btn primary" type="button" id="play">Send it</button></p>
    </section>

    <section class="block"><h2>Read Morse</h2>
      <div class="field"><label for="dots">Dots and dashes (letters apart with a space, words with /)</label><input id="dots" class="mono" placeholder="... --- ..." autocomplete="off"></div>
      <p class="decoded" id="dotstext" aria-live="polite">–</p>
      <div class="noprint"><button class="btn key" type="button" id="key">Hold to key in Morse (or hold Space)</button>
        <button class="btn small" type="button" id="clearkey">Clear</button>
        <p class="muted" style="font-size:13px">A short press is a dot, a long one a dash. Pause for a new letter; pause longer for a new word. Set the speed above to match the sender.</p></div>
    </section>

    <section class="block"><h2>Spell it out</h2>
      <div class="field"><label for="spellin">Name, place or code to spell over a radio or bad phone line</label><input id="spellin" value="" placeholder="e.g. Beirut 9" autocomplete="off"></div>
      <p class="decoded" id="spellout">–</p>
      <div class="nato">${Object.entries(NATO).map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join('')}</div>
    </section>

    <section class="block"><h2>Signals searchers know</h2>
      <p class="muted" style="max-width:70ch">To aircraft: lay these out in the open, as big as you can (at least 2.5 m, 8 ft, long), in something that stands out against the ground: stones, branches, clothing, or lines trampled in snow.</p>
      <div class="g2a">${GROUND.map(([k, label, d]) => `<figure><svg viewBox="0 0 80 80" role="img" aria-label="${k}: ${label}">${d}</svg><figcaption><b>${k}</b> ${label}</figcaption></figure>`).join('')}</div>
      <dl class="readout signals">
        <div><dt>Three of anything</dt><dd>Means help: three whistle blasts, three flashes of a light or mirror, three fires in a triangle. Pause, then repeat. In the mountains of Europe the call is six blasts or flashes a minute, answered with three.</dd></div>
        <div><dt>Mirror</dt><dd>Hold it by your eye, stretch your other arm out with two fingers in a V around the aircraft or searcher, and tilt the mirror until the bright spot falls between your fingers. Then flash.</dd></div>
        <div><dt>Trapped</dt><dd>Tap on a pipe or wall, or blow a whistle, rather than shouting: it carries further and saves your breath and lungs from dust.</dd></div>
      </dl>
    </section>

    <section class="block"><h2>Radio channels</h2>
      <p class="muted" style="max-width:70ch">Common emergency and calling channels. Rules on who may transmit, and where, differ by country. Check your local rules, and use what you're licensed for.</p>
      <div class="tablewrap"><table class="radio"><thead><tr><th>For</th><th>Channel</th><th>Where</th><th>Note</th></tr></thead>
        <tbody>${RADIO.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    </section>
    <div class="flash" id="flash" hidden aria-hidden="true"><span>Tap to stop</span></div>`;

  // Sending: sound and/or full-screen light, driven by the standard Morse timeline.
  let audio = null;
  let stopFn = null;
  const flash = $('#flash', root);
  const speed = () => unitMs(Number($('#wpm', root).value));

  function stop() {
    stopFn?.();
    stopFn = null;
    flash.hidden = true;
    flash.classList.remove('on');
    const sos = $('#sos', root);
    sos.setAttribute('aria-pressed', 'false');
    sos.querySelector('b').textContent = 'SOS';
    $('#play', root).textContent = 'Send it';
  }

  function send(morse, repeat) {
    stop();
    const steps = timeline(morse);
    if (!steps.length) return;
    const unit = speed();
    const sound = $('#snd', root).checked;
    const light = $('#lgt', root).checked;
    let osc = null;
    let gain = null;
    if (sound) {
      audio ??= new AudioContext();
      osc = audio.createOscillator();
      gain = audio.createGain();
      osc.frequency.value = 650;
      gain.gain.value = 0;
      osc.connect(gain).connect(audio.destination);
      osc.start();
    }
    if (light) flash.hidden = false;
    let i = 0;
    let timer = null;
    const tick = () => {
      if (i === steps.length) {
        if (!repeat) return stop();
        i = 0;
        set(false);
        timer = setTimeout(tick, 7 * unit);
        return;
      }
      const [on, units] = steps[i++];
      set(on);
      timer = setTimeout(tick, units * unit);
    };
    const set = (on) => {
      if (gain) gain.gain.setTargetAtTime(on ? 0.35 : 0, audio.currentTime, 0.004);
      flash.classList.toggle('on', on);
    };
    stopFn = () => {
      clearTimeout(timer);
      if (osc) {
        gain.gain.setTargetAtTime(0, audio.currentTime, 0.004);
        osc.stop(audio.currentTime + 0.05);
      }
    };
    tick();
  }

  const paintMsg = () => ($('#msgcode', root).textContent = encode($('#msg', root).value) || '–');
  const paintDots = () => ($('#dotstext', root).textContent = decode($('#dots', root).value) || '–');
  const paintSpell = () => ($('#spellout', root).textContent = spell($('#spellin', root).value) || '–');
  paintMsg();

  root.addEventListener('input', (e) => {
    if (e.target.id === 'msg') paintMsg();
    if (e.target.id === 'dots') paintDots();
    if (e.target.id === 'spellin') paintSpell();
  });

  shadeWhenPinned(root);
  const stopCheckin = mountCheckin($('#safe', root));
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button') ?? e.target;
    if (t.closest('.em-print')) window.print();
    if (t.id === 'netsos') openSosDialog();
    if (t.id === 'sos') {
      if (stopFn) return stop();
      send(SOS, true);
      t.setAttribute('aria-pressed', 'true');
      t.querySelector('b').textContent = 'Stop';
    }
    if (t.id === 'play') {
      if (stopFn) return stop();
      send(encode($('#msg', root).value), false);
      if (stopFn) t.textContent = 'Stop';
    }
    if (t.id === 'clearkey') {
      $('#dots', root).value = '';
      paintDots();
    }
  });
  flash.addEventListener('pointerdown', stop);

  // Keying: press length decides dot or dash; silence decides letter and word breaks.
  let downAt = 0;
  let gapTimer = null;
  const keyDown = () => {
    if (downAt) return;
    downAt = performance.now();
    clearTimeout(gapTimer);
    $('#key', root).classList.add('down');
  };
  const keyUp = () => {
    if (!downAt) return;
    const unit = speed();
    const held = performance.now() - downAt;
    downAt = 0;
    $('#key', root).classList.remove('down');
    const box = $('#dots', root);
    box.value += held < 2 * unit ? '.' : '-';
    paintDots();
    gapTimer = setTimeout(() => {
      box.value += ' ';
      gapTimer = setTimeout(() => {
        box.value = box.value.trimEnd() + ' / ';
        paintDots();
      }, 4 * unit);
    }, 3 * unit);
  };
  const key = $('#key', root);
  key.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    keyDown();
  });
  key.addEventListener('pointerup', keyUp);
  key.addEventListener('pointerleave', keyUp);
  const onKey = (e) => {
    if (e.key === 'Escape') stop();
    if (e.code !== 'Space' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    e.preventDefault();
    if (e.type === 'keydown' && !e.repeat) keyDown();
    if (e.type === 'keyup') keyUp();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKey);

  return () => {
    stop();
    stopCheckin();
    clearTimeout(gapTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKey);
  };
}
