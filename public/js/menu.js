import { $, $$, esc } from './core.js';

/**
 * Phones: the bottom bar keeps Home, Library, Chat, Maps, SOS and More; More opens every section under the same
 * headings as the desktop menu, built from that menu so the two never drift apart.
 */
export function startMoreMenu() {
  const rail = $('.rail');
  const btn = $('#more-btn');
  const sheet = $('#moresheet');

  const chip = (a, label = a.querySelector('.label-full, span')?.textContent) =>
    `<a href="${a.getAttribute('href')}" data-route="${a.dataset.route}">${a.querySelector('svg').outerHTML}<span>${esc(label)}</span></a>`;

  function build() {
    const groups = [];
    for (const el of rail.children) {
      if (el.classList.contains('railsec')) groups.push({ name: el.textContent, links: [] });
      else if (el.matches('a[data-route]') && groups.length && el.dataset.route !== 'home') groups.at(-1).links.push(chip(el));
    }
    const ready = groups.find((g) => g.name === 'Be ready');
    ready?.links.unshift(chip($('.railsos', rail), 'Emergency'));
    const jobs = $('#jobs-badge');
    const transfers = `<button type="button" data-transfers>${$('#jobs-btn svg').outerHTML}<span>Transfers${jobs.hidden ? '' : ` · ${esc(jobs.textContent)}`}</span></button>`;
    const account = `<a href="#account" data-route="account"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg><span>Account</span></a>`;
    groups.push({ name: 'You', links: [transfers, account] });
    sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>${groups.map((g) => `<p class="railsec">${esc(g.name)}</p><div class="chips">${g.links.join('')}</div>`).join('')}`;
    const current = document.body.dataset.route;
    $$('a[data-route]', sheet).forEach((a) => a.dataset.route === current && a.setAttribute('aria-current', 'page'));
  }

  const setOpen = (open) => {
    if (open) {
      build();
      sheet.style.setProperty('--barh', `${rail.offsetHeight}px`);
    }
    sheet.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(sheet.hidden);
  });
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-transfers]')) {
      setOpen(false);
      $('#jobs-btn').click();
    } else if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('click', (e) => !sheet.hidden && !sheet.contains(e.target) && setOpen(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !sheet.hidden && setOpen(false));
  window.addEventListener('hashchange', () => setOpen(false));
}
