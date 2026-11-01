import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { showCommand, splitCommand } from '../src/services/apps.js';
import { freePort, here, listen, makeExecutable, mockOllama, tmpHome, waitFor, CONTENT_PATH } from './helpers.js';

describe('command lines', () => {
  it('splits like a shell for quotes and backslashes, without running one', () => {
    assert.deepEqual(splitCommand(`app --name "My files" --dir '/tmp/a b' x\\ y ""`), ['app', '--name', 'My files', '--dir', '/tmp/a b', 'x y', '']);
    assert.deepEqual(splitCommand('a; rm -rf ~'), ['a;', 'rm', '-rf', '~'], 'a semicolon is just a character');
    assert.throws(() => splitCommand('app "open'), /never closed/);
  });
  it('shows a command that pastes back into Terminal as the same arguments', () => {
    const argv = ['/opt/homebrew/bin/brew', 'install', 'it is', "o'k", '--x=1'];
    assert.equal(showCommand(argv), `/opt/homebrew/bin/brew install 'it is' 'o'\\''k' --x=1`);
  });
});

describe('apps shelf', () => {
  let h: string;
  let base: string;
  let contentUrl: string;
  let close: () => Promise<void>;
  let appPort: number;
  let bin: string;
  let files: http.Server;
  const cookies = new Map<string, string>();

  async function call(who: string, p: string, init: RequestInit & { json?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (cookies.get(who)) headers.Cookie = cookies.get(who)!;
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch((CONTENT_PATH.test(p) ? contentUrl : base) + p, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined, redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookies.set(who, set.split(';')[0]!);
    const t = await r.text();
    let json: any = t;
    try {
      json = JSON.parse(t);
    } catch {
      /* text */
    }
    return { status: r.status, headers: r.headers, json };
  }

  async function boot() {
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(
      loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, OUTPOST_APPS_FILE: path.join(h, 'catalog.json') }),
    );
    const s = http.createServer(made.app);
    base = `http://127.0.0.1:${await listen(s)}`;
    const cs = http.createServer(made.content);
    contentUrl = `http://127.0.0.1:${await listen(cs)}`;
    close = async () => {
      await Promise.all([made.ctx.kiwix.stop(), made.ctx.kolibri.stop(false), made.ctx.apps.stopAll()]);
      s.closeAllConnections();
      s.close();
      cs.closeAllConnections();
      cs.close();
      ollama.close();
    };
  }

  before(async () => {
    h = await tmpHome();
    appPort = await freePort();
    const tools = path.join(h, 'tools');
    await fsp.mkdir(tools);
    makeExecutable(path.join(here, 'fixtures', 'fake-brew.mjs'), path.join(tools, 'fake-brew'));
    fs.copyFileSync(path.join(here, 'fixtures', 'fake-app.mjs'), path.join(tools, 'fake-app.mjs'));
    bin = path.join(tools, 'files-app'); // appears only once "installed"
    // A release archive holding one program, served locally, for the pinned-download install.
    const stage = path.join(h, 'stage');
    await fsp.mkdir(stage);
    makeExecutable(path.join(here, 'fixtures', 'fake-app.mjs'), path.join(stage, 'dl-app'));
    await fsp.writeFile(path.join(stage, 'README.md'), 'not unpacked');
    execFileSync('/usr/bin/tar', ['-czf', path.join(h, 'dl.tgz'), '-C', stage, 'dl-app', 'README.md']);
    const tgz = await fsp.readFile(path.join(h, 'dl.tgz'));
    const sha = createHash('sha256').update(tgz).digest('hex');
    files = http.createServer((req, res) => res.end(req.url === '/good.tgz' ? tgz : Buffer.from('tampered')));
    const fp = await listen(files);
    const pinned = (file: string, sum: string) => ({ arm64: { url: `http://127.0.0.1:${fp}/${file}`, sha256: sum }, x64: { url: `http://127.0.0.1:${fp}/${file}`, sha256: sum }, extract: 'dl-app' });
    const dlApp = (id: string, download: object) => ({ id, name: id, description: 'Test download', download, bin: '{home}/bin/dl-app', args: ['--port', '{port}'], port: 0, prefix: false, members: 'read' });
    const catalog = {
      apps: [
        {
          id: 'files',
          name: 'Files',
          description: 'Test app',
          install: [path.join(tools, 'fake-brew'), 'install', bin],
          bin,
          args: ['--port', '{port}', '--baseURL', '{prefix}', '--root', '{home}/files'],
          folders: ['{home}/files'],
          port: appPort,
          prefix: true,
          health: '/health',
          members: 'read',
        },
      ],
    };
    (catalog as any).devices = [
      {
        id: 'maps',
        name: 'Maps app',
        what: 'Test',
        page: 'https://example.org/',
        platforms: [
          { label: 'Android', file: { url: `http://127.0.0.1:${fp}/good.tgz`, sha256: sha, size: tgz.length } },
          { label: 'Bad', file: { url: `http://127.0.0.1:${fp}/bad.tgz`, sha256: sha, size: tgz.length } },
          { label: 'iPhone', link: 'https://example.org/ios' },
        ],
      },
    ];
    catalog.apps.push(dlApp('tampered', pinned('bad.tgz', sha)) as any, dlApp('dl', pinned('good.tgz', sha)) as any);
    catalog.apps[1]!.port = await freePort();
    catalog.apps[2]!.port = await freePort();
    await fsp.writeFile(path.join(h, 'catalog.json'), JSON.stringify(catalog));
    await boot();
  });
  after(async () => {
    await close();
    files.close();
    await fsp.rm(h, { recursive: true, force: true });
  });

  it('installs only the exact command the admin confirmed', async () => {
    const [app] = (await call('admin', '/api/apps')).json.apps;
    assert.equal(app.installed, false);
    assert.equal(app.commands.install, `${path.join(h, 'tools', 'fake-brew')} install ${bin}`);
    assert.equal((await call('admin', '/api/apps/files/install', { method: 'POST', json: { command: 'rm -rf ~' } })).status, 409);
    assert.equal((await call('admin', '/api/apps/files/start', { method: 'POST', json: { command: app.commands.start } })).status, 409, "can't start before it's installed");
    const r = await call('admin', '/api/apps/files/install', { method: 'POST', json: { command: app.commands.install } });
    assert.equal(r.status, 200);
    const job = await waitFor(async () => {
      const j = (await call('admin', '/api/jobs')).json.jobs.find((x: any) => x.id === r.json.job.id);
      return j?.status === 'done' && j;
    });
    assert.equal(job.message, 'Files is installed');
    assert.equal((await call('admin', '/api/apps')).json.apps[0].installed, true);
  });

  it('starts on 127.0.0.1 after confirmation and serves it under /apps/<id>/ without the Outpost login', async () => {
    const [app] = (await call('admin', '/api/apps')).json.apps;
    assert.equal(app.commands.start, `${bin} --port ${appPort} --baseURL /apps/files --root ${h}/files`);
    assert.equal((await call('admin', '/api/apps/files/start', { method: 'POST', json: { command: app.commands.start.replace('/apps/files', '/x') } })).status, 409);
    assert.equal((await call('admin', '/api/apps/files/start', { method: 'POST', json: { command: app.commands.start } })).status, 200);
    await waitFor(async () => (await call('admin', '/api/apps')).json.apps[0].ready);
    assert.ok(fs.existsSync(path.join(h, 'files')), 'its folder was made');
    assert.equal((await call('admin', '/apps/files')).headers.get('location'), '/apps/files/');
    const echo = await call('admin', '/apps/files/api/resources?x=1', { method: 'POST' });
    assert.equal(echo.json.url, '/apps/files/api/resources?x=1');
    assert.equal(echo.json.authorization, null);
    assert.equal((await call('admin', '/apps/nope/')).status, 404);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'apps.json'), 'utf8')).running, ['files']);
  });

  it('installs a pinned download only when its SHA-256 matches, unpacking just the program', async () => {
    const install = async (id: string) => {
      const app = (await call('admin', '/api/apps')).json.apps.find((a: any) => a.id === id);
      assert.match(app.commands.install, new RegExp(`^Download http://.*\\nCheck its SHA-256 is [0-9a-f]{64}\\nUnpack dl-app into ${h}/bin$`));
      const r = await call('admin', `/api/apps/${id}/install`, { method: 'POST', json: { command: app.commands.install } });
      assert.equal(r.status, 200);
      return waitFor(async () => {
        const j = (await call('admin', '/api/jobs')).json.jobs.find((x: any) => x.id === r.json.job.id);
        return (j?.status === 'done' || j?.status === 'error') && j;
      });
    };
    const bad = await install('tampered');
    assert.equal(bad.status, 'error');
    assert.match(bad.error, /doesn't match its fingerprint/);
    assert.ok(!fs.existsSync(path.join(h, 'bin', 'dl-app')), 'nothing installed');
    const good = await install('dl');
    assert.equal(good.status, 'done', good.error);
    assert.equal(fs.statSync(path.join(h, 'bin', 'dl-app')).mode & 0o111, 0o111, 'executable');
    assert.ok(!fs.existsSync(path.join(h, 'bin', 'README.md')), 'only the program is unpacked');
    assert.ok(!fs.existsSync(path.join(h, 'apps', 'dl', '.install')), 'download cleaned up');
    const apps = (await call('admin', '/api/apps')).json.apps;
    assert.equal(apps.find((a: any) => a.id === 'dl').installed, true);
    assert.equal(apps.find((a: any) => a.id === 'tampered').installed, true, 'both use the same program path, now present');
  });

  it('saves device installers only when their SHA-256 matches, for any signed-in device to download', async () => {
    const plats = async () => (await call('admin', '/api/apps')).json.devices[0].platforms;
    const [android, bad, ios] = await plats();
    assert.deepEqual(ios, { label: 'iPhone', link: 'https://example.org/ios' });
    assert.equal(android.saved, false);
    assert.equal(android.confirm, `Download ${android.confirm.split('\n')[0]!.slice(9)}\nCheck its SHA-256 is ${android.confirm.match(/[0-9a-f]{64}/)![0]}\nSave it as ${h}/files/Installers/good.tgz (${android.confirm.match(/\(([^)]+)\)$/)![1]})`);
    assert.equal((await call('admin', '/api/apps/devices/maps/0/save', { method: 'POST', json: { confirm: bad.confirm } })).status, 409);
    assert.equal((await call('admin', '/api/apps/devices/maps/2/save', { method: 'POST', json: { confirm: 'x' } })).status, 404, 'links have nothing to save');
    const save = async (i: number, confirm: string) => {
      const r = await call('admin', `/api/apps/devices/maps/${i}/save`, { method: 'POST', json: { confirm } });
      assert.equal(r.status, 200);
      return waitFor(async () => {
        const j = (await call('admin', '/api/jobs')).json.jobs.find((x: any) => x.id === r.json.job.id);
        return (j?.status === 'done' || j?.status === 'error') && j;
      });
    };
    const refused = await save(1, bad.confirm);
    assert.equal(refused.status, 'error');
    assert.ok(!fs.existsSync(path.join(h, 'files', 'Installers', 'bad.tgz')), 'tampered file not kept');
    assert.ok(!fs.existsSync(path.join(h, 'files', 'Installers', 'bad.tgz.part')));
    assert.equal((await save(0, android.confirm)).status, 'done');
    const now = (await plats())[0];
    assert.equal(now.saved, true);
    assert.equal(now.href, '/installers/good.tgz');
    const got = await fetch(base + now.href);
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).length, android.size);
  });

  it('lets members open apps and read, but not change them or see commands', async () => {
    assert.equal((await call('admin', '/api/users', { method: 'POST', json: { name: 'anna', password: 'correct horse', role: 'admin' } })).status, 201);
    assert.equal((await call('admin', '/api/users', { method: 'POST', json: { name: 'ben', password: 'battery staple', role: 'member' } })).status, 401, 'sign-in is on now');
    assert.equal((await call('admin', '/api/auth/login', { method: 'POST', json: { name: 'anna', password: 'correct horse' } })).status, 200);
    assert.equal((await call('admin', '/api/users', { method: 'POST', json: { name: 'ben', password: 'battery staple', role: 'member' } })).status, 201);
    assert.equal((await call('ben', '/api/auth/login', { method: 'POST', json: { name: 'ben', password: 'battery staple' } })).status, 200);

    const [seen] = (await call('ben', '/api/apps')).json.apps;
    assert.equal(seen.commands, undefined);
    assert.equal(seen.logs, undefined);
    const plat = (await call('ben', '/api/apps')).json.devices[0].platforms[0];
    assert.equal(plat.confirm, undefined);
    assert.equal(plat.saved, true);
    assert.equal((await call('ben', '/api/apps/devices/maps/1/save', { method: 'POST', json: { confirm: 'x' } })).status, 403);
    assert.equal((await call('ben', '/installers/good.tgz')).status, 200, 'members can download saved installers');
    assert.equal((await fetch(`${base}/installers/good.tgz`)).status, 401, 'signed-out visitors cannot');
    assert.equal((await call('ben', '/api/apps/files/stop', { method: 'POST' })).status, 403);
    assert.equal((await call('ben', '/api/apps', { method: 'POST', json: { id: 'x', name: 'x', command: 'x', port: 9999 } })).status, 403);
    assert.equal((await call('ben', '/apps/files/api/resources', { method: 'POST' })).status, 403, 'File Browser is read-only for members');
    const read = await call('ben', '/apps/files/api/resources');
    assert.equal(read.status, 200);
    assert.equal(read.json.cookie, null, "the Outpost session cookie isn't passed on");
    assert.equal((await fetch(`${contentUrl}/apps/files/api/resources`)).status, 401, 'signed-out visitors get nothing');
    const page = await fetch(`${contentUrl}/apps/files/`, { redirect: 'manual', headers: { Accept: 'text/html' } });
    assert.match(String(page.headers.get('location')), /^http:\/\/127\.0\.0\.1:8080\/login\.html\?next=http%3A%2F%2F127\.0\.0\.1%3A8090%2Fapps%2Ffiles%2F$/, 'browsers sign in on Outpost itself, then come back');
  });

  it('checks custom apps and keeps their commands private', async () => {
    const add = (json: object) => call('admin', '/api/apps', { method: 'POST', json: { name: 'Wiki', id: 'wiki', command: `${bin} --port {port}`, port: 18096, ...json } });
    assert.equal((await add({ id: 'Bad Name' })).status, 400);
    assert.equal((await add({ port: 8080 })).status, 409, "Outpost's own port");
    assert.equal((await add({ port: appPort })).status, 409, "another app's port");
    assert.equal((await add({ port: 80 })).status, 400);
    assert.equal((await add({ command: 'app "open' })).status, 400);
    assert.equal((await add({ id: 'files' })).status, 409);
    assert.equal((await add({})).status, 200);
    const wiki = (await call('admin', '/api/apps')).json.apps.find((a: any) => a.id === 'wiki');
    assert.equal(wiki.custom, true);
    assert.equal(wiki.url, null, 'no base path: linked on its own port');
    assert.equal(wiki.commands.start, `${bin} --port 18096`);
    assert.equal(fs.statSync(path.join(h, 'apps.json')).mode & 0o777, 0o600);
    assert.equal((await call('admin', '/api/apps/files', { method: 'DELETE' })).status, 400, "built-in apps can't be removed");
    assert.equal((await call('admin', '/api/apps/wiki', { method: 'DELETE' })).status, 200);
    assert.equal((await call('admin', '/api/apps')).json.apps.length, 3);
  });

  it('starts running apps again when Outpost restarts, and forgets them once stopped', async () => {
    await close();
    await boot();
    await call('admin', '/api/auth/login', { method: 'POST', json: { name: 'anna', password: 'correct horse' } });
    await waitFor(async () => (await call('admin', '/api/apps')).json.apps[0].ready);
    assert.equal((await call('admin', '/api/apps/files/stop', { method: 'POST' })).status, 200);
    assert.equal((await call('admin', '/api/apps')).json.apps[0].state, 'stopped');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'apps.json'), 'utf8')).running, []);
  });
});

describe('bundled apps catalog', () => {
  it('pins every download to an https URL and a full SHA-256, and links only to https pages', async () => {
    const cat = JSON.parse(await fsp.readFile(path.join(here, '..', 'data', 'apps.json'), 'utf8'));
    const pins = [
      ...cat.apps.flatMap((a: any) => (a.download ? [a.download.arm64, a.download.x64] : [])),
      ...cat.devices.flatMap((d: any) => d.platforms.filter((p: any) => p.file).map((p: any) => p.file)),
    ];
    assert.ok(pins.length >= 8);
    for (const p of pins) {
      assert.match(p.url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//, p.url);
      assert.match(p.sha256, /^[0-9a-f]{64}$/, p.url);
    }
    for (const d of cat.devices) {
      assert.match(d.page, /^https:\/\//);
      for (const p of d.platforms) {
        assert.ok(p.link || p.file, `${d.id} ${p.label}`);
        if (p.link) assert.match(p.link, /^https:\/\//);
        if (p.file) assert.ok(Number.isInteger(p.file.size) && p.file.size > 0);
      }
    }
    const ports = cat.apps.map((a: any) => a.port);
    assert.equal(new Set(ports).size, ports.length, 'each app has its own port');
  });
});
