import { Router } from 'express';
import type { AppContext } from '../context.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * /join (open to everyone, before sign-in): how a phone gets onto Outpost's HTTPS, so its GPS works on the map.
 * /outpost-ca.crt: the CA certificate to install. Both are public; neither reveals anything private.
 */
export function joinRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/outpost-ca.crt', async (_req, res) => {
    const der = ctx.cfg.https.on ? await ctx.tls.caDer() : null;
    if (!der) return void res.status(404).type('text').send("Outpost's HTTPS is off, so there is no certificate to install.");
    res.type('application/x-x509-ca-cert').set('Content-Disposition', 'attachment; filename="outpost-ca.crt"').send(der);
  });

  r.get('/join', async (req, res) => {
    const host = (req.hostname || 'localhost').replace(/[^\w.:-]/g, '');
    const port = ctx.cfg.https.port;
    const secure = `https://${host}:${port}/`;
    const fp = ctx.cfg.https.on ? await ctx.tls.caFingerprint() : null;
    const body = !ctx.cfg.https.on
      ? `<p>HTTPS is off on this Outpost, so phones can't share their location with its map. The person running Outpost can turn it on by sharing Outpost on the network (see the setup guide).</p><p><a class="btn primary" href="/">Open Outpost</a></p>`
      : `<p class="lead">Do this once per phone, so the map can show where you are. GPS works without internet; your browser only needs a secure connection to Outpost.</p>
<section class="block"><h2>1. Get Outpost's certificate</h2>
<p><a class="btn primary" href="/outpost-ca.crt">Download the certificate</a></p>
<p class="muted">It only vouches for addresses on local networks (like 192.168.x.x) and .local names, so it can't be used for real websites. To check it's the right one, its SHA-256 fingerprint starts with <code>${esc((fp ?? '').slice(0, 23))}</code>.</p></section>
<section class="block"><h2>2. Trust it</h2>
<h3>iPhone and iPad</h3><ol>
<li>Open this page in <b>Safari</b>, tap <b>Download the certificate</b>, then <b>Allow</b>.</li>
<li>Open <b>Settings</b>: tap <b>Profile Downloaded</b> near the top (or <b>General → VPN &amp; Device Management</b>), then <b>Install</b>.</li>
<li>Go to <b>Settings → General → About → Certificate Trust Settings</b> and turn on <b>Outpost local CA</b>.</li></ol>
<h3>Android</h3><ol>
<li>Tap <b>Download the certificate</b>.</li>
<li>Open <b>Settings</b> and search for <b>CA certificate</b> (usually <b>Security → More security settings → Encryption &amp; credentials → Install a certificate → CA certificate</b>).</li>
<li>Tap <b>Install anyway</b> and choose <code>outpost-ca.crt</code> from Downloads.</li></ol>
<h3>Mac or PC</h3><p>Open the downloaded file. On a Mac it opens Keychain Access: double-click <b>Outpost local CA</b>, open <b>Trust</b>, and choose <b>Always Trust</b>.</p></section>
<section class="block"><h2>3. Open Outpost securely</h2>
<p><a class="btn primary" href="${esc(secure)}">${esc(secure)}</a></p>
<p class="muted">Bookmark this address. On the Maps page, tap <b>Locate me</b> and allow location when the phone asks.</p>
<p class="muted">Don't need your location on the map? <a href="/">Open Outpost without this</a>.</p></section>`;
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join Outpost</title><link rel="stylesheet" href="/app.css"><link rel="icon" type="image/png" href="/img/badge-64.png"></head>
<body class="login-page"><main class="join"><div class="brand"><img src="/img/badge-256.png" alt="" width="72" height="68"><b>Outpost</b></div><h1>Join Outpost</h1>${body}</main></body></html>`);
  });
  return r;
}
