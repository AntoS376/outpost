#!/usr/bin/env node
// Stand-in for kiwix-serve: listens on --port and answers under /kiwix/.
import http from 'node:http';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const files = args.filter((a) => a.endsWith('.zim'));
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`FAKE KIWIX zims=${files.length} path=${req.url} args=${args.filter((a) => !a.endsWith('.zim')).join(' ')}`);
  })
  .on('error', () => {
    // What the real kiwix-serve 3.8 prints when its port is taken.
    console.log(`ERROR: Unable to instantiate the HTTP daemon. The port ${port} is maybe already occupied or need more permissions to be open. Please try as root or with a port number higher or equal to 1024.`);
    process.exit(1);
  })
  .listen(port, '127.0.0.1');
