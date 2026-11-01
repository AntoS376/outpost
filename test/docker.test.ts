import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, here, listen, makeExecutable, mockOllama, tmpHome, waitFor } from './helpers.js';

/** Outpost with accounts anna (admin) and ben (member), and the fake docker. */
async function setup(env: Record<string, string>) {
  const h = await tmpHome();
  const docker = path.join(h, 'docker');
  makeExecutable(`${here}/fixtures/fake-docker.mjs`, docker);
  const stateFile = path.join(h, 'docker-state.json');
  // Something on this Mac that Outpost didn't make: it must never be listed or touched.
  fs.writeFileSync(stateFile, JSON.stringify({ calls: [], containers: [{ name: 'outpost-mine', image: 'postgres', state: 'running', labels: ['other=1'], ports: '' }, { name: 'web', image: 'nginx', state: 'running', labels: [], ports: '0.0.0.0:80->80/tcp' }] }));
  process.env.FAKE_DOCKER_STATE = stateFile;
  const ollama = mockOllama();
  const op = await listen(ollama);
  const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, OUTPOST_DOCKER_BIN: docker, ...env }));
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
  const fake = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { calls: string[][]; containers: { name: string; state: string; args: string[] }[] };
  return {
    h,
    docker,
    call,
    fake,
    close: async () => {
      s.closeAllConnections();
      s.close();
      ollama.close();
      delete process.env.FAKE_DOCKER_STATE;
      await fsp.rm(h, { recursive: true, force: true });
    },
  };
}

const spec = { image: 'nginx:1.27', name: 'web', port: 80, hostPort: 8100, env: [{ key: 'TZ', value: 'Asia/Beirut' }], folders: [{ folder: 'html', target: '/usr/share/nginx/html', readOnly: true }] };

describe('docker apps', () => {
  it('stays off, running nothing, unless OUTPOST_DOCKER=1', async () => {
    const t = await setup({});
    try {
      const st = (await t.call('anna', '/api/docker')).json;
      assert.equal(st.enabled, false);
      assert.deepEqual(st.containers, []);
      assert.equal((await t.call('anna', '/api/docker/preview', 'POST', { spec })).status, 200, 'the form can still be checked');
      assert.equal((await t.call('anna', '/api/docker', 'POST', { spec, confirm: 'x' })).status, 409);
      assert.deepEqual(t.fake().calls, [], 'docker never ran');
    } finally {
      await t.close();
    }
  });

  it('has an admin-only switch that saves OUTPOST_DOCKER to the settings file', async () => {
    const dir = await tmpHome();
    const envFile = path.join(dir, 'settings', 'env');
    const u = await setup({ OUTPOST_ENV_FILE: envFile });
    try {
      assert.equal((await u.call('ben', '/api/docker/enabled', 'POST', { on: true })).status, 403, 'members cannot');
      const r = await u.call('anna', '/api/docker/enabled', 'POST', { on: true });
      assert.equal(r.status, 200);
      assert.equal(r.json.restarting, false, 'not under launchd in tests');
      assert.match(fs.readFileSync(envFile, 'utf8'), /^OUTPOST_DOCKER=1$/m);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
      await u.call('anna', '/api/docker/enabled', 'POST', { on: false });
      assert.match(fs.readFileSync(envFile, 'utf8'), /^OUTPOST_DOCKER=0$/m);
      assert.deepEqual(u.fake().calls, [], 'docker never ran');
    } finally {
      await u.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('says how to get Docker when the command is missing', async () => {
    const t = await setup({ OUTPOST_DOCKER: '1', OUTPOST_DOCKER_BIN: '/nowhere/docker' });
    try {
      const st = (await t.call('anna', '/api/docker')).json;
      assert.equal(st.cli, null);
      assert.deepEqual(st.help.map((x: any) => x.name), ['Docker Desktop', 'OrbStack']);
      assert.equal((await t.call('anna', '/api/docker', 'POST', { spec, confirm: 'x' })).status, 412);
    } finally {
      await t.close();
    }
  });

  it('notices when Docker is installed but not running', async () => {
    const t = await setup({ OUTPOST_DOCKER: '1' });
    process.env.FAKE_DOCKER_DOWN = '1';
    try {
      const st = (await t.call('anna', '/api/docker')).json;
      assert.equal(st.running, false);
      assert.equal(st.engine, 'OrbStack');
    } finally {
      delete process.env.FAKE_DOCKER_DOWN;
      await t.close();
    }
  });

  it('refuses anything beyond the form: privileges, host network, the socket, folders outside its own', async () => {
    const t = await setup({ OUTPOST_DOCKER: '1' });
    try {
      const preview = async (over: Record<string, unknown>) => t.call('anna', '/api/docker/preview', 'POST', { spec: { ...spec, ...over } });
      const refused: [Record<string, unknown>, RegExp][] = [
        [{ privileged: true }, /privileged/],
        [{ network: 'host' }, /host networking/],
        [{ capAdd: ['ALL'] }, /field/],
        [{ volumes: ['/:/host'] }, /only takes the fields/],
        [{ image: '--privileged' }, /image/],
        [{ image: 'Nginx' }, /image/],
        [{ image: 'nginx;rm' }, /image/],
        [{ name: '../x' }, /short name/],
        [{ hostPort: 80 }, /1024/],
        [{ hostPort: 8080 }, /already used/],
        [{ port: 0 }, /inside the container/],
        [{ env: [{ key: '1BAD', value: 'x' }] }, /valid setting/],
        [{ env: [{ key: 'A', value: 'two\nlines' }] }, /one line/],
        [{ folders: [{ folder: '../../..', target: '/data' }] }, /no "\.\."/],
        [{ folders: [{ folder: '/etc', target: '/data' }] }, /must be a folder inside|full path/],
        [{ folders: [{ folder: 'a', target: '/var/run/docker.sock' }] }, /Docker socket/],
        [{ folders: [{ folder: 'docker.sock', target: '/x' }] }, /Docker socket/],
        [{ folders: [{ folder: 'a', target: '/' }] }, /full path/],
        [{ folders: [{ folder: 'a', target: '/etc/passwd' }] }, /over \/etc/],
        [{ folders: [{ folder: 'a', target: 'data' }] }, /full path/],
      ];
      for (const [over, why] of refused) {
        const r = await preview(over);
        assert.equal(r.status >= 400, true, JSON.stringify(over));
        assert.match(r.json.error, why, JSON.stringify(over));
      }
      // A link inside the container's folder that points elsewhere is caught when it runs.
      fs.mkdirSync(path.join(t.h, 'containers', 'web'), { recursive: true });
      fs.symlinkSync('/tmp', path.join(t.h, 'containers', 'web', 'escape'));
      const sneaky = { ...spec, folders: [{ folder: 'escape', target: '/data' }] };
      const shown = (await t.call('anna', '/api/docker/preview', 'POST', { spec: sneaky })).json.command;
      const r = await t.call('anna', '/api/docker', 'POST', { spec: sneaky, confirm: shown });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /outside containers\/web/);
      assert.ok(!t.fake().calls.some((c) => c[0] === 'run'), 'docker run never happened');
    } finally {
      await t.close();
    }
  });

  it('runs exactly the confirmed command for an admin, and manages only its own containers', async () => {
    const t = await setup({ OUTPOST_DOCKER: '1' });
    try {
      assert.equal((await t.call('ben', '/api/docker')).status, 403, 'members see nothing');
      assert.equal((await t.call('ben', '/api/docker/preview', 'POST', { spec })).status, 403);
      assert.equal((await t.call('ben', '/api/docker', 'POST', { spec, confirm: 'x' })).status, 403);

      const st = (await t.call('anna', '/api/docker')).json;
      assert.equal(st.running, true);
      assert.equal(st.version, '28.1.1');
      assert.deepEqual(st.containers, [], "containers Outpost didn't make aren't listed");

      const { command, url } = (await t.call('anna', '/api/docker/preview', 'POST', { spec })).json;
      const html = path.join(t.h, 'containers', 'web', 'html');
      assert.equal(
        command,
        `${t.docker} run --detach --name outpost-web --label com.outpost.managed=true --label com.outpost.name=web --restart unless-stopped --publish 127.0.0.1:8100:80 --env TZ=Asia/Beirut --mount type=bind,source=${html},target=/usr/share/nginx/html,readonly nginx:1.27`,
      );
      assert.equal(url, 'http://localhost:8100/');
      assert.equal((await t.call('anna', '/api/docker', 'POST', { spec: { ...spec, hostPort: 8101 }, confirm: command })).status, 409, 'what runs is what was shown');

      const started = await t.call('anna', '/api/docker', 'POST', { spec, confirm: command });
      assert.equal(started.status, 202);
      const job = await waitFor(async () => {
        const j = (await t.call('anna', '/api/jobs')).json.jobs.find((x: any) => x.id === started.json.job.id);
        return j.status !== 'running' && j;
      });
      assert.equal(job.status, 'done', job.error);
      const ran = t.fake().containers.find((c) => c.name === 'outpost-web')!;
      assert.deepEqual([t.docker, ...ran.args].join(' '), command, 'the very arguments shown, no shell');
      assert.ok(fs.statSync(html).isDirectory(), 'its folder was made');
      assert.equal(fs.statSync(path.join(t.h, 'containers', 'web')).mode & 0o777, 0o700);

      assert.deepEqual((await t.call('anna', '/api/docker')).json.containers, [{ name: 'web', image: 'nginx:1.27', state: 'running', status: 'Up 2 minutes', hostPort: 8100 }]);
      assert.equal((await t.call('anna', '/api/docker', 'POST', { spec, confirm: command })).status, 409, 'one per name');

      assert.equal((await t.call('anna', '/api/docker/web/stop', 'POST')).status, 200);
      assert.equal((await t.call('anna', '/api/docker')).json.containers[0].state, 'exited');
      assert.equal((await t.call('anna', '/api/docker/web/start', 'POST')).status, 200);
      assert.equal((await t.call('anna', '/api/docker/web/logs')).json.logs, 'hello from outpost-web\na warning on stderr\n');
      assert.equal((await t.call('ben', '/api/docker/web/logs')).status, 403);
      assert.equal((await t.call('ben', '/api/docker/web/stop', 'POST')).status, 403);

      // Containers Outpost didn't label can't be reached through it, even with a matching name.
      for (const [p, m] of [['/api/docker/mine/stop', 'POST'], ['/api/docker/mine', 'DELETE'], ['/api/docker/mine/logs', 'GET']] as const) {
        assert.equal((await t.call('anna', p, m)).status, 404, p);
      }
      assert.equal((await t.call('anna', '/api/docker/web/restart', 'POST')).status, 404);

      assert.equal((await t.call('anna', '/api/docker/web', 'DELETE')).status, 200);
      assert.deepEqual((await t.call('anna', '/api/docker')).json.containers, []);
      assert.ok(fs.existsSync(html), 'removing keeps its files');
      assert.deepEqual(t.fake().containers.map((c) => c.name).sort(), ['outpost-mine', 'web'], 'the others are untouched');
      assert.ok(!t.fake().calls.some((c) => ['stop', 'start', 'rm', 'logs'].includes(c[0]!) && !c.includes('outpost-web')));
    } finally {
      await t.close();
    }
  });
});
