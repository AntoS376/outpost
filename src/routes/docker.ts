import { Router } from 'express';
import type { AppContext } from '../context.js';
import { HttpError } from '../util.js';
import { setEnv } from './setup.js';

/** /api/docker: Docker apps. Admins only, reads included (the central auth gate refuses members). */
export function dockerRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    const status = await ctx.docker.status();
    res.json({ ...status, containers: status.running ? await ctx.docker.list() : [] });
  });
  // The on/off switch: saved to the settings file, then Outpost restarts to pick it up.
  r.post('/enabled', async (req, res) => {
    await setEnv(ctx.cfg.envFile, 'OUTPOST_DOCKER', req.body?.on === true ? '1' : '0');
    res.json({ restarting: ctx.restart() });
  });
  // The exact command a run would use, for the admin to read before confirming.
  r.post('/preview', (req, res) => res.json(ctx.docker.preview(req.body?.spec ?? {})));
  r.post('/', async (req, res) => res.status(202).json({ job: await ctx.docker.start(req.body?.spec ?? {}, req.body?.confirm) }));
  r.post('/:name/:action', async (req, res) => {
    const action = String(req.params.action);
    if (action !== 'start' && action !== 'stop') throw new HttpError(404, 'Not found');
    await ctx.docker.act(String(req.params.name), action);
    res.json({ ok: true });
  });
  r.get('/:name/logs', async (req, res) => res.json({ logs: await ctx.docker.logs(String(req.params.name)) }));
  r.delete('/:name', async (req, res) => {
    await ctx.docker.act(String(req.params.name), 'remove');
    res.json({ ok: true });
  });
  return r;
}
