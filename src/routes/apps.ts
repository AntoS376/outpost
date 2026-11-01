import { Router, type RequestHandler } from 'express';
import type { AppContext } from '../context.js';
import { userOf } from '../auth.js';
import { localProxy } from '../proxy.js';

/**
 * /api/apps: the Apps shelf. Everyone signed in sees the list; installing, starting, stopping and custom apps are
 * admin-only (the central auth gate refuses those to members). Commands are shown to admins only.
 */
export function appsRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    const admin = userOf(res).role === 'admin';
    res.json({ apps: await ctx.apps.list(admin), devices: ctx.apps.listDevices(admin) });
  });
  r.post('/devices/:id/:index/save', (req, res) => res.json({ job: ctx.apps.saveInstaller(req.params.id, req.params.index, req.body?.confirm) }));
  r.post('/', async (req, res) => res.json({ app: await ctx.apps.addCustom(req.body ?? {}) }));
  r.post('/:id/install', (req, res) => res.json({ job: ctx.apps.install(req.params.id, req.body?.command) }));
  r.post('/:id/start', async (req, res) => {
    await ctx.apps.start(req.params.id, req.body?.command ?? '');
    res.json({ ok: true });
  });
  r.post('/:id/stop', async (req, res) => {
    await ctx.apps.stop(req.params.id);
    res.json({ ok: true });
  });
  r.delete('/:id', async (req, res) => {
    await ctx.apps.removeCustom(req.params.id);
    res.json({ ok: true });
  });
  return r;
}

const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:2rem;max-width:36rem;margin:auto;color:#444">
<h2>${title}</h2><p>${text}</p><p><a href="/#apps">Back to Apps</a></p></body>`;

/** /apps/<id>/… → that app on 127.0.0.1, for apps that take a base path. Members may only read unless the app allows more. */
export function appsProxy(ctx: AppContext): RequestHandler {
  return (req, res, next) => {
    const [, id = '', ...rest] = req.path.split('/');
    const app = ctx.apps.get(id);
    if (!app?.prefix) return void res.status(404).type('html').send(page('No such app', 'This app isn\'t on the shelf, or it opens on its own port instead.'));
    if (!rest.length) return void res.redirect(302, `/apps/${id}/`);
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (!reading && userOf(res).role !== 'admin' && app.members !== 'write') {
      return void res.status(403).json({ error: `Only an admin can make changes in ${app.name}.` });
    }
    localProxy({ port: app.port, readOnly: false, keepHost: true, offline: page(`${app.name} isn't running`, 'Start it from the Apps shelf in Outpost.') })(req, res, next);
  };
}
