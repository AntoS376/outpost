import { $, api, esc, fmtBytes, jsonBody, openTray, toast } from './core.js';

const DETAIL = [
  { zoom: 15, label: 'Streets (most detail)' },
  { zoom: 12, label: 'Towns and main roads' },
  { zoom: 9, label: 'Regions and highways' },
];

/** First-run wizard: make the admin account, choose Wi-Fi sharing, pick a Wikipedia size, a level per topic, a map and AI models, then queue them all in Transfers. */
export async function viewSetup(root) {
  root.innerHTML = `<h1>Set up Outpost</h1>
    <p class="lead">Choose what to download while you are online. Everything goes to Transfers and keeps going if you leave this page. You can come back here from Home any time.</p>
    <div id="setup-body"><p class="muted">Looking up the Kiwix catalog…</p></div>`;
  const body = $('#setup-body', root);

  let data, users;
  try {
    [data, users] = await Promise.all([api('/setup'), api('/users').catch(() => null)]);
  } catch (e) {
    body.innerHTML = `<div class="note-box">${esc(e.message)}</div>
      <p class="row"><button class="btn" type="button" id="retry">Try again</button><button class="btn" type="button" id="skip">Skip setup</button></p>`;
    $('#retry', root).onclick = () => viewSetup(root);
    $('#skip', root).onclick = skip;
    return;
  }

  const sel = {
    topics: new Map(), // topic id → level id
    wikipedia: null, // a Wikipedia choice id, or null for none
    map: 'world', // 'none' | 'world' | 'region'
    region: { w: '', s: '', e: '', n: '', maxzoom: 12, name: 'my-region.pmtiles' },
    models: new Set(data.models.filter((m) => m.recommended && !m.installed).map((m) => m.name)),
  };
  const estimates = { world: null, region: null }; // bytes, 'busy', or an error message
  const account = { name: '', done: null }; // done: the account's name once it exists
  let share = false;
  let step = 0;

  async function skip() {
    await api('/setup/dismiss', { method: 'POST' }).catch(() => {});
    location.hash = '#home';
  }

  const books = () => {
    const seen = new Map();
    const add = (b) => !b.installed && seen.set(b.fileName, b);
    for (const t of data.topics) t.levels.find((l) => l.id === sel.topics.get(t.id))?.books.forEach(add);
    const w = data.wikipedia.find((x) => x.id === sel.wikipedia);
    if (w) add(w);
    return [...seen.values()];
  };
  const models = () => (data.canPullModels ? data.models.filter((m) => sel.models.has(m.name) && !m.installed) : []);
  const mapBytes = () => (sel.map === 'none' ? 0 : typeof estimates[sel.map] === 'number' ? estimates[sel.map] : null);
  const total = () => books().reduce((n, b) => n + (b.size ?? 0), 0) + (mapBytes() ?? 0) + models().reduce((n, m) => n + m.size, 0);

  async function estimate(kind) {
    const area = kind === 'world' ? { bbox: data.maps.world.bbox, maxzoom: data.maps.world.maxzoom } : { bbox: ['w', 's', 'e', 'n'].map((k) => Number(sel.region[k])), maxzoom: sel.region.maxzoom };
    estimates[kind] = 'busy';
    paint();
    try {
      estimates[kind] = (await api('/setup/map-estimate', jsonBody(area))).bytes;
    } catch (e) {
      estimates[kind] = e.message;
    }
    paint();
  }
  const estimateText = (kind) => {
    const v = estimates[kind];
    if (v === 'busy') return 'Estimating size… (a few seconds)';
    if (typeof v === 'number') return `About ${fmtBytes(v)}`;
    if (typeof v === 'string') return `<span class="error-text">${esc(v)}</span>`;
    return '';
  };

  function stepBooks() {
    const size = (b) => (b.installed ? 'installed' : fmtBytes(b.size ?? 0));
    const wiki = `<h2 class="wsub">Wikipedia</h2>
      <div class="choices">
        <label class="choice"><input type="radio" name="wiki" value="" ${sel.wikipedia ? '' : 'checked'}><span><strong>No Wikipedia</strong></span></label>
        ${data.wikipedia
          .map((w) => `<label class="choice"><input type="radio" name="wiki" value="${esc(w.id)}" ${sel.wikipedia === w.id ? 'checked' : ''}>
            <span><strong>${esc(w.choice)}</strong> <span class="muted">${size(w)}</span><br>${esc(w.note)}</span></label>`)
          .join('')}</div>`;
    const topics = data.topics
      .map((t) => {
        const chosen = t.levels.find((l) => l.id === sel.topics.get(t.id));
        return `<fieldset class="topic"><legend>${esc(t.title)}</legend><p class="muted">${esc(t.description)}</p>
          <div class="levels">
            <label><input type="radio" name="topic-${esc(t.id)}" value="" ${chosen ? '' : 'checked'}><span>None</span></label>
            ${t.levels.map((l) => `<label><input type="radio" name="topic-${esc(t.id)}" value="${esc(l.id)}" ${chosen === l ? 'checked' : ''}><span>${esc(l.title)}</span><small>${fmtBytes(l.size)}</small></label>`).join('')}
          </div>
          ${chosen ? `<p>${esc(chosen.description)}</p>
            <details><summary>What's in it (${chosen.books.length} book${chosen.books.length === 1 ? '' : 's'})</summary>
              <ul class="booklist">${chosen.books.map((b) => `<li>${esc(b.note)} <span class="muted">${size(b)}</span></li>`).join('')}</ul></details>` : ''}
        </fieldset>`;
      })
      .join('');
    return `<p class="muted">Pick what you want. Sizes come from the Kiwix catalog right now.</p>${wiki}
      <h2 class="wsub">Topics</h2><p class="muted">Choose a level for each topic you want. Each level includes the ones before it.</p>
      <div class="topics">${topics}</div>
      ${data.dropped.length ? `<p class="muted" style="font-size:13px">Not in the catalog right now, so left out: ${data.dropped.map(esc).join(', ')}.</p>` : ''}`;
  }

  function stepMap() {
    const r = sel.region;
    return `<p class="muted">Maps come from the newest Protomaps world build. You can add more areas later on the Maps page.</p>
      <div class="choices">
        <label class="choice"><input type="radio" name="map" value="world" ${sel.map === 'world' ? 'checked' : ''}>
          <span><strong>${esc(data.maps.world.title)}</strong><br>${esc(data.maps.world.note)}<br><span class="muted">${estimateText('world')}</span></span></label>
        <label class="choice"><input type="radio" name="map" value="region" ${sel.map === 'region' ? 'checked' : ''}>
          <span><strong>An area in detail</strong><br>Enter its edges in degrees (west and south are negative in the Americas and southern hemisphere).
          <span class="grid4">${['w', 's', 'e', 'n']
            .map((k) => `<input data-edge="${k}" inputmode="decimal" placeholder="${{ w: 'West', s: 'South', e: 'East', n: 'North' }[k]}" aria-label="${{ w: 'West', s: 'South', e: 'East', n: 'North' }[k]} edge" value="${esc(r[k])}">`)
            .join('')}</span>
          <select data-detail aria-label="Detail">${DETAIL.map((d) => `<option value="${d.zoom}" ${r.maxzoom === d.zoom ? 'selected' : ''}>${d.label}</option>`).join('')}</select>
          <span class="row" style="margin-top:8px"><button class="btn small" type="button" id="estimate">Estimate size</button><span class="muted">${estimateText('region')}</span></span>
          <span class="muted" style="font-size:13px;display:block;margin-top:6px">Not sure of the numbers? Take the world overview now, zoom to your area on the Maps page, and use “Use what the map shows now”.</span></span></label>
        <label class="choice"><input type="radio" name="map" value="none" ${sel.map === 'none' ? 'checked' : ''}><span><strong>No map for now</strong></span></label>
      </div>`;
  }

  function stepModels() {
    if (!data.canPullModels) return `<p class="note-box">Your AI server manages its own models, so there is nothing to download here.</p>`;
    return `<p class="muted">Models run on this Mac through Ollama. The checked ones are a good start.</p>
      <div class="choices">${data.models
        .map(
          (m) => `<label class="choice"><input type="checkbox" data-model="${esc(m.name)}" ${m.installed ? 'checked disabled' : sel.models.has(m.name) ? 'checked' : ''}>
          <span><strong>${esc(m.name)}</strong> <span class="muted">${m.installed ? 'installed' : fmtBytes(m.size)}</span><br>${esc(m.note)}</span></label>`,
        )
        .join('')}</div>`;
  }

  function stepReview() {
    const b = books();
    const m = models();
    const mb = mapBytes();
    const t = total();
    const tooBig = t > data.free;
    const lines = [
      ...b.map((x) => [x.choice ? `Wikipedia: ${x.choice}` : x.note, x.size ?? 0]),
      ...(sel.map === 'none' ? [] : [[sel.map === 'world' ? data.maps.world.title : `Map area (${sel.region.name})`, mb]]),
      ...m.map((x) => [`AI model ${x.name}`, x.size]),
    ];
    if (!lines.length) return `<p class="muted">Nothing chosen yet. Go back and pick something, or skip setup.</p>`;
    return `<ul class="rows review">${lines.map(([name, size]) => `<li><span>${esc(name)}</span><span class="muted">${size === null ? 'size unknown' : fmtBytes(size)}</span></li>`).join('')}
        <li><strong>Total</strong><strong>${fmtBytes(t)}${mb === null && sel.map !== 'none' ? ' + map' : ''}</strong></li></ul>
      <p class="${tooBig ? 'note-box' : 'muted'}">${tooBig ? `<span class="error-text">That is more than the ${fmtBytes(data.free)} free on this disk.</span> Go back and choose less, or free up space first.` : `${fmtBytes(data.free)} free on this disk. Large downloads can take hours; they resume if interrupted.`}</p>`;
  }

  function stepAccount() {
    if (account.done) return `<p class="note-box">Account <strong>${esc(account.done)}</strong> is ready, and you are signed in with it.</p>`;
    return `<p class="muted">Make the first account. It is the admin: it can add people, change settings and download things. You sign in with it from now on.</p>
      <form id="account" style="display:grid;gap:12px;margin:0 0 14px">
        <div><label for="uname">Name</label><input id="uname" required maxlength="32" autocapitalize="none" spellcheck="false" autocomplete="username" placeholder="e.g. sam" value="${esc(account.name)}"></div>
        <div><label for="upass">Password</label><input id="upass" type="password" required minlength="8" autocomplete="new-password" placeholder="8 characters or more"></div>
        <p class="muted" style="font-size:13px">Use letters a–z, digits, “-” or “_” for the name. Write the password down somewhere safe: nobody can look it up later.</p>
      </form>`;
  }

  function stepWifi() {
    return `<p class="muted">Outpost can stay on this Mac only, or let phones, tablets and other computers on your Wi-Fi use it too. Everyone has to sign in with an account you made.</p>
      <div class="choices">
        <label class="choice"><input type="radio" name="share" value="" ${share ? '' : 'checked'}><span><strong>Only this Mac</strong><br>The most private choice. You can change it later.</span></label>
        <label class="choice"><input type="radio" name="share" value="on" ${share ? 'checked' : ''}><span><strong>This Mac and devices on my Wi-Fi</strong><br>Outpost restarts once to switch this on (a few seconds). Afterwards, open <strong>/join</strong> on a phone to set it up.</span></label>
      </div>`;
  }

  // Account and Wi-Fi come first, so the restart for sharing happens before any download starts.
  const steps = [
    ...(users?.mode === 'open' ? [{ name: 'Account', view: stepAccount }] : []),
    ...(users && !data.shared ? [{ name: 'Wi-Fi', view: stepWifi }] : []),
    { name: 'Books', view: stepBooks },
    { name: 'Map', view: stepMap },
    { name: 'AI models', view: stepModels },
    { name: 'Review', view: stepReview },
  ];
  const at = (name) => steps[step]?.name === name;

  /** Creates the admin account and signs in with it. */
  async function makeAccount() {
    const form = $('#account', body);
    if (!form.reportValidity()) return false;
    const name = $('#uname', form).value.trim();
    const password = $('#upass', form).value;
    account.name = name;
    await api('/users', jsonBody({ name, password, role: 'admin' }));
    await api('/auth/login', jsonBody({ name, password }));
    account.done = name;
    return true;
  }

  /** Turns on Wi-Fi sharing and waits for Outpost to come back after its restart. */
  async function shareOnWifi() {
    const r = await api('/setup/share', jsonBody({ on: true }));
    data.shared = true;
    if (!r.restarting) {
      toast('Saved. Quit and start Outpost again to share it on Wi-Fi.');
      return;
    }
    await new Promise((ok) => setTimeout(ok, 2000));
    for (let i = 0; i < 60; i++) {
      if (await fetch('/healthz').then((x) => x.ok, () => false)) break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    toast('Outpost is now shared on your Wi-Fi.');
  }

  function paint() {
    const view = steps[step].view();
    const last = step === steps.length - 1;
    const blocked = last && (total() === 0 && sel.map === 'none' ? true : total() > data.free || (sel.map !== 'none' && mapBytes() === null));
    body.innerHTML = `<ol class="steps">${steps.map((s, i) => `<li ${i === step ? 'aria-current="step"' : ''}>${i + 1}. ${s.name}</li>`).join('')}</ol>
      <section class="wizard">${view}</section>
      <div class="row wizard-nav">
        ${step > 0 ? '<button class="btn" type="button" id="back">Back</button>' : ''}
        ${last ? `<button class="btn primary" type="button" id="start" ${blocked ? 'disabled' : ''}>Start downloads</button>` : '<button class="btn primary" type="button" id="next">Next</button>'}
        <button class="btn" type="button" id="skip" style="margin-left:auto">Skip setup</button>
      </div>`;
  }

  body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'wiki' || t.name?.startsWith('topic-')) {
      if (t.name === 'wiki') sel.wikipedia = t.value || null;
      else if (t.value) sel.topics.set(t.name.slice(6), t.value);
      else sel.topics.delete(t.name.slice(6));
      paint();
      // Keep the keyboard where it was after redrawing.
      body.querySelector(`input[name="${CSS.escape(t.name)}"][value="${CSS.escape(t.value)}"]`)?.focus();
      return;
    }
    if (t.name === 'share') share = t.value === 'on';
    if (t.dataset.model) t.checked ? sel.models.add(t.dataset.model) : sel.models.delete(t.dataset.model);
    if (t.name === 'map') {
      sel.map = t.value;
      if (sel.map === 'world' && estimates.world === null) estimate('world');
      else paint();
    }
    if (t.dataset.detail !== undefined) {
      sel.region.maxzoom = Number(t.value);
      estimates.region = null;
      paint();
    }
  });
  // Enter in the account form means Next (a form with two fields and no submit button never submits by itself).
  body.addEventListener('submit', (e) => e.preventDefault());
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.closest('#account')) return;
    e.preventDefault();
    $('#next', body)?.click();
  });
  body.addEventListener('input', (e) => {
    if (e.target.dataset.edge) {
      sel.region[e.target.dataset.edge] = e.target.value.trim();
      estimates.region = null;
    }
  });
  body.addEventListener('click', async (e) => {
    const id = e.target.id;
    if (id === 'skip') return skip();
    if (id === 'back') step--;
    if (id === 'next') {
      const btn = e.target;
      try {
        if (at('Account') && !account.done) {
          btn.disabled = true;
          if (!(await makeAccount())) return (btn.disabled = false);
        }
        if (at('Wi-Fi') && share && !data.shared) {
          btn.disabled = true;
          btn.textContent = 'Restarting Outpost…';
          await shareOnWifi();
        }
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Next';
        return;
      }
      step++;
      if (at('Map') && sel.map === 'world' && estimates.world === null) return estimate('world');
    }
    if (id === 'estimate') {
      sel.map = 'region';
      return estimate('region');
    }
    if (id === 'start') {
      e.target.disabled = true;
      e.target.textContent = 'Starting…';
      const map = sel.map === 'none' ? null : sel.map === 'world' ? { preset: 'world' } : { bbox: ['w', 's', 'e', 'n'].map((k) => Number(sel.region[k])), maxzoom: sel.region.maxzoom, name: sel.region.name };
      try {
        const r = await api('/setup/start', jsonBody({ topics: Object.fromEntries(sel.topics), wikipedia: sel.wikipedia, map, models: [...sel.models] }));
        toast(`${r.jobs.length} download${r.jobs.length === 1 ? '' : 's'} started. Follow them under Transfers.`);
        openTray();
        location.hash = '#home';
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
        e.target.textContent = 'Start downloads';
      }
      return;
    }
    if (['back', 'next'].includes(id)) paint();
  });

  paint();
}
