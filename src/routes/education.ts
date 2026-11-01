import { Router } from 'express';
import type { AppContext } from '../context.js';

/** Start, stop and check Kolibri. */
export function educationRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (_req, res) => res.json(await ctx.kolibri.status()));
  r.post('/start', async (_req, res) => {
    await ctx.kolibri.start();
    res.json(await ctx.kolibri.status());
  });
  r.post('/stop', async (_req, res) => {
    await ctx.kolibri.stop();
    res.json(await ctx.kolibri.status());
  });
  return r;
}
