import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { dirSize, listFiles, OUTPOST_RELEASED, OUTPOST_VERSION, resolveBin } from '../util.js';
import { userOf } from '../auth.js';
import { readBattery } from '../services/battery.js';

export function statusRoutes(ctx: AppContext): Router {
  const r = Router();
  // The top bar's battery meter asks often, so this stays separate from the heavier status below.
  r.get('/battery', async (_req, res) => res.json(await readBattery()));
  r.get('/', async (_req, res) => {
    const user = userOf(res);
    const { cfg } = ctx;
    const [fs, models, maps, zim, mapBytes, noteBytes, docBytes, ragBytes, notes, ragList, kolibri] = await Promise.all([
      fsp.statfs(cfg.home).catch(() => null),
      ctx.ai.models(),
      listFiles(cfg.dirs.maps, '.pmtiles'),
      dirSize(cfg.dirs.zim),
      dirSize(cfg.dirs.maps),
      dirSize(cfg.dirs.notes),
      dirSize(cfg.dirs.docs),
      dirSize(cfg.dirs.rag),
      ctx.notesFor(user.name).list(),
      ctx.rag.list(),
      ctx.kolibri.status(),
    ]);
    res.json({
      version: OUTPOST_VERSION,
      released: OUTPOST_RELEASED,
      // lan: this Mac's IPv4 addresses on the local network, for the "open it from another device" link.
      listen: {
        host: cfg.host,
        port: cfg.port,
        lan: Object.values(os.networkInterfaces())
          .flat()
          .filter((n) => n && n.family === 'IPv4' && !n.internal)
          .map((n) => n!.address),
        // This Mac's Bonjour name (<name>.local), which phones on the same Wi-Fi can use instead of the number.
        local: ctx.tls.currentNames().dns.find((d) => d.endsWith('.local')) ?? null,
        awake: ctx.awake.status(),
        // Ports for books, Education and apps (same host); https only when Outpost is shared.
        content: { port: cfg.content.port, httpsPort: cfg.https.on ? cfg.content.httpsPort : null },
        https: cfg.https.on ? { port: cfg.https.port, fingerprint: await ctx.tls.caFingerprint() } : null,
      },
      uptime: Math.round(process.uptime()),
      host: { platform: process.platform, arch: process.arch, hostname: os.hostname(), totalmem: os.totalmem() },
      storage: {
        home: cfg.home,
        free: fs ? fs.bavail * fs.bsize : null,
        total: fs ? fs.blocks * fs.bsize : null,
        used: { library: zim, maps: mapBytes, notes: noteBytes, documents: docBytes + ragBytes },
      },
      services: {
        library: ctx.kiwix.status(),
        ai: {
          provider: ctx.ai.kind,
          label: ctx.ai.label,
          reachable: models !== null,
          url: ctx.ai.url,
          models: models?.filter((m) => !m.embedding).length ?? 0,
          embedModel: cfg.embedModel,
          canManageModels: ctx.ai.canManageModels,
        },
        maps: { files: maps.length },
        notes: { count: notes.length },
        documents: { count: ragList.docs.length },
        education: { state: kolibri.state },
      },
      binaries: {
        'kiwix-serve': !!resolveBin(cfg.kiwixBin),
        pmtiles: !!resolveBin(cfg.pmtilesBin),
      },
      tools: {
        cyberchef: (await fsp.readFile(path.join(cfg.dirs.assets, 'cyberchef', 'VERSION'), 'utf8').catch(() => '')).trim() || null,
      },
      auth: ctx.users.mode() !== 'open',
      user,
    });
  });
  return r;
}
