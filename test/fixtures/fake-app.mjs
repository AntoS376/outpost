#!/usr/bin/env node
// Stand-in for an Apps shelf web app: `fake-app --port N --baseURL /apps/<id>`, echoing each request as JSON.
import http from 'node:http';
const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const port = Number(opt('--port'));
const base = opt('--baseURL') ?? '';
http
  .createServer((req, res) => {
    if (req.url === `${base}/health`) return void res.end('ok');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null, args }));
  })
  .listen(port, '127.0.0.1');
