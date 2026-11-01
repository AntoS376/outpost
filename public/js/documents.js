import { $, api, esc, fmtBytes, fmtDate, onJobs, openTray, store, toast } from './core.js';

const ACCEPT = '.pdf,.txt,.md,.markdown,.csv,.tsv,.json,.log,.html,.htm,.xml,.yaml,.yml';
const kind = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'text').toUpperCase();

/** Documents: the files the assistant can answer from. Everyone signed in can see them; admins add and remove. */
export async function viewDocuments(root, sub) {
  // Preparedness has its own page now; old links still land there.
  if (sub === 'ready') {
    location.replace('#ready');
    return;
  }
  root.innerHTML = `<div class="titlebar"><div><h1>Documents</h1>
      <p class="lead">Your own files, for the assistant to answer from: manuals, plans, first-aid guides, notes. They're read and indexed on this Mac and never leave it.</p></div>
      <a class="btn primary" href="#ai" id="askdocs">Ask the assistant about these</a></div>
    <div id="docs"><p class="muted">Loading…</p></div>`;
  const box = $('#docs', root);
  let data = null;
  let models = null;
  let reindexJob = null;

  async function load() {
    [data, models] = await Promise.all([api('/ai/docs'), api('/ai/models').catch(() => null)]);
  }

  function paint() {
    const { docs, index, embedModel } = data;
    const tagged = (n) => (n.includes(':') ? n : `${n}:latest`);
    const embedReady = models?.models?.some((m) => tagged(m.name) === tagged(embedModel));
    const ollama = models?.canManageModels;
    const reachable = models?.reachable;
    const rows = docs
      .slice()
      .sort((a, b) => b.added - a.added)
      .map(
        (d) => `<li class="card doc">
          <span class="doctype">${esc(kind(d.name))}</span>
          <div class="grow"><strong>${esc(d.name)}</strong>
            <span>${d.chunks.toLocaleString()} part${d.chunks === 1 ? '' : 's'} · ${(d.chars / 1000).toFixed(d.chars < 10_000 ? 1 : 0)}k characters · added ${fmtDate(d.added)}</span></div>
          <span class="pill ${d.current ? 'ok' : 'warn'}"><i aria-hidden="true"></i>${d.current ? 'Indexed' : 'Needs re-index'}</span>
          <button class="btn small danger admin-only" type="button" data-rm="${esc(d.id)}" data-name="${esc(d.name)}">Remove</button></li>`,
      )
      .join('');
    const pct = index.maxChunks ? Math.min(100, (index.chunks / index.maxChunks) * 100) : 0;
    box.innerHTML = `
      <section class="card dropzone admin-only" id="drop">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>
        <div><strong>Add documents</strong><span>Drop files here, or <label for="docfile" class="linklabel">choose files</label>. PDF, text, Markdown, CSV, JSON or HTML.</span></div>
        <input id="docfile" type="file" multiple accept="${ACCEPT}" hidden>
        <div id="docstat" class="muted"></div>
      </section>
      ${embedReady === false
        ? ollama
          ? `<p class="note-box admin-only">Searching documents needs the <code>${esc(embedModel)}</code> model. <button class="btn small" type="button" id="getembed" ${reachable ? '' : 'disabled'}>Download it</button></p>`
          : `<p class="note-box">Searching documents needs the embedding model <code>${esc(embedModel)}</code>. Load it in your AI server, or set <code>OUTPOST_EMBED_MODEL</code> to one it has.</p>`
        : ''}
      ${index.stale ? `<p class="note-box admin-only">${index.stale === 1 ? '1 document was' : `${index.stale} documents were`} indexed with another model or an older format. Re-index so searches use <code>${esc(embedModel)}</code>; until then they're searched the old way. <button class="btn small" type="button" id="reindex" ${reachable ? '' : 'disabled'}>Re-index</button></p>` : ''}
      <div class="ptitle docshead"><h2>${docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : 'No documents yet'}</h2>
        <span class="kicker">Index ${index.chunks.toLocaleString()} of ${index.maxChunks.toLocaleString()} parts · ${fmtBytes(index.bytes)}</span></div>
      <div class="bar" title="Document index use"><i style="width:${pct}%"></i></div>
      ${docs.length ? `<ul class="doclist">${rows}</ul>` : `<p class="muted" style="margin-top:14px">Add a file above, then ask the assistant about it with “Answer from my documents” turned on.</p>`}
      <p class="muted small" style="margin-top:16px">Everyone who can sign in to this Outpost can ask the assistant about these documents, so its answers may quote them. Only admins can add or remove them.</p>`;
  }

  async function refresh() {
    await load();
    paint();
  }

  async function addFiles(files) {
    const stat = $('#docstat', root);
    for (const file of files) {
      stat.textContent = `Reading ${file.name}…`;
      try {
        // PDFs go up as raw bytes and are read on the server; everything else is read as text here.
        const pdf = file.name.toLowerCase().endsWith('.pdf');
        await api(`/ai/docs?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': pdf ? 'application/pdf' : 'text/plain' }, body: pdf ? file : await file.text() });
        toast(`${file.name} added`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    await refresh();
  }

  box.addEventListener('change', (e) => {
    if (e.target.id === 'docfile' && e.target.files.length) addFiles([...e.target.files]);
  });
  box.addEventListener('dragover', (e) => {
    const drop = e.target.closest('#drop');
    if (!drop) return;
    e.preventDefault();
    drop.classList.add('over');
  });
  box.addEventListener('dragleave', (e) => e.target.closest('#drop')?.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    const drop = e.target.closest('#drop');
    if (!drop) return;
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  });
  box.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    try {
      if (rm && confirm(`Remove ${rm.dataset.name}? The assistant won't be able to answer from it any more.`)) {
        await api(`/ai/docs/${encodeURIComponent(rm.dataset.rm)}`, { method: 'DELETE' });
        await refresh();
      }
      if (e.target.id === 'reindex') {
        reindexJob = (await api('/ai/docs/reindex', { method: 'POST' })).job.id;
        toast('Re-indexing started. Follow it under Transfers.');
        openTray();
      }
      if (e.target.id === 'getembed') {
        e.target.disabled = true;
        e.target.textContent = 'Downloading…';
        const res = await fetch('/api/ai/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: data.embedModel }) });
        await res.text();
        await refresh();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  // "Ask the assistant about these" turns on answering from documents.
  $('#askdocs', root).addEventListener('click', () => store.set('outpost.useDocs', true));

  // A re-index finishing elsewhere (Transfers) refreshes the list.
  const off = onJobs((jobs, finished) => {
    if (finished.some((j) => j.kind === 'reindex') || (reindexJob && jobs.some((j) => j.id === reindexJob && j.status !== 'running'))) {
      reindexJob = null;
      refresh().catch(() => undefined);
    }
  });

  try {
    await refresh();
  } catch (err) {
    box.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
  return () => off();
}
