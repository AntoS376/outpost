import { $, api, esc, jsonBody, toast } from './core.js';

const STATUS = { safe: 'Safe', help: 'Needs help', coming: 'On the way' };
const ago = (at) => {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

/** "Who's safe": your status for everyone on this Outpost, and theirs, refreshed every 10 seconds. Returns a stop function. */
export function mountCheckin(box) {
  box.innerHTML = `<h2>Who’s safe</h2>
    <p class="muted" style="max-width:70ch">Tell everyone signed in to this Outpost how you are, and see who hasn’t said yet. Kept in memory only; a line goes away after a day.</p>
    <div class="row safebtns"><button class="btn safe-safe" type="button" data-st="safe">I’m safe</button>
      <button class="btn safe-help" type="button" data-st="help">I need help</button>
      <button class="btn" type="button" data-st="coming">I’m on my way</button></div>
    <div class="field"><label for="safenote">Note (optional, sent with your status)</label><input id="safenote" maxlength="140" placeholder="e.g. At home, no damage" autocomplete="off"></div>
    <ul class="safelist" id="safelist"><li class="muted">Loading…</li></ul>`;
  const list = $('#safelist', box);

  async function refresh() {
    let data;
    try {
      data = await api('/checkin');
    } catch (e) {
      list.innerHTML = `<li class="error-text">${esc(e.message)}</li>`;
      return;
    }
    const lines = data.people.map((l) => `<li><span class="safe-st ${l.status}">${STATUS[l.status]}</span><b>${esc(l.name)}${l.name === data.me ? ' (you)' : ''}</b>
      ${l.note ? `<span>${esc(l.note)}</span>` : ''}<span class="muted small">${ago(l.at)}</span>
      ${l.name === data.me ? '<button class="btn small" type="button" id="safeclear">Clear</button>' : ''}</li>`);
    const missing = data.everyone.filter((n) => !data.people.some((l) => l.name === n));
    if (missing.length) lines.push(`<li class="muted">Not checked in yet: ${missing.map(esc).join(', ')}</li>`);
    list.innerHTML = lines.join('') || '<li class="muted">Nobody has checked in yet.</li>';
  }

  box.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-st]')?.dataset.st;
    try {
      if (st) {
        await api('/checkin/me', jsonBody({ status: st, note: $('#safenote', box).value }, 'PUT'));
        toast(`Everyone sees: ${STATUS[st]}`);
      } else if (e.target.id === 'safeclear') {
        await api('/checkin/me', { method: 'DELETE' });
      } else return;
    } catch (err) {
      return toast(err.message, 'error');
    }
    refresh();
  });
  refresh();
  const timer = setInterval(refresh, 10_000);
  return () => clearInterval(timer);
}
