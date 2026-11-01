import { Router } from 'express';
import type { AppContext } from '../context.js';
import { userOf } from '../auth.js';

/** The signed-in person's saved conversations (~/Outpost/chats/<user>/). */
export function chatsRoutes(ctx: AppContext): Router {
  const r = Router();
  const mine = (res: Parameters<typeof userOf>[0]) => ctx.chatsFor(userOf(res).name);
  r.get('/', async (_req, res) => res.json({ chats: await mine(res).list() }));
  r.get('/:id', async (req, res) => res.json(await mine(res).get(String(req.params.id))));
  r.put('/:id', async (req, res) => res.json(await mine(res).put(String(req.params.id), req.body ?? {})));
  r.delete('/:id', async (req, res) => {
    await mine(res).remove(String(req.params.id));
    res.json({ ok: true });
  });
  return r;
}
