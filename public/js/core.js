export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
export const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or full: ignore */
    }
  },
};

let contentPorts = null;
/**
 * Where books, Education and apps are served: this same host on their own port (matching http or https), so their
 * pages can't act as Outpost. Falls back to '' (Outpost forwards the old addresses).
 */
export async function contentBase() {
  contentPorts ??= api('/status').then((s) => s.listen.content, () => null);
  const c = await contentPorts;
  const port = c && (location.protocol === 'https:' ? c.httpsPort : c.port);
  return port ? `${location.protocol}//${location.hostname}:${port}` : '';
}

export async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (res.status === 401 && path !== '/auth/login') {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`;
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}
export const jsonBody = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

/** Reads an NDJSON response body, calling onObj for each parsed line. */
export async function streamNdjson(res, onObj) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      onObj(obj);
    }
  }
}

/* ---------- transfers (background jobs) ---------- */
let jobs = [];
const listeners = new Set();
export const getJobs = () => jobs;
/** cb(jobs, justFinished[]) runs after every poll. Returns an unsubscribe function. */
export function onJobs(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function renderTray() {
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const badge = $('#jobs-badge');
  badge.hidden = running === 0;
  badge.textContent = running;
  const body = $('#tray-body');
  if (!body || $('#tray').hidden) return;
  if (!jobs.length) {
    body.innerHTML = `<div class="empty"><p class="muted">Downloads, map extractions and document re-indexing show up here while they run.</p></div>`;
    return;
  }
  body.innerHTML = jobs
    .map((j) => {
      const pct = j.total ? Math.min(100, Math.round((j.received / j.total) * 100)) : null;
      const state = { queued: 'Waiting', running: pct !== null ? `${pct}%` : 'Working', done: 'Done', error: 'Failed', cancelled: 'Cancelled' }[j.status];
      const detail =
        j.status === 'error'
          ? `<span class="error-text">${esc(j.error)}</span>`
          : (j.kind === 'download' || j.kind === 'model-pull') && j.status === 'running' && j.received
            ? `${fmtBytes(j.received)}${j.total ? ` of ${fmtBytes(j.total)}` : ''}`
            : esc(j.message);
      return `<div class="job"><div class="top"><strong>${esc(j.label)}</strong><span class="muted">${state}</span></div>
        ${j.status === 'running' ? `<div class="bar"><i style="width:${pct ?? 100}%${pct === null ? ';opacity:.4' : ''}"></i></div>` : ''}
        <div class="muted">${detail}</div>
        <div style="margin-top:8px">${
          j.status === 'running' || j.status === 'queued'
            ? `<button class="btn small" data-cancel="${j.id}" type="button">Cancel</button>`
            : `<button class="btn small" data-clear="${j.id}" type="button">Dismiss</button>`
        }</div></div>`;
    })
    .join('');
}

async function pollJobs() {
  try {
    const data = await api('/jobs');
    const active = (j) => j.status === 'running' || j.status === 'queued';
    const wasRunning = new Set(jobs.filter(active).map((j) => j.id));
    jobs = data.jobs;
    const finished = jobs.filter((j) => wasRunning.has(j.id) && !active(j));
    for (const j of finished) {
      if (j.status === 'done') toast(`${j.label} is ready`);
      else if (j.status === 'error') toast(`${j.label} failed: ${j.error}`, 'error');
      else toast(`${j.label} cancelled`);
    }
    renderTray();
    listeners.forEach((cb) => cb(jobs, finished));
  } catch {
    /* server restarting: try again next tick */
  }
}

export function openTray() {
  if ($('#tray').hidden) $('#jobs-btn').click();
}

/** Asks before any command runs, showing it exactly. Resolves true only on "Run it". */
export function confirmCommand(title, why, command) {
  const dlg = document.createElement('dialog');
  dlg.className = 'cmd-dialog';
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(why)}</p>
    <pre><code>${esc(command)}</code></pre>
    <p class="muted">It runs as your Mac account, without a shell. Nothing runs until you choose <b>Run it</b>.</p>
    <div class="row"><button class="btn" value="no" autofocus>Cancel</button><button class="btn primary" value="yes">Run it</button></div></form>`;
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'yes');
      dlg.remove();
    });
    dlg.showModal();
  });
}

/** Installs Kolibri or CyberChef with its script, after the admin confirms it; progress shows under Transfers. */
export async function installAddon(id, name, why) {
  const { command } = await api(`/install/${id}`);
  if (!(await confirmCommand(`Install ${name}?`, why, command))) return false;
  await api(`/install/${id}`, jsonBody({ confirm: command }));
  toast(`Installing ${name}…`);
  openTray();
  return true;
}

export function startJobsUI() {
  const tray = $('#tray');
  const btn = $('#jobs-btn');
  const setOpen = (open) => {
    tray.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) renderTray();
  };
  btn.addEventListener('click', () => setOpen(tray.hidden));
  $('#tray-close').addEventListener('click', () => setOpen(false));
  tray.addEventListener('click', async (e) => {
    const cancel = e.target.closest('[data-cancel]');
    const clear = e.target.closest('[data-clear]');
    try {
      if (cancel) await api(`/jobs/${cancel.dataset.cancel}/cancel`, { method: 'POST' });
      if (clear) await api(`/jobs/${clear.dataset.clear}`, { method: 'DELETE' });
    } catch (err) {
      toast(err.message, 'error');
    }
    pollJobs();
  });
  pollJobs();
  setInterval(pollJobs, 1500);
  return { open: () => setOpen(true), refresh: pollJobs };
}
