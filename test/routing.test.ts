import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { JobManager } from '../src/services/jobs.js';
import { describeStep, inRegion, RoutingService } from '../src/services/routing.js';
import { freePort, here, listen, makeExecutable, mockOllama, tmpHome, waitFor } from './helpers.js';

const box = (w: number, s: number, e: number, n: number) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

describe('offline directions', () => {
  it('says each turn in plain English', () => {
    const at = { location: [0, 0] as [number, number] };
    const say = (maneuver: object, extra: object = {}) => describeStep({ distance: 0, duration: 0, maneuver: { ...at, ...maneuver } as never, ...extra });
    assert.equal(say({ type: 'depart', bearing_after: 268 }, { name: 'Sea Road' }), 'Head west on Sea Road');
    assert.equal(say({ type: 'turn', modifier: 'right' }, { name: 'Emir Béchir' }), 'Turn right onto Emir Béchir');
    assert.equal(say({ type: 'turn', modifier: 'slight left' }, { name: 'Hamra', ref: 'A2' }), 'Turn slight left onto Hamra (A2)');
    assert.equal(say({ type: 'turn', modifier: 'uturn' }), 'Make a U-turn');
    assert.equal(say({ type: 'new name', modifier: 'straight' }, { name: 'Sea Highway' }), 'Continue onto Sea Highway');
    assert.equal(say({ type: 'off ramp', modifier: 'slight right' }, { destinations: 'Jbail' }), 'Take the exit on the right towards Jbail');
    assert.equal(say({ type: 'roundabout', modifier: 'right', exit: 2 }, { name: 'Main Street' }), 'At the roundabout, take the second exit onto Main Street');
    assert.equal(say({ type: 'fork', modifier: 'slight left' }, { name: 'M51' }), 'Keep left at the fork onto M51');
    assert.equal(say({ type: 'end of road', modifier: 'left' }), 'At the end of the road, turn left');
    assert.equal(say({ type: 'arrive', modifier: 'right' }), 'Arrive at your destination, on the right');
  });

  it('knows which region a point is in, holes included', () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
    assert.equal(inRegion(2, 2, [[ring, hole]]), true);
    assert.equal(inRegion(5, 5, [[ring, hole]]), false);
    assert.equal(inRegion(11, 5, [[ring]]), false);
  });

  it('changes nothing and names the Homebrew command when the tools are missing', async () => {
    const h = await tmpHome();
    try {
      const cfg = loadConfig({ OUTPOST_HOME: h, OUTPOST_OSRM_DIR: path.join(h, 'nothing-here'), OUTPOST_OSMIUM_BIN: path.join(h, 'no-osmium') });
      const routing = new RoutingService(cfg, new JobManager(cfg));
      assert.deepEqual(await routing.tools(), { osrm: false, osmium: false, version: null });
      await assert.rejects(routing.build('any.pmtiles', ['alpha']), (e: any) => e.status === 412 && /brew install osrm-backend osmium-tool/.test(e.message));
      await routing.stopAll();
      assert.deepEqual(fs.readdirSync(h), [], 'nothing written');
    } finally {
      await fsp.rm(h, { recursive: true, force: true });
    }
  });

  it('lets an admin prepare a map from Geofabrik regions, and everyone get routes', async () => {
    const h = await tmpHome();
    const bin = path.join(h, 'osrm-bin');
    fs.mkdirSync(bin);
    for (const t of ['osrm-extract', 'osrm-partition', 'osrm-customize', 'osrm-routed']) makeExecutable(`${here}/fixtures/fake-osrm.mjs`, path.join(bin, t));
    makeExecutable(`${here}/fixtures/fake-osmium.mjs`, path.join(bin, 'osmium'));
    const profiles = path.join(h, 'profiles');
    fs.mkdirSync(profiles);
    for (const p of ['car', 'foot', 'bicycle']) fs.writeFileSync(path.join(profiles, `${p}.lua`), `-- ${p}`);

    // Geofabrik: an index with outlines, and the downloads (counting them).
    const downloads: string[] = [];
    const geofabrik = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${(geofabrik.address() as any).port}`;
      if (req.url === '/index-v1.json') {
        const f = (id: string, parent: string | undefined, coords: number[][][], url = `${base}/${id}.osm.pbf`) => ({ type: 'Feature', properties: { id, parent, name: id.toUpperCase(), urls: { pbf: url } }, geometry: { type: 'Polygon', coordinates: coords } });
        res.setHeader('Content-Type', 'application/json');
        return void res.end(
          JSON.stringify({
            features: [
              f('alpha', 'europe', box(7.0, 43.0, 7.42, 43.75)),
              f('beta', 'europe', box(7.42, 43.0, 8.0, 43.75)), // the map's top quarter is sea: only the continent has it
              f('europe', undefined, box(-20, 30, 40, 70)),
              f('elsewhere', 'europe', box(7.0, 43.0, 8.0, 44.5), 'http://example.invalid/evil.osm.pbf'),
              f('far-away', 'asia', box(35, 33, 36, 34)),
            ],
          }),
        );
      }
      const m = req.url!.match(/^\/(\w+)\.osm\.pbf$/);
      if (!m) return void res.writeHead(404).end();
      const body = `pbf:${m[1]}`;
      res.setHeader('Content-Length', String(body.length));
      if (req.method === 'HEAD') return void res.end();
      downloads.push(m[1]!);
      res.end(body);
    });
    const gp = await listen(geofabrik);
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(
      loadConfig({
        OUTPOST_HOME: h,
        OUTPOST_KIWIX_PORT: String(await freePort()),
        OLLAMA_URL: `http://127.0.0.1:${op}`,
        OUTPOST_OSRM_DIR: bin,
        OUTPOST_OSRM_PROFILES: profiles,
        OUTPOST_OSMIUM_BIN: path.join(bin, 'osmium'),
        OUTPOST_GEOFABRIK_INDEX: `http://127.0.0.1:${gp}/index-v1.json`,
      }),
    );
    fs.copyFileSync(`${here}/fixtures/monaco-places.pmtiles`, path.join(h, 'maps', 'monaco.pmtiles'));
    const s = http.createServer(made.app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    const cookies: Record<string, string> = {};
    const call = async (who: string, p: string, method = 'GET', json?: unknown) => {
      const r = await fetch(base + p, { method, headers: { ...(cookies[who] ? { Cookie: cookies[who] } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
      const set = r.headers.get('set-cookie');
      if (set) cookies[who] = set.split(';')[0]!;
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const dir = path.join(h, 'routing', 'monaco.pmtiles');
    try {
      await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' });
      await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
      await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
      await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });

      const before = (await call('ben', '/api/routing/monaco.pmtiles')).json;
      assert.equal(before.ready, false);
      assert.deepEqual(before.tools, { osrm: true, osmium: true, version: 'v26.10.0' });
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41,43.73&to=7.43,43.74')).status, 409, 'not set up yet');
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/regions')).status, 403, 'only admins look up regions (it goes online)');
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles', 'POST', { regions: ['alpha'] })).status, 403, 'only admins prepare');
      assert.equal((await call('anna', '/api/routing/..%2Fsecret/regions')).status, 400);

      const found = (await call('anna', '/api/routing/monaco.pmtiles/regions')).json;
      assert.deepEqual(found.bbox, [7.4, 43.72, 7.44, 43.76]);
      assert.deepEqual(found.regions.filter((r: any) => r.suggested).map((r: any) => r.id).sort(), ['alpha', 'beta'], 'the smallest regions that cover the map');
      assert.ok(!found.regions.some((r: any) => r.id === 'elsewhere'), 'downloads only from Geofabrik itself');
      assert.ok(!found.regions.some((r: any) => r.id === 'europe' || r.id === 'far-away'), 'no continents, nothing off the map');
      assert.equal(found.regions.find((r: any) => r.id === 'alpha').size, 'pbf:alpha'.length);

      assert.equal((await call('anna', '/api/routing/monaco.pmtiles', 'POST', { regions: ['nope'] })).status, 400);
      const started = await call('anna', '/api/routing/monaco.pmtiles', 'POST', { regions: ['alpha', 'beta'] });
      assert.equal(started.status, 202);
      const job = await waitFor(async () => {
        const j = (await call('anna', '/api/jobs')).json.jobs.find((x: any) => x.id === started.json.job.id);
        return j.status !== 'running' && j.status !== 'queued' && j;
      });
      assert.equal(job.status, 'done', job.error);

      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      assert.deepEqual(meta.regions, [{ id: 'alpha', name: 'ALPHA' }, { id: 'beta', name: 'BETA' }]);
      assert.equal(meta.dataDate, '2026-10-30T21:24:51Z');
      assert.equal(fs.readFileSync(path.join(dir, 'region.osm.pbf'), 'utf8'), 'cut 7.3500000000000005,43.67,7.49,43.809999999999995 from pbf:alpha+pbf:beta', 'joined, then cut to the map plus a margin');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['bike', 'car', 'foot', 'meta.json', 'profiles', 'region.osm.pbf'], 'downloads and work folders cleaned up');
      assert.match(fs.readFileSync(path.join(dir, 'profiles', 'car.lua'), 'utf8'), /name:en/);
      assert.deepEqual(downloads.sort(), ['alpha', 'beta']);

      const route = await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41,43.73&to=7.43,43.74');
      assert.equal(route.status, 200, JSON.stringify(route.json));
      assert.deepEqual(route.json.steps.map((x: any) => x.text), ['Head east on car Street', 'Turn right onto Emir Béchir', 'At the roundabout, take the second exit', 'Arrive at your destination, on the left']);
      assert.equal(route.json.distance, 1235);
      assert.deepEqual(route.json.geometry.coordinates[2], [7.43, 43.74]);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=bike&from=7.41,43.73&to=7.43,43.74')).json.steps[0].text, 'Head east on bicycle Street');
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=boat&from=7.41,43.73&to=7.43,43.74')).status, 400);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41&to=7.43,43.74')).status, 400);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41,95&to=7.43,43.74')).status, 400);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=foot&from=0,43.73&to=7.43,43.74')).status, 422);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=foot&from=1,1&to=1,1')).status, 404);

      // Preparing again reuses the road data already here: no new download.
      const again = await call('anna', '/api/routing/monaco.pmtiles', 'POST', {});
      assert.equal(again.status, 202);
      await waitFor(async () => (await call('anna', '/api/jobs')).json.jobs.find((x: any) => x.id === again.json.job.id).status === 'done');
      assert.deepEqual(downloads.sort(), ['alpha', 'beta']);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41,43.73&to=7.43,43.74')).status, 200, 'answers after the switch');

      // A newer OSRM can't read the data: routes wait until it's prepared again.
      process.env.FAKE_OSRM_VERSION = 'v26.11.0';
      (made.ctx.routing as any).version = null;
      const outdated = (await call('ben', '/api/routing/monaco.pmtiles')).json;
      assert.equal(outdated.outdated, true);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41,43.73&to=7.43,43.74')).status, 409);

      // A failed step leaves the working directions alone.
      process.env.FAKE_OSRM_VERSION = '';
      (made.ctx.routing as any).version = null;
      process.env.FAKE_OSRM_FAIL = 'extract';
      const broken = await call('anna', '/api/routing/monaco.pmtiles', 'POST', {});
      const failed = await waitFor(async () => {
        const j = (await call('anna', '/api/jobs')).json.jobs.find((x: any) => x.id === broken.json.job.id);
        return j.status !== 'running' && j;
      });
      assert.equal(failed.status, 'error');
      assert.match(failed.error, /Input file is broken/);
      assert.equal((await call('ben', '/api/routing/monaco.pmtiles/route?mode=car&from=7.41,43.73&to=7.43,43.74')).status, 200);
      assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.new')));
      delete process.env.FAKE_OSRM_FAIL;

      // Removing the map removes its directions.
      assert.equal((await call('anna', '/api/maps/monaco.pmtiles', 'DELETE')).status, 200);
      assert.equal(fs.existsSync(dir), false);
    } finally {
      delete process.env.FAKE_OSRM_VERSION;
      delete process.env.FAKE_OSRM_FAIL;
      await made.ctx.routing.stopAll();
      s.closeAllConnections();
      s.close();
      geofabrik.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
