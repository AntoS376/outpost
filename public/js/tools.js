import { $, api, esc, installAddon, toast } from './core.js';
import { CALCULATOR, CONVERTER } from './calculator.js';

const bytesToBinary = (bytes) => [...bytes].map((b) => String.fromCharCode(b)).join('');
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function randomInt(max) {
  // Rejection sampling keeps the result unbiased.
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

const TOOLS = [
  CALCULATOR,
  CONVERTER,
  {
    id: 'encode',
    title: 'Encode and decode',
    desc: 'Base64, web addresses (URL), hexadecimal',
    html: `<div class="field"><label for="enc-in">Text</label><textarea id="enc-in" rows="4"></textarea></div>
      <div class="row"><div><label for="enc-kind">Format</label><select id="enc-kind"><option value="b64">Base64</option><option value="url">URL</option><option value="hex">Hexadecimal</option></select></div>
      <button class="btn primary" data-act="enc" type="button">Encode</button><button class="btn" data-act="dec" type="button">Decode</button></div>
      <div class="field" style="margin-top:12px"><label for="enc-out">Result</label><textarea id="enc-out" rows="4" readonly></textarea></div>
      <button class="btn small" data-copy="enc-out" type="button">Copy result</button>`,
    wire(el) {
      const run = (decode) => {
        const input = $('#enc-in', el).value;
        const kind = $('#enc-kind', el).value;
        const out = $('#enc-out', el);
        try {
          if (kind === 'b64') out.value = decode ? dec.decode(Uint8Array.from(atob(input.trim()), (c) => c.charCodeAt(0))) : btoa(bytesToBinary(enc.encode(input)));
          else if (kind === 'url') out.value = decode ? decodeURIComponent(input) : encodeURIComponent(input);
          else if (decode) {
            const hex = input.replace(/\s+/g, '');
            if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Hex must be pairs of digits 0-9 and a-f');
            out.value = dec.decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)));
          } else out.value = [...enc.encode(input)].map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
          out.value = '';
          toast(`Can't ${decode ? 'decode' : 'encode'} that: ${e.message}`, 'error');
        }
      };
      el.addEventListener('click', (e) => {
        if (e.target.dataset.act === 'enc') run(false);
        if (e.target.dataset.act === 'dec') run(true);
      });
    },
  },
  {
    id: 'hash',
    title: 'Checksums',
    desc: 'SHA-1, SHA-256, SHA-384, SHA-512 of text',
    html: `<div class="field"><label for="hash-in">Text</label><textarea id="hash-in" rows="3"></textarea></div><div id="hash-out" class="out"></div>`,
    wire(el) {
      const out = $('#hash-out', el);
      let t = null;
      $('#hash-in', el).addEventListener('input', (e) => {
        clearTimeout(t);
        t = setTimeout(async () => {
          if (!crypto.subtle) {
            out.innerHTML = `<p class="muted">Checksums need a secure page. Open Outpost at <code>http://localhost</code> on the Mac itself.</p>`;
            return;
          }
          const data = enc.encode(e.target.value);
          const rows = [];
          for (const algo of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
            const digest = new Uint8Array(await crypto.subtle.digest(algo, data));
            rows.push(`<p><strong>${algo}</strong><br>${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}</p>`);
          }
          out.innerHTML = rows.join('');
        }, 150);
      });
    },
  },
  {
    id: 'json',
    title: 'JSON',
    desc: 'Check, indent or compact JSON',
    html: `<div class="field"><label for="json-in">JSON</label><textarea id="json-in" rows="7" spellcheck="false"></textarea></div>
      <div class="row"><button class="btn primary" data-act="fmt" type="button">Indent</button><button class="btn" data-act="min" type="button">Compact</button></div><p id="json-msg" class="muted" style="margin-top:10px" aria-live="polite"></p>`,
    wire(el) {
      el.addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act !== 'fmt' && act !== 'min') return;
        const ta = $('#json-in', el);
        const msg = $('#json-msg', el);
        try {
          const v = JSON.parse(ta.value);
          ta.value = act === 'fmt' ? JSON.stringify(v, null, 2) : JSON.stringify(v);
          msg.textContent = 'Valid JSON.';
          msg.className = 'muted';
        } catch (err) {
          msg.textContent = `Not valid JSON: ${err.message}`;
          msg.className = 'error-text';
        }
      });
    },
  },
  {
    id: 'time',
    title: 'Dates and Unix time',
    desc: 'Convert between epoch seconds and readable dates',
    html: `<div class="row"><div class="grow"><label for="ts-in">Unix time (seconds or milliseconds) or a date</label><input id="ts-in" placeholder="1767225600 or 2026-01-01T00:00:00Z"></div>
      <button class="btn" data-act="now" type="button">Use now</button></div><div id="ts-out" class="out" style="margin-top:12px"></div>`,
    wire(el) {
      const out = $('#ts-out', el);
      const input = $('#ts-in', el);
      const show = () => {
        const raw = input.value.trim();
        if (!raw) {
          out.innerHTML = '';
          return;
        }
        let d;
        if (/^-?\d+(\.\d+)?$/.test(raw)) {
          const n = Number(raw);
          d = new Date(Math.abs(n) < 1e11 ? n * 1000 : n);
        } else d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          out.innerHTML = '<span class="error-text">That isn’t a date or timestamp I can read.</span>';
          return;
        }
        out.innerHTML = `<p><strong>Your time zone</strong><br>${esc(d.toString())}</p><p><strong>UTC</strong><br>${esc(d.toUTCString())}</p><p><strong>ISO 8601</strong><br>${esc(d.toISOString())}</p><p><strong>Unix seconds</strong><br>${Math.floor(d.getTime() / 1000)}</p>`;
      };
      input.addEventListener('input', show);
      el.addEventListener('click', (e) => {
        if (e.target.dataset.act === 'now') {
          input.value = String(Math.floor(Date.now() / 1000));
          show();
        }
      });
    },
  },
  {
    id: 'password',
    title: 'Password generator',
    desc: 'Random passwords made on this device',
    html: `<div class="row"><div><label for="pw-len">Length: <span id="pw-n">20</span></label><input id="pw-len" type="range" min="8" max="64" value="20"></div></div>
      <div class="row" style="margin:10px 0"><label class="check"><input type="checkbox" id="pw-lower" checked><span>a–z</span></label><label class="check"><input type="checkbox" id="pw-upper" checked><span>A–Z</span></label>
      <label class="check"><input type="checkbox" id="pw-digit" checked><span>0–9</span></label><label class="check"><input type="checkbox" id="pw-sym"><span>Symbols</span></label></div>
      <div class="row"><button class="btn primary" data-act="gen" type="button">Generate</button><button class="btn" data-copy="pw-out" type="button">Copy</button></div>
      <div class="field" style="margin-top:12px"><input id="pw-out" readonly aria-label="Generated password" class="out"></div>`,
    wire(el) {
      const len = $('#pw-len', el);
      const gen = () => {
        const sets = [['pw-lower', 'abcdefghijklmnopqrstuvwxyz'], ['pw-upper', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'], ['pw-digit', '0123456789'], ['pw-sym', '!@#$%^&*()-_=+[]{};:,.?']]
          .filter(([id]) => $(`#${id}`, el).checked)
          .map(([, chars]) => chars);
        if (!sets.length) return toast('Choose at least one kind of character', 'error');
        const all = sets.join('');
        const chars = sets.map((s) => s[randomInt(s.length)]); // guarantee one of each chosen kind
        while (chars.length < Number(len.value)) chars.push(all[randomInt(all.length)]);
        for (let i = chars.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [chars[i], chars[j]] = [chars[j], chars[i]];
        }
        $('#pw-out', el).value = chars.join('');
      };
      len.addEventListener('input', () => ($('#pw-n', el).textContent = len.value));
      el.addEventListener('click', (e) => e.target.dataset.act === 'gen' && gen());
      gen();
    },
  },
];

/** The other entries under CyberChef: pages of their own. */
const MORE = `<li><span class="lamp ok" role="img" aria-label="Available"></span><div><strong>Accounts</strong><p>Who can sign in, admins and members, your password.</p></div>
    <div><a class="btn" href="#account">Open</a></div></li>
    <li><span class="lamp ok" role="img" aria-label="Available"></span><div><strong>Updates</strong><p>Opt-in: look for newer Outpost, book and model versions once a day. Off unless you turn it on.</p></div>
    <div><a class="btn" href="#updates">Open</a></div></li>
    <li><span class="lamp ok" role="img" aria-label="Available"></span><div><strong>Benchmark</strong><p>How fast this Mac handles hashing, compression, disk, memory and AI. Results stay on this Mac.</p></div>
    <div><a class="btn" href="#benchmark">Open</a></div></li>`;

export async function viewTools(root) {
  root.innerHTML = `<h1>Tools</h1><p class="lead">Calculators, a unit converter and other small utilities that run in this page. Nothing you type is sent anywhere.</p>
    <div id="cyberchef"></div>
    ${TOOLS.map((t) => `<details class="tool" id="tool-${t.id}"><summary><strong>${esc(t.title)}</strong><span class="muted">${esc(t.desc)}</span></summary><div class="inner">${t.html}</div></details>`).join('')}`;
  for (const t of TOOLS) t.wire($(`#tool-${t.id} .inner`, root));
  root.addEventListener('click', async (e) => {
    const id = e.target.dataset?.copy;
    if (!id) return;
    const el = $(`#${id}`, root);
    try {
      await navigator.clipboard.writeText(el.value);
      toast('Copied');
    } catch {
      el.select();
      toast('Press Cmd+C to copy', 'info');
    }
  });
  $('details', root).open = true;

  // CyberChef: GCHQ's toolkit for encoding, encryption, compression and data analysis, served by Outpost once installed.
  const box = $('#cyberchef', root);
  let poll = null;
  async function paintCyberChef() {
    const [version, install] = await Promise.all([api('/status').then((s) => s.tools.cyberchef, () => null), api('/install/cyberchef').catch(() => ({ job: null }))]);
    const action = version
      ? '<a class="btn primary" href="/tools/cyberchef/" target="_blank" rel="noopener">Open CyberChef</a>'
      : install.job
        ? '<button class="btn primary" type="button" disabled>Installing…</button>'
        : '<button class="btn primary admin-only" type="button" id="cc-install">Install</button>';
    const note = version ? '' : install.job ? ` ${esc(install.job.message || 'Starting')}. Follow it under Transfers.` : ' About 80 MB.<span class="member-only"> An admin can install it here.</span>';
    box.innerHTML = `<ul class="ready"><li><span class="lamp ${version ? 'ok' : 'idle'}" role="img" aria-label="${version ? 'Installed' : 'Not installed'}"></span>
    <div><strong>CyberChef</strong> <span class="muted">${version ? esc(version) : install.job ? 'installing' : 'not installed'}</span>
      <p>Hundreds of operations for encoding, encryption, compression, hashing and data analysis, running offline in your browser.${note}</p></div>
    <div>${action}</div></li>${MORE}</ul>`;
    clearTimeout(poll);
    if (install.job && box.isConnected) poll = setTimeout(paintCyberChef, 2500);
  }
  box.addEventListener('click', async (e) => {
    if (e.target.id !== 'cc-install') return;
    const why = 'Outpost downloads the pinned CyberChef release from GitHub, keeps it only if its SHA-256 matches, and serves it here behind the same sign-in.';
    try {
      if (await installAddon('cyberchef', 'CyberChef', why)) paintCyberChef();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  await paintCyberChef();
}
