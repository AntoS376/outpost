// `npm run demo`: runs Outpost against fake Kiwix/Ollama/pmtiles stand-ins so you can click through the UI
// without installing anything. Not used in production.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { freePort, here, listen, makeExecutable, mockFiles, mockOllama, tmpHome } from './helpers.js';

const home = await tmpHome();
const bin = path.join(home, 'bin');
await fsp.mkdir(bin);
makeExecutable(path.join(here, 'fixtures/fake-kiwix.mjs'), path.join(bin, 'kiwix-serve'));
makeExecutable(path.join(here, 'fixtures/fake-pmtiles.mjs'), path.join(bin, 'pmtiles'));
makeExecutable(path.join(here, 'fixtures/fake-docker.mjs'), path.join(bin, 'docker'));
process.env.FAKE_DOCKER_STATE = path.join(home, 'docker-state.json');
const ollama = mockOllama();
const files = mockFiles();
const ollamaPort = await listen(ollama);
const filesPort = await listen(files);
const cfg = loadConfig({
  OUTPOST_HOME: path.join(home, 'data'),
  OUTPOST_PORT: process.env.PORT ?? '8765',
  OUTPOST_KIWIX_BIN: path.join(bin, 'kiwix-serve'),
  OUTPOST_PMTILES_BIN: path.join(bin, 'pmtiles'),
  OUTPOST_KIWIX_PORT: String(await freePort()),
  OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
  OUTPOST_CATALOG_URL: `http://127.0.0.1:${filesPort}/catalog/v2`,
  // Docker apps, with a stand-in docker command.
  OUTPOST_DOCKER: '1',
  OUTPOST_DOCKER_BIN: path.join(bin, 'docker'),
});
const { app, ctx } = await createApp(cfg);
await fsp.writeFile(path.join(cfg.dirs.zim, 'wikipedia_en_demo.zim'), 'x'.repeat(4096));
await ctx.kiwix.sync();
await ctx.notesFor(cfg.user).put('water-plan', '# Water plan\n\n- Store **4 litres** per person per day\n- Boil for 3 minutes\n\n```\nrotate stock every 6 months\n```\n');
await ctx.notesFor(cfg.user).create('Contacts');
if (process.env.DEMO_PMTILES && fs.existsSync(process.env.DEMO_PMTILES)) fs.copyFileSync(process.env.DEMO_PMTILES, path.join(cfg.dirs.maps, 'world-overview.pmtiles'));
const server = http.createServer(app);
server.listen(cfg.port, '127.0.0.1', () => console.log(`demo ready on http://127.0.0.1:${cfg.port}`));
process.on('SIGTERM', async () => {
  await ctx.kiwix.stop();
  process.exit(0);
});
