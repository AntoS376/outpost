import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { OllamaClient } from '../services/ollama.js';
import { HttpError } from '../util.js';

/** Opt-in update checks: status, on/off, check now, and one-click downloads of what a check found. */
export function updatesRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (_req, res) => res.json(await ctx.updates.status()));

  r.put('/', async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    await ctx.updates.setEnabled(req.body.enabled);
    res.json(await ctx.updates.status());
  });

  r.post('/check', async (_req, res) => {
    res.json(await ctx.updates.check());
  });

  // Downloads only what the last check offered, by name; never a URL from the browser. Nothing is replaced.
  r.post('/download', async (req, res) => {
    const results = await ctx.updates.results();
    const kind = req.body?.kind;
    if (kind === 'book' && typeof req.body?.file === 'string') {
      const b = results?.books.find((x) => x.file === req.body.file);
      if (!b) throw new HttpError(404, 'No update was found for that book. Check again.');
      const job = ctx.jobs.startDownload(b.url, path.join(ctx.cfg.dirs.zim, b.newFile), b.newFile, () => ctx.kiwix.sync());
      return void res.status(202).json({ job });
    }
    if (kind === 'model' && typeof req.body?.name === 'string') {
      const m = results?.models.find((x) => x.name === req.body.name);
      if (!m) throw new HttpError(404, 'No update was found for that model. Check again.');
      if (!(ctx.ai instanceof OllamaClient)) throw new HttpError(409, 'Model updates need Ollama.');
      const ollama = ctx.ai;
      const job = ctx.jobs.startTask('model-pull', `Update ${m.name}`, (j, signal) =>
        ollama.pull(m.name, signal, (status, done, total) => {
          j.message = status;
          if (total) {
            j.received = done;
            j.total = total;
          }
        }),
      );
      return void res.status(202).json({ job });
    }
    throw new HttpError(400, 'Say what to download: {kind: "book", file} or {kind: "model", name}.');
  });
  return r;
}
