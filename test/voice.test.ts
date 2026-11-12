import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { VOICE_ONLINE_MS, VOICE_TTL_MS, VoiceStore, wavSeconds } from '../src/services/voice.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

/** A WAV file of `seconds` of quiet tone, as the browser recorder makes them. */
function wav(seconds: number, { rate = 16_000, channels = 1, bits = 16 } = {}): Uint8Array {
  const frames = Math.round(seconds * rate);
  const bytes = frames * channels * (bits / 8);
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames && bits === 16 && channels === 1; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 2000), 44 + i * 2);
  return new Uint8Array(buf);
}

/** Outpost with an admin (anna) and a member (ben). */
async function setup() {
  const h = await tmpHome();
  const ollama = mockOllama();
  const op = await listen(ollama);
  const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}` }));
  const s = http.createServer(made.app);
  const base = `http://127.0.0.1:${await listen(s)}`;
  const cookies: Record<string, string> = {};
  const call = async (who: string, p: string, init: { method?: string; json?: unknown; body?: Uint8Array } = {}) => {
    const headers: Record<string, string> = cookies[who] ? { Cookie: cookies[who]! } : {};
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';
    if (init.body) headers['Content-Type'] = 'audio/wav';
    const r = await fetch(base + p, { method: init.method ?? 'GET', headers, body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined) });
    const set = r.headers.get('set-cookie');
    if (set) cookies[who] = set.split(';')[0]!;
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, headers: r.headers, json: type.includes('json') ? await r.json() : null, bytes: type.includes('json') ? null : new Uint8Array(await r.arrayBuffer()) };
  };
  await call('x', '/api/users', { method: 'POST', json: { name: 'anna', password: 'correct horse', role: 'admin' } });
  await call('anna', '/api/auth/login', { method: 'POST', json: { name: 'anna', password: 'correct horse' } });
  await call('anna', '/api/users', { method: 'POST', json: { name: 'ben', password: 'battery staple', role: 'member' } });
  await call('ben', '/api/auth/login', { method: 'POST', json: { name: 'ben', password: 'battery staple' } });
  return {
    h,
    call,
    close: async () => {
      await made.ctx.kiwix.stop();
      s.closeAllConnections();
      s.close();
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    },
  };
}

describe('voice messages', () => {
  it('lets anyone signed in send a clip that everyone can list and play back exactly', async () => {
    const t = await setup();
    try {
      assert.equal((await t.call('nobody', '/api/voice')).status, 401, 'signed out: nothing');
      const clip = wav(2.5);
      const sent = await t.call('ben', '/api/voice', { method: 'POST', body: clip });
      assert.equal(sent.status, 201, JSON.stringify(sent.json));
      assert.equal(sent.json.name, 'ben');
      assert.equal(sent.json.seconds, 2.5);
      const second = await t.call('anna', '/api/voice', { method: 'POST', body: wav(1) });
      assert.equal(second.status, 201);

      const all = (await t.call('anna', '/api/voice')).json.messages;
      assert.deepEqual(all.map((m: { name: string; mine: boolean }) => [m.name, m.mine]), [['ben', false], ['anna', true]], 'oldest first, mine marked');
      const newer = (await t.call('ben', `/api/voice?after=${sent.json.id}`)).json.messages;
      assert.deepEqual(newer.map((m: { id: string }) => m.id), [second.json.id], 'only what came after');

      const played = await t.call('anna', `/api/voice/${sent.json.id}.wav`);
      assert.equal(played.status, 200);
      assert.match(played.headers.get('content-type') ?? '', /audio\/wav/);
      assert.deepEqual(played.bytes, clip, 'the very bytes that were sent');
      assert.equal(fs.statSync(path.join(t.h, 'voice', `${sent.json.id}.wav`)).mode & 0o777, 0o600);
      assert.equal((await t.call('anna', '/api/voice/../users.json.wav')).status, 404);
      assert.equal((await t.call('anna', '/api/voice/not-an-id.wav')).status, 404);
    } finally {
      await t.close();
    }
  });

  it('refuses what other phones could not play, clips that are too short or long, and a flood', async () => {
    const t = await setup();
    try {
      const send = (body: Uint8Array) => t.call('ben', '/api/voice', { method: 'POST', body });
      const refused: [Uint8Array, number, RegExp][] = [
        [new TextEncoder().encode('not audio at all, just some text'), 400, /WAV/],
        [wav(1, { channels: 2 }), 400, /mono/],
        [wav(1, { bits: 8 }), 400, /16-bit/],
        [wav(0.1), 400, /too short/],
        [wav(61, { rate: 8_000 }), 400, /up to 60 seconds/],
        [wav(70), 413, /up to 60 seconds/],
      ];
      for (const [body, status, why] of refused) {
        const r = await send(body);
        assert.equal(r.status, status, why.source);
        assert.match(r.json.error, why);
      }
      assert.equal((await send(wav(1))).status, 201);
      const again = await send(wav(1));
      assert.equal(again.status, 429, 'one clip every 2 seconds per person');
      assert.ok(Number(again.headers.get('retry-after')) >= 1);
      assert.equal((await t.call('anna', '/api/voice', { method: 'POST', body: wav(1) })).status, 201, 'others are not held up');
    } finally {
      await t.close();
    }
  });

  it('lets the sender or an admin delete a clip, and no one else', async () => {
    const t = await setup();
    try {
      const annas = (await t.call('anna', '/api/voice', { method: 'POST', body: wav(1) })).json;
      const bens = (await t.call('ben', '/api/voice', { method: 'POST', body: wav(1) })).json;
      assert.equal((await t.call('ben', `/api/voice/${annas.id}`, { method: 'DELETE' })).status, 403);
      assert.equal((await t.call('ben', `/api/voice/${bens.id}`, { method: 'DELETE' })).status, 200, 'your own');
      assert.ok(!fs.existsSync(path.join(t.h, 'voice', `${bens.id}.wav`)), 'its file goes too');
      assert.equal((await t.call('anna', `/api/voice/${annas.id}`, { method: 'DELETE' })).status, 200, 'an admin');
      assert.deepEqual((await t.call('anna', '/api/voice')).json.messages, []);
    } finally {
      await t.close();
    }
  });

  it('keeps clips through a restart and removes them after 24 hours', async () => {
    const dir = path.join(await tmpHome(), 'voice');
    let now = 1_000_000;
    const store = new VoiceStore(dir, () => now);
    const m = await store.add('anna', wav(1));
    assert.deepEqual((await new VoiceStore(dir, () => now).list()).map((x) => x.id), [m.id], 'read back after a restart');
    now += VOICE_TTL_MS + 1;
    const later = new VoiceStore(dir, () => now);
    assert.deepEqual(await later.list(), []);
    assert.ok(!fs.existsSync(path.join(dir, `${m.id}.wav`)), 'the file is gone too');
  });

  it('shows who is on the channel: people, their devices, and who is listening', async () => {
    const t = await setup();
    try {
      await t.call('anna', '/api/voice?device=anna-mac-0001&on=1');
      await t.call('anna', '/api/voice?device=anna-phone-001&on=0');
      await t.call('ben', '/api/voice?device=ben-phone-0001&on=0');
      await t.call('ben', '/api/voice?device=bad id!&on=1');
      const { online } = (await t.call('ben', '/api/voice?device=ben-phone-0001&on=0')).json;
      assert.deepEqual(online, [
        { name: 'anna', devices: 2, listening: 1 },
        { name: 'ben', devices: 1, listening: 0 },
      ], 'one person, many devices; a malformed device id is ignored');
    } finally {
      await t.close();
    }
  });

  it('forgets a device soon after it stops checking in', () => {
    let now = 0;
    const store = new VoiceStore('/nowhere', () => now);
    store.see('anna', 'anna-mac-0001', true);
    assert.deepEqual(store.online(), [{ name: 'anna', devices: 1, listening: 1 }]);
    now += VOICE_ONLINE_MS + 1;
    assert.deepEqual(store.online(), []);
  });

  it('reads the length from the WAV header', () => {
    assert.equal(wavSeconds(wav(3)), 3);
    assert.equal(wavSeconds(wav(2, { rate: 8_000 })), 2);
  });
});

describe('recording in the browser', () => {
  it('turns microphone samples into a 16 kHz mono WAV that Outpost accepts, at the right length', async () => {
    const { encodeWav } = await import('../public/js/wav.js');
    // 1.5 s of a 440 Hz tone at 48 kHz, in uneven blocks as the microphone delivers it.
    const rate = 48_000;
    const all = Float32Array.from({ length: rate * 1.5 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5);
    const chunks: Float32Array[] = [];
    for (let i = 0; i < all.length; i += 128 + (i % 3)) chunks.push(all.slice(i, i + 128 + (i % 3)));
    const out: Uint8Array = encodeWav(chunks, rate);
    assert.equal(wavSeconds(out), 1.5);
    const v = new DataView(out.buffer);
    assert.equal(v.getUint32(24, true), 16_000, '16 kHz');
    assert.equal(v.getUint16(22, true), 1, 'mono');
    const peak = Math.max(...Array.from({ length: 2000 }, (_, i) => Math.abs(v.getInt16(44 + i * 2, true))));
    assert.ok(peak > 12_000 && peak < 17_000, `the tone survives at about half volume (peak ${peak})`);
    assert.equal(encodeWav([Float32Array.of(2, -2, 0.5)], 16_000).length, 44 + 6);
    const clipped = new DataView(encodeWav([Float32Array.of(2, -2)], 16_000).buffer);
    assert.deepEqual([clipped.getInt16(44, true), clipped.getInt16(46, true)], [32767, -32768], 'loud input is clipped, not wrapped');
  });
});
