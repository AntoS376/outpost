import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { assertHttpUrl, fileNameFromUrl, HttpError, safeFileName } from '../util.js';

export function jobsRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (_req, res) => res.json({ jobs: ctx.jobs.list() }));

  r.post('/download', (req, res) => {
    const { url, kind, name } = (req.body ?? {}) as { url?: string; kind?: string; name?: string };
    const u = assertHttpUrl(url);
    if (kind !== 'zim' && kind !== 'map') throw new HttpError(400, 'kind must be "zim" or "map"');
    const ext = kind === 'zim' ? '.zim' : '.pmtiles';
    const fileName = safeFileName(name || fileNameFromUrl(u.href), [ext]);
    if (!fileName) throw new HttpError(400, `Could not determine a valid ${ext} file name from that URL`);
    const dest = path.join(kind === 'zim' ? ctx.cfg.dirs.zim : ctx.cfg.dirs.maps, fileName);
    const job = ctx.jobs.startDownload(u.href, dest, fileName, kind === 'zim' ? () => ctx.kiwix.sync() : () => void ctx.places.build(fileName));
    res.status(202).json({ job });
  });

  r.post('/:id/cancel', (req, res) => {
    if (!ctx.jobs.cancel(String(req.params.id))) throw new HttpError(404, 'No running job with that id');
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    if (!ctx.jobs.clear(String(req.params.id))) throw new HttpError(404, 'No finished job with that id');
    res.json({ ok: true });
  });

  return r;
}
