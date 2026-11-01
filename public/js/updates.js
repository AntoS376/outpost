import { $, api, esc, fmtBytes, jsonBody, openTray, toast } from './core.js';

const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Opt-in update checks: what's newer, with a download button each. Nothing installs or deletes by itself. */
export async function viewUpdates(root) {
  root.innerHTML = `<h1>Updates</h1>
    <p class="lead">Outpost can look for newer versions of itself, your books and your AI models once a day. It only tells you; you choose what to download, and nothing is replaced or deleted.</p>
    <div id="upd"><p class="muted">Loading…</p></div>`;
  const box = $('#upd', root);
  let s;

  async function load() {
    s = await api('/updates');
  }

  function results() {
    const r = s.results;
    if (!r) return s.enabled ? `<p class="muted">${s.checking ? 'Checking…' : 'No check yet.'}</p>` : '';
    const o = r.outpost;
    const any = (o?.newer ? 1 : 0) + r.books.length + r.models.length;
    return `<p class="muted">Last checked ${when(r.checked)}. ${any ? `${any} update${any === 1 ? '' : 's'} available.` : 'Everything is up to date.'}</p>
      ${o ? `<section class="block"><h2>Outpost</h2><p>${o.newer ? `Version <strong>${esc(o.latest)}</strong> is out; you have ${esc(o.current)}. <a class="btn small" href="${esc(o.url)}" target="_blank" rel="noopener">See the release</a>` : `You have the latest version (${esc(o.current)}).`}</p>
        ${o.newer ? '<p class="muted" style="font-size:13px">To update, follow the release notes; Outpost never updates itself.</p>' : ''}</section>` : ''}
      ${r.books.length ? `<section class="block"><h2>Books</h2><ul class="rows">${r.books.map((b) => `<li><div class="grow"><strong>${esc(b.title)}</strong>
          <span>${esc(b.file)} → ${esc(b.newFile)}${b.size ? ` · ${fmtBytes(b.size)}` : ''}</span></div>
          <button class="btn small primary admin-only" type="button" data-book="${esc(b.file)}">Download</button></li>`).join('')}</ul>
        <p class="muted" style="font-size:13px">The new edition downloads next to the old one. Remove the old one in Library → Manage when you're happy.</p></section>` : ''}
      ${r.models.length ? `<section class="block"><h2>AI models</h2><ul class="rows">${r.models.map((m) => `<li><div class="grow"><strong>${esc(m.name)}</strong><span>A newer version is in Ollama's library.</span></div>
          <button class="btn small primary admin-only" type="button" data-model="${esc(m.name)}">Download</button></li>`).join('')}</ul></section>` : ''}
      ${r.notes.length ? `<p class="note-box">${r.notes.map(esc).join('<br>')}</p>` : ''}`;
  }

  function render() {
    box.innerHTML = `<section class="block" style="border-top:0;padding-top:0">
        <label class="check admin-only"><input type="checkbox" id="enabled" ${s.enabled ? 'checked' : ''}><span>Check for updates once a day</span></label>
        <p class="muted" style="max-width:70ch;margin-top:8px">${s.enabled ? 'On.' : 'Off: Outpost contacts nothing.'} When on, it asks ${s.repo ? `GitHub (releases of <code>${esc(s.repo)}</code>), ` : ''}the Kiwix catalog and Ollama's model library. It sends no account, name or identifier.</p>
        ${s.enabled ? `<p><button class="btn admin-only" type="button" id="check" ${s.checking ? 'disabled' : ''}>${s.checking ? 'Checking…' : 'Check now'}</button></p>` : ''}
      </section>${results()}`;
  }

  box.addEventListener('change', async (e) => {
    if (e.target.id !== 'enabled') return;
    try {
      s = await api('/updates', jsonBody({ enabled: e.target.checked }, 'PUT'));
      render();
      if (s.enabled) poll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  box.addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.id === 'check') {
        t.disabled = true;
        t.textContent = 'Checking…';
        await api('/updates/check', { method: 'POST' });
        await load();
        render();
      }
      if (t.dataset.book || t.dataset.model) {
        await api('/updates/download', jsonBody(t.dataset.book ? { kind: 'book', file: t.dataset.book } : { kind: 'model', name: t.dataset.model }));
        toast('Download started. Follow it under Transfers.');
        openTray();
        t.disabled = true;
      }
    } catch (err) {
      toast(err.message, 'error');
      await load();
      render();
    }
  });

  let timer = null;
  function poll() {
    clearInterval(timer);
    timer = setInterval(async () => {
      await load();
      render();
      if (!s.checking) clearInterval(timer);
    }, 1500);
  }

  await load();
  render();
  if (s.checking) poll();
  return () => clearInterval(timer);
}
