import { Router } from 'express';
import type { AppContext } from '../context.js';
import { HttpError } from '../util.js';

/** "35.5,33.89" → [35.5, 33.89] (longitude first, as on the map). */
function point(raw: unknown, which: string): [number, number] {
  const parts = String(raw ?? '').split(',').map((v) => (v.trim() === '' ? NaN : Number(v)));
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) throw new HttpError(400, `${which} must be "longitude,latitude"`);
  return parts as [number, number];
}

/**
 * /api/routing: offline directions per map. Everyone signed in may ask for a route; preparing or removing a map's
 * directions needs an admin (the central gate refuses those changes to members, and the region list is admin-only).
 */
export function routingRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/:map', async (req, res) => res.json(await ctx.routing.status(String(req.params.map))));

  r.get('/:map/regions', async (req, res) => res.json(await ctx.routing.regions(String(req.params.map))));

  r.get('/:map/route', async (req, res) => {
    const q = req.query;
    res.json(await ctx.routing.route(String(req.params.map), String(q.mode ?? 'car'), point(q.from, 'from'), point(q.to, 'to')));
  });

  // Download the chosen regions and prepare directions; with no regions, prepare again from the data already here.
  r.post('/:map', async (req, res) => {
    const regions = req.body?.regions;
    res.status(202).json({ job: await ctx.routing.build(String(req.params.map), regions == null ? null : (regions as string[])) });
  });

  r.delete('/:map', async (req, res) => {
    await ctx.routing.remove(String(req.params.map));
    res.json({ ok: true });
  });

  return r;
}
