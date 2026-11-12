import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { ensureDirs, type Config } from './config.js';
import type { AppContext } from './context.js';
import { authenticate, authRoutes, guardHost, readCookie, userOf } from './auth.js';
import { UserStore } from './services/users.js';
import { ChatStore } from './services/chats.js';
import { usersRoutes } from './routes/users.js';
import { chatsRoutes } from './routes/chats.js';
import { UpdateChecker } from './services/updates.js';
import { updatesRoutes } from './routes/updates.js';
import { emergencyRoutes } from './routes/emergency.js';
import { readyRoutes } from './routes/ready.js';
import { AppsService } from './services/apps.js';
import { appsProxy, appsRoutes } from './routes/apps.js';
import { LocalTls } from './services/tls.js';
import { joinRoutes } from './routes/join.js';
import { KeepAwake } from './services/awake.js';
import { PositionBoard } from './services/positions.js';
import { SosBoard } from './services/sos.js';
import { RoutingService } from './services/routing.js';
import { routingRoutes } from './routes/routing.js';
import { DockerService } from './services/docker.js';
import { dockerRoutes } from './routes/docker.js';
import { GpuMonitor } from './services/gpu.js';
import { kiwixProxy, kolibriProxy } from './proxy.js';
import { KolibriService } from './services/kolibri.js';
import { InstallerService } from './services/installers.js';
import { VoiceStore } from './services/voice.js';
import { PlaceIndex } from './services/places.js';
import { Benchmark } from './services/benchmark.js';
import { benchmarkRoutes } from './routes/benchmark.js';
import { educationRoutes } from './routes/education.js';
import { installRoutes } from './routes/install.js';
import { voiceRoutes } from './routes/voice.js';
import { HttpError } from './util.js';
import { KiwixService } from './services/process.js';
import { JobManager } from './services/jobs.js';
import { OllamaClient } from './services/ollama.js';
import { OpenAiCompatibleClient } from './services/openai.js';
import { RagStore } from './services/rag.js';
import { moveFilesSafely, NotesStore } from './services/notes.js';
import { statusRoutes } from './routes/status.js';
import { libraryRoutes } from './routes/library.js';
import { jobsRoutes } from './routes/jobs.js';
import { mapsRoutes } from './routes/maps.js';
import { notesRoutes } from './routes/notes.js';
import { aiRoutes } from './routes/ai.js';
import { setupRoutes } from './routes/setup.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const guideFile = fileURLToPath(new URL('../docs/SETUP.md', import.meta.url));

/** Outpost's own address and the content address for this request's host, matching its scheme (http or https). */
export function origins(cfg: Config, req: express.Request): { main: string; content: string } {
  const secure = req.protocol === 'https';
  const host = req.hostname.includes(':') ? `[${req.hostname}]` : req.hostname;
  return {
    main: `${req.protocol}://${host}:${secure ? cfg.https.port : cfg.port}`,
    content: `${req.protocol}://${host}:${secure ? cfg.content.httpsPort : cfg.content.port}`,
  };
}

/**
 * Two apps: `app` is Outpost itself; `content` serves books (/kiwix), Education (/kolibri) and apps (/apps) on their
 * own ports. Different origins, so a page in a book or an app can't read Outpost's pages or make changes in its name.
 * The sign-in cookie is per host (not port), so the same sign-in works on both.
 */
export async function createApp(cfg: Config): Promise<{ app: express.Express; content: express.Express; ctx: AppContext }> {
  await ensureDirs(cfg);
  const jobs = new JobManager(cfg);
  const users = new UserStore(cfg);
  await users.load();
  // Notes from before accounts existed sit directly in notes/; they belong to the first admin (or the only user).
  await moveFilesSafely(cfg.dirs.notes, path.join(cfg.dirs.notes, users.firstAdmin() ?? cfg.user), (n) => n.endsWith('.md'));
  const ai = cfg.ai.provider === 'ollama' ? new OllamaClient(cfg) : new OpenAiCompatibleClient(cfg);
  const ctx: AppContext = {
    cfg,
    kiwix: new KiwixService(cfg),
    jobs,
    ai,
    rag: new RagStore(cfg, ai),
    users,
    updates: new UpdateChecker(cfg, ai),
    notesFor: (user) => new NotesStore(path.join(cfg.dirs.notes, user)),
    chatsFor: (user) => new ChatStore(path.join(cfg.home, 'chats', user)),
    kolibri: new KolibriService(cfg),
    installers: new InstallerService(cfg, jobs),
    voice: new VoiceStore(cfg.dirs.voice),
    places: new PlaceIndex(cfg, jobs),
    benchmark: new Benchmark(cfg, ai),
    apps: new AppsService(cfg, jobs),
    tls: new LocalTls(cfg),
    awake: new KeepAwake(cfg),
    positions: new PositionBoard(),
    sos: new SosBoard(),
    routing: new RoutingService(cfg, jobs),
    gpu: new GpuMonitor(cfg.ioregBin),
    // Ports a Docker app may not take: Outpost's own, its helpers' and the shelf apps'.
    docker: new DockerService(cfg, jobs, () => [
      cfg.port,
      cfg.https.port,
      cfg.content.port,
      cfg.content.httpsPort,
      cfg.kiwixPort,
      cfg.kolibri.port,
      cfg.kolibri.zipPort,
      11434,
      ...ctx.apps.all().map((a) => a.port),
    ]),
    // main.ts handles SIGTERM: it stops the reader, Kolibri and apps, then exits cleanly, so launchd leaves it off.
    requestShutdown: () => process.kill(process.pid, 'SIGTERM'),
    // SIGHUP stops the same way but exits non-zero, and launchd starts Outpost again. Outside launchd nothing would.
    restart: () => {
      // launchd names the service in XPC_SERVICE_NAME (scripts/install-launchd.sh); other apps' shells set it too.
      if (process.env.XPC_SERVICE_NAME !== 'com.outpost.server') return false;
      setTimeout(() => process.kill(process.pid, 'SIGHUP'), 500); // let the reply reach the browser first
      return true;
    },
  };
  await ctx.apps.load();

  const app = express();
  app.disable('x-powered-by');
  app.use(guardHost(cfg));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(authenticate(cfg, users));
  app.use('/api/auth', authRoutes(users));
  app.use(joinRoutes(ctx));

  // Books, Education and apps live on the content address now; old links are sent there.
  app.use(['/kiwix', '/kolibri', '/apps'], (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.status(404).json({ error: 'This moved to the content address.' });
    res.redirect(302, origins(cfg, req).content + req.originalUrl);
  });
  // Installers saved from the Apps page, for phones and computers to fetch without internet.
  app.use(
    '/installers',
    express.static(ctx.apps.installersDir, {
      dotfiles: 'deny',
      index: false,
      // Always a download, never a page that could run in Outpost's name (the folder is writable through File Browser).
      setHeaders: (res) => {
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('Content-Security-Policy', 'sandbox');
      },
    }),
  );
  app.use('/installers', (_req, res) => {
    res.status(404).send('Not saved on this Outpost.');
  });
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api/status', statusRoutes(ctx));
  app.use('/api/library', libraryRoutes(ctx));
  app.use('/api/jobs', jobsRoutes(ctx));
  app.use('/api/maps', mapsRoutes(ctx));
  app.use('/api/routing', routingRoutes(ctx));
  app.use('/api/notes', notesRoutes(ctx));
  app.use('/api/ai', aiRoutes(ctx));
  app.use('/api/setup', setupRoutes(ctx));
  app.use('/api/education', educationRoutes(ctx));
  app.use('/api/install', installRoutes(ctx));
  app.use('/api/voice', voiceRoutes(ctx));
  app.use('/api/benchmark', benchmarkRoutes(ctx));
  app.use('/api/users', usersRoutes(ctx));
  app.use('/api/chats', chatsRoutes(ctx));
  app.use('/api/updates', updatesRoutes(ctx));
  app.use('/api/emergency', emergencyRoutes(ctx));
  app.use('/api/ready', readyRoutes(ctx));
  app.use('/api/apps', appsRoutes(ctx));
  app.use('/api/docker', dockerRoutes(ctx));
  // The group map: who is sharing their position, and where. Your own entry only; in memory only.
  app.get('/api/positions', (_req, res) => {
    const me = userOf(res).name;
    res.json({ positions: ctx.positions.list().map((p) => ({ ...p, me: p.name === me })) });
  });
  app.put('/api/positions/me', (req, res) => res.json(ctx.positions.set(userOf(res).name, req.body ?? {})));
  app.delete('/api/positions/me', (_req, res) => {
    ctx.positions.remove(userOf(res).name);
    res.json({ ok: true });
  });
  // Network SOS: calls for help shown to everyone signed in. In memory only; the sender or an admin cancels.
  app.get('/api/sos', (_req, res) => {
    const me = userOf(res).name;
    res.json({ alerts: ctx.sos.list().map((a) => ({ ...a, mine: a.name === me, acked: a.acks.some((k) => k.name === me) })) });
  });
  app.post('/api/sos', (req, res) => {
    try {
      res.status(201).json(ctx.sos.send(userOf(res).name, req.body ?? {}));
    } catch (e) {
      const wait = (e as { retryAfter?: number }).retryAfter;
      if (wait) res.set('Retry-After', String(wait));
      throw e;
    }
  });
  app.post('/api/sos/:id/ack', (req, res) => res.json(ctx.sos.ack(String(req.params.id), userOf(res).name)));
  app.delete('/api/sos/:id', (req, res) => {
    const me = userOf(res);
    ctx.sos.cancel(String(req.params.id), me.name, me.role === 'admin');
    if (me.role === 'admin') console.log(`SOS ${req.params.id} cancelled by ${me.name}`);
    res.json({ ok: true });
  });
  // Shutdown (admins only: the central gate refuses this to members). Answers first, then stops.
  app.post('/api/shutdown', (_req, res) => {
    console.log(`Shutdown requested by ${userOf(res).name}`);
    res.on('finish', () => setTimeout(() => ctx.requestShutdown(), 300));
    res.json({ ok: true });
  });
  // Keep the Mac awake while serving (admins only: the central gate refuses this change to members).
  app.put('/api/awake', async (req, res) => {
    await ctx.awake.set(req.body?.on === true);
    res.json(ctx.awake.status());
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/assets/fonts', express.static(path.join(cfg.dirs.assets, 'fonts')));
  // CyberChef, once installed from Tools (scripts/fetch-cyberchef.sh): static files, behind the same sign-in as everything else.
  app.use('/tools/cyberchef', express.static(path.join(cfg.dirs.assets, 'cyberchef'), { index: 'index.html', dotfiles: 'deny' }));
  app.use('/tools/cyberchef', (_req, res) => {
    res
      .status(404)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>CyberChef isn't installed</title><body style="font:16px system-ui;padding:2rem;max-width:36rem;margin:auto;color:#444">` +
          `<h2>CyberChef isn't installed</h2><p>An admin can install it from Tools (about 80 MB), or run <code>./scripts/fetch-cyberchef.sh</code> in Terminal in the Outpost folder. Then reload this page.</p>` +
          `<p><a href="/#tools">Back to Tools</a></p></body>`,
      );
  });
  // The setup guide: one Markdown file, read on GitHub before installing and in the app (Guide page) after.
  app.get('/guide.md', (_req, res) => res.type('text/markdown; charset=utf-8').sendFile(guideFile));
  app.use(express.static(publicDir));
  // Browsers (Safari especially) also ask the site root for an icon; answer with the current tab icon.
  app.get('/favicon.ico', (_req, res) => res.type('image/png').set('Cache-Control', 'no-cache').sendFile(path.join(publicDir, 'img', 'badge-64.png')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error(err); // HttpErrors are expected outcomes, not bugs
    if (res.headersSent) return res.destroy();
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Internal error' : err.message });
  };
  app.use(onError);

  await ctx.kiwix.sync();
  await ctx.kolibri.resume();
  await ctx.apps.resume();
  await ctx.awake.resume();
  await ctx.places.ensureAll(); // starts background jobs; doesn't wait for them
  await ctx.routing.resume(); // likewise, when OSRM was updated
  ctx.updates.startSchedule(); // does nothing unless update checks were turned on
  const content = express();
  content.disable('x-powered-by');
  // Only Outpost's own pages (both schemes) may frame content, e.g. the Library page showing the reader, and content
  // itself: Kiwix's viewer shows each article in a frame of its own.
  content.use(guardHost(cfg, (req) => {
    const host = req.hostname.includes(':') ? `[${req.hostname}]` : req.hostname;
    return `'self' http://${host}:${cfg.port} https://${host}:${cfg.https.port}`;
  }));
  content.get('/healthz', (_req, res) => res.json({ ok: true }));
  content.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  content.use(authenticate(cfg, users, (req) => `${origins(cfg, req).main}/login.html?next=${encodeURIComponent(origins(cfg, req).content + req.originalUrl)}`));
  content.use('/kiwix', kiwixProxy(cfg.kiwixPort));
  content.use('/kolibri', kolibriProxy(cfg.kolibri.port));
  content.use('/apps', appsProxy(ctx));
  // The reader's look follows the Light / Dark / Auto choice made in Outpost's top bar. It lives on another port, so
  // the choice comes in a cookie (cookies are per host); Auto keeps following the device.
  content.get('/kiwix-skin.css', async (req, res) => {
    const theme = readCookie(req.headers.cookie, 'outpost_theme');
    let css = await fsp.readFile(path.join(publicDir, 'kiwix-skin.css'), 'utf8');
    if (theme === 'light' || theme === 'dark') {
      css = css.replaceAll('@media (prefers-color-scheme: dark)', theme === 'dark' ? '@media all' : '@media not all').replace('color-scheme: light dark', `color-scheme: ${theme}`);
    }
    res.set('Cache-Control', 'no-cache').type('text/css').send(css);
  });
  content.use('/vendor/fonts', express.static(path.join(publicDir, 'vendor', 'fonts')));
  content.use((req, res) => res.redirect(302, origins(cfg, req).main + '/'));
  content.use(onError);

  return { app, content, ctx };
}
