import { Router } from 'express';
import type { AppContext } from '../context.js';
import { userOf } from '../auth.js';

/** /api/radio: the RTL-SDR receiver. Anyone signed in may listen and tune (one dial, shared by everyone listening). */
export function radioRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (_req, res) => res.json(await ctx.radio.status()));
  r.put('/', async (req, res) => res.json(await ctx.radio.tune(req.body ?? {})));
  r.get('/audio', async (_req, res) => ctx.radio.listen(res));
  // Admins only (the central gate): off frees the dongle for another program, and stops it for everyone.
  r.put('/power', async (req, res) => res.json({ enabled: await ctx.radio.setEnabled(req.body?.enabled) }));
  r.post('/scan', async (req, res) => res.json(await ctx.radio.scan(req.body ?? {})));
  r.post('/autoscan', async (req, res) => {
    await ctx.radio.autoscan(req.body ?? {});
    res.json(await ctx.radio.status());
  });
  r.delete('/autoscan', async (_req, res) => {
    await ctx.radio.stopAutoscan();
    res.json(await ctx.radio.status());
  });
  // Planes on the map: dump1090 takes the dongle until stopped. Anyone signed in may start, stop and see them.
  r.get('/planes', async (_req, res) => res.json(await ctx.radio.aircraft()));
  // Where the antenna is (admins only, by the central gate): distances and rings on the planes map.
  r.put('/site', async (req, res) => res.json({ site: await ctx.radio.setSite(req.body ?? {}) }));
  r.post('/planes', async (_req, res) => {
    await ctx.radio.startPlanes();
    res.json({ on: true });
  });
  r.delete('/planes', async (_req, res) => {
    await ctx.radio.stopPlanes();
    res.json({ on: false });
  });
  // Sensors (433 MHz weather stations and the like): rtl_433 takes the dongle until stopped. Anyone signed in.
  r.get('/sensors', (_req, res) => res.json(ctx.radio.sensorReport()));
  r.post('/sensors', async (req, res) => {
    await ctx.radio.startSensors(req.body ?? {});
    res.json(ctx.radio.sensorReport());
  });
  r.delete('/sensors', async (_req, res) => {
    await ctx.radio.stopSensors();
    res.json(ctx.radio.sensorReport());
  });
  // APRS (ham stations' positions and messages): rtl_fm into direwolf until stopped. Anyone signed in.
  r.get('/aprs', async (_req, res) => res.json(await ctx.radio.aprsReport()));
  r.post('/aprs', async (req, res) => {
    await ctx.radio.startAprs(req.body ?? {});
    res.json(await ctx.radio.aprsReport());
  });
  r.delete('/aprs', async (_req, res) => {
    await ctx.radio.stopAprs();
    res.json(await ctx.radio.aprsReport());
  });
  // Station names, shared by everyone; Record saves what the receiver hears to the call log.
  r.put('/names', async (req, res) => res.json({ names: await ctx.radio.setName(req.body ?? {}) }));
  r.post('/record', async (_req, res) => {
    ctx.radio.startRecording();
    res.json(await ctx.radio.status());
  });
  r.delete('/record', async (_req, res) => {
    await ctx.radio.stopRecording();
    res.json(await ctx.radio.status());
  });
  // The call log: what the receiver heard with squelch on, kept 24 hours. Deleting is for admins (central gate).
  r.get('/calls', async (_req, res) => res.json({ calls: await ctx.radio.calls.list() }));
  r.get('/calls/:id.wav', (req, res) => {
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.type('audio/wav').sendFile(ctx.radio.calls.fileOf(String(req.params.id)), (err) => err && !res.headersSent && res.status(404).json({ error: 'No such call.' }));
  });
  r.post('/calls/:id/voice', async (req, res) => {
    const wav = await ctx.radio.calls.read(String(req.params.id));
    res.status(201).json(await ctx.voice.add(userOf(res).name, new Uint8Array(wav)));
  });
  r.delete('/calls/:id', async (req, res) => {
    await ctx.radio.calls.remove(String(req.params.id));
    res.json({ ok: true });
  });
  return r;
}
