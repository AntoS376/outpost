import { Router } from 'express';
import type { AppContext } from '../context.js';
import { isInstaller } from '../services/installers.js';
import { HttpError } from '../util.js';

/** /api/install/:id: Kolibri, CyberChef and map fonts. Reading is open to anyone signed in; installing needs an admin (central gate). */
export function installRoutes(ctx: AppContext): Router {
  const r = Router();
  const id = (raw: string) => {
    if (!isInstaller(raw)) throw new HttpError(404, 'Not found');
    return raw;
  };
  r.get('/:id', (req, res) => res.json(ctx.installers.status(id(String(req.params.id)))));
  r.post('/:id', (req, res) => res.status(202).json({ job: ctx.installers.start(id(String(req.params.id)), req.body?.confirm) }));
  return r;
}
