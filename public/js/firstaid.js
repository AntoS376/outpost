import { $, api, contentBase, esc } from './core.js';

/**
 * First-aid cards, written in our own words from the government pages cited on each card (read on the date given).
 * Choking and burns are left out until they have a checked source.
 */
export const CARDS = [
  {
    id: 'cpr',
    title: 'CPR for an adult (hands only)',
    when: 'Someone collapses, does not wake when you tap their shoulder, and is not breathing normally.',
    steps: [
      'Call your emergency number. Say where you are first. Put the phone on speaker.',
      'Send someone to find an AED (defibrillator) if there may be one nearby. Use it as soon as it arrives.',
      'Kneel beside them. Put both hands, one on the other, in the centre of the chest. Keep your arms straight.',
      'Push hard and fast: at least 5 cm (2 inches) deep, 100 to 120 times a minute. The beat below keeps the pace.',
      'If someone else knows CPR, swap every 2 minutes. Keep going until help takes over.',
    ],
    search: 'Cardiopulmonary resuscitation',
    source: ['Seattle Fire Department: Learn Hands-Only CPR', 'https://fireline.seattle.gov/2020/02/05/learn-hands-only-cpr-for-heart-month/'],
  },
  {
    id: 'bleeding',
    title: 'Severe bleeding',
    when: 'Blood is spurting, pooling, or will not stop.',
    steps: [
      'Press hard on the wound with your hands straight away.',
      'Put a dressing or clean cloth on the wound and keep pressing firmly.',
      'If an arm or leg keeps bleeding, put on a tourniquet and write down the time you did it.',
      'Call your emergency number as soon as you can, or get someone else to.',
    ],
    search: 'Bleeding',
    source: ['Seattle Emergency Management: Stop the Bleed', 'https://seattle.gov/emergency-management/community-engagement/stop-the-bleed'],
  },
  {
    id: 'water',
    title: 'Make water safe to drink',
    when: 'Tap water may be unsafe after a disaster, or you only have water from a river, lake or tank.',
    steps: [
      'If it is cloudy, filter it through a clean cloth, paper towel or coffee filter, or let it settle and pour off the clear water.',
      'Boil: bring it to a rolling boil for 1 minute (3 minutes above 2,000 m / 6,500 ft). Let it cool.',
      'Or use unscented household bleach (5–9%): 8 drops per gallon (3.8 L) of clear water, 16 drops if cloudy. Stir and wait 30 minutes.',
      'Neither works on water with fuel or toxic chemicals in it. Do not drink that.',
    ],
    search: 'Water purification',
    source: ['CDC: How to Make Water Safe in an Emergency', 'https://www.cdc.gov/water-emergency/about/index.html'],
  },
  {
    id: 'hypothermia',
    title: 'Hypothermia (too cold)',
    when: 'Shivering, exhaustion, confusion, fumbling hands, memory loss, slurred speech or drowsiness. A body temperature below 35 °C (95 °F) is an emergency.',
    steps: [
      'Get them somewhere warm and take off any wet clothing.',
      'Warm the centre of the body first: chest, neck, head and groin. Use skin-to-skin contact under loose, dry layers of blankets or clothing.',
      'Give warm drinks only if they are fully awake. No alcohol.',
      'Once warmer, keep them dry and wrapped, head and neck included. Get medical care.',
      'If they are unconscious or not breathing: handle them gently, call your emergency number, and start CPR, even if they seem dead.',
    ],
    search: 'Hypothermia',
    source: ['CDC: Preventing and recognizing hypothermia', 'https://www.cdc.gov/winter-weather/prevention/index.html'],
  },
  {
    id: 'heat',
    title: 'Heat stroke (too hot)',
    when: 'In heat or after hard work: confusion or slurred speech, passing out, seizures, hot dry skin or heavy sweating, a very high body temperature. It can kill if treatment is delayed: act at once.',
    steps: [
      'Call your emergency number, and stay with them.',
      'Move them into shade and take off outer clothing.',
      'Cool them fast: a cold-water or ice bath if you can. Otherwise put cold wet cloths or ice on the head, neck, armpits and groin, and soak their clothes with cool water.',
      'Give sips of cool water only if they are alert. Nothing by mouth if they are not.',
      'Keep cooling until help arrives, unless they start shivering.',
    ],
    search: 'Heat stroke',
    source: ['CDC NIOSH: Heat-related illnesses', 'https://www.cdc.gov/niosh/heat-stress/about/illnesses.html'],
  },
];
export const CHECKED = '2026-10-30';

/** First aid tab: the cards, and a CPR beat to push along with. */
export async function firstAidView(body) {
  // Link each card to the offline medical encyclopedia when it's installed.
  let book = null;
  const content = await contentBase();
  try {
    const files = (await api('/library')).files.map((f) => f.name.replace(/\.zim$/, ''));
    book = files.find((n) => /^(wikipedia_en_medicine|mdwiki_en)/.test(n)) ?? files.find((n) => /^wikipedia_en_/.test(n)) ?? null;
  } catch {
    /* library unavailable: no links */
  }
  body.innerHTML = `<p class="note-box"><b>These cards don't replace first-aid training or emergency services.</b> Call your emergency number first (for example 112 in Europe, 911 in North America). Each card is written in plain words from the government page named on it, checked ${CHECKED}. A course, such as one from your local Red Cross or Red Crescent, teaches what a card can't.</p>
    <section class="block cpr noprint"><h2>CPR beat</h2>
      <div class="beatrow"><button class="beat" type="button" id="beat" aria-pressed="false"><span>Start</span></button>
        <div><p style="margin:0 0 6px">Push down on every beat: <b>110 a minute</b>, in the middle of the 100–120 range.</p>
          <p class="muted" style="font-size:13px;margin:0">It beeps and flashes. Count shown: <b id="beats">0</b> pushes · <b id="beattime">0:00</b>. Swap with someone every 2 minutes if you can.</p></div></div></section>
    <div class="aidcards">${CARDS.map((c) => `<article class="aidcard" id="aid-${c.id}"><h2>${esc(c.title)}</h2>
        <p class="when">${esc(c.when)}</p>
        <ol>${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <p class="src">Source: <a href="${c.source[1]}" target="_blank" rel="noopener">${esc(c.source[0])}</a>${book ? ` · <a class="noprint" href="${content}/kiwix/search?books.name=${encodeURIComponent(book)}&pattern=${encodeURIComponent(c.search)}" target="_blank" rel="noopener">Read more offline</a>` : ''}</p></article>`).join('')}</div>
    <p class="muted" style="font-size:13px;margin-top:12px">Not here yet: choking and burns. They will be added once checked against a government source.</p>`;

  // 110 beats a minute: a short click and a pulse of the circle on each beat.
  let audio = null;
  let timer = null;
  let started = 0;
  let count = 0;
  const btn = $('#beat', body);
  const stop = () => {
    clearInterval(timer);
    timer = null;
    btn.setAttribute('aria-pressed', 'false');
    btn.firstElementChild.textContent = 'Start';
  };
  const tick = () => {
    count++;
    $('#beats', body).textContent = String(count);
    const s = Math.floor((performance.now() - started) / 1000);
    $('#beattime', body).textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    btn.classList.remove('pulse');
    void btn.offsetWidth; // restart the animation
    btn.classList.add('pulse');
    if (!audio) return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.4, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.08);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.09);
  };
  btn.addEventListener('click', () => {
    if (timer) return stop();
    audio ??= new AudioContext();
    count = 0;
    started = performance.now();
    btn.setAttribute('aria-pressed', 'true');
    btn.firstElementChild.textContent = 'Stop';
    tick();
    timer = setInterval(tick, 60000 / 110);
  });
  return stop;
}
