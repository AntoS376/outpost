import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Config } from './config.js';
import { HttpError } from './util.js';
import type { User, UserStore } from './services/users.js';

export const COOKIE = 'outpost_session';
const MAX_AGE = 30 * 86_400;

/** Paths anyone may load before signing in: the login page and what it needs, and how a phone joins over HTTPS. */
const PUBLIC = new Set(['/healthz', '/login.html', '/app.css', '/theme.js', '/favicon.ico', '/api/auth/login', '/api/auth/me', '/join', '/outpost-ca.crt']);
/** Folders of public look-and-feel files: the logo and the interface fonts (read-only, nothing private). */
const PUBLIC_DIRS = ['/img/', '/vendor/fonts/'];

/**
 * Changes a member may make. Everything else that isn't a read (GET/HEAD) needs an admin, including routes added
 * later, so a forgotten route fails safe.
 */
const MEMBER_CHANGES: [RegExp, string[]][] = [
  [/^\/api\/ai\/chat$/, ['POST']],
  [/^\/api\/notes(\/[^/]+)?$/, ['POST', 'PUT', 'DELETE']],
  [/^\/api\/chats(\/[^/]+)?$/, ['PUT', 'DELETE']],
  [/^\/api\/emergency$/, ['PUT']], // your own emergency card and checklists
  [/^\/api\/positions\/me$/, ['PUT', 'DELETE']], // your own place on the group map
  [/^\/api\/sos$/, ['POST']], // call for help (the board checks who may cancel)
  [/^\/api\/sos\/[^/]+\/ack$/, ['POST']],
  [/^\/api\/sos\/[^/]+$/, ['DELETE']],
  [/^\/api\/auth\/(login|logout)$/, ['POST']],
  [/^\/api\/auth\/password$/, ['PUT']],
  [/^\/kolibri(\/|$)/, ['POST', 'PUT', 'PATCH', 'DELETE']], // Kolibri has its own accounts and checks
  [/^\/apps\//, ['POST', 'PUT', 'PATCH', 'DELETE']], // the apps proxy checks each app's rule for members
];
/** Reads only admins may make. */
// Region lookups go online; Docker apps are an admin's business entirely.
const ADMIN_READS = [/^\/api\/users(\/|$)/, /^\/api\/routing\/[^/]+\/regions$/, /^\/api\/docker(\/|$)/];

export const userOf = (res: Response): User => res.locals.user as User;

/**
 * Whether a request was addressed to a name this Mac really has. A web page can't fake that through DNS rebinding
 * (pointing its own domain at 127.0.0.1 so the browser treats Outpost as that page's origin): rebinding needs a
 * domain name, so IP addresses, localhost, Bonjour .local names and the Mac's own host name are safe; any other name
 * must be listed in OUTPOST_ALLOWED_HOSTS.
 */
export function hostAllowed(hostHeader: string | undefined, extra: string[]): boolean {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
  if (!host) return false;
  if (net.isIP(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === os.hostname().toLowerCase()) return true;
  return extra.includes(host);
}

/**
 * Turns away requests for unknown host names, and stops other sites framing Outpost (clickjacking). `ancestors` names
 * who may frame these pages (default: only the same origin).
 */
export function guardHost(cfg: Config, ancestors?: (req: Request) => string): RequestHandler {
  return (req, res, next) => {
    if (!hostAllowed(req.headers.host, cfg.allowedHosts)) {
      return void res
        .status(421)
        .type('text')
        .send(`Outpost doesn't answer to the name "${String(req.headers.host ?? '').slice(0, 100)}". Use this Mac's address, or add the name to OUTPOST_ALLOWED_HOSTS.`);
    }
    if (ancestors) res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors(req)}`);
    else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    }
    next();
  };
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Drops Outpost's own cookie from a Cookie header before it goes to Kiwix or Kolibri. */
export function withoutSessionCookie(header: string | string[] | undefined): string | undefined {
  const rest = String(header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${COOKIE}=`));
  return rest.length ? rest.join('; ') : undefined;
}

const sessionCookie = (token: string, maxAge = MAX_AGE) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

/** Works out who is asking, and turns away anyone who isn't allowed. */
/** Where a signed-out browser is sent to sign in (the content origin sends it back to Outpost's own address). */
export type LoginRedirect = (req: Request) => string;

export function authenticate(cfg: Config, users: UserStore, loginUrl: LoginRedirect = () => '/login.html'): RequestHandler {
  // Scripts may use Basic auth; checking a password is slow on purpose, so a verified header is remembered briefly.
  const basicCache = new Map<string, { user: User; until: number }>();
  return async (req, res, next) => {
    try {
      // Changes from another website are refused outright (the browser always says where a request came from).
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
        let host = '';
        try {
          host = new URL(req.headers.origin).host;
        } catch {
          /* "null" or garbage */
        }
        if (host !== req.headers.host) throw new HttpError(403, 'Refused: this request came from another website.');
      }

      let user: User | null = null;
      if (users.mode() === 'open') user = { name: cfg.user, role: 'admin' };
      else {
        const token = readCookie(req.headers.cookie, COOKIE);
        if (token) user = users.fromSession(token);
        const auth = req.headers.authorization ?? '';
        if (!user && auth.startsWith('Basic ')) {
          const key = createHash('sha256').update(auth).digest('hex');
          const hit = basicCache.get(key);
          if (hit && hit.until > Date.now() && users.get(hit.user.name)) user = hit.user;
          else {
            const raw = Buffer.from(auth.slice(6), 'base64').toString();
            const i = raw.indexOf(':');
            const verified = await users.verify(raw.slice(0, i), raw.slice(i + 1), req.ip ?? '').catch(() => null);
            if (verified) {
              user = verified.user;
              basicCache.set(key, { user, until: Date.now() + 5 * 60_000 });
            }
          }
        }
      }

      if (!user) {
        if (PUBLIC.has(req.path) || ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_DIRS.some((d) => req.path.startsWith(d)))) return next();
        if (req.path.startsWith('/api/')) throw new HttpError(401, 'Sign in first.');
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) return void res.redirect(302, loginUrl(req));
        if (req.method === 'GET' && req.path === '/') return void res.redirect(302, loginUrl(req));
        res.set('WWW-Authenticate', 'Basic realm="Outpost", charset="UTF-8"');
        throw new HttpError(401, 'Sign in first.');
      }
      res.locals.user = user;

      if (user.role !== 'admin') {
        const reading = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        const allowed = reading ? !ADMIN_READS.some((re) => re.test(req.path)) : MEMBER_CHANGES.some(([re, methods]) => re.test(req.path) && methods.includes(req.method));
        if (!allowed) throw new HttpError(403, 'Only an admin can do that. Ask an admin, or sign in as one.');
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** /api/auth: sign in and out, who am I, change my password. */
export function authRoutes(users: UserStore): Router {
  const r = Router();
  r.use(express.json({ limit: '16kb' }));

  r.get('/me', (_req, res) => {
    res.json({ mode: users.mode(), user: (res.locals.user as User | undefined) ?? null });
  });

  r.post('/login', async (req, res) => {
    if (users.mode() === 'open') throw new HttpError(400, 'Sign-in is off: there is no password or account yet.');
    let who;
    try {
      who = await users.verify(req.body?.name, req.body?.password, req.ip ?? '');
    } catch (e) {
      const wait = (e as { retryAfter?: number }).retryAfter;
      if (wait) res.set('Retry-After', String(wait));
      throw e;
    }
    res.setHeader('Set-Cookie', sessionCookie(await users.startSession(who.user, who.env)));
    res.json({ user: who.user });
  });

  r.post('/logout', async (req, res) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token) await users.endSession(token);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    res.json({ ok: true });
  });

  r.put('/password', async (req, res) => {
    const user = res.locals.user as User | undefined;
    if (!user || users.mode() === 'open') throw new HttpError(400, 'There are no accounts yet, so there is no password to change.');
    try {
      await users.changeOwn(user, req.body?.current, req.body?.password, readCookie(req.headers.cookie, COOKIE), req.ip ?? '');
    } catch (e) {
      const wait = (e as { retryAfter?: number }).retryAfter;
      if (wait) res.set('Retry-After', String(wait));
      throw e;
    }
    res.json({ ok: true });
  });

  return r;
}
