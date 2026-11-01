import { $, api, contentBase, esc, fmtBytes, jsonBody, toast } from './core.js';
import { mountDocker } from './docker-apps.js';

const STATE = {
  'not-installed': ['idle', 'Not installed'],
  installing: ['idle', 'Installing…'],
  stopped: ['idle', 'Stopped'],
  starting: ['idle', 'Starting…'],
  running: ['ok', 'Running'],
  crashed: ['warn', 'Stopped working'],
};

/** Asks before any command runs, showing it exactly. Resolves true only on "Run it". */
function confirmCommand(title, why, command) {
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

/** The Apps shelf: local web apps Outpost can install (after you confirm), start and stop. */
export async function viewApps(root) {
  root.innerHTML = `<h1>Apps</h1><p class="lead">Extra tools that run on this Mac and open in your browser. Outpost installs or starts one only when you say so, and shows you the exact command first.</p>
    <div id="apps"><p class="muted">Loading…</p></div>
    <section class="block admin-only"><h2>Docker apps</h2>
      <p class="muted" style="max-width:70ch">Run a ready-made app from a Docker image. Outpost writes the whole command itself and shows it before anything runs: the app opens on a port of this Mac only, and sees only its own folder in <code>~/Outpost/containers</code>. Use images you trust.</p>
      <div id="docker"></div></section>
    <section class="block"><h2>Get for your devices</h2>
      <p class="muted" style="max-width:70ch">Apps for phones and computers that work offline. Links go to each app's official page. An admin can save an installer here; then any device that can sign in can download it from Outpost, even with no internet. Android phones can install a saved <code>.apk</code> after allowing installs from the browser; iPhones install only from the App Store.</p>
      <div id="devices"></div></section>
    <section class="block admin-only"><h2>Add your own app</h2>
      <p class="muted" style="max-width:70ch">Any program that serves a web page on a port. Install it yourself first (for example with Homebrew). Ask it to listen on <code>127.0.0.1</code> only; Outpost can't check that for you. In the command you can use <code>{port}</code>, <code>{prefix}</code> (<code>/apps/&lt;short name&gt;</code>), <code>{data}</code> (its own folder in Outpost) and <code>{home}</code> (the Outpost folder).</p>
      <form id="custom" class="appform">
        <div><label for="c-name">Name</label><input id="c-name" maxlength="60" required placeholder="e.g. My wiki"></div>
        <div><label for="c-id">Short name</label><input id="c-id" maxlength="32" required pattern="[a-z0-9][a-z0-9-]*" autocapitalize="none" spellcheck="false" placeholder="e.g. wiki"></div>
        <div class="wide"><label for="c-cmd">Command that starts it</label><input id="c-cmd" maxlength="1000" required spellcheck="false" autocapitalize="none" placeholder="e.g. mywiki --host 127.0.0.1 --port {port}"></div>
        <div><label for="c-port">Port</label><input id="c-port" type="number" min="1024" max="65535" required placeholder="e.g. 8096"></div>
        <div><label for="c-health">Ready check (optional)</label><input id="c-health" spellcheck="false" placeholder="e.g. /health"></div>
        <label class="check wide"><input id="c-prefix" type="checkbox"> It can run under <code>/apps/&lt;short name&gt;/</code> (it takes a base path), so other devices can open it through Outpost</label>
        <div class="wide"><button class="btn primary" type="submit">Add to the shelf</button></div>
      </form></section>`;
  const box = $('#apps', root);
  const dbox = $('#devices', root);
  let apps = [];
  let devices = [];
  let content = '';
  let timer = null;

  function card(a) {
    const key = a.installing ? 'installing' : !a.installed ? 'not-installed' : a.state;
    const [lamp, label] = STATE[key] ?? ['idle', key];
    const open = a.state === 'running' && a.ready;
    const href = a.url ? content + a.url : `http://localhost:${a.port}/`;
    const meta = [a.license && esc(a.license), a.homepage && `<a href="${esc(a.homepage)}" target="_blank" rel="noopener">Website</a>`, `port ${a.port}`].filter(Boolean).join(' · ');
    const buttons = [
      open ? `<a class="btn primary" href="${esc(href)}" target="_blank" rel="noopener">Open</a>` : '',
      !a.installed && a.commands?.install && !a.installing ? `<button class="btn primary admin-only" data-act="install" data-id="${a.id}">Install</button>` : '',
      a.installed && !['running', 'starting'].includes(a.state) ? `<button class="btn${open ? '' : ' primary'} admin-only" data-act="start" data-id="${a.id}">Start</button>` : '',
      ['running', 'starting', 'crashed'].includes(a.state) ? `<button class="btn admin-only" data-act="stop" data-id="${a.id}">Stop</button>` : '',
      a.custom ? `<button class="btn danger admin-only" data-act="remove" data-id="${a.id}">Remove</button>` : '',
    ].join('');
    const where = a.url
      ? 'Opens through Outpost, so any device that can sign in can use it.'
      : `Opens on its own port, so only this Mac can open it (<code>localhost:${a.port}</code>).`;
    const missing = !a.installed && !a.commands?.install ? `<p class="muted">Not found on this Mac. Install it yourself, then reload this page.</p>` : '';
    const logs = a.logs?.length && ['crashed', 'starting'].includes(a.state) ? `<details class="admin-only"><summary>Last messages</summary><pre>${esc(a.logs.join('\n'))}</pre></details>` : '';
    return `<article class="appcard"><header><h2>${esc(a.name)}</h2><span class="tstate ${lamp}"><i aria-hidden="true"></i>${label}${a.state === 'running' && !a.ready ? ', not answering yet' : ''}</span></header>
      <p>${esc(a.description)}</p>${a.note ? `<p class="muted">${esc(a.note)}</p>` : ''}
      <p class="muted">${where}</p>${missing}
      <p class="meta">${meta}</p>${logs}<div class="row">${buttons}</div></article>`;
  }

  function device(d) {
    const rows = d.platforms.map((p, i) => {
      const open = p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">Official page</a>` : '';
      if (!p.file) return `<li><b>${esc(p.label)}</b> ${open}</li>`;
      const get = p.saved
        ? `<a class="btn small primary" href="${esc(p.href)}" download>Download (${fmtBytes(p.size)})</a>`
        : p.saving
          ? '<span class="muted">Saving…</span>'
          : `<button class="btn small admin-only" data-save="${i}" data-id="${d.id}">Save installer (${fmtBytes(p.size)})</button><span class="muted member-only">Not saved here yet</span>`;
      return `<li><b>${esc(p.label)}</b> ${get} ${open}</li>`;
    });
    return `<article class="appcard"><header><h2>${esc(d.name)}</h2></header><p>${esc(d.what)}</p>
      <ul class="plats">${rows.join('')}</ul>
      <p class="meta">${[d.license && esc(d.license), `<a href="${esc(d.page)}" target="_blank" rel="noopener">Website</a>`].filter(Boolean).join(' · ')}</p></article>`;
  }

  async function load() {
    try {
      ({ apps, devices } = await api('/apps'));
      content = await contentBase();
    } catch (err) {
      box.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
      return;
    }
    box.innerHTML = apps.length ? `<div class="appgrid">${apps.map(card).join('')}</div>` : '<p class="muted">The shelf is empty.</p>';
    dbox.innerHTML = devices.length ? `<div class="appgrid">${devices.map(device).join('')}</div>` : '';
    // Keep checking while something is installing or starting up.
    clearTimeout(timer);
    if (devices.some((d) => d.platforms.some((p) => p.saving)) || apps.some((a) => a.installing || a.state === 'starting' || (a.state === 'running' && !a.ready))) timer = setTimeout(load, 2500);
  }

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const a = apps.find((x) => x.id === btn.dataset.id);
    if (!a) return;
    const act = btn.dataset.act;
    try {
      if (act === 'install') {
        const why = a.commands.install.startsWith('Download ')
          ? `Outpost downloads the official build of ${a.name}, refuses it unless its fingerprint matches, and unpacks only the program. You can follow it under Transfers.`
          : 'This runs the install command below. It can take a few minutes; you can follow it under Transfers.';
        if (!(await confirmCommand(`Install ${a.name}?`, why, a.commands.install))) return;
        btn.disabled = true;
        await api(`/apps/${a.id}/install`, jsonBody({ command: a.commands.install }));
        toast(`Installing ${a.name}…`);
      } else if (act === 'start') {
        if (!(await confirmCommand(`Start ${a.name}?`, 'Outpost runs this and keeps it running, including after a restart, until you stop it.', a.commands.start))) return;
        btn.disabled = true;
        await api(`/apps/${a.id}/start`, jsonBody({ command: a.commands.start }));
      } else if (act === 'stop') {
        btn.disabled = true;
        await api(`/apps/${a.id}/stop`, { method: 'POST' });
      } else if (act === 'remove') {
        if (!confirm(`Remove ${a.name} from the shelf? It stops it; the program and its files stay on this Mac.`)) return;
        await api(`/apps/${a.id}`, { method: 'DELETE' });
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    await load();
  });

  dbox.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-save]');
    if (!btn) return;
    const d = devices.find((x) => x.id === btn.dataset.id);
    const p = d?.platforms[Number(btn.dataset.save)];
    if (!p?.confirm) return;
    if (!(await confirmCommand(`Save the ${d.name} installer?`, `Outpost downloads it from the official release, keeps it only if its fingerprint matches, and puts it in the Installers folder of File Browser. You can follow it under Transfers.`, p.confirm))) return;
    btn.disabled = true;
    try {
      await api(`/apps/devices/${d.id}/${btn.dataset.save}/save`, jsonBody({ confirm: p.confirm }));
      toast(`Saving the ${d.name} installer…`);
    } catch (err) {
      toast(err.message, 'error');
    }
    await load();
  });

  $('#custom', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => $(id, root).value.trim();
    try {
      await api('/apps', jsonBody({ name: v('#c-name'), id: v('#c-id'), command: v('#c-cmd'), port: Number(v('#c-port')), health: v('#c-health'), prefix: $('#c-prefix', root).checked }));
      e.target.reset();
      toast('Added. Choose Start to run it.');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Docker apps are admin-only (the server refuses members), so members don't even ask.
  const offDocker = document.body.dataset.role === 'admin' ? mountDocker($('#docker', root), confirmCommand) : null;
  await load();
  return () => {
    clearTimeout(timer);
    offDocker?.();
  };
}
