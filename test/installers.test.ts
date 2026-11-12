import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { InstallerService, progressText } from '../src/services/installers.js';
import { freePort, listen, mockOllama, tmpHome, waitFor } from './helpers.js';

/** Outpost with an admin (anna), a member (ben), and stand-ins for the two install scripts. */
async function setup() {
  const h = await tmpHome();
  const scripts = path.join(h, 'scripts');
  await fsp.mkdir(scripts);
  const script = (name: string, body: string) => fs.writeFileSync(path.join(scripts, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Proves it got Outpost's data folder, takes a moment (so a second click can join it), and succeeds.
  script('install-kolibri.sh', 'echo "Downloading Kolibri 0.19.5 (about 100 MB)..."; sleep 1; touch "$OUTPOST_HOME/kolibri-ran"; echo "Kolibri installed."');
  script('fetch-cyberchef.sh', 'echo "Downloading CyberChef v11.5.0..."; echo "Error: The download\'s checksum is wrong. Nothing was installed." >&2; exit 1');
  const ollama = mockOllama();
  const op = await listen(ollama);
  const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
  made.ctx.installers = new InstallerService(made.ctx.cfg, made.ctx.jobs, scripts);
  const s = http.createServer(made.app);
  const base = `http://127.0.0.1:${await listen(s)}`;
  const cookies: Record<string, string> = {};
  const call = async (who: string, p: string, method = 'GET', json?: unknown) => {
    const r = await fetch(base + p, { method, headers: { ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookies[who] = set.split(';')[0]!;
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' });
  await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
  await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
  await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });
  const finished = (id: string) =>
    waitFor(async () => {
      const j = (await call('anna', '/api/jobs')).json.jobs.find((x: { id: string }) => x.id === id);
      return j.status !== 'running' && j;
    });
  return {
    h,
    scripts,
    call,
    finished,
    close: async () => {
      await made.ctx.kiwix.stop();
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    },
  };
}

describe('installing Kolibri and CyberChef from their pages', () => {
  it('runs the install script only for an admin who confirmed exactly that command', async () => {
    const t = await setup();
    try {
      const { command, job: idle } = (await t.call('ben', '/api/install/kolibri')).json;
      assert.equal(command, path.join(t.scripts, 'install-kolibri.sh'), 'members may see what would run');
      assert.equal(idle, null);
      assert.equal((await t.call('ben', '/api/install/kolibri', 'POST', { confirm: command })).status, 403, 'but only an admin installs');
      assert.equal((await t.call('anna', '/api/install/other', 'POST', { confirm: command })).status, 404);
      assert.equal((await t.call('ben', '/api/install/mapfonts')).json.command, path.join(t.scripts, 'fetch-map-assets.sh'), 'map fonts install the same way');
      assert.equal((await t.call('anna', '/api/install/kolibri', 'POST', { confirm: 'rm -rf ~' })).status, 409, 'what runs is what was shown');
      assert.ok(!fs.existsSync(path.join(t.h, 'kolibri-ran')), 'nothing ran yet');

      const first = (await t.call('anna', '/api/install/kolibri', 'POST', { confirm: command })).json.job;
      const again = (await t.call('anna', '/api/install/kolibri', 'POST', { confirm: command })).json.job;
      assert.equal(again.id, first.id, 'a second click joins the install in progress');
      assert.equal((await t.call('anna', '/api/install/kolibri')).json.job.id, first.id, 'the page can show it is installing');

      const job = await t.finished(first.id);
      assert.equal(job.status, 'done', job.error);
      assert.equal(job.label, 'Install Kolibri');
      assert.match(job.message, /Kolibri is installed/);
      assert.ok(fs.existsSync(path.join(t.h, 'kolibri-ran')), "the script got Outpost's data folder");
      assert.equal((await t.call('anna', '/api/install/kolibri')).json.job, null);
    } finally {
      await t.close();
    }
  });

  it("explains a failed install with the script's own error", async () => {
    const t = await setup();
    try {
      const { command } = (await t.call('anna', '/api/install/cyberchef')).json;
      const started = (await t.call('anna', '/api/install/cyberchef', 'POST', { confirm: command })).json.job;
      const job = await t.finished(started.id);
      assert.equal(job.status, 'error');
      assert.equal(job.error, "The download's checksum is wrong. Nothing was installed.");
    } finally {
      await t.close();
    }
  });

  it("shows curl's progress bar as a percentage, and other lines as they are", () => {
    assert.equal(progressText('######                                                       27.7%'), 'Downloading: 27%');
    assert.equal(progressText('######################################################################## 100.0%'), 'Downloading: 100%');
    assert.equal(progressText('==> Downloading Homebrew API data'), '==> Downloading Homebrew API data');
  });
});
