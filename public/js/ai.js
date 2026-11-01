import { $, api, esc, fmtBytes, jsonBody, onJobs, openTray, store, streamNdjson, toast } from './core.js';
import { md } from './md.js';
import { mountGpuGauge } from './gpu-gauge.js';

export async function viewAi(root) {
  root.innerHTML = `<h1>Assistant</h1>
    <p class="lead" id="ailead">A language model running on this Mac. Questions stay on this machine.</p>
    <div class="chat">
      <section class="gpu" id="gpu" aria-label="GPU"></section>
      <div class="chat-main"><div class="msgs" id="msgs" aria-live="polite"></div>
        <form class="composer" id="composer"><textarea id="prompt" rows="2" placeholder="Ask something. Enter sends, Shift+Enter adds a line." aria-label="Message"></textarea>
        <button class="btn primary" id="send" type="submit">Send</button></form></div>
      <aside class="side" id="side"></aside></div>`;

  let models = [];
  let reachable = false;
  let ollama = true; // only Ollama can download and remove models from here
  let aiUrl = '';
  let embedModel = 'nomic-embed-text';
  let docs = [];
  let index = null; // { chunks, maxChunks, bytes, stale }
  let reindexJob = null; // id of the re-index this page started
  let model = store.get('outpost.model', '');
  let useDocs = store.get('outpost.useDocs', false);
  let messages = store.get('outpost.chat', []);
  let chatId = store.get('outpost.chatId', null); // the saved conversation this one came from, if any
  let saved = [];
  let busy = false;
  let ctrl = null;
  const msgsEl = $('#msgs', root);
  const promptEl = $('#prompt', root);
  const sendBtn = $('#send', root);

  async function loadModels() {
    const data = await api('/ai/models');
    models = data.models;
    reachable = data.reachable;
    ollama = data.canManageModels;
    aiUrl = data.url;
    $('#ailead', root).textContent = ollama
      ? 'A language model running on this Mac through Ollama. Questions stay on this machine.'
      : `A language model on your AI server at ${aiUrl}. Questions go only to that server.`;
    embedModel = data.embedModel;
    const chatModels = models.filter((m) => !m.embedding);
    if (!chatModels.some((m) => m.name === model)) model = chatModels[0]?.name ?? '';
  }
  async function loadSaved() {
    saved = (await api('/chats').catch(() => ({ chats: [] }))).chats;
  }
  async function loadDocs() {
    const data = await api('/ai/docs');
    docs = data.docs;
    index = data.index;
  }

  function paintMessages(scroll = true) {
    if (!messages.length) {
      msgsEl.innerHTML = `<div class="empty"><h2>Ask anything</h2><p class="muted">${
        reachable ? (model ? 'Type below to start. Turn on “Answer from my documents” to ground replies in files you add.' : ollama ? 'Download a model on the right to begin.' : 'Load a chat model in your AI server, then reload this page.') : ollama ? "Ollama isn't running. Open the Ollama app, or run <code>ollama serve</code> in Terminal." : `The AI server at <code>${esc(aiUrl)}</code> isn't answering. Start its local server (for example in LM Studio), then reload.`
      }</p></div>`;
      return;
    }
    msgsEl.innerHTML = messages
      .map((m, i) => {
        const last = i === messages.length - 1 && busy;
        const body = m.role === 'user' ? esc(m.content) : m.error && !m.content ? `<span class="error-text">${esc(m.error)}</span>` : md(m.content) + (m.error ? `<p class="error-text">${esc(m.error)}</p>` : '') + (last && !m.content ? '<span class="muted">Thinking…</span>' : '');
        const src = m.sources?.length ? `<div class="src">From your documents: ${[...new Set(m.sources.map((s) => s.doc))].map(esc).join(', ')}</div>` : '';
        return `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? 'You' : esc(model || 'Assistant')}</div><div class="body">${body}</div>${src}</div>`;
      })
      .join('');
    if (scroll) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function paintSide() {
    const embedReady = models.some((m) => m.name.split(':')[0] === embedModel.split(':')[0]);
    const chatModels = models.filter((m) => !m.embedding);
    $('#side', root).innerHTML = `
      <section><h3>Model</h3>
        ${chatModels.length ? `<select id="model" aria-label="Model">${chatModels.map((m) => `<option ${m.name === model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : `<p class="muted">${!reachable ? (ollama ? 'Ollama is not running.' : 'The AI server is not answering.') : !ollama ? 'No chat model loaded. Load one in your AI server.' : models.length ? 'No chat model yet. Download one below, for example llama3.2:3b.' : 'No models installed.'}</p>`}
        ${ollama ? `<form id="pull" class="admin-only" style="margin-top:10px"><label for="pullname">Download a model</label>
          <div class="row" style="flex-wrap:nowrap"><input id="pullname" placeholder="llama3.2:3b" required><button class="btn" type="submit" ${reachable ? '' : 'disabled'}>Get</button></div></form>
        <div id="pullstat" class="muted" style="margin-top:8px"></div>` : `<p class="muted" style="font-size:13px;margin-top:8px">Models are managed in your AI server.</p>`}
        ${models.length ? `<ul class="mini">${models.map((m) => `<li><span>${esc(m.name)}${m.embedding ? ' <span class="muted">(for documents)</span>' : ''}</span>${ollama ? `<button class="btn small danger admin-only" type="button" data-rm="${esc(m.name)}">Remove</button>` : ''}</li>`).join('')}</ul>` : ''}
      </section>
      <section><h3>My documents <a class="small" href="#documents" style="float:right;font-family:var(--body);letter-spacing:0;text-transform:none;font-weight:500">Manage</a></h3>
        <label class="check"><input type="checkbox" id="usedocs" ${useDocs ? 'checked' : ''}><span>Answer from my documents</span></label>
        <ul class="mini">${docs.length ? docs.map((d) => `<li><span>${esc(d.name)} <span class="muted">(${d.chunks.toLocaleString()} part${d.chunks === 1 ? '' : 's'}${d.current ? '' : ', needs re-indexing'})</span></span><button class="btn small danger admin-only" type="button" data-rmdoc="${d.id}">Remove</button></li>`).join('') : '<li class="muted">None added yet.</li>'}</ul>
        ${index && docs.length ? `<div class="muted" style="font-size:13px;margin-top:10px">Index: ${index.chunks.toLocaleString()} of ${index.maxChunks.toLocaleString()} parts · ${fmtBytes(index.bytes)}</div>
          <div class="bar" style="margin-top:6px" title="Document index use"><i style="width:${Math.min(100, (index.chunks / index.maxChunks) * 100)}%"></i></div>` : ''}
        ${index?.stale ? `<p class="note-box admin-only" style="margin-top:10px">${index.stale === 1 ? '1 document was' : `${index.stale} documents were`} indexed with another model or an older format. Re-index so searches use <code>${esc(embedModel)}</code>. Until then they are searched the old way. <button class="btn small" type="button" id="reindex" ${reachable ? '' : 'disabled'}>Re-index</button></p>` : ''}
        <div class="admin-only" style="margin-top:10px"><label for="docfile">Add PDF, text, Markdown, CSV, JSON or HTML files</label>
          <input id="docfile" type="file" multiple accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.log,.html,.htm,.xml,.yaml,.yml"></div>
        ${embedReady ? '' : ollama ? `<p class="note-box admin-only" style="margin-top:10px">Searching documents needs the <code>${esc(embedModel)}</code> model. <button class="btn small" type="button" id="getembed" ${reachable ? '' : 'disabled'}>Download it</button></p>` : `<p class="note-box" style="margin-top:10px">Searching documents needs the embedding model <code>${esc(embedModel)}</code>. Load it in your AI server, or set <code>OUTPOST_EMBED_MODEL</code> to one it has.</p>`}
        <div id="docstat" class="muted" style="margin-top:8px"></div>
      </section>
      <section><h3>Saved conversations</h3>
        <ul class="mini">${saved.length ? saved.map((c) => `<li><button class="linkish" type="button" data-open="${esc(c.id)}">${esc(c.title)}</button><span class="muted">${c.count}</span><button class="btn small danger" type="button" data-delchat="${esc(c.id)}" aria-label="Delete ${esc(c.title)}">Delete</button></li>`).join('') : '<li class="muted">None yet. Only you can see yours.</li>'}</ul>
        <p class="row" style="margin-top:10px"><button class="btn small" type="button" id="savechat" ${messages.length ? '' : 'disabled'}>${chatId && saved.some((c) => c.id === chatId) ? 'Save changes' : 'Save this conversation'}</button>
          <button class="btn small" type="button" id="clear">New conversation</button></p></section>`;
  }

  async function pullModel(name, statEl) {
    statEl.textContent = 'Starting…';
    try {
      const res = await fetch('/api/ai/pull', jsonBody({ name }));
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      let failed = null;
      await streamNdjson(res, (o) => {
        if (o.error) failed = o.error;
        else if (o.total && o.completed) statEl.textContent = `${o.status}: ${Math.round((o.completed / o.total) * 100)}%`;
        else if (o.status) statEl.textContent = o.status;
      });
      if (failed) throw new Error(failed);
      toast(`${name} is ready`);
      statEl.textContent = '';
    } catch (e) {
      statEl.innerHTML = `<span class="error-text">${esc(e.message)}</span>`;
      return;
    }
    await loadModels();
    paintSide();
    paintMessages();
  }

  async function send() {
    const text = promptEl.value.trim();
    if (!text || busy) return;
    if (!model) return toast('Choose or download a model first', 'error');
    promptEl.value = '';
    messages.push({ role: 'user', content: text });
    const reply = { role: 'assistant', content: '', sources: [] };
    messages.push(reply);
    busy = true;
    sendBtn.textContent = 'Stop';
    ctrl = new AbortController();
    paintMessages();
    try {
      const history = messages.slice(0, -1).map(({ role, content }) => ({ role, content }));
      const res = await fetch('/api/ai/chat', { ...jsonBody({ model, messages: history, useDocs }), signal: ctrl.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await streamNdjson(res, (o) => {
        if (o.sources) reply.sources = o.sources;
        if (o.error) reply.error = o.error;
        if (o.message?.content) {
          reply.content += o.message.content;
          paintMessages();
        }
      });
    } catch (e) {
      if (e.name !== 'AbortError') reply.error = e.message;
    } finally {
      busy = false;
      ctrl = null;
      sendBtn.textContent = 'Send';
      if (!reply.content && !reply.error) reply.content = '(stopped)';
      store.set('outpost.chat', messages.slice(-40));
      paintMessages();
      paintSide(); // the Save button depends on there being messages
    }
  }

  $('#composer', root).addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) ctrl?.abort();
    else send();
  });
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) send();
    }
  });

  const side = $('#side', root);
  side.addEventListener('change', async (e) => {
    if (e.target.id === 'model') {
      model = e.target.value;
      store.set('outpost.model', model);
    }
    if (e.target.id === 'usedocs') {
      useDocs = e.target.checked;
      store.set('outpost.useDocs', useDocs);
    }
    if (e.target.id === 'docfile') {
      const stat = $('#docstat', root);
      for (const file of e.target.files) {
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
      await loadDocs();
      paintSide();
    }
  });
  side.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'pull') pullModel($('#pullname', root).value.trim(), $('#pullstat', root));
  });
  side.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    const rmdoc = e.target.closest('[data-rmdoc]');
    try {
      if (rm && confirm(`Remove the model ${rm.dataset.rm}? You can download it again later.`)) {
        await api(`/ai/models/${encodeURIComponent(rm.dataset.rm)}`, { method: 'DELETE' });
        await loadModels();
        paintSide();
        paintMessages();
      }
      if (rmdoc) {
        await api(`/ai/docs/${rmdoc.dataset.rmdoc}`, { method: 'DELETE' });
        await loadDocs();
        paintSide();
      }
      if (e.target.id === 'getembed') pullModel(embedModel, $('#docstat', root));
      if (e.target.id === 'reindex') {
        reindexJob = (await api('/ai/docs/reindex', { method: 'POST' })).job.id;
        toast('Re-indexing started. Follow it under Transfers.');
        openTray();
      }
      if (e.target.id === 'savechat') {
        chatId ??= `c-${Date.now().toString(36)}`;
        store.set('outpost.chatId', chatId);
        await api(`/chats/${chatId}`, jsonBody({ model, messages: messages.map(({ role, content }) => ({ role, content })) }, 'PUT'));
        toast('Conversation saved');
        await loadSaved();
        paintSide();
      }
      const open = e.target.closest('[data-open]');
      if (open) {
        const c = await api(`/chats/${encodeURIComponent(open.dataset.open)}`);
        messages = c.messages;
        chatId = c.id;
        if (c.model && models.some((m) => m.name === c.model)) model = c.model;
        store.set('outpost.chat', messages);
        store.set('outpost.chatId', chatId);
        paintSide();
        paintMessages();
      }
      const del = e.target.closest('[data-delchat]');
      if (del && confirm('Delete this saved conversation?')) {
        await api(`/chats/${encodeURIComponent(del.dataset.delchat)}`, { method: 'DELETE' });
        if (chatId === del.dataset.delchat) chatId = null;
        store.set('outpost.chatId', chatId);
        await loadSaved();
        paintSide();
      }
      if (e.target.id === 'clear') {
        chatId = null;
        store.set('outpost.chatId', null);
        messages = [];
        store.set('outpost.chat', []);
        paintMessages();
        paintSide();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  try {
    await Promise.all([loadModels(), loadDocs(), loadSaved()]);
  } catch (e) {
    toast(e.message, 'error');
  }
  paintSide();
  paintMessages();
  const off = onJobs(async (jobs, finished) => {
    // A short re-index can finish between two polls, so also watch the one started here by id.
    const mine = reindexJob && jobs.find((j) => j.id === reindexJob && j.status !== 'running');
    if (mine) reindexJob = null;
    if (mine || finished.some((j) => j.kind === 'reindex')) {
      await loadDocs();
      paintSide();
    }
  });
  const stopGauge = mountGpuGauge($('#gpu', root));
  return () => {
    off();
    ctrl?.abort();
    stopGauge();
  };
}
