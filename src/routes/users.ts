import path from 'node:path';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { moveFilesSafely } from '../services/notes.js';

/** /api/users: admins add, change and remove accounts. (Members are turned away by the auth gate.) */
export function usersRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', (_req, res) => res.json({ users: ctx.users.list(), mode: ctx.users.mode(), envAdmin: ctx.cfg.pass ? ctx.cfg.user : null }));

  r.post('/', async (req, res) => {
    const wasOpen = ctx.users.mode() === 'open';
    const user = await ctx.users.create(req.body?.name, req.body?.password, req.body?.role);
    // The first account in open mode takes over what was written before sign-in existed.
    if (wasOpen && user.name !== ctx.cfg.user) {
      for (const kind of ['notes', 'chats']) {
        const from = path.join(ctx.cfg.home, kind, ctx.cfg.user);
        await moveFilesSafely(from, path.join(ctx.cfg.home, kind, user.name));
        await fsp.rmdir(from).catch(() => undefined);
      }
    }
    res.status(201).json(user);
  });

  r.put('/:name', async (req, res) => {
    res.json(await ctx.users.update(req.params.name, { role: req.body?.role, password: req.body?.password }));
  });

  // Removing an account keeps its notes and chats on disk (in notes/<name> and chats/<name>).
  r.delete('/:name', async (req, res) => {
    await ctx.users.remove(req.params.name);
    res.json({ ok: true });
  });
  return r;
}
