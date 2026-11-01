import { Router } from 'express';
import type { AppContext } from '../context.js';
import { userOf } from '../auth.js';
import { HttpError } from '../util.js';

/** The signed-in person's notes (~/Outpost/notes/<user>/). Nobody sees anyone else's. */
export function notesRoutes(ctx: AppContext): Router {
  const r = Router();
  const mine = (res: Parameters<typeof userOf>[0]) => ctx.notesFor(userOf(res).name);
  r.get('/', async (_req, res) => res.json({ notes: await mine(res).list() }));
  r.post('/', async (req, res) => {
    const title = String((req.body ?? {}).title ?? '').slice(0, 120);
    res.status(201).json(await mine(res).create(title));
  });
  r.get('/:id', async (req, res) => res.json(await mine(res).get(String(req.params.id))));
  r.put('/:id', async (req, res) => {
    const content = (req.body ?? {}).content;
    if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
    res.json(await mine(res).put(String(req.params.id), content));
  });
  r.delete('/:id', async (req, res) => {
    await mine(res).remove(String(req.params.id));
    res.json({ ok: true });
  });
  return r;
}
