import { $, api, esc } from './core.js';
import { md } from './md.js';

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

/** The setup guide (docs/SETUP.md), with this Outpost's own sharing status on top and a list of sections. */
export async function viewGuide(root) {
  root.innerHTML = `<div class="guide"><aside class="guide-toc"><p class="muted">Loading…</p></aside><article class="guide-body"></article></div>`;
  const [text, s] = await Promise.all([fetch('/guide.md').then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))), api('/status').catch(() => null)]);
  const body = $('.guide-body', root);
  body.innerHTML = md(text);

  // Right now: is this Outpost shared, and at which address?
  if (s) {
    const shared = !LOOPBACK.includes(s.listen.host);
    const links = (s.listen.lan ?? []).map((ip) => `<code>http://${esc(ip)}:${s.listen.port}</code>`);
    const now = document.createElement('div');
    now.className = 'note-box';
    now.innerHTML = shared
      ? `<b>This Outpost is shared.</b> Other devices on the same Wi-Fi can open ${links.length ? links.join(' or ') : 'it once the Mac joins a network'}${s.auth ? ' and sign in.' : '.'}`
      : `<b>This Outpost is not shared yet:</b> only this Mac can open it. Part 3 below turns sharing on.`;
    body.querySelector('h2')?.after(now);
  }

  // Number-free anchors for each part, listed on the side.
  const heads = [...body.querySelectorAll('h3')];
  heads.forEach((h, i) => (h.id = `part-${i + 1}`));
  $('.guide-toc', root).innerHTML = `<nav aria-label="Guide sections"><strong>In this guide</strong><ol>${heads
    .map((h) => `<li><a href="#guide/${h.id}">${esc(h.textContent.replace(/^\d+\.\s*/, ''))}</a></li>`)
    .join('')}</ol><button class="btn small" type="button" id="print-guide">Print</button></nav>`;
  $('#print-guide', root).addEventListener('click', () => window.print());
  $('.guide-toc', root).addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#guide/"]');
    if (!a) return;
    e.preventDefault();
    $(`#${a.getAttribute('href').split('/')[1]}`, root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
