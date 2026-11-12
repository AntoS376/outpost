import { $, api, contentBase, esc, fmtBytes, jsonBody, toast } from './core.js';
import { openSosDialog } from './sos.js';
import { snapshot } from './voice-core.js';
import { voiceBand } from './voice-band.js';

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

function row(state, title, text, action = '') {
  const label = { ok: 'Ready', idle: 'Not set up', warn: 'Needs attention' }[state];
  return `<li><span class="lamp ${state}" role="img" aria-label="${label}"></span>
    <div><strong>${esc(title)}</strong><p>${text}</p></div><div>${action}</div></li>`;
}

/** Engraved illustrations for the four main cards (public/img/icons). */
const art = (key) => `<img class="engrave" src="/img/icons/${key}.png" alt="">`;

/** Slim tile icons: pictures where there is one (public/img/icons), line drawings otherwise. */
const PICTURE = new Set(['education', 'notes', 'tools', 'accounts']);
const LINE = {
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  setup: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  games: '<rect x="4" y="3" width="11" height="15" rx="2"/><path d="M9 21h9a2 2 0 0 0 2-2V8"/><path d="M9.5 7.5l-2 3 2 3 2-3z"/>',
  ready: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  radio: '<path d="M12 10v11"/><path d="M9 21h6"/><circle cx="12" cy="8" r="2"/><path d="M8.5 4.5a5 5 0 0 0 0 7"/><path d="M15.5 4.5a5 5 0 0 1 0 7"/><path d="M5.6 2a9 9 0 0 0 0 12"/><path d="M18.4 2a9 9 0 0 1 0 12"/>',
};
const icon = (key) => (PICTURE.has(key) ? `<img class="sicon pic" src="/img/icons/${key}.png" alt="">` : `<svg class="sicon" viewBox="0 0 24 24" aria-hidden="true">${LINE[key]}</svg>`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const arrow = '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/** A main card: illustration, three-line kicker, title, what powers it, a line about it and its live status. */
function primary({ href, art: key, kicker, title, by, text, state, status, external }) {
  return `<a class="card primary" href="${href}"${external ? ' target="_blank" rel="noopener"' : ''}>
    <div class="ptop">${art(key)}<span class="kicker">${kicker.join('<br>')}</span></div>
    <h2>${title}</h2>${by ? `<span class="by">${by}</span>` : ''}
    <p>${text}</p>
    <span class="status ${state}"><i aria-hidden="true"></i>${status}${arrow}</span></a>`;
}

/** A slim tile: icon, title and a one-line caption with its state. */
function slim({ href, icon: key, title, caption, state, external, adminOnly }) {
  return `<a class="card slim${adminOnly ? ' admin-only' : ''}" href="${href}"${external ? ' target="_blank" rel="noopener"' : ''}>
    ${icon(key)}
    <span><strong>${title}</strong><small class="${state}" title="${caption}"><span>${caption}</span></small></span>${arrow}</a>`;
}

/** Copies text, also on plain-HTTP pages where the clipboard API is off. */
async function copy(text, input) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('Address copied.');
}

export async function viewHome(root) {
  root.innerHTML = `<header class="fieldhead">
      <div class="word"><h1>Outpost</h1><span>Knowledge travels further</span></div>
      <p class="kicker motto">Offline library<br>Survival tools<br>A more resilient tomorrow</p>
    </header>
    <div id="home-body"><p class="muted">Checking…</p></div>`;
  const body = $('#home-body', root);
  const vb = voiceBand();

  async function render() {
    let s;
    try {
      s = await api('/status');
    } catch (e) {
      body.innerHTML = `<p class="error-text">Can't reach the Outpost server: ${esc(e.message)}</p>`;
      return;
    }
    const lib = s.services.library;
    const ai = s.services.ai;
    const edu = s.services.education.state;
    const ollama = ai.provider === 'ollama';
    const attention = [];

    // Library
    let libState = 'ok';
    let libStatus = `${plural(lib.zims, 'book')} ready`;
    if (lib.zims === 0) [libState, libStatus] = ['idle', 'No books yet'];
    else if (lib.reason === 'no-binary' || !s.binaries['kiwix-serve']) {
      [libState, libStatus] = ['warn', "Reader not installed"];
      attention.push(row('warn', 'Library', `${plural(lib.zims, 'book')} downloaded, but the reader isn't installed. Run <code>./scripts/setup-mac.sh</code> again, then restart Outpost.`));
    } else if (lib.state !== 'running') {
      [libState, libStatus] = ['warn', `Reader ${lib.state}`];
      attention.push(row('warn', 'Library', `The reader is ${esc(lib.state)}. ${lib.hint ? esc(lib.hint) : lib.logs.length ? `Last message: <code>${esc(lib.logs[lib.logs.length - 1])}</code>` : ''}`, `<button class="btn admin-only" type="button" id="restart-reader">Restart reader</button>`));
    }

    // Assistant
    let aiState = 'ok';
    let aiStatus = `${plural(ai.models, 'chat model')} ready`;
    if (!ai.reachable) {
      [aiState, aiStatus] = ['warn', `${ollama ? 'Ollama' : 'AI server'} not answering`];
      attention.push(row('warn', 'Assistant', ollama ? `Ollama isn't answering at <code>${esc(ai.url)}</code>. Open the Ollama app, or run <code>ollama serve</code> in Terminal.` : `The AI server isn't answering at <code>${esc(ai.url)}</code>. Start its local server (for example in LM Studio), then reload.`));
    } else if (ai.models === 0) [aiState, aiStatus] = ['idle', 'No chat model yet'];

    // Updates waiting (only when someone turned update checks on)
    const up = await api('/updates').catch(() => null);
    const r = up?.enabled ? up.results : null;
    const updates = r ? (r.outpost?.newer ? 1 : 0) + r.books.length + r.models.length : 0;
    if (updates) attention.push(row('idle', 'Updates', `${plural(updates, 'update')} available for ${[r.outpost?.newer && 'Outpost', r.books.length && 'books', r.models.length && 'AI models'].filter(Boolean).join(', ')}.`, `<a class="btn" href="#updates">See</a>`));

    const eduStatus = { running: 'Running', starting: 'Starting', stopped: 'Stopped', 'not-installed': 'Not installed', 'python-missing': 'Needs repair', crashed: 'Stopped working' }[edu] ?? edu;
    const eduState = edu === 'running' ? 'ok' : ['python-missing', 'crashed'].includes(edu) ? 'warn' : 'idle';
    const docs = s.services.documents.count;
    const notes = s.services.notes.count;
    const maps = s.services.maps.files;
    const apps = ((await api('/apps').catch(() => null))?.apps ?? []).filter((a) => a.state === 'running').length;
    const loop = LOOPBACK.includes(s.listen.host);
    const content = await contentBase();

    const cards = [
      primary({ href: lib.state === 'running' ? '#library' : '#library/manage', art: 'library', kicker: ['Knowledge', 'anywhere', 'always'], title: 'Library', by: 'Kiwix', text: 'Wikipedia, medical references and how-to guides, offline.', state: libState, status: libStatus }),
      primary({ href: '#maps', art: 'maps', kicker: ['Find', 'explore', 'navigate'], title: 'Maps', by: 'Protomaps', text: 'Offline street maps, with place search and Locate me.', state: maps ? 'ok' : 'idle', status: maps ? `${plural(maps, 'map')} ready` : 'No maps yet' }),
      primary({ href: '#ai', art: 'assistant', kicker: ['A helpful', 'companion', 'offline'], title: 'Assistant', by: ollama ? 'Local Ollama' : 'Your AI server', text: "Ask questions and get guidance from AI that runs on this Mac's own chip.", state: aiState, status: aiStatus }),
      primary({ href: '#documents', art: 'documents', kicker: ['Your files', 'your knowledge', 'with you'], title: 'Documents', by: 'Files & resources', text: 'Your own files, for the assistant to answer from.', state: docs ? 'ok' : 'idle', status: docs ? `${plural(docs, 'document')} ready` : 'None added yet' }),
    ];
    // Smaller tiles, grouped by what they're for.
    const groups = [
      ['Stay ready', [
        slim({ href: '#ready', icon: 'ready', title: 'Preparedness', caption: 'Guides & supply kit', state: 'idle' }),
        slim({ href: '#radio', icon: 'radio', title: 'Radio', caption: 'Channels & check-ins', state: 'idle' }),
        slim({ href: '#notes', icon: 'notes', title: 'Notes', caption: notes ? plural(notes, 'note') : 'Capture & organize', state: notes ? 'ok' : 'idle' }),
      ]],
      ['Learn & unwind', [
        slim({ href: edu === 'running' ? `${content}/kolibri/` : '#education', external: edu === 'running', icon: 'education', title: 'Education', caption: `Courses · ${eduStatus}`, state: eduState }),
        slim({ href: '#apps', icon: 'apps', title: 'Apps', caption: apps ? `${plural(apps, 'app')} running` : 'File browser, music', state: apps ? 'ok' : 'idle' }),
        slim({ href: '#games', icon: 'games', title: 'Games', caption: 'Solitaire, Sudoku & more', state: 'idle' }),
      ]],
      ['Manage', [
        slim({ href: '#tools', icon: 'tools', title: 'Tools', caption: updates ? `${plural(updates, 'update')} waiting` : s.tools.cyberchef ? 'CyberChef · encode, decode' : 'Encode, decode, analyze', state: 'idle' }),
        slim({ href: '#account', icon: 'accounts', title: 'Accounts', caption: s.auth ? `Signed in as ${esc(s.user.name)}` : 'Users & access', state: 'idle' }),
        slim({ href: '#setup', icon: 'setup', title: 'Easy setup', caption: 'Books, maps, models', state: 'idle', adminOnly: true }),
      ]],
    ];

    // System status: one line per service, its state in monospace.
    const line = (label, state, text) => `<li><span>${label}</span><b class="${state}">${text}</b></li>`;
    const status = [
      line('Sharing', loop ? 'idle' : 'ok', loop ? 'This Mac' : 'Broadcasting'),
      line('Library', libState, lib.zims ? (libState === 'ok' ? 'Ready' : 'Check') : 'Empty'),
      line('Maps', maps ? 'ok' : 'idle', maps ? 'Ready' : 'Empty'),
      line('Assistant', aiState, aiState === 'ok' ? 'Ready' : aiState === 'warn' ? 'Offline' : 'No model'),
      line('Education', eduState, eduStatus),
      line('Keep awake', s.listen.awake?.on ? 'ok blink' : 'idle', s.listen.awake?.on ? 'On' : 'Off'),
    ].join('');

    // Storage: what Outpost uses by kind, the rest of the disk, and what's free.
    const u = s.storage.used;
    const total = s.storage.total;
    const free = s.storage.free;
    const parts = [
      ['Library', u.library, 'var(--c1)'],
      ['Maps', u.maps, 'var(--c2)'],
      ['Documents', u.documents, 'var(--c3)'],
      ['Notes', u.notes, 'var(--c4)'],
    ];
    const usedTotal = parts.reduce((a, p) => a + p[1], 0);
    const other = total && free != null ? Math.max(0, total - free - usedTotal) : 0;
    const pct = (v) => Math.max(0.6, (v / total) * 100);
    const seg = total
      ? [...parts.filter((p) => p[1] > 0).map(([n, v, c]) => `<i style="width:${pct(v)}%;background:${c}" title="${n} ${fmtBytes(v)}"></i>`), other ? `<i class="other" style="width:${(other / total) * 100}%" title="Other files ${fmtBytes(other)}"></i>` : ''].join('')
      : '';

    // Share Outpost: QR code, the address with a copy button, keep-awake.
    const ip = s.listen.lan?.[0];
    const address = ip ? `http://${ip}:${s.listen.port}` : '';
    const joinUrl = `http://${ip ?? s.host.hostname}:${s.listen.port}/join`;
    const share = loop || !ip
      ? `<p>Only this Mac can open Outpost right now.</p><p class="muted">To open it from phones on your Wi-Fi: create an admin account on <a href="#account">Accounts</a>, add <code>OUTPOST_HOST=0.0.0.0</code> to <code>~/.config/outpost/env</code>, then restart Outpost. The <a href="#guide">setup guide</a> walks you through it.</p>`
      : `<div class="sharegrid"><button class="qr" type="button" id="qr" aria-label="Show the join code bigger" title="Show bigger"></button>
          <div><p>Connect to this Outpost on your device: same Wi-Fi, then scan or type.</p>
          <div class="copyrow"><input id="addr" readonly value="${esc(address)}" aria-label="Outpost's address"><button class="btn" type="button" id="copy" aria-label="Copy the address"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button></div>
          ${s.listen.local ? `<small class="muted">Or <code>http://${esc(s.listen.local)}:${s.listen.port}</code>. The number address can change when the router restarts.</small>` : ''}</div></div>
        ${s.listen.awake?.available ? `<label class="check admin-only"><input type="checkbox" id="awake"${s.listen.awake.on ? ' checked' : ''}> Keep this Mac awake while Outpost runs</label>` : ''}
        <p class="muted small">Scanning opens <code>/join</code>, which also sets up <b>Locate me</b> and shows how to add Outpost to the home screen. <a href="#guide">Setup guide</a></p>`;

    body.innerHTML = `<div class="sos">
        <svg class="warn" viewBox="0 0 48 44" aria-hidden="true"><path d="M24 3 L46 41 H2 Z"/><path d="M24 16 v12" class="cut"/><circle cx="24" cy="34" r="2.4" class="dot"/></svg>
        <a class="sostitle" href="#emergency"><strong>Emergency SOS</strong><span>Signal · first aid · location</span></a>
        <span class="sostext">Call everyone on this Outpost for help, or signal with sound, light and Morse. First-aid steps, where you are, your emergency card and kits. Works offline.</span>
        <button class="sosbtn" type="button" id="sendsos"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>Send SOS</button></div>
      ${attention.length ? `<ul class="ready attention">${attention.join('')}</ul>` : ''}
      <div class="primaries">${cards.join('')}</div>
      <div class="slimgroups">${groups.map(([label, tiles]) => `<section class="slimgroup"><h2 class="kicker">${label}</h2><div class="slims">${tiles.join('')}</div></section>`).join('')}</div>
      <div class="lower">
        <section class="card panel"><h2>System status</h2><ul class="statuslist">${status}</ul></section>
        <section class="card panel"><div class="ptitle"><h2>Storage</h2>${total ? `<span class="kicker">${fmtBytes(total)} total</span>` : ''}</div>
          ${free != null ? `<p class="bigfree">${fmtBytes(free)} free</p>` : ''}
          ${seg ? `<div class="stor" role="img" aria-label="Disk use by kind">${seg}</div>` : ''}
          <div class="legend">${parts.map(([n, v, c]) => `<span style="--sw:${c}">${n} <b>${fmtBytes(v)}</b></span>`).join('')}${other ? `<span style="--sw:color-mix(in srgb, var(--accent) 62%, var(--panel))">Other files <b>${fmtBytes(other)}</b></span>` : ''}</div>
          <p class="muted small">Outpost uses ${fmtBytes(usedTotal)} in <code>${esc(s.storage.home)}</code>.</p></section>
        <section class="card panel sharepanel"><h2><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>Share Outpost</h2>${share}</section>
      </div>
      <footer class="fieldfoot"><span>Offline today · stronger tomorrow</span><span>Outpost v${esc(s.version)}${s.released ? ` · updated ${new Date(`${s.released}T12:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span></footer>`;

    $('.sos', body).after(vb.band);
    const qr = $('#qr', body);
    if (qr) {
      const { qrSvg } = await import('/vendor/qr.js');
      qr.innerHTML = qrSvg(joinUrl);
      qr.onclick = () => {
        const dlg = document.createElement('dialog');
        dlg.className = 'qr-big';
        dlg.innerHTML = `<form method="dialog"><h2>Join Outpost</h2><p>Join the same Wi-Fi as this Mac, then scan with the phone's camera.</p>${qrSvg(joinUrl, { cellSize: 8 })}<p><code>${esc(joinUrl)}</code></p><button class="btn primary" autofocus>Close</button></form>`;
        document.body.append(dlg);
        dlg.addEventListener('close', () => dlg.remove());
        dlg.showModal();
      };
    }
    $('#copy', body)?.addEventListener('click', () => copy(address, $('#addr', body)));
    const awake = $('#awake', body);
    awake?.addEventListener('change', async () => {
      try {
        const st = await api('/awake', jsonBody({ on: awake.checked }, 'PUT'));
        toast(st.on ? 'This Mac will stay awake while Outpost runs.' : 'This Mac can sleep normally again.');
      } catch (err) {
        awake.checked = !awake.checked;
        toast(err.message, 'error');
      }
    });
  }

  body.addEventListener('click', async (e) => {
    if (e.target.closest('#sendsos')) return openSosDialog();
    if (e.target.id !== 'restart-reader') return;
    e.target.disabled = true;
    e.target.textContent = 'Restarting…';
    await api('/library/restart', { method: 'POST' }).catch((err) => toast(err.message, 'error'));
    setTimeout(render, 1500);
  });

  await render();
  // Re-render every 5 s, but not while someone is using a control on the page (it would lose focus) or holding Talk.
  const timer = setInterval(() => {
    if ((!body.contains(document.activeElement) || document.activeElement === body) && !snapshot().recording) render();
  }, 5000);
  return () => {
    clearInterval(timer);
    vb.stop();
  };
}
