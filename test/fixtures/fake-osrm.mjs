#!/usr/bin/env node
// Stand-in for OSRM's programs, copied in as osrm-extract, osrm-partition, osrm-customize and osrm-routed.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(process.env.FAKE_OSRM_VERSION || 'v26.10.0');
  process.exit(0);
}
if (tool === 'osrm-extract') {
  const [flag, profile, input] = args;
  const lua = fs.readFileSync(profile, 'utf8');
  if (flag !== '-p' || !/require\("(car|foot|bicycle)"\)/.test(lua)) process.exit(3);
  if (process.env.FAKE_OSRM_FAIL === 'extract') {
    console.error('[error] Input file is broken');
    process.exit(1);
  }
  const mode = lua.match(/require\("(\w+)"\)/)[1];
  fs.writeFileSync(input.replace(/\.osm\.pbf$/, '.osrm'), JSON.stringify({ mode, data: fs.readFileSync(input, 'utf8') }));
  process.exit(0);
}
if (tool === 'osrm-partition' || tool === 'osrm-customize') {
  fs.writeFileSync(`${args[0]}.${tool.slice(5)}`, 'ok');
  process.exit(fs.existsSync(args[0]) ? 0 : 4);
}
if (tool === 'osrm-routed') {
  const port = Number(args[args.indexOf('--port') + 1]);
  const graph = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
  for (const part of ['partition', 'customize']) if (!fs.existsSync(`${args.at(-1)}.${part}`)) process.exit(5);
  http
    .createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const m = req.url.match(/^\/route\/v1\/\w+\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)\?/);
      if (!m) return res.end(JSON.stringify({ code: 'Ok' }));
      const [a, b, c, d] = m.slice(1).map(Number);
      if (a === 0 || c === 0) return res.end(JSON.stringify({ code: 'NoSegment', message: 'Could not find a matching segment' }));
      if (a === c && b === d && a === 1) return res.end(JSON.stringify({ code: 'NoRoute' }));
      const step = (type, modifier, name, extra = {}) => ({ name, distance: 100.4, duration: 20.2, maneuver: { type, modifier, location: [a, b], bearing_after: 90, ...extra } });
      res.end(
        JSON.stringify({
          code: 'Ok',
          routes: [
            {
              distance: 1234.5,
              duration: 321.6,
              geometry: { type: 'LineString', coordinates: [[a, b], [(a + c) / 2, (b + d) / 2], [c, d]] },
              legs: [{ steps: [step('depart', undefined, `${graph.mode} Street`), step('turn', 'right', 'Emir Béchir'), step('roundabout', 'right', '', { exit: 2 }), step('arrive', 'left', '')] }],
            },
          ],
        }),
      );
    })
    .listen(port, '127.0.0.1');
} else process.exit(2);
