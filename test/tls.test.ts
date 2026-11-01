import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { isPrivateIp, LocalTls } from '../src/services/tls.js';
import { freePort, listen, mockOllama, tmpHome } from './helpers.js';

describe('local HTTPS', () => {
  it('knows which addresses its CA may vouch for', () => {
    for (const ip of ['192.168.1.20', '10.1.2.3', '172.16.0.1', '172.31.255.255', '127.0.0.1']) assert.ok(isPrivateIp(ip), ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '169.254.1.1', '100.64.0.1', 'fe80::1']) assert.ok(!isPrivateIp(ip), ip);
  });

  it('makes a name-constrained CA and a server certificate for this Mac, kept private and reused', async () => {
    const h = await tmpHome();
    try {
      const tls = new LocalTls(loadConfig({ OUTPOST_HOME: h }));
      const creds = await tls.ensure();
      assert.equal(fs.statSync(tls.dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(tls.dir, 'ca.key')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(tls.dir, 'server.key')).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(tls.dir).sort(), ['ca.key', 'ca.pem', 'server.key', 'server.pem'], 'no leftovers');

      const ca = new X509Certificate(fs.readFileSync(path.join(tls.dir, 'ca.pem')));
      const cert = new X509Certificate(creds.cert as Buffer);
      assert.ok(ca.ca);
      assert.ok(cert.verify(ca.publicKey), 'signed by the CA');
      for (const ip of tls.currentNames().ips) assert.equal(cert.checkIP(ip), ip);
      assert.equal(cert.checkHost('localhost'), 'localhost');
      assert.ok((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000 <= 826, "within Apple's 825-day limit");
      const text = execFileSync('/usr/bin/openssl', ['x509', '-in', path.join(tls.dir, 'ca.pem'), '-noout', '-text']).toString();
      assert.match(text, /Name Constraints: critical/);
      assert.match(text, /IP:192\.168\.0\.0\/255\.255\.0\.0/);
      assert.match(text, /DNS:local\b/);
      assert.equal(await tls.caFingerprint(), ca.fingerprint256);

      // A certificate for a real website, even if signed by this CA, fails the constraints.
      const evil = path.join(h, 'evil');
      await fsp.writeFile(`${evil}.cnf`, '[ext]\nbasicConstraints = critical,CA:FALSE\nsubjectAltName = DNS:www.apple.com\n');
      execFileSync('/usr/bin/openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${evil}.key`]);
      execFileSync('/usr/bin/openssl', ['req', '-new', '-key', `${evil}.key`, '-subj', '/CN=evil', '-out', `${evil}.csr`]);
      execFileSync('/usr/bin/openssl', ['x509', '-req', '-in', `${evil}.csr`, '-CA', path.join(tls.dir, 'ca.pem'), '-CAkey', path.join(tls.dir, 'ca.key'), '-set_serial', '7', '-days', '1', '-extfile', `${evil}.cnf`, '-extensions', 'ext', '-out', `${evil}.pem`], { stdio: 'ignore' });
      assert.throws(
        () => execFileSync('/usr/bin/openssl', ['verify', '-CAfile', path.join(tls.dir, 'ca.pem'), `${evil}.pem`], { stdio: 'pipe' }),
        (e: any) => /permitted subtree violation/.test(`${e.stdout}${e.stderr}`),
      );

      // Reused while it still fits; a fresh one when it doesn't cover this Mac any more.
      const again = await tls.ensure();
      assert.equal(new X509Certificate(again.cert as Buffer).serialNumber, cert.serialNumber);
      await fsp.writeFile(path.join(tls.dir, 'server.pem'), 'garbage');
      const renewed = new X509Certificate((await tls.ensure()).cert as Buffer);
      assert.notEqual(renewed.serialNumber, cert.serialNumber);
      assert.equal(new X509Certificate(fs.readFileSync(path.join(tls.dir, 'ca.pem'))).fingerprint256, ca.fingerprint256, 'same CA, so phones stay set up');

      // A real HTTPS round trip, trusting only the CA.
      const srv = https.createServer(await tls.ensure(), (_q, r) => r.end('ok'));
      const port = await listen(srv as unknown as http.Server);
      const body = await new Promise<string>((resolve, reject) => {
        https.get({ host: '127.0.0.1', port, ca: fs.readFileSync(path.join(tls.dir, 'ca.pem')) }, (r) => {
          let b = '';
          r.on('data', (d) => (b += d));
          r.on('end', () => resolve(b));
        }).on('error', reject);
      });
      srv.close();
      assert.equal(body, 'ok');
    } finally {
      await fsp.rm(h, { recursive: true, force: true });
    }
  });

  it('offers the join page and certificate before sign-in, only when Outpost is shared', async () => {
    const h = await tmpHome();
    const ollama = mockOllama();
    const op = await listen(ollama);
    const servers: http.Server[] = [];
    const boot = async (env: Record<string, string>) => {
      const made = await createApp(loadConfig({ OUTPOST_HOME: h, OUTPOST_KIWIX_PORT: String(await freePort()), OLLAMA_URL: `http://127.0.0.1:${op}`, ...env }));
      const s = http.createServer(made.app);
      servers.push(s);
      return { ctx: made.ctx, base: `http://127.0.0.1:${await listen(s)}` };
    };
    try {
      const shared = await boot({ OUTPOST_HOST: '0.0.0.0', OUTPOST_PASSWORD: 'correct horse', OUTPOST_HTTPS_PORT: '9443' });
      await shared.ctx.tls.ensure();
      assert.equal((await fetch(`${shared.base}/api/status`)).status, 401, 'everything else still needs sign-in');
      const join = await fetch(`${shared.base}/join`);
      assert.equal(join.status, 200);
      const html = await join.text();
      assert.match(html, /Download the certificate/);
      assert.match(html, /https:\/\/127\.0\.0\.1:9443\//);
      const crt = await fetch(`${shared.base}/outpost-ca.crt`);
      assert.equal(crt.status, 200);
      assert.equal(crt.headers.get('content-type'), 'application/x-x509-ca-cert');
      const der = new X509Certificate(Buffer.from(await crt.arrayBuffer()));
      assert.ok(der.ca);
      assert.match(der.subject, /Outpost local CA/);
      const st = await fetch(`${shared.base}/api/status`, { headers: { Authorization: `Basic ${Buffer.from('outpost:correct horse').toString('base64')}` } });
      assert.equal((await st.json()).listen.https.port, 9443);

      const local = await boot({});
      assert.equal((await fetch(`${local.base}/outpost-ca.crt`)).status, 404, 'no HTTPS while Outpost is only on this Mac');
      assert.match(await (await fetch(`${local.base}/join`)).text(), /HTTPS is off/);
      assert.equal((await (await fetch(`${local.base}/api/status`)).json()).listen.https, null);
    } finally {
      for (const s of servers) {
        s.closeAllConnections();
        s.close();
      }
      ollama.close();
      await fsp.rm(h, { recursive: true, force: true });
    }
  });
});
