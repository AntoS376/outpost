import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { HttpError, safeFileName } from '../util.js';
import { loadCatalog, readyDir } from '../services/ready.js';

// Ready.gov preparedness guides. The PDFs are served only by a name the catalog lists, and only from
// docs/ready itself (no subfolders, no links pointing out of it). Missing ones can be downloaded, but
// only from the link the catalog gives, which must be https on ready.gov or fema.gov.
export function readyRoutes(ctx: AppContext): Router {
  const r = Router();
  const dir = readyDir(ctx.cfg);

  const catalog = async () => {
    try {
      return await loadCatalog(ctx.cfg);
    } catch {
      throw new HttpError(422, 'The preparedness catalog could not be read');
    }
  };

  // Labels of the guide downloads still waiting or running.
  const busy = () => new Set(ctx.jobs.list().filter((j) => j.kind === 'download' && (j.status === 'running' || j.status === 'queued')).map((j) => j.label));

  const withState = async (cat: Awaited<ReturnType<typeof catalog>>) => {
    const active = busy();
    return Promise.all(
      cat.items.map(async (it) => {
        const st = it.file ? await fsp.stat(path.join(dir, it.file)).catch(() => null) : null;
        const have = !!st?.isFile();
        return { ...it, have, size: have ? st!.size : null, downloading: !have && active.has(it.title) };
      }),
    );
  };

  r.get('/', async (_req, res) => {
    const cat = await catalog();
    res.json({ found: true, builtin: !!cat.builtin, categories: cat.categories, items: await withState(cat) });
  });

  // Body: {ids: [...]} for chosen guides, or {all: true} for every missing one.
  r.post('/pull', async (req, res) => {
    const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    const cat = await catalog();
    let wanted;
    if (body.all === true) wanted = cat.items;
    else if (Array.isArray(body.ids) && body.ids.length && body.ids.length <= 2000 && body.ids.every((x) => typeof x === 'string')) {
      wanted = (body.ids as string[]).map((id) => {
        const it = cat.items.find((i) => i.id === id);
        if (!it) throw new HttpError(404, 'Not in the preparedness catalog');
        return it;
      });
    } else throw new HttpError(400, 'Say which guides to download');
    const state = await withState({ ...cat, items: wanted });
    const todo = state.filter((it) => it.download && it.file && !it.have && !it.downloading);
    if (todo.length) await fsp.mkdir(dir, { recursive: true });
    const jobs = todo.map((it) => ctx.jobs.startDownload(it.download!, path.join(dir, it.file!), it.title));
    res.status(202).json({ jobs });
  });

  r.get('/file/:name', async (req, res) => {
    const name = safeFileName(String(req.params.name ?? ''), ['.pdf']);
    if (!name) throw new HttpError(400, 'Not a guide file name');
    const cat = await catalog();
    if (!cat?.items.some((it) => it.file === name)) throw new HttpError(404, 'Not in the preparedness catalog');
    const base = await fsp.realpath(dir).catch(() => null);
    const real = base ? await fsp.realpath(path.join(dir, name)).catch(() => null) : null;
    if (!base || !real || path.dirname(real) !== base) throw new HttpError(404, 'Not downloaded yet');
    const st = await fsp.stat(real);
    if (!st.isFile()) throw new HttpError(404, 'Not downloaded yet');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
    res.sendFile(real);
  });

  return r;
}
