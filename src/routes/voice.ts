import { Router } from 'express';
import type { AppContext } from '../context.js';
import { userOf } from '../auth.js';
import { readLimited } from '../services/pdf.js';
import { VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from '../services/voice.js';

/** /api/voice: one shared channel of short voice messages, for everyone signed in. */
export function voiceRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    const me = userOf(res).name;
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    ctx.voice.see(me, req.query.device, req.query.on === '1');
    res.json({ messages: (await ctx.voice.list(after)).map((m) => ({ ...m, mine: m.name === me })), online: ctx.voice.online() });
  });
  r.post('/', async (req, res) => {
    const wav = await readLimited(req, VOICE_MAX_BYTES, () => `Voice messages can be up to ${VOICE_MAX_SECONDS} seconds.`);
    try {
      res.status(201).json(await ctx.voice.add(userOf(res).name, wav));
    } catch (e) {
      const wait = (e as { retryAfter?: number }).retryAfter;
      if (wait) res.set('Retry-After', String(wait));
      throw e;
    }
  });
  // Each clip's id never changes, so a device can keep it once fetched.
  r.get('/:id.wav', (req, res) => {
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.type('audio/wav').sendFile(ctx.voice.fileOf(String(req.params.id)), (err) => err && !res.headersSent && res.status(404).json({ error: 'No such voice message.' }));
  });
  r.delete('/:id', async (req, res) => {
    const me = userOf(res);
    await ctx.voice.remove(String(req.params.id), me.name, me.role === 'admin');
    res.json({ ok: true });
  });
  return r;
}
