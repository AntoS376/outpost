import { $, api, esc, fmtBytes, fmtDate, getJobs, jsonBody, onJobs, openTray, toast, contentBase } from './core.js';

// Used until the catalog's own language list loads (or if it can't).
const LANGS = [['eng', 'English'], ['fra', 'français'], ['ara', 'العربية'], ['spa', 'español'], ['deu', 'Deutsch'], ['por', 'português'], ['rus', 'русский'], ['zho', '中文']];
const SIZES = [['', 'Any size'], [100e6, 'Under 100 MB'], [1e9, 'Under 1 GB'], [5e9, 'Under 5 GB'], [20e9, 'Under 20 GB']];
const FLAVOURS = { nopic: 'No pictures', maxi: 'Full', mini: 'Introductions only' };
const catName = (c) => c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** Bytes still to come for downloads that are running or waiting. */
const pendingBytes = () =>
  getJobs()
    .filter((j) => j.kind === 'download' && (j.status === 'running' || j.status === 'queued'))
    .reduce((n, j) => n + (j.total ? Math.max(0, j.total - j.received) : 0), 0);

export async function viewLibrary(root, sub) {
  const manage = sub === 'manage';
  root.innerHTML = `<div class="titlebar"><div><h1>Library</h1>
    <p class="lead">${manage ? 'Add or remove the books stored on this Mac.' : 'Wikipedia and other references, readable with no connection.'}</p></div>
    <div class="seg"><a href="#library" ${manage ? '' : 'aria-current="page"'}>Read</a><a class="admin-only" href="#library/manage" ${manage ? 'aria-current="page"' : ''}>Manage</a></div></div>
    <div id="lib-body" class="${manage ? '' : 'frame-host'}"></div>`;
  const body = $('#lib-body', root);
  return manage ? manageView(body) : readView(body, root);
}

async function readView(body, root) {
  body.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
  const lib = await api('/library');
  if (lib.kiwix.state === 'running' || lib.kiwix.state === 'starting') {
    const reader = `${await contentBase()}/kiwix/`;
    body.innerHTML = `<div class="frame"><iframe src="${esc(reader)}" title="Offline library"></iframe></div>
      <p class="muted" style="margin:8px 0 0">Page not loading? <a href="${esc(reader)}" target="_blank" rel="noopener">Open the library in its own tab</a>.</p>`;
    return;
  }
  const noBinary = lib.kiwix.reason === 'no-binary';
  body.innerHTML = `<div class="empty"><h2>${noBinary ? 'The reader needs one more tool' : 'Nothing to read yet'}</h2>
    <p class="muted">${noBinary ? `You have ${lib.files.length} book${lib.files.length === 1 ? '' : 's'}, but <code>kiwix-serve</code> isn't installed. Run <code>./scripts/setup-mac.sh</code> in Terminal to install it, then restart Outpost.` : 'Download a book such as Wikipedia and the reader starts on its own.'}</p>
    <a class="btn primary admin-only" href="#library/manage">Add books</a></div>`;
}

async function manageView(body) {
  let results = [];
  let free = null;
  let nextStart = null;
  let total = 0;
  let loading = false;
  let searchId = 0; // only the newest search may paint, however the responses arrive
  let langs = LANGS.map(([code, name]) => ({ code, name, count: null }));
  let cats = [];
  const filter = { q: '', lang: 'eng', category: '', maxSize: '' };

  async function render() {
    const [lib, st] = await Promise.all([api('/library'), api('/status')]);
    free = st.storage.free;
    body.innerHTML = `
      <section class="block"><h2>Installed</h2>
        ${lib.files.length
          ? `<ul class="rows">${lib.files.map((f) => `<li><div class="grow"><strong>${esc(f.name)}</strong><span>${fmtBytes(f.size)}, added ${fmtDate(f.mtime)}</span></div>
              <button class="btn small danger" type="button" data-del="${esc(f.name)}">Remove</button></li>`).join('')}</ul>`
          : `<p class="muted">Nothing installed yet.</p>`}
        ${free != null ? `<p class="muted" style="margin-top:10px">${fmtBytes(free)} free on this disk.</p>` : ''}
      </section>
      <section class="block"><h2>Find books</h2>
        <form id="search" class="row filters"><div class="grow"><label for="q">Search the Kiwix catalog</label><input id="q" type="search" placeholder="wikipedia, medicine, gutenberg" value="${esc(filter.q)}"></div>
          <div><label for="lang">Language</label><select id="lang"><option value="">Any language</option>${langs.map((l) => `<option value="${esc(l.code)}" ${l.code === filter.lang ? 'selected' : ''}>${esc(l.name)}${l.count ? ` (${l.count})` : ''}</option>`).join('')}</select></div>
          <div><label for="category">Kind</label><select id="category"><option value="">Everything</option>${cats.map((c) => `<option value="${esc(c)}" ${c === filter.category ? 'selected' : ''}>${esc(catName(c))}</option>`).join('')}</select></div>
          <div><label for="maxsize">Size</label><select id="maxsize">${SIZES.map(([v, n]) => `<option value="${v}" ${String(v) === String(filter.maxSize) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <button class="btn primary" type="submit">Search</button></form>
        <div id="results"></div>
        <p class="muted" style="margin-top:10px">Searching needs an internet connection. Downloads can take a long time; they resume if interrupted.</p>
      </section>
      <section class="block"><h2>Add by link</h2>
        <form id="link" class="row"><div class="grow"><label for="url">Direct link to a .zim file</label><input id="url" type="url" required placeholder="https://download.kiwix.org/zim/…"></div>
          <button class="btn" type="submit">Download</button></form></section>
      <section class="block"><h2>Add from this Mac</h2>
        <p class="muted">Already downloaded a .zim file? Copy it in without leaving the page.</p>
        <input id="file" type="file" accept=".zim" style="max-width:380px"><div id="up" class="bar" hidden style="margin-top:10px"><i style="width:0"></i></div>
      </section>`;
    paintResults();
  }

  function paintResults(message) {
    const box = $('#results', body);
    if (!box) return;
    if (message || !results.length) {
      box.innerHTML = `<p class="muted" style="margin-top:12px">${message ?? (loading ? 'Searching…' : 'No books matched. Try fewer words, another language or a larger size.')}</p>`;
      return;
    }
    box.innerHTML = `<p class="muted" style="margin:12px 0 0;font-size:13px">${total.toLocaleString()} book${total === 1 ? '' : 's'} in the catalog match${filter.maxSize ? ' (before the size filter)' : ''}. ${free != null ? `${fmtBytes(free)} free on this disk.` : ''}</p>
      <ul class="rows" style="margin-top:6px">${results.map((e, i) => {
      const tooBig = free != null && e.size != null && e.size > free;
      const meta = [e.size ? fmtBytes(e.size) : 'Size unknown', FLAVOURS[e.flavour], e.language && esc(e.language.split(',').length > 3 ? 'many languages' : e.language), e.category && esc(catName(e.category)), e.articleCount && `${e.articleCount.toLocaleString()} articles`].filter(Boolean).join(' · ');
      const action = e.installed
        ? '<span class="muted">Installed</span>'
        : `<button class="btn small ${e.olderVersion ? '' : 'primary'}" type="button" data-dl="${i}" ${tooBig ? 'disabled' : ''}>${e.olderVersion ? 'Update' : 'Download'}</button>`;
      return `<li><div class="grow"><strong>${esc(e.title)}</strong><span>${esc(String(e.description ?? '').slice(0, 160))}</span>
        <span>${meta}${e.olderVersion ? ` · <span class="ok-text">newer than your ${esc(e.olderVersion)}</span>` : ''}${tooBig && !e.installed ? ' · <span class="error-text">not enough free space</span>' : ''}</span></div>${action}</li>`;
    }).join('')}</ul>
      ${nextStart !== null ? '<p><button class="btn" type="button" id="more">Show more</button></p>' : ''}`;
  }

  async function loadResults(append = false) {
    const mine = append ? searchId : ++searchId;
    loading = true;
    if (!append) paintResults('Searching…');
    const params = new URLSearchParams({ q: filter.q, lang: filter.lang, category: filter.category, maxSize: filter.maxSize, count: '20' });
    if (append && nextStart !== null) params.set('start', String(nextStart));
    try {
      const data = await api(`/library/catalog?${params}`);
      if (mine !== searchId) return;
      results = append ? [...results, ...data.entries] : data.entries;
      nextStart = data.nextStart;
      total = data.total;
      free = data.free;
      loading = false;
      paintResults();
    } catch (err) {
      if (mine !== searchId) return;
      results = [];
      loading = false;
      paintResults(`<span class="error-text">${esc(err.message)}</span>`);
    }
  }

  function readFilters() {
    filter.q = $('#q', body).value.trim();
    filter.lang = $('#lang', body).value;
    filter.category = $('#category', body).value;
    filter.maxSize = $('#maxsize', body).value;
  }

  async function startDownload(url, name) {
    try {
      await api('/jobs/download', jsonBody({ url, kind: 'zim', name }));
      toast(`Downloading ${name || 'file'}. Follow it under Transfers.`);
      openTray();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  body.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    const dl = e.target.closest('[data-dl]');
    if (del) {
      if (!confirm(`Remove ${del.dataset.del} from this Mac? You can download it again later.`)) return;
      try {
        await api(`/library/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
        toast('Removed');
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (dl) {
      const entry = results[Number(dl.dataset.dl)];
      const pending = pendingBytes();
      if (entry.size && free != null && entry.size > free - pending) {
        const ok = confirm(`${entry.title} needs ${fmtBytes(entry.size)}. Your current downloads still need ${fmtBytes(pending)} of the ${fmtBytes(free)} free, so this may not fit. Download anyway?`);
        if (!ok) return;
      }
      startDownload(entry.url, entry.fileName);
    }
    if (e.target.id === 'more') {
      e.target.disabled = true;
      e.target.textContent = 'Loading…';
      loadResults(true);
    }
  });

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'search') {
      readFilters();
      loadResults();
    }
    if (e.target.id === 'link') {
      const url = $('#url', body).value.trim();
      const name = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
      startDownload(url, name);
      $('#url', body).value = '';
    }
  });

  body.addEventListener('change', (e) => {
    if (['lang', 'category', 'maxsize'].includes(e.target.id)) {
      readFilters();
      loadResults();
      return;
    }
    if (e.target.id !== 'file' || !e.target.files[0]) return;
    const file = e.target.files[0];
    const bar = $('#up', body);
    bar.hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/library/upload/${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 200) toast(`${file.name} added`);
      else toast(JSON.parse(xhr.responseText || '{}').error || 'Upload failed', 'error');
      render();
    };
    xhr.onerror = () => toast('Upload failed', 'error');
    xhr.send(file);
  });

  await render();
  loadResults();
  // The catalog's own language and category lists replace the defaults when they arrive.
  api('/library/catalog/filters')
    .then((f) => {
      const byCount = [...f.languages].sort((a, b) => b.count - a.count);
      langs = byCount.length ? byCount : langs;
      cats = f.categories;
      const keepQ = $('#q', body)?.value ?? '';
      filter.q = keepQ;
      render();
    })
    .catch(() => {});
  const off = onJobs((_jobs, finished) => {
    if (finished.some((j) => j.kind === 'download' && j.status === 'done')) render().then(() => loadResults());
  });
  return off;
}
