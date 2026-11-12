import { $, api, esc, jsonBody, openTray, onJobs, toast } from './core.js';

/*
 * Docker apps on the Apps page (admins): containers Outpost runs through Docker Desktop or OrbStack, each on a port
 * of this Mac only, with its folders inside ~/Outpost/containers/<name>/. See src/services/docker.ts.
 */

const STATE = { running: ['ok', 'Running'], exited: ['idle', 'Stopped'], created: ['idle', 'Not started'], restarting: ['warn', 'Restarting'], paused: ['idle', 'Paused'], dead: ['warn', 'Stopped working'] };

// Trusted places to find images: Docker's own, publishers Docker has checked, and LinuxServer.io.
const FIND = [
  ['Docker Official Images', 'https://hub.docker.com/search?badges=official'],
  ['Verified Publishers', 'https://hub.docker.com/search?badges=verified_publisher'],
  ['LinuxServer.io', 'https://www.linuxserver.io/our-images'],
];

/** confirmCommand(title, why, command) → Promise<boolean>: the Apps shelf's "show the exact command" dialog. */
export function mountDocker(host, confirmCommand) {
  let st = null;
  let rows = { env: 0, folders: 0 };

  const envRow = (i) => `<div class="dkrow" data-env="${i}"><input aria-label="Setting name" placeholder="NAME" spellcheck="false" autocapitalize="none" maxlength="128"><input aria-label="Value" placeholder="value" spellcheck="false" autocapitalize="none" maxlength="4096"><button class="btn small" type="button" data-drop>Remove</button></div>`;
  const folderRow = (i) => `<div class="dkrow" data-folder="${i}"><input aria-label="Folder in Outpost" placeholder="e.g. data (blank: its own folder)" spellcheck="false" autocapitalize="none" maxlength="200"><input aria-label="Path inside the container" placeholder="e.g. /data" spellcheck="false" autocapitalize="none" maxlength="200"><label class="check"><input type="checkbox"> Read-only</label><button class="btn small" type="button" data-drop>Remove</button></div>`;

  function card(c) {
    const [lamp, label] = STATE[c.state] ?? ['idle', c.state];
    return `<article class="appcard"><header><h2>${esc(c.name)}</h2><span class="tstate ${lamp}"><i aria-hidden="true"></i>${esc(label)}</span></header>
      <p class="muted">${esc(c.image)} · ${esc(c.status)}</p>
      <p class="muted">Its files: <code>~/Outpost/containers/${esc(c.name)}/</code>. Opens on this Mac only${c.hostPort ? ` (<code>localhost:${c.hostPort}</code>)` : ''}.</p>
      <div class="row">${c.state === 'running' && c.hostPort ? `<a class="btn primary" href="http://localhost:${c.hostPort}/" target="_blank" rel="noopener">Open</a>` : ''}
        ${c.state === 'running' ? `<button class="btn" data-dk="stop" data-name="${esc(c.name)}">Stop</button>` : `<button class="btn" data-dk="start" data-name="${esc(c.name)}">Start</button>`}
        <button class="btn" data-dk="logs" data-name="${esc(c.name)}">Messages</button>
        <button class="btn danger" data-dk="remove" data-name="${esc(c.name)}">Remove</button></div></article>`;
  }

  function form() {
    return `<form id="dkform" class="appform"><h3 class="wide">Run a Docker app</h3>
        <p class="wide muted small">Find apps: ${FIND.map(([name, url]) => `<a href="${url}" target="_blank" rel="noopener">${name}</a>`).join(' · ')}. Stick to images from sources like these; each app's page lists the port and folders to fill in below.</p>
        <div><label for="dk-image">Image</label><input id="dk-image" required maxlength="255" spellcheck="false" autocapitalize="none" placeholder="e.g. nginx:1.27"></div>
        <div><label for="dk-name">Short name</label><input id="dk-name" required maxlength="32" pattern="[a-z0-9][a-z0-9\\-]*" spellcheck="false" autocapitalize="none" placeholder="e.g. web"></div>
        <div><label for="dk-port">App's port in the container</label><input id="dk-port" type="number" min="1" max="65535" required placeholder="e.g. 80"></div>
        <div><label for="dk-host">Port on this Mac</label><input id="dk-host" type="number" min="1024" max="65535" required placeholder="e.g. 8100"></div>
        <div class="wide"><label>Settings (environment variables)</label><div id="dk-env"></div><button class="btn small" type="button" data-add="env">Add a setting</button></div>
        <div class="wide"><label>Folders</label><p class="muted small">Each is a folder inside <code>~/Outpost/containers/&lt;short name&gt;/</code>, shown to the container at the path you give. Nothing else on the Mac is reachable.</p>
          <div id="dk-folders"></div><button class="btn small" type="button" data-add="folders">Add a folder</button></div>
        <div class="wide"><button class="btn primary" type="submit">Review the command</button></div></form>`;
  }

  async function load() {
    try {
      st = await api('/docker');
    } catch (e) {
      host.innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
      return;
    }
    const links = st.help.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>`).join(' or ');
    if (!st.enabled) {
      host.innerHTML = `<p class="muted" style="max-width:70ch">Off. Turn this on to run Docker containers from here. You also need ${links} on this Mac.</p><button class="btn primary" type="button" data-power="on">Turn on Docker apps</button>`;
      return;
    }
    if (!st.cli) {
      host.innerHTML = `<p class="note-box">Docker isn't installed on this Mac. Install ${links} (both are free for personal use), open it once, then reload this page.</p><button class="btn small" type="button" data-power="off">Turn off Docker apps</button>`;
      return;
    }
    if (!st.running) {
      host.innerHTML = `<p class="note-box">${esc(st.engine)} is installed but not running. Open it, wait until it says it's running, then reload this page.</p><button class="btn small" type="button" data-power="off">Turn off Docker apps</button>`;
      return;
    }
    const fresh = !$('#dkform', host); // a half-filled form stays as it is
    const list = st.containers.length ? `<div class="appgrid">${st.containers.map(card).join('')}</div>` : '<p class="muted">No Docker apps yet.</p>';
    if (fresh) {
      host.innerHTML = `<p class="muted small">${esc(st.engine)} ${esc(st.version)}. Outpost shows only the containers it started. <button class="btn small" type="button" data-power="off">Turn off Docker apps</button></p><div id="dklist"></div>${form()}`;
      rows = { env: 0, folders: 0 };
    }
    $('#dklist', host).innerHTML = list;
  }

  function spec() {
    const v = (id) => $(id, host).value.trim();
    return {
      image: v('#dk-image'),
      name: v('#dk-name'),
      port: Number(v('#dk-port')),
      hostPort: Number(v('#dk-host')),
      env: [...host.querySelectorAll('[data-env]')].map((r) => ({ key: r.children[0].value.trim(), value: r.children[1].value })).filter((e) => e.key || e.value),
      folders: [...host.querySelectorAll('[data-folder]')].map((r) => ({ folder: r.children[0].value.trim(), target: r.children[1].value.trim(), readOnly: r.querySelector('[type=checkbox]').checked })).filter((f) => f.folder || f.target),
    };
  }

  /** Saves the switch, then waits for Outpost to come back after its restart. */
  async function turn(on, btn) {
    if (!on && !confirm('Turn off Docker apps? Running containers keep running in Docker; Outpost just stops showing them.')) return;
    btn.disabled = true;
    try {
      const r = await api('/docker/enabled', jsonBody({ on }));
      if (!r.restarting) {
        host.innerHTML = `<p class="note-box">Saved. Quit and start Outpost again to finish turning Docker apps ${on ? 'on' : 'off'}.</p>`;
        return;
      }
      host.innerHTML = '<p class="muted">Restarting Outpost…</p>';
      await new Promise((ok) => setTimeout(ok, 2000));
      for (let i = 0; i < 60; i++) {
        if (await fetch('/healthz').then((x) => x.ok, () => false)) break;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      toast(`Docker apps are ${on ? 'on' : 'off'}.`);
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  }

  host.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const box = $(`#dk-${add.dataset.add}`, host);
      box.insertAdjacentHTML('beforeend', add.dataset.add === 'env' ? envRow(rows.env++) : folderRow(rows.folders++));
      box.lastElementChild.querySelector('input').focus();
      return;
    }
    if (e.target.closest('[data-drop]')) return void e.target.closest('.dkrow').remove();
    const power = e.target.closest('[data-power]');
    if (power) return void turn(power.dataset.power === 'on', power);
    const btn = e.target.closest('[data-dk]');
    if (!btn) return;
    const name = btn.dataset.name;
    const act = btn.dataset.dk;
    try {
      if (act === 'logs') {
        const { logs } = await api(`/docker/${encodeURIComponent(name)}/logs`);
        const dlg = document.createElement('dialog');
        dlg.className = 'cmd-dialog';
        dlg.innerHTML = `<form method="dialog"><h2>Messages from ${esc(name)}</h2><pre class="dklogs">${esc(logs || '(nothing yet)')}</pre><div class="row"><button class="btn" value="ok" autofocus>Close</button></div></form>`;
        document.body.append(dlg);
        dlg.addEventListener('close', () => dlg.remove());
        dlg.showModal();
        return;
      }
      if (act === 'remove' && !confirm(`Remove ${name}? The container is deleted; its files in ~/Outpost/containers/${name}/ stay.`)) return;
      btn.disabled = true;
      if (act === 'remove') await api(`/docker/${encodeURIComponent(name)}`, { method: 'DELETE' });
      else await api(`/docker/${encodeURIComponent(name)}/${act}`, { method: 'POST' });
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  });

  host.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = spec();
    try {
      const { command, url } = await api('/docker/preview', jsonBody({ spec: s }));
      const why = `Docker downloads the image if it isn't on this Mac yet, then starts it. It opens at ${url} on this Mac only, and starts again with Docker until you stop it.`;
      if (!(await confirmCommand(`Run ${s.name}?`, why, command))) return;
      const { job } = await api('/docker', jsonBody({ spec: s, confirm: command }));
      toast(`Starting ${s.name}. Follow it under Transfers.`);
      openTray();
      follow(job.id);
      e.target.reset();
      $('#dk-env', host).innerHTML = '';
      $('#dk-folders', host).innerHTML = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // A quick run can finish before Transfers notices it, so follow the job itself until it ends.
  let following = null;
  function follow(id) {
    clearInterval(following);
    following = setInterval(async () => {
      const j = (await api('/jobs').catch(() => null))?.jobs.find((x) => x.id === id);
      if (j && (j.status === 'running' || j.status === 'queued')) return;
      clearInterval(following);
      if (j?.status === 'error') toast(j.error, 'error');
      load();
    }, 1000);
  }

  const off = onJobs((_j, finished) => finished.some((j) => j.kind === 'docker') && load());
  load();
  return () => {
    off();
    clearInterval(following);
  };
}
