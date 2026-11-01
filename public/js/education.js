import { $, api, esc, toast, contentBase } from './core.js';

const LABEL = { 'not-installed': 'Not installed', 'python-missing': 'Needs repair', stopped: 'Stopped', starting: 'Starting', running: 'Running', crashed: 'Stopped working' };
const LAMP = { running: 'ok', starting: 'idle', stopped: 'idle', 'not-installed': 'idle', 'python-missing': 'warn', crashed: 'warn' };

/** Kolibri: offline courses, videos and exercises, run by Outpost. */
export async function viewEducation(root) {
  root.innerHTML = `<h1>Education</h1>
    <p class="lead">Courses, videos and exercises for learners of all ages, through <a href="https://learningequality.org/kolibri/" target="_blank" rel="noopener">Kolibri</a>. Outpost runs it on this Mac and keeps it behind the same sign-in.</p>
    <div id="edu-body"><p class="muted">Checking…</p></div>`;
  const body = $('#edu-body', root);
  let busy = false;

  async function render() {
    let s;
    try {
      s = await api('/education');
    } catch (e) {
      body.innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
      return;
    }
    const installed = s.state !== 'not-installed' && s.state !== 'python-missing';
    const on = s.state === 'running' || s.state === 'starting';
    body.innerHTML = `<ul class="ready"><li><span class="lamp ${LAMP[s.state]}" role="img" aria-label="${LABEL[s.state]}"></span>
        <div><strong>Kolibri: ${LABEL[s.state]}</strong><p>${s.message ? esc(s.message) : on ? 'Ready.' : 'Start it when you want to use it. Outpost remembers and starts it again after a restart.'}</p></div>
        <div class="row">${installed ? `<span class="admin-only">${on ? '<button class="btn" type="button" id="stop">Stop</button>' : '<button class="btn primary" type="button" id="start">Start</button>'}</span>` : ''}
          ${s.state === 'running' ? `<a class="btn primary" href="${esc((await contentBase()) + s.url)}" target="_blank" rel="noopener">Open Kolibri</a>` : ''}</div></li></ul>
      ${installed ? '' : `<section class="block"><h2>Install</h2><p>In Terminal, in the Outpost folder, run:</p><pre><code>./scripts/install-kolibri.sh</code></pre>
        <p class="muted">It puts Kolibri in <code>~/Outpost/kolibri-venv</code> without needing an administrator password. Kolibri needs Python 3.10 to 3.14; if this Mac has none, the script installs Python 3.13 with Homebrew. About 150 MB.</p></section>`}
      <section class="block"><h2>Good to know</h2><ul class="tips">
        <li>The first time you open Kolibri it asks you to set it up: choose a name for your learning facility and create an administrator account.</li>
        <li>Kolibri has its own accounts. Add learners and coaches in Kolibri under <b>Facility → Users</b>. They are separate from the Outpost sign-in.</li>
        <li>Add courses in Kolibri under <b>Device → Channels → Import</b>, while you are online. Kolibri downloads them from Kolibri Studio.</li>
        <li>Interactive activities (HTML5 apps) open on this Mac. Other devices on your network can use the rest of Kolibri through Outpost, but those activities need port ${s.zipPort} on this Mac, which stays private.</li>
      </ul></section>`;
  }

  body.addEventListener('click', async (e) => {
    if (busy || !['start', 'stop'].includes(e.target.id)) return;
    busy = true;
    e.target.disabled = true;
    e.target.textContent = e.target.id === 'start' ? 'Starting…' : 'Stopping…';
    try {
      await api(`/education/${e.target.id}`, { method: 'POST' });
    } catch (err) {
      toast(err.message, 'error');
    }
    busy = false;
    render();
  });

  await render();
  const timer = setInterval(render, 4000);
  return () => clearInterval(timer);
}
