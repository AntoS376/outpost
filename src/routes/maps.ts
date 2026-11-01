import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { assertHttpUrl, HttpError, listFiles, parseBbox, parseMaxzoom, safeFileName } from '../util.js';

export function mapsRoutes(ctx: AppContext): Router {
  const r = Router();
  const dir = ctx.cfg.dirs.maps;

  r.get('/', async (_req, res) => {
    const fonts = await fsp.stat(path.join(ctx.cfg.dirs.assets, 'fonts')).then((s) => s.isDirectory(), () => false);
    const files = await Promise.all(
      (await listFiles(dir, '.pmtiles')).map(async (f) => ({ ...f, places: await ctx.places.count(f.name), indexing: ctx.places.isBuilding(f.name) })),
    );
    res.json({ files, fonts });
  });

  // Places (cities, towns, neighbourhoods) in one map's local index. Not street addresses.
  r.get('/search', async (req, res) => {
    const name = safeFileName(String(req.query.file ?? ''), ['.pmtiles']);
    if (!name) throw new HttpError(400, 'file must be a .pmtiles name');
    if (!(await fsp.stat(path.join(dir, name)).catch(() => null))) throw new HttpError(404, `No map called ${name}`);
    res.json({ results: await ctx.places.search(name, String(req.query.q ?? '').slice(0, 100)) });
  });

  // Range requests are handled by sendFile; the PMTiles client depends on them.
  r.get('/files/:name', (req, res, next) => {
    const name = safeFileName(String(req.params.name), ['.pmtiles']);
    if (!name) throw new HttpError(400, 'Invalid file name');
    res.sendFile(name, { root: dir, acceptRanges: true, dotfiles: 'deny' }, (err) => err && next(err));
  });

  // (Re)build one map's place index, e.g. after a failed or cancelled run.
  r.post('/:name/index', async (req, res) => {
    const name = safeFileName(String(req.params.name), ['.pmtiles']);
    if (!name) throw new HttpError(400, 'Invalid file name');
    if (!(await fsp.stat(path.join(dir, name)).catch(() => null))) throw new HttpError(404, `No map called ${name}`);
    res.status(202).json({ job: ctx.places.build(name) });
  });

  r.delete('/:name', async (req, res) => {
    const name = safeFileName(String(req.params.name), ['.pmtiles']);
    if (!name) throw new HttpError(400, 'Invalid file name');
    await fsp.rm(path.join(dir, name), { force: true });
    await ctx.places.remove(name);
    await ctx.routing.remove(name);
    res.json({ ok: true });
  });

  r.put('/upload/:name', async (req, res) => {
    const name = safeFileName(String(req.params.name), ['.pmtiles']);
    if (!name) throw new HttpError(400, 'Invalid file name (must end in .pmtiles)');
    const part = path.join(dir, `${name}.part`);
    try {
      await pipeline(req, fs.createWriteStream(part));
    } catch (e) {
      await fsp.rm(part, { force: true });
      throw e;
    }
    await fsp.rename(part, path.join(dir, name));
    ctx.places.build(name);
    res.json({ ok: true, name });
  });

  r.post('/extract', (req, res) => {
    const b = (req.body ?? {}) as { source?: string; name?: string; bbox?: unknown; maxzoom?: unknown };
    const src = assertHttpUrl(b.source);
    if (!src.pathname.toLowerCase().endsWith('.pmtiles')) throw new HttpError(400, 'Source must be a .pmtiles URL');
    const name = safeFileName(String(b.name ?? ''), ['.pmtiles']);
    if (!name) throw new HttpError(400, 'Output name must end in .pmtiles and use plain characters');
    const job = ctx.jobs.startExtract(src.href, path.join(dir, name), parseBbox(b.bbox), parseMaxzoom(b.maxzoom), name, () => void ctx.places.build(name));
    res.status(202).json({ job });
  });

  return r;
}
