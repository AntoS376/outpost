import { $, api, esc, fmtBytes, jsonBody } from './core.js';
import { kitsView } from './emergency-kit.js';

const GROUPS = [
  ['', 'All'],
  ['plans', 'Action plans'],
  ['hazards', 'Hazards'],
  ['specialized', 'Specialized guides'],
  ['business', 'Business'],
  ['youth', 'Youth'],
];

// The Ready.gov basic disaster supplies kit.
/** Preparedness: your emergency kits, and Ready.gov guides kept on this Mac. */
export async function viewReady(root) {
  root.innerHTML = `<div class="titlebar"><div><h1>Preparedness</h1>
      <p class="lead">Your emergency kits, and plans, hazard guides and checklists from Ready.gov. Download the guides once and they work without the internet.</p></div></div>
    <div class="prep">
      <div id="kit"></div>
      <h2 class="prep-guides">Ready.gov guides</h2>
      <div class="prep-tools">
        <div class="prep-pills" role="group" aria-label="Show"></div>
        <input type="search" id="rq" placeholder="Search guides" aria-label="Search guides" autocomplete="off">
        <button class="btn small primary" type="button" id="rall" hidden></button>
      </div>
      <p class="muted small" id="rstatus" role="status"></p>
      <div id="rlist"><p class="muted">Loading…</p></div>
    </div>`;
  const kit = $('#kit', root);
  kitsView(kit).catch((err) => (kit.innerHTML = `<p class="note-box">${esc(err.message)}</p>`));

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
