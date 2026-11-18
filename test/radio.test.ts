import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { bestChannel, deviceFrom, rtlFmArgs, rtlPowerArgs, scanLevels, validScan, validTuning } from '../src/services/radio.js';
import { CALL_TTL_MS, CallLog, wavFile } from '../src/services/radioCalls.js';
import { wavSeconds } from '../src/services/voice.js';
import { messageRate, readAircraft, validSite } from '../src/services/planes.js';
import { SENSOR_STALE_MS, SensorBoard, TYRE_WINDOW_MS } from '../src/services/sensors.js';
import { AprsBoard, STATION_STALE_MS, csvCells, kindOf } from '../src/services/aprs.js';
import { freePort, listen, makeExecutable, mockOllama, tmpHome, waitFor } from './helpers.js';

const fixtures = new URL('./fixtures/', import.meta.url).pathname;

describe('radio settings', () => {
  it('accepts 24–1,766 MHz, the five modes and squelch 0–10', () => {
    assert.deepEqual(validTuning({ freq: 446_006_250, mode: 'fm', squelch: 4 }), { freq: 446_006_250, mode: 'fm', squelch: 4 });
    assert.equal(validTuning({ freq: 1_026_000, mode: 'am' }).freq, 1_026_000, 'AM radio, by direct sampling');
    for (const bad of [{ freq: 400_000 }, { freq: 2e9 }, { freq: 'x' }, { mode: 'cw' }, { squelch: 11 }, { squelch: 2.5 }]) {
      assert.throws(() => validTuning(bad), (e: any) => e.status === 400, JSON.stringify(bad));
    }
    assert.equal(validTuning({ mode: 'usb' }, { freq: 28e6, mode: 'am', squelch: 0 }).freq, 28e6, 'missing fields keep the current tuning');
  });

  it('runs rtl_fm at 24 kHz, with squelch except on broadcast FM', () => {
    assert.deepEqual(rtlFmArgs({ freq: 446_006_250, mode: 'fm', squelch: 4 }), ['-f', '446006250', '-M', 'fm', '-s', '24000', '-l', '300', '-']);
    assert.deepEqual(rtlFmArgs({ freq: 27_185_000, mode: 'am', squelch: 0 }), ['-f', '27185000', '-M', 'am', '-s', '24000', '-']);
    assert.deepEqual(rtlFmArgs({ freq: 100_500_000, mode: 'wbfm', squelch: 9 }), ['-f', '100500000', '-M', 'wbfm', '-r', '24000', '-']);
    assert.deepEqual(rtlFmArgs({ freq: 1_026_000, mode: 'am', squelch: 0 }), ['-f', '1026000', '-M', 'am', '-s', '24000', '-E', 'direct2', '-'], 'below 24 MHz: direct sampling on the Q branch');
    assert.deepEqual(rtlFmArgs({ freq: 14_200_000, mode: 'usb', squelch: 0 }).slice(-3), ['-E', 'direct2', '-']);
    assert.ok(!rtlFmArgs({ freq: 24_000_000, mode: 'am', squelch: 0 }).includes('direct2'), 'from 24 MHz the tuner works');
  });

  it('sweeps the channels with bins small enough to tell them apart', () => {
    assert.deepEqual(rtlPowerArgs([26_965_000, 27_405_000], 10_000), ['-f', '26955000:27415000:2500', '-i', '1', '-1', '-']);
    assert.match(rtlPowerArgs([88e6, 108e6], 200_000)[1]!, /^87800000:108200000:50000$/);
    for (const bad of [{}, { freqs: [], width: 1e4 }, { freqs: [1e6], width: 1e4 }, { freqs: [14e6], width: 1e4 }, { freqs: [27e6], width: 100 }, { freqs: Array(1025).fill(27e6), width: 1e4 }, { freqs: [30e6, 100e6], width: 1e4 }]) {
      assert.throws(() => validScan(bad), (e: any) => e.status === 400, JSON.stringify(bad).slice(0, 60));
    }
  });

  it("finds each channel's strongest bin and the noise floor in rtl_power's CSV", () => {
    const csv = '2026-11-17, 15:00:00, 27000000, 27040000, 10000.00, 4096, -30.1, -29.9, -5.0, -30.0\n\n';
    const r = scanLevels(csv, [27_005_000, 27_025_000, 27_100_000], 10_000);
    assert.deepEqual(r.levels, [-30.1, -5, null], 'only bins within half a channel count; a channel outside the sweep has no reading');
    assert.equal(r.floor, -29.9);
    assert.deepEqual(scanLevels('', [27e6], 1e4), { levels: [null], floor: null });
  });

  it('picks the strongest channel that stands clear of the noise', () => {
    assert.equal(bestChannel([-30, -12, -20, null], -30), 1);
    assert.equal(bestChannel([-30, -25, -29], -30), -1, 'nothing 8 dB above the floor');
    assert.equal(bestChannel([-20], null), -1);
  });

  it("reads rtl_test's answer", () => {
    assert.equal(deviceFrom('Found 1 device(s):\n  0:  Realtek'), 'ok');
    assert.equal(deviceFrom('No supported devices found.'), 'none');
    assert.equal(deviceFrom('Found 1 device(s):\nKernel driver is active, or device is claimed by second instance of librtlsdr.'), 'busy');
  });
});

describe('radio receiver', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => (t = await setup()));
  after(() => t.close());

  async function setup() {
    const h = await tmpHome();
    const bin = path.join(h, 'fakebin');
    fs.mkdirSync(bin);
    makeExecutable(path.join(fixtures, 'fake-rtl-fm.mjs'), path.join(bin, 'rtl_fm'));
    makeExecutable(path.join(fixtures, 'fake-rtl-test.mjs'), path.join(bin, 'rtl_test'));
    makeExecutable(path.join(fixtures, 'fake-rtl-power.mjs'), path.join(bin, 'rtl_power'));
    makeExecutable(path.join(fixtures, 'fake-dump1090.mjs'), path.join(bin, 'dump1090'));
    makeExecutable(path.join(fixtures, 'fake-rtl433.mjs'), path.join(bin, 'rtl_433'));
    makeExecutable(path.join(fixtures, 'fake-direwolf.mjs'), path.join(bin, 'direwolf'));
    const log = path.join(h, 'rtl.log');
    process.env.FAKE_RTL_LOG = log;
    const ollama = mockOllama();
    const op = await listen(ollama);
    const made = await createApp(
      loadConfig({
        OUTPOST_HOME: h,
        OUTPOST_KIWIX_PORT: String(await freePort()),
        OLLAMA_URL: `http://127.0.0.1:${op}`,
        OUTPOST_RTL_FM_BIN: path.join(bin, 'rtl_fm'),
        OUTPOST_RTL_TEST_BIN: path.join(bin, 'rtl_test'),
        OUTPOST_RTL_POWER_BIN: path.join(bin, 'rtl_power'),
        OUTPOST_DUMP1090_BIN: path.join(bin, 'dump1090'),
        OUTPOST_RTL433_BIN: path.join(bin, 'rtl_433'),
        OUTPOST_DIREWOLF_BIN: path.join(bin, 'direwolf'),
      }),
    );
    const s = http.createServer(made.app);
    const base = `http://127.0.0.1:${await listen(s)}`;
    const cookies: Record<string, string> = {};
    const call = async (who: string, p: string, method = 'GET', json?: unknown) => {
      const headers: Record<string, string> = cookies[who] ? { Cookie: cookies[who]! } : {};
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(base + p, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
      const set = r.headers.get('set-cookie');
      if (set) cookies[who] = set.split(';')[0]!;
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    /** Opens the audio stream as `who` and returns its first bytes and a way to hang up. */
    const tuneIn = async (who: string) => {
      const ctrl = new AbortController();
      const r = await fetch(base + '/api/radio/audio', { headers: { Cookie: cookies[who]! }, signal: ctrl.signal });
      const reader = r.body!.getReader();
      const first = await reader.read();
      return { status: r.status, rate: r.headers.get('x-sample-rate'), bytes: first.value?.length ?? 0, reader, hangUp: () => ctrl.abort() };
    };
    await call('x', '/api/users', 'POST', { name: 'anna', password: 'correct horse', role: 'admin' });
    await call('anna', '/api/auth/login', 'POST', { name: 'anna', password: 'correct horse' });
    await call('anna', '/api/users', 'POST', { name: 'ben', password: 'battery staple', role: 'member' });
    await call('ben', '/api/auth/login', 'POST', { name: 'ben', password: 'battery staple' });
    const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    return {
      h,
      base,
      cookie: (who: string) => cookies[who]!,
      ctx: made.ctx,
      call,
      tuneIn,
      runs,
      close: async () => {
        await made.ctx.radio.stop();
        await made.ctx.kiwix.stop();
        s.closeAllConnections();
        s.close();
        ollama.close();
        delete process.env.FAKE_RTL_LOG;
        delete process.env.FAKE_RTL;
        await fsp.rm(h, { recursive: true, force: true });
      },
    };
  }

  it('reports the tools, the dongle and the dial', async () => {
    const s = (await t.call('ben', '/api/radio')).json;
    assert.equal(s.tools, true);
    assert.equal(s.device, 'ok');
    assert.equal(s.on, false);
    assert.equal(s.rate, 24000);
  });

  it('lets members tune, and remembers the dial', async () => {
    const r = await t.call('ben', '/api/radio', 'PUT', { freq: 446_006_250, mode: 'fm', squelch: 4 });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.h, 'radio.json'), 'utf8')).freq, 446_006_250);
    assert.equal((await t.call('ben', '/api/radio', 'PUT', { freq: 400_000 })).status, 400, 'below 0.5 MHz');
    assert.equal((await t.call('ben', '/api/install/radio', 'POST', { confirm: 'x' })).status, 403, 'installing is for admins');
  });

  it('shares one receiver between listeners, retunes it, and lets the dongle go when everyone leaves', async () => {
    const a = await t.tuneIn('anna');
    const b = await t.tuneIn('ben');
    assert.equal(a.status, 200);
    assert.equal(a.rate, '24000');
    assert.ok(a.bytes > 0 && b.bytes > 0, 'both hear audio');
    assert.equal(t.runs().length, 1, 'one rtl_fm for both');
    assert.equal((await t.call('ben', '/api/radio')).json.listeners, 2);

    await t.call('anna', '/api/radio', 'PUT', { freq: 100_500_000, mode: 'wbfm' });
    await waitFor(async () => t.runs().length === 2);
    assert.match(t.runs()[1]!, /-f 100500000 -M wbfm -r 24000/);
    assert.ok((await a.reader.read()).value!.length > 0, 'the stream keeps going across a retune');

    a.hangUp();
    b.hangUp();
    await waitFor(async () => !(await t.call('anna', '/api/radio')).json.on);
  });

  it('scans for activity, pausing the receiver and picking it up again', async () => {
    const cb = [27_165_000, 27_175_000, 27_185_000, 27_205_000];
    const quiet = await t.call('ben', '/api/radio/scan', 'POST', { freqs: cb, width: 10_000 });
    assert.equal(quiet.status, 200, 'members may scan');
    assert.deepEqual(quiet.json.levels, [-30, -30, -2.5, -30]);
    assert.equal(quiet.json.floor, -30);

    const a = await t.tuneIn('anna');
    const before = t.runs().filter((l) => !l.startsWith('power')).length;
    assert.equal((await t.call('anna', '/api/radio/scan', 'POST', { freqs: cb, width: 10_000 })).status, 200);
    await waitFor(async () => t.runs().filter((l) => !l.startsWith('power')).length === before + 1);
    assert.ok((await a.reader.read()).value!.length > 0, 'the listener hears the receiver again after the scan');
    a.hangUp();
    await waitFor(async () => !(await t.call('anna', '/api/radio')).json.on);

    process.env.FAKE_RTL = 'none';
    try {
      const r = await t.call('anna', '/api/radio/scan', 'POST', { freqs: cb, width: 10_000 });
      assert.equal(r.status, 409);
      assert.match(r.json.error, /No radio found/);
    } finally {
      delete process.env.FAKE_RTL;
    }
  });

  it('lets an admin switch the receiver off, which stops it, frees the dongle and is remembered', async () => {
    const a = await t.tuneIn('ben');
    assert.equal((await t.call('ben', '/api/radio/power', 'PUT', { enabled: false })).status, 403, 'members cannot switch it off');
    const checks = () => t.runs().length;
    const off = await t.call('anna', '/api/radio/power', 'PUT', { enabled: false });
    assert.deepEqual(off.json, { enabled: false });
    while (!(await a.reader.read()).done); // listeners are cut off: the stream ends
    const s = (await t.call('ben', '/api/radio')).json;
    assert.equal(s.enabled, false);
    assert.equal(s.on, false);
    assert.equal(s.device, null, 'no dongle checks while off');
    const before = checks();
    assert.equal((await t.call('ben', '/api/radio/audio')).status, 409);
    assert.equal((await t.call('ben', '/api/radio/scan', 'POST', { freqs: [27_185_000], width: 10_000 })).status, 409);
    assert.equal(checks(), before, 'nothing ran on the dongle');
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.h, 'radio.json'), 'utf8')).enabled, false, 'remembered across restarts');
    assert.equal((await t.call('anna', '/api/radio/power', 'PUT', { enabled: 'yes' })).status, 400);
    assert.deepEqual((await t.call('anna', '/api/radio/power', 'PUT', { enabled: true })).json, { enabled: true });
    assert.equal((await t.call('ben', '/api/radio')).json.device, 'ok');
  });

  it('auto-scans to a busy channel, logs the call, and lets members share it on Voice', async () => {
    process.env.FAKE_RTL_BURST = '1200';
    try {
      const cb = [27_165_000, 27_175_000, 27_185_000, 27_205_000];
      assert.equal((await t.call('ben', '/api/radio/autoscan', 'POST', { freqs: cb, width: 10_000, mode: 'wbfm' })).status, 400, 'not for broadcast FM');
      const started = await t.call('ben', '/api/radio/autoscan', 'POST', { freqs: cb, width: 10_000, mode: 'am' });
      assert.equal(started.status, 200);
      assert.ok(started.json.autoscan);
      const s = await waitFor(async () => {
        const st = (await t.call('ben', '/api/radio')).json;
        return st.autoscan?.on === 27_185_000 ? st : null;
      });
      assert.equal(s.tuning.freq, 27_185_000, 'tuned to the one channel with a signal');
      await waitFor(async () => t.runs().some((l) => /^-f 27185000 -M am -s 24000 -l \d+ -$/.test(l))); // with squelch, to hear when the call ends
      assert.equal((await t.call('ben', '/api/radio/scan', 'POST', { freqs: cb, width: 10_000 })).status, 409, 'no manual scan meanwhile');

      const call = await waitFor(async () => (await t.call('ben', '/api/radio/calls')).json.calls[0], 10_000);
      assert.equal(call.freq, 27_185_000);
      assert.ok(call.seconds >= 1, `a call of ${call.seconds} s`);
      const wav = await fetch(`${t.base}/api/radio/calls/${call.id}.wav`, { headers: { Cookie: t.cookie('ben') } });
      assert.equal(wav.headers.get('content-type'), 'audio/wav');
      assert.equal(Buffer.from(await wav.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
      const shared = await t.call('ben', `/api/radio/calls/${call.id}/voice`, 'POST');
      assert.equal(shared.status, 201);
      assert.ok((await t.call('anna', '/api/voice')).json.messages.some((m: any) => m.id === shared.json.id && m.name === 'ben'), 'on the Voice channel');
      assert.equal((await t.call('ben', `/api/radio/calls/${call.id}`, 'DELETE')).status, 403, 'members cannot delete calls');

      await t.call('ben', '/api/radio', 'PUT', { freq: 446_006_250, mode: 'fm' });
      assert.equal((await t.call('ben', '/api/radio')).json.autoscan, null, 'tuning by hand stops auto-scan');
      assert.equal((await t.call('anna', '/api/radio/autoscan', 'DELETE')).status, 200);
      await waitFor(async () => !(await t.call('anna', '/api/radio')).json.on);
      assert.equal((await t.call('anna', `/api/radio/calls/${call.id}`, 'DELETE')).status, 200);
    } finally {
      delete process.env.FAKE_RTL_BURST;
    }
  });

  it('hands the dongle to the planes decoder, and back', async () => {
    const a = await t.tuneIn('anna');
    assert.equal((await t.call('ben', '/api/radio/planes', 'POST')).status, 200, 'members may start planes');
    while (!(await a.reader.read()).done); // listening stops: the dongle is busy with planes
    await waitFor(async () => t.runs().some((l) => /^dump1090 --write-json \S+ --write-json-every 1 --quiet$/.test(l))); // no network ports
    const seen = await waitFor(async () => {
      const r = (await t.call('ben', '/api/radio/planes')).json;
      return r.planes.length && r.rate !== null ? r : null;
    }, 12_000);
    assert.equal(seen.on, true);
    assert.deepEqual(seen.planes.map((p: any) => [p.flight, p.emergency]), [['MEA322', false], ['ELY002', true]]);
    assert.deepEqual(seen.unplaced, [{ hex: '89645a', flight: 'UAE953', alt: 24000 }]);
    assert.ok(seen.rate > 3000 && seen.rate < 9000, `about 6,000 messages a minute, got ${seen.rate}`);
    assert.equal((await t.call('ben', '/api/radio/planes')).json.on, true, 'still on after the last listener left (the receiver lets go, planes stay)');
    assert.equal(seen.rssi, -11.6);
    assert.equal((await t.call('ben', '/api/radio/audio')).status, 409, 'no listening meanwhile');
    assert.match((await t.call('ben', '/api/radio/scan', 'POST', { freqs: [27_185_000], width: 10_000 })).json.error, /busy with planes/);
    const st = (await t.call('ben', '/api/radio')).json;
    assert.equal(st.planes, true);
    assert.equal(st.device, 'ok');
    assert.equal((await t.call('ben', '/api/radio/planes', 'DELETE')).status, 200);
    assert.deepEqual((await t.call('ben', '/api/radio/planes')).json, { on: false, site: null, planes: [], unplaced: [], rate: null, rssi: null });
    const b = await t.tuneIn('ben');
    assert.ok(b.bytes > 0, 'listening works again');
    b.hangUp();
    await waitFor(async () => !(await t.call('anna', '/api/radio')).json.on);

    process.env.FAKE_RTL = 'busy';
    try {
      await t.call('anna', '/api/radio/planes', 'POST');
      const err = await waitFor(async () => (await t.call('anna', '/api/radio')).json.error || null);
      assert.match(err, /Another program is using the radio/);
      assert.equal((await t.call('anna', '/api/radio/planes')).json.on, false);
    } finally {
      delete process.env.FAKE_RTL;
    }
  });

  it('remembers where the antenna is, and gives it to the planes decoder', async () => {
    assert.equal((await t.call('ben', '/api/radio/site', 'PUT', { lat: 33.89, lon: 35.5 })).status, 403, 'admins set the location');
    assert.equal((await t.call('anna', '/api/radio/site', 'PUT', { lat: 200, lon: 0 })).status, 400);
    assert.deepEqual((await t.call('anna', '/api/radio/site', 'PUT', { lat: 33.89, lon: 35.5 })).json, { site: { lat: 33.89, lon: 35.5 } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.h, 'radio.json'), 'utf8')).site, { lat: 33.89, lon: 35.5 });
    await t.call('ben', '/api/radio/planes', 'POST');
    await waitFor(async () => t.runs().some((l) => /--quiet --lat 33\.89 --lon 35\.5$/.test(l)));
    assert.deepEqual((await t.call('ben', '/api/radio/planes')).json.site, { lat: 33.89, lon: 35.5 });
    const before = t.runs().length;
    await t.call('anna', '/api/radio/site', 'PUT', { lat: 33.9, lon: 35.51 });
    await waitFor(async () => t.runs().length > before && /--lat 33\.9 --lon 35\.51$/.test(t.runs().at(-1)!));
    assert.equal((await t.call('ben', '/api/radio/planes')).json.on, true, 'restarted with the new location');
    await t.call('ben', '/api/radio/planes', 'DELETE');
    await t.call('anna', '/api/radio/site', 'PUT', { lat: null, lon: null });
  });

  it('hands the dongle to the sensors decoder, switching from planes, and remembers the frequency', async () => {
    await t.call('ben', '/api/radio/planes', 'POST');
    assert.equal((await t.call('ben', '/api/radio/sensors', 'POST', { freq: '27M' })).status, 400);
    const started = await t.call('ben', '/api/radio/sensors', 'POST', { freq: '868M' });
    assert.equal(started.status, 200, 'members may start sensors');
    assert.equal((await t.call('ben', '/api/radio/planes')).json.on, false, 'planes stopped: one decoder at a time');
    await waitFor(async () => t.runs().some((l) => l === 'rtl_433 -f 868M -F json -M level'));
    const r = await waitFor(async () => {
      const x = (await t.call('ben', '/api/radio/sensors')).json;
      return x.sensors.length === 2 && x.tyres > 0 ? x : null;
    });
    assert.equal(r.on, true);
    assert.equal(r.freq, '868M');
    assert.equal(r.sensors.find((s: any) => s.model === 'Nexus-TH').readings.temperature_C, 20);
    assert.ok(r.others >= 1);
    const st = (await t.call('ben', '/api/radio')).json;
    assert.deepEqual([st.sensors, st.planes, st.device], [true, false, 'ok']);
    assert.match((await t.call('ben', '/api/radio/audio')).json.error, /busy with sensors/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.h, 'radio.json'), 'utf8')).sensorFreq, '868M');
    assert.equal((await t.call('ben', '/api/radio/sensors', 'DELETE')).json.on, false);
    assert.equal((await t.call('ben', '/api/radio/sensors', 'POST')).json.freq, '868M', 'the last frequency again');
    await t.call('ben', '/api/radio/sensors', 'DELETE');
  });

  it('shares station names, and records what the receiver hears into the call log', async () => {
    assert.deepEqual((await t.call('ben', '/api/radio/names', 'PUT', { freq: 100_500_000, name: '  Radio   Liban ' })).json, { names: { 100500000: 'Radio Liban' } }, 'members may name stations');
    assert.equal((await t.call('ben', '/api/radio/names', 'PUT', { freq: 5, name: 'x' })).status, 400);
    assert.equal((await t.call('ben', '/api/radio/names', 'PUT', { freq: 100_500_000, name: 'x'.repeat(41) })).status, 400);
    assert.deepEqual((await t.call('anna', '/api/radio')).json.names, { 100500000: 'Radio Liban' }, 'everyone sees them');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.h, 'radio.json'), 'utf8')).names, { 100500000: 'Radio Liban' });
    await t.call('ben', '/api/radio/names', 'PUT', { freq: 100_500_000, name: '' });
    assert.deepEqual((await t.call('anna', '/api/radio')).json.names, {}, 'an empty name removes it');

    assert.equal((await t.call('ben', '/api/radio/record', 'POST')).status, 409, 'nothing to record while the receiver is off');
    await t.call('ben', '/api/radio', 'PUT', { freq: 100_500_000, mode: 'wbfm' });
    const a = await t.tuneIn('ben');
    const before = (await t.call('ben', '/api/radio/calls')).json.calls.length;
    assert.equal((await t.call('ben', '/api/radio/record', 'POST')).json.recording, 0, 'members may record');
    await new Promise((r) => setTimeout(r, 1600));
    assert.ok((await t.call('ben', '/api/radio')).json.recording >= 1);
    await t.call('ben', '/api/radio/record', 'DELETE');
    const calls = (await t.call('ben', '/api/radio/calls')).json.calls;
    assert.equal(calls.length, before + 1, 'saved even without squelch (broadcast FM)');
    assert.equal(calls[0].freq, 100_500_000);
    assert.ok(calls[0].seconds >= 1);
    assert.equal((await t.call('ben', '/api/radio')).json.recording, null);
    a.hangUp();
    await waitFor(async () => !(await t.call('anna', '/api/radio')).json.on);
  });

  it('decodes APRS with rtl_fm piped into direwolf, ports off, and says so when the dongle is busy', async () => {
    assert.equal((await t.call('ben', '/api/radio/aprs', 'POST', { freq: '145.000M' })).status, 400);
    assert.equal((await t.call('ben', '/api/radio/aprs', 'POST', { freq: '144.390M' })).status, 200, 'members may start APRS');
    await waitFor(async () => t.runs().some((l) => l === '-f 144.390M -M fm -s 24000 -') && t.runs().some((l) => /^direwolf -c \S+direwolf\.conf -r 24000 -b 16 -n 1 -t 0 -q hd -L \S+packets\.csv -$/.test(l)));
    const conf = fs.readFileSync(path.join(t.h, 'aprs', 'direwolf.conf'), 'utf8');
    assert.match(conf, /^AGWPORT 0$/m, 'no AGW network port');
    assert.match(conf, /^KISSPORT 0$/m, 'no KISS network port');
    assert.match(conf, /^ADEVICE stdin null$/m, 'audio out goes nowhere: it never transmits');
    const r = await waitFor(async () => {
      const x = (await t.call('ben', '/api/radio/aprs')).json;
      return x.stations.length === 2 ? x : null;
    });
    assert.deepEqual([r.on, r.freq], [true, '144.390M']);
    assert.equal(r.stations.find((s: any) => s.key === 'OD5WX').comment, 'Wind 5 km/h, 21 C');
    assert.equal(r.stations.find((s: any) => s.key === 'OD5XYZ-9').kind, 'car');
    assert.match((await t.call('ben', '/api/radio/audio')).json.error, /busy with APRS/);
    assert.equal((await t.call('ben', '/api/radio')).json.aprs, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.h, 'radio.json'), 'utf8')).aprsFreq, '144.390M');
    assert.equal((await t.call('ben', '/api/radio/aprs', 'DELETE')).json.on, false);

    process.env.FAKE_RTL = 'busy';
    try {
      await t.call('ben', '/api/radio/aprs', 'POST');
      const err = await waitFor(async () => (await t.call('ben', '/api/radio')).json.error || null);
      assert.match(err, /Another program is using the radio/, "rtl_fm's message, read from its log file");
      assert.equal((await t.call('ben', '/api/radio/aprs')).json.on, false);
    } finally {
      delete process.env.FAKE_RTL;
    }
  });

  it('says so when another program holds the dongle', async () => {
    process.env.FAKE_RTL = 'busy';
    try {
      const a = await t.tuneIn('anna');
      assert.equal(a.status, 200);
      const s = await waitFor(async () => {
        const st = (await t.call('anna', '/api/radio')).json;
        return st.error ? st : null;
      });
      assert.match(s.error, /Another program is using the radio/);
      assert.equal(s.on, false);
    } finally {
      delete process.env.FAKE_RTL;
    }
  });
});

describe('planes', () => {
  it("reads dump1090's aircraft.json: placed planes, planes heard without a position, signal and emergencies", () => {
    const file = readAircraft({
      now: 1_700_000_000,
      messages: 4242,
      aircraft: [
        { hex: '4b1805', flight: 'MEA322  ', lat: 33.82, lon: 35.49, alt_baro: 3400, gs: 182.5, track: 164.2, baro_rate: 1856, squawk: '4421', seen: 0.2, seen_pos: 0.4, rssi: -11.6 },
        { hex: '738065', lat: 34.1, lon: 35.2, alt_baro: 'ground', squawk: '7600', seen: 1, seen_pos: 5, rssi: -20 },
        { hex: 'aa11bb', flight: 'UAE953', alt_baro: 24000, seen: 3, rssi: -9 },
        { hex: 'cc22dd', lat: 33.5, lon: 35.9, seen: 61, seen_pos: 61, rssi: -1 },
        { hex: 'ee33ff', lat: 'x', lon: 35, seen_pos: 1 },
        null,
      ],
    });
    assert.deepEqual(file.planes[0], { hex: '4b1805', flight: 'MEA322', lat: 33.82, lon: 35.49, alt: 3400, speed: 182.5, track: 164.2, climb: 1856, squawk: '4421', emergency: false, seen: 0, rssi: -11.6 });
    assert.equal(file.planes[1]!.alt, 'ground');
    assert.equal(file.planes[1]!.emergency, true, '7600: radio failure');
    assert.equal(file.planes.length, 2, 'stale and malformed ones are left out');
    assert.deepEqual(file.unplaced, [{ hex: 'aa11bb', flight: 'UAE953', alt: 24000 }], 'heard lately, no position yet');
    assert.equal(file.rssi, -9, 'strongest signal heard in the last minute (not the stale -1)');
    assert.deepEqual([file.messages, file.now], [4242, 1_700_000_000]);
    assert.deepEqual(readAircraft('nonsense'), { planes: [], unplaced: [], messages: null, now: null, rssi: null });
  });

  it('works out messages a minute, and checks a receiver location', () => {
    assert.equal(messageRate([{ now: 100, messages: 0 }]), null);
    assert.equal(messageRate([{ now: 100, messages: 0 }, { now: 103, messages: 50 }]), null, 'too short a gap to tell');
    assert.equal(messageRate([{ now: 100, messages: 1000 }, { now: 110, messages: 1500 }]), 3000);
    assert.deepEqual(validSite({ lat: 33.8938123, lon: 35.5018456 }), { lat: 33.89381, lon: 35.50185 });
    assert.equal(validSite({ lat: null, lon: null }), null, 'forget it');
    for (const bad of [{}, { lat: 91, lon: 0 }, { lat: 0, lon: 'x' }]) assert.throws(() => validSite(bad), (e: any) => e.status === 400);
  });
});

describe('sensors', () => {
  it('lists sensors that measure something, in metric, and only counts tyre sensors and buttons', () => {
    let now = 1_000_000;
    const board = new SensorBoard(() => now);
    board.add('{"model":"Fineoffset-WH24","id":140,"temperature_C":21.4,"humidity":63,"wind_avg_m_s":2.1,"wind_dir_deg":225,"rain_in":0.5,"battery_ok":1,"rssi":-8.24}');
    board.add('{"model":"Nexus-TH","id":211,"channel":2,"temperature_F":68,"humidity":48,"battery_ok":0}');
    board.add('{"model":"Toyota","type":"TPMS","id":"d9d14b9f","pressure_PSI":30.5,"temperature_C":25}');
    board.add('{"model":"Generic-Doorbell","id":7,"cmd":1}');
    board.add('not json');
    board.add('{"no":"model"}');
    now += 1000;
    board.add('{"model":"Fineoffset-WH24","id":140,"temperature_C":21.6}');
    const r = board.list();
    assert.deepEqual(r.sensors.map((s) => s.model), ['Fineoffset-WH24', 'Nexus-TH'], 'most recent first');
    assert.deepEqual(r.sensors[0]!.readings, { temperature_C: 21.6, humidity: 63, wind_avg_km_h: 7.6, wind_dir_deg: 225, rain_mm: 12.7, battery_ok: 1 }, 'kept between readings, converted to metric');
    assert.equal(r.sensors[0]!.count, 2);
    assert.equal(r.sensors[1]!.readings.temperature_C, 20, '68 °F');
    assert.equal(r.sensors[1]!.channel, '2');
    assert.deepEqual([r.tyres, r.others, r.heard], [1, 1, 5], 'a tyre sensor counted, never listed; a doorbell counted');
    assert.ok(!JSON.stringify(r).includes('d9d14b9f'), "no car's tyre-sensor id anywhere");
    now += TYRE_WINDOW_MS + 1;
    assert.equal(board.list().tyres, 0);
    now += SENSOR_STALE_MS;
    assert.deepEqual(board.list().sensors, [], 'not heard for 30 minutes: dropped');
  });
});

describe('APRS', () => {
  it("reads direwolf's CSV log: positions, objects, status packets and quoted comments", () => {
    assert.deepEqual(csvCells('a,"b, c","say ""hi""",'), ['a', 'b, c', 'say "hi"', '']);
    assert.equal(kindOf('/>'), 'car');
    assert.equal(kindOf('/_'), 'weather station');
    assert.equal(kindOf('\\?'), 'station');
    let now = 1_000_000;
    const board = new AprsBoard(() => now);
    board.add('0,1,t,OD5XYZ-9,OD5XYZ-9,73,0,!,OD5XYZ-9,/>,33.88,35.5,36.0,90.0,100.0,,,,,,,early');
    assert.deepEqual(board.list().stations, [], 'nothing before the header');
    board.add('chan,utime,isotime,source,heard,level,error,dti,name,symbol,latitude,longitude,speed,course,altitude,frequency,offset,tone,system,status,telemetry,comment');
    board.add('0,1,t,OD5XYZ-9,OD5XYZ-9,73,0,!,OD5XYZ-9,/>,33.883333,35.5,36.0,90.0,100.0,,,,,,,"On the way, north"');
    board.add('0,1,t,OD5ABC,OD5ABC,73,0,;,MEETING,\\M,33.9,35.52,,,,,,,,,,Gather here at 6');
    now += 1000;
    board.add('0,1,t,OD5XYZ-9,OD5XYZ-9,73,0,>,OD5XYZ-9,,,,,,,,,,,Back at 5,,');
    board.add('0,1,t,,,73,0,!,,,1,2,,,,,,,,,,no source');
    const { stations, heard } = board.list();
    assert.equal(heard, 3);
    const car = stations.find((s) => s.key === 'OD5XYZ-9')!;
    assert.deepEqual([car.kind, car.lat, car.lon, car.speed, car.course, car.altitude, car.comment, car.count], ['car', 33.883333, 35.5, 36, 90, 100, 'Back at 5', 2], 'a status packet keeps the position, symbol and motion');
    const obj = stations.find((s) => s.key === 'MEETING')!;
    assert.deepEqual([obj.call, obj.comment], ['OD5ABC', 'Gather here at 6'], 'an object is listed by its name, sent by its call');
    now += STATION_STALE_MS + 1;
    assert.deepEqual(board.list().stations, [], 'not heard for over two hours: dropped');
  });
});

describe('saved channels', () => {
  it('finds the frequency in what people type for a channel', async () => {
    // The page module reads nothing from the page when it loads, but core.js expects a browser's globals to exist.
    Object.assign(globalThis, { window: globalThis, document: { querySelector: () => null } });
    const { channelMhz } = await import('../public/js/radio-rx.js');
    const cases: [string, number | null][] = [
      ['GMRS 17, tone 12', 462.6], ['CB 19', 27.185], ['cb ch 9', 27.065], ['PMR446 3', 446.03125], ['Marine 16', 156.8], ['WX2', 162.4],
      ['462.5625', 462.5625], ['446,00625 MHz', 446.00625], ['146 MHz', 146], ['Family', null], ['GMRS 40', null], ['10.5', null],
    ];
    for (const [text, mhz] of cases) assert.equal(channelMhz(text), mhz, text);
  });
});

describe('radio call log', () => {
  it('keeps calls as WAV files Voice accepts, newest first, for 24 hours', async () => {
    const dir = await tmpHome();
    let now = 1_000_000;
    const log = new CallLog(path.join(dir, 'calls'), () => now);
    const wav = wavFile(Buffer.alloc(24_000 * 2 * 2 + 1), 24_000);
    assert.equal(wavSeconds(new Uint8Array(wav)), 2, 'two seconds, odd byte dropped');
    const a = await log.add({ at: now, freq: 446_006_250, mode: 'fm', seconds: 2 }, wav);
    now += 1000;
    const b = await log.add({ at: now, freq: 27_185_000, mode: 'am', seconds: 2 }, wav);
    assert.deepEqual((await log.list()).map((c) => c.id), [b.id, a.id]);
    assert.ok((await log.read(a.id)).subarray(0, 4).equals(Buffer.from('RIFF')));
    await log.remove(b.id);
    assert.equal(fs.existsSync(log.fileOf(b.id)), false);
    now += CALL_TTL_MS;
    assert.deepEqual(await log.list(), [], 'older than a day: gone');
    assert.equal(fs.existsSync(log.fileOf(a.id)), false, 'file and all');
    assert.throws(() => log.fileOf('../index'), (e: any) => e.status === 404);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
