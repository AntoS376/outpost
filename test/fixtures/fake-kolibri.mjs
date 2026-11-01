#!/usr/bin/env node
// Stand-in for Kolibri's CLI: `kolibri start --foreground --port N` and `kolibri stop`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const [cmd, ...rest] = process.argv.slice(2);
const home = process.env.KOLIBRI_HOME;
if (cmd === 'stop') {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'stop-calls'), 'stop\n');
  process.exit(0);
}
if (cmd !== 'start' || !rest.includes('--foreground')) process.exit(2);
const port = Number(rest[rest.indexOf('--port') + 1]);
const prefix = process.env.KOLIBRI_URL_PATH_PREFIX;
http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!req.url.startsWith(prefix)) return void res.writeHead(404).end();
      res.setHeader('Content-Type', 'application/json');
      if (req.url === `${prefix}api/public/info/`) return void res.end(JSON.stringify({ application: 'kolibri', kolibri_version: '0.19.5' }));
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
        authorization: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        host: req.headers.host,
        env: { listen: process.env.KOLIBRI_LISTEN_ADDRESS, prefix, zip: process.env.KOLIBRI_ZIP_CONTENT_PORT, zeroconf: process.env.KOLIBRI_ZEROCONF_ENABLED, home },
      }));
    });
  })
  .listen(port, process.env.KOLIBRI_LISTEN_ADDRESS);
process.on('SIGTERM', () => process.exit(0));
