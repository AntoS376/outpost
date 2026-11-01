import http from 'node:http';
import type { RequestHandler } from 'express';
import { withoutSessionCookie } from './auth.js';

const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:2rem;max-width:36rem;margin:auto;color:#444">
<h2>${title}</h2><p>${text}</p></body>`;

/**
 * Reverse-proxies a path prefix to a local child server, streaming both ways. The Outpost login (Authorization)
 * is never forwarded. `readOnly` allows only GET/HEAD; `keepHost` passes the browser's Host so the upstream builds
 * links that point back through Outpost.
 */
export function localProxy(opts: { port: number; readOnly: boolean; keepHost: boolean; offline: string; skin?: (path: string) => string | null }): RequestHandler {
  return (req, res) => {
    if (opts.readOnly && req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).send('Method not allowed');
      return;
    }
    const headers = { ...req.headers };
    if (!opts.keepHost) headers.host = `127.0.0.1:${opts.port}`;
    delete headers.authorization; // never forward the Outpost login upstream
    // Pages that get a stylesheet added: ask for them uncompressed so the HTML can be edited on the way through.
    const skin = opts.skin && (req.method === 'GET' || req.method === 'HEAD') ? opts.skin(req.path) : null;
    if (skin) delete headers['accept-encoding'];
    const cookie = withoutSessionCookie(headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    const upstream = http.request({ host: '127.0.0.1', port: opts.port, method: req.method, path: req.originalUrl, headers }, (up) => {
      const html = String(up.headers['content-type'] ?? '').startsWith('text/html') && !up.headers['content-encoding'];
      if (!skin || !html) {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      up.on('data', (c: Buffer) => chunks.push(c));
      up.on('end', () => {
        const page = Buffer.concat(chunks).toString('utf8');
        const link = `<link rel="stylesheet" href="${skin}">`;
        const out = page.includes('</head>') ? page.replace('</head>', `${link}</head>`) : link + page;
        const outHeaders = { ...up.headers };
        delete outHeaders['content-length'];
        res.writeHead(up.statusCode ?? 502, outHeaders);
        res.end(out);
      });
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.status(503).type('html').send(opts.offline);
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}

/** The reader's own pages (library home, search results, the toolbar around a book), not book articles. */
export const KIWIX_SKINNED = /^\/(viewer|nojs|search)?$/;

/** /kiwix → kiwix-serve, read-only, with Outpost's look on the reader's own pages. */
export function kiwixProxy(port: number): RequestHandler {
  return localProxy({
    port,
    readOnly: true,
    keepHost: false,
    skin: (p) => (KIWIX_SKINNED.test(p) ? '/kiwix-skin.css' : null),
    offline: page("The library server isn't running", 'Add a ZIM file (for example Wikipedia) from <b>Library → Manage</b>. Outpost starts the reader automatically.'),
  });
}

/** /kolibri → Kolibri, all methods (it has forms and an API). */
export function kolibriProxy(port: number): RequestHandler {
  return localProxy({
    port,
    readOnly: false,
    keepHost: true,
    offline: page("Education isn't running", 'Start Kolibri from the <a href="/#education">Education</a> page in Outpost.'),
  });
}
