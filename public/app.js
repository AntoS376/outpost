import { $, $$, api, startJobsUI, store, toast } from './js/core.js';
import { viewHome } from './js/home.js';
import { viewLibrary } from './js/library.js';
import { viewAi } from './js/ai.js';
import { viewMaps } from './js/maps.js';
import { viewNotes } from './js/notes.js';
import { viewTools } from './js/tools.js';
import { viewSetup } from './js/setup.js';
import { viewEducation } from './js/education.js';
import { viewBenchmark } from './js/benchmark.js';
import { viewAccount } from './js/account.js';
import { viewUpdates } from './js/updates.js';
import { viewEmergency } from './js/emergency.js';
import { viewApps } from './js/apps.js';
import { viewGuide } from './js/guide.js';
import { viewDocuments } from './js/documents.js';
import { viewGames } from './js/games.js';
import { viewReady } from './js/ready.js';
import { viewRadio } from './js/radio.js';
import { startSosWatch } from './js/sos.js';

const routes = { home: viewHome, library: viewLibrary, ai: viewAi, maps: viewMaps, notes: viewNotes, tools: viewTools, setup: viewSetup, education: viewEducation, benchmark: viewBenchmark, account: viewAccount, updates: viewUpdates, emergency: viewEmergency, apps: viewApps, guide: viewGuide, documents: viewDocuments, games: viewGames, ready: viewReady, radio: viewRadio };
// Views that need the full window height (the content scrolls inside, not the page).
const fills = { library: (sub) => sub !== 'manage', ai: () => true, maps: () => true, notes: () => true };

const LABELS = { home: 'Home', library: 'Library', ai: 'Assistant', maps: 'Maps', education: 'Education', notes: 'Notes', tools: 'Tools', setup: 'Setup', benchmark: 'Benchmark', account: 'Accounts', updates: 'Updates', emergency: 'Emergency', apps: 'Apps', guide: 'Guide', documents: 'Documents', games: 'Games', ready: 'Preparedness', radio: 'Radio' };
const main = $('#main');

// Header status: is the Outpost server answering?
async function heartbeat() {
  const el = $('#srvstate');
  const ok = await fetch('/healthz', { cache: 'no-store' }).then((r) => r.ok, () => false);
  el.classList.toggle('down', !ok);
  el.lastElementChild.textContent = ok ? 'Running' : 'Not answering';
}
setInterval(heartbeat, 10_000);

// Header battery meter for the Mac Outpost runs on; stays hidden on Macs without a battery.
async function battery() {
  const el = $('#battery');
  const b = await fetch('/api/status/battery', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
  el.hidden = !b?.present;
  if (el.hidden) return;
  const pct = b.percent;
  const time = b.minutes ? `${Math.floor(b.minutes / 60)} h ${b.minutes % 60} min` : '';
  const state = b.charging ? `charging${time ? `, ${time} until full` : ''}` : b.plugged ? 'plugged in' : time ? `${time} left` : 'on battery';
  el.setAttribute('aria-label', `Battery ${pct}%, ${state}`);
  el.title = `Battery ${pct}%, ${state}`;
  el.classList.toggle('low', pct <= 20 && !b.plugged);
  el.classList.toggle('charging', b.charging || b.plugged);
  el.querySelector('.level').setAttribute('width', String((19 * pct) / 100));
  el.lastElementChild.textContent = `${pct}%`;
}
battery();
setInterval(battery, 60_000);
let cleanup = null;
let token = 0;

async function route() {
  const [name, sub] = (location.hash.slice(1) || 'home').split('/');
  const key = routes[name] ? name : 'home';
  document.body.dataset.route = key;
  const mine = ++token;
  if (cleanup) {
    try {
      await cleanup();
    } catch {
      /* leaving the old view must never block the new one */
    }
    cleanup = null;
  }
  $$('.rail a[data-route]').forEach((a) => (a.dataset.route === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  main.className = fills[key]?.(sub) ? 'fill' : '';
  main.scrollTop = 0;
  main.innerHTML = '<div class="page"></div>';
  document.title = `${key === 'home' ? '' : `${LABELS[key] ?? key} - `}Outpost`;
  $('#where').textContent = LABELS[key] ?? key;
  try {
    const result = await routes[key]($('.page', main), sub);
    if (mine !== token) await result?.(); // the user navigated away while this view was loading
    else cleanup = result ?? null;
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Who is signed in decides what this page offers; the server enforces the same rules.
try {
  const me = await api('/auth/me');
  document.body.dataset.role = me.user?.role ?? 'member';
  if (me.mode !== 'open' && me.user) {
    const who = $('#whoami');
    who.hidden = false;
    who.innerHTML = `Signed in as <a href="#account">${me.user.name.replace(/[<>&"]/g, '')}</a>`;
  }
} catch {
  /* api() sends people who aren't signed in to the login page */
}
// Header: is Outpost on the Wi-Fi, and at which address?
api('/status')
  .then((s) => {
    const pill = $('#netpill');
    const shared = !['127.0.0.1', '::1', 'localhost'].includes(s.listen.host);
    const ip = s.listen.lan?.[0];
    pill.className = `pill netpill${shared ? ' live' : ''}`;
    pill.innerHTML = shared && ip ? '<i aria-hidden="true"></i>Broadcasting on Wi-Fi' : '<i aria-hidden="true"></i>This Mac only';
    pill.hidden = false;
    const addr = $('#netip');
    addr.textContent = shared && ip ? ip.replace(/[^\d.]/g, '') : '';
    addr.hidden = !(shared && ip);
  })
  .catch(() => undefined);
// Light / Dark / Auto: remembered on this device (public/theme.js applies it before the page draws).
const THEMES = {
  auto: { next: 'light', label: 'Auto', says: 'follows this device', icon: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>' },
  light: { next: 'dark', label: 'Light', says: 'always light', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  dark: { next: 'auto', label: 'Dark', says: 'always dark', icon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>' },
};
function paintTheme(theme) {
  const t = THEMES[theme] ?? THEMES.auto;
  const btn = $('#theme');
  btn.querySelector('svg').innerHTML = t.icon;
  btn.querySelector('span').textContent = t.label;
  btn.title = `Appearance: ${t.label} (${t.says}). Click for ${THEMES[t.next].label}.`;
  btn.setAttribute('aria-label', btn.title);
}
paintTheme(store.get('outpost.theme', 'auto'));
$('#theme').addEventListener('click', () => {
  const theme = THEMES[store.get('outpost.theme', 'auto')]?.next ?? 'auto';
  store.set('outpost.theme', theme);
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.cookie = `outpost_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
  paintTheme(theme);
  window.dispatchEvent(new Event('outpost:theme'));
});
// Shutdown (admins): asks first, then stops Outpost and says how to start it again.
$('#shutdown').addEventListener('click', () => {
  const dlg = document.createElement('dialog');
  dlg.className = 'cmd-dialog';
  dlg.innerHTML = `<form method="dialog"><h2>Shut down Outpost?</h2>
    <p>Outpost stops for everyone using it, on this Mac and on other devices, along with the library reader, Education and any apps. Downloads in progress stop too.</p>
    <p class="muted">To start it again on this Mac, double-click <b>Start Outpost.command</b> in the Outpost folder, or log out and back in.</p>
    <div class="row"><button class="btn" value="no" autofocus>Cancel</button><button class="btn danger" value="yes">Shut down</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', async () => {
    const yes = dlg.returnValue === 'yes';
    dlg.remove();
    if (!yes) return;
    try {
      await api('/shutdown', { method: 'POST' });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    window.removeEventListener('hashchange', route);
    $('#main').className = '';
    $('#main').innerHTML = `<div class="page stopped-page"><div class="card"><h1>Outpost is shut down</h1>
      <p>Nobody can open it until it starts again.</p>
      <p>On this Mac, double-click <b>Start Outpost.command</b> in the Outpost folder, or log out and back in. You can close this tab.</p></div></div>`;
  });
  dlg.showModal();
});
startJobsUI();
startSosWatch();
window.addEventListener('hashchange', route);
// First launch with nothing installed: open the setup wizard instead of an empty Home.
if (!location.hash) {
  try {
    if ((await api('/setup/status')).show) history.replaceState(null, '', '#setup');
  } catch {
    /* Home explains what is missing */
  }
}
route();
