import { $, api, esc, fmtBytes, jsonBody, store } from './core.js';

const GROUPS = [
  ['', 'All'],
  ['plans', 'Action plans'],
  ['hazards', 'Hazards'],
  ['specialized', 'Specialized guides'],
  ['business', 'Business'],
  ['youth', 'Youth'],
];

// The Ready.gov basic disaster supplies kit.
const BASIC_KIT = [
  ['water', 'Water', 'One gallon per person per day, for several days'],
  ['food', 'Food', 'At least a several-day supply of non-perishable food'],
  ['radio', 'Battery or hand-crank radio', 'Plus a NOAA Weather Radio with tone alert'],
  ['flashlight', 'Flashlight', ''],
  ['firstaid', 'First aid kit', ''],
  ['batteries', 'Extra batteries', ''],
  ['whistle', 'Whistle', 'To signal for help'],
  ['mask', 'Dust mask, plastic sheeting and duct tape', 'To filter air and shelter in place'],
  ['sanitation', 'Moist towelettes, garbage bags and plastic ties', 'For personal sanitation'],
  ['wrench', 'Wrench or pliers', 'To turn off utilities'],
  ['opener', 'Manual can opener', 'For food'],
  ['maps', 'Local maps', ''],
  ['phone', 'Cell phone with chargers and a backup battery', ''],
];

const KIT_KEY = 'outpost.readyKit';
export const back = '<a class="btn small" href="#home">← Home</a>';

/** Preparedness: Ready.gov guides kept on this Mac, plus the basic supply kit checklist. */
export async function viewReady(root) {
  root.innerHTML = `<div class="titlebar"><div>${back}
      <p class="kicker">Field manual · Ready.gov</p><h1>Preparedness guides</h1>
      <p class="lead">Plans, hazard guides and checklists from Ready.gov. Download them once and they work without the internet.</p></div></div>
    <div class="prep">
      <section class="card prep-kit" id="kit"></section>
      <div class="prep-tools">
        <div class="prep-pills" role="group" aria-label="Show"></div>
        <input type="search" id="rq" placeholder="Search guides" aria-label="Search guides" autocomplete="off">
        <button class="btn small primary" type="button" id="rall" hidden></button>
      </div>
      <p class="muted small" id="rstatus" role="status"></p>
      <div id="rlist"><p class="muted">Loading…</p></div>
    </div>`;
  paintKit($('#kit', root));

  const list = $('#rlist', root);
  const pills = $('.prep-pills', root);
  const q = $('#rq', root);
  const all = $('#rall', root);
  const status = $('#rstatus', root);
  let data;
  try {
    data = await api('/ready');
  } catch (e) {
    list.innerHTML = `<p class="note-box">${esc(e.message)}</p>`;
    return;
  }
  if (!data.items.length) {
    pills.hidden = true;
    q.hidden = true;
    list.innerHTML = `<p class="note-box">The preparedness catalog lists no guides.</p>`;
    return;
  }
  let group = '';
  let polling = false;

  const missing = () => data.items.filter((it) => !it.have && !it.downloading && it.download && it.file);

  function paintTools() {
    const n = missing().length;
    const busy = data.items.filter((it) => it.downloading).length;
    const have = data.items.filter((it) => it.have).length;
    all.hidden = !n;
    all.textContent = `Download all missing (${n})`;
    status.textContent = busy
      ? `Downloading ${busy} guide${busy === 1 ? '' : 's'}… Progress also shows under Transfers.`
      : `${have} of ${data.items.length} guides on this Mac.`;
  }

  async function reload() {
    try {
      data = await api('/ready');
    } catch {
      return;
    }
    paint();
  }

  // Check every two seconds until nothing is downloading, then show the final list.
  async function watch() {
    if (polling) return;
    polling = true;
    while (root.isConnected) {
      await new Promise((r) => setTimeout(r, 2000));
      await reload();
      if (!data.items.some((it) => it.downloading)) break;
    }
    polling = false;
  }

  async function pull(body) {
    try {
      await api('/ready/pull', jsonBody(body));
    } catch (e) {
      status.textContent = e.message;
      return;
    }
    await reload();
    watch();
  }

  function matches(it, g) {
    if (g && it.group !== g) return false;
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${it.title} ${it.description} ${it.tags.join(' ')} ${it.category}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  function paint() {
    paintTools();
    pills.innerHTML = GROUPS.map(([g, label]) => {
      const n = data.items.filter((it) => matches(it, g)).length;
      return `<button type="button" class="rpill" data-g="${esc(g)}" aria-pressed="${g === group}">${esc(label)} <span>${n}</span></button>`;
    }).join('');
    const shown = data.items.filter((it) => matches(it, group));
    if (!shown.length) {
      list.innerHTML = `<p class="muted">Nothing matches. Try another word or filter.</p>`;
      return;
    }
    const byCat = new Map();
    for (const it of shown) byCat.set(it.category, [...(byCat.get(it.category) ?? []), it]);
    list.innerHTML = [...byCat]
      .map(([cat, items]) => `<section class="prep-cat"><div class="ptitle"><h2>${esc(cat)}</h2><span class="kicker">${items.length} item${items.length === 1 ? '' : 's'}</span></div>
        <ul class="prep-grid">${items.map(card).join('')}</ul></section>`)
      .join('');
  }

  function card(it) {
    const href = it.file ? `/api/ready/file/${encodeURIComponent(it.file)}` : '';
    const actions = it.have
      ? `<a class="btn small primary" href="${esc(href)}" target="_blank" rel="noopener">Open</a>
         <a class="btn small" href="${esc(href)}?download=1" download="${esc(it.file)}">Download</a>
         <span class="rmeta">PDF · ${esc(fmtBytes(it.size))}</span>`
      : it.downloading
        ? `<span class="rbadge">Downloading…</span>`
        : it.download && it.file
          ? `<button class="btn small primary" type="button" data-pull="${esc(it.id)}">Download to this Mac</button>
             <span class="rbadge missing">Not on this Mac yet</span>`
          : `<span class="rbadge missing">${it.file ? 'Not downloaded yet' : 'No PDF listed'}</span>`;
    return `<li class="prep-card">
      <div class="rtags"><span class="rbadge cat">${esc(it.category)}</span>${it.tags.slice(0, 4).map((t) => `<span class="rbadge">${esc(t)}</span>`).join('')}</div>
      <h3>${esc(it.title)}</h3>
      ${it.description ? `<p>${esc(it.description)}</p>` : ''}
      ${it.source ? `<p class="rsrc">${esc(it.source)}</p>` : ''}
      <div class="ractions">${actions}</div></li>`;
  }

  pills.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    group = b.dataset.g;
    paint();
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pull]');
    if (!b) return;
    b.disabled = true;
    pull({ ids: [b.dataset.pull] });
  });
  all.addEventListener('click', () => {
    all.disabled = true;
    pull({ all: true }).finally(() => (all.disabled = false));
  });
  q.addEventListener('input', paint);
  paint();
  if (data.items.some((it) => it.downloading)) watch();
}

function paintKit(box) {
  const ticks = store.get(KIT_KEY, {}) ?? {};
  const ready = BASIC_KIT.filter(([id]) => ticks[id]).length;
  box.innerHTML = `<div class="ptitle"><h2>Basic supply kit</h2>
      <span class="kicker" id="kitcount">${ready} of ${BASIC_KIT.length} ready</span></div>
    <div class="bar" title="Kit ready"><i style="width:${(ready / BASIC_KIT.length) * 100}%"></i></div>
    <ul class="kitlist">${BASIC_KIT.map(([id, label, hint]) => `<li><label>
      <input type="checkbox" data-kit="${esc(id)}" ${ticks[id] ? 'checked' : ''}>
      <span><strong>${esc(label)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label></li>`).join('')}</ul>
    <button class="btn small" type="button" id="kitreset" ${ready ? '' : 'disabled'}>Clear all ticks</button>
    <p class="muted small">Ticks are saved in this browser only.</p>`;
  box.onchange = (e) => {
    const id = e.target.dataset?.kit;
    if (!id) return;
    const now = store.get(KIT_KEY, {}) ?? {};
    if (e.target.checked) now[id] = true;
    else delete now[id];
    store.set(KIT_KEY, now);
    paintKit(box);
    $(`[data-kit="${id}"]`, box)?.focus();
  };
  box.onclick = (e) => {
    if (e.target.id !== 'kitreset') return;
    store.set(KIT_KEY, {});
    paintKit(box);
  };
}
