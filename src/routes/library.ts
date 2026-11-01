import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { HttpError, listFiles, safeFileName } from '../util.js';
import { browseCatalog, catalogFilters } from '../services/catalog.js';

export function libraryRoutes(ctx: AppContext): Router {
  const r = Router();
  const dir = ctx.cfg.dirs.zim;

  r.get('/', async (_req, res) => {
    res.json({ files: await listFiles(dir, '.zim'), kiwix: ctx.kiwix.status() });
  });

  // A page of the Kiwix catalog, filtered, with each book's state on this Mac.
  r.get('/catalog', async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 100);
    const lang = String(req.query.lang ?? 'eng').slice(0, 8);
    const category = String(req.query.category ?? '').slice(0, 40);
    const start = Math.max(0, Math.floor(Number(req.query.start ?? 0)) || 0);
    const count = Math.min(60, Math.max(1, Math.floor(Number(req.query.count ?? 20)) || 20));
    const rawMax = String(req.query.maxSize ?? '');
    const maxSize = rawMax === '' ? null : Number(rawMax);
    if (maxSize !== null && !(maxSize > 0)) throw new HttpError(400, 'maxSize must be a number of bytes');
    const [{ entries, total }, files, fsStat] = await Promise.all([
      browseCatalog(ctx.cfg, { q, lang, category, start, count }),
      listFiles(dir, '.zim'),
      fsp.statfs(dir),
    ]);
    const names = new Set(files.map((f) => f.name));
    res.json({
      // The catalog can't filter by size, so this page is filtered here; unknown sizes are kept.
      entries: entries
        .filter((e) => maxSize === null || e.size === null || e.size <= maxSize)
        .map((e) => {
          const prefix = `${e.name}${e.flavour ? `_${e.flavour}` : ''}_`;
          const older = files.find((f) => f.name !== e.fileName && f.name.startsWith(prefix) && /^\d{4}-\d{2}\.zim$/.test(f.name.slice(prefix.length)));
          return { ...e, installed: names.has(e.fileName), olderVersion: older?.name ?? null };
        }),
      total,
      nextStart: start + count < total ? start + count : null,
      free: fsStat.bavail * fsStat.bsize,
    });
  });

  let filters: { at: number; data: Awaited<ReturnType<typeof catalogFilters>> } | null = null;
  r.get('/catalog/filters', async (_req, res) => {
    if (!filters || Date.now() - filters.at > 3600_000) filters = { at: Date.now(), data: await catalogFilters(ctx.cfg) };
    res.json(filters.data);
  });

  r.post('/restart', async (_req, res) => {
    await ctx.kiwix.sync();
    res.json(ctx.kiwix.status());
  });

  r.delete('/:name', async (req, res) => {
    const name = safeFileName(String(req.params.name), ['.zim']);
    if (!name) throw new HttpError(400, 'Invalid file name');
    await fsp.rm(path.join(dir, name), { force: true });
    await ctx.kiwix.sync();
    res.json({ ok: true });
  });

  // Streams a local file straight to disk (no size limit, no buffering in memory).
  r.put('/upload/:name', async (req, res) => {
    const name = safeFileName(String(req.params.name), ['.zim']);
    if (!name) throw new HttpError(400, 'Invalid file name (must end in .zim)');
    const part = path.join(dir, `${name}.part`);
    try {
      await pipeline(req, fs.createWriteStream(part));
    } catch (e) {
      await fsp.rm(part, { force: true });
      throw e;
    }
    await fsp.rename(part, path.join(dir, name));
    await ctx.kiwix.sync();
    res.json({ ok: true, name });
  });

  return r;
}
