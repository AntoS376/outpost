import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { LOOPBACK } from '../config.js';
import type { AppContext } from '../context.js';
import { bookInstalled, loadCollections, resolveCollections, type Collections, type Resolved, type ResolvedBook } from '../services/collections.js';
import type { Job } from '../services/jobs.js';
import { OllamaClient } from '../services/ollama.js';
import { UserStore } from '../services/users.js';
import { estimateExtract, latestPlanet } from '../services/planet.js';
import { HttpError, listFiles, parseBbox, parseMaxzoom, readJson, safeFileName, writeJsonAtomic } from '../util.js';

interface State {
  setupDismissed?: boolean;
}

const GB = (n: number) => `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} GB`;
const tagged = (name: string) => (name.includes(':') ? name : `${name}:latest`);

/** First-run wizard: a Wikipedia size, a level per topic, a map region and AI models, queued in one go. */
export function setupRoutes(ctx: AppContext): Router {
  const r = Router();
  const stateFile = path.join(ctx.cfg.home, 'state.json');
  let cache: { at: number; data: Collections; resolved: Resolved } | null = null;

  // Catalog lookups take a few seconds, so the result is reused for ten minutes.
  async function catalog(): Promise<{ data: Collections; resolved: Resolved }> {
    if (cache && Date.now() - cache.at < 10 * 60_000) return cache;
    const data = await loadCollections(ctx.cfg.collectionsFile);
    cache = { at: Date.now(), data, resolved: await resolveCollections(ctx.cfg, data) };
    return cache;
  }

  async function freeBytes(): Promise<number> {
    const s = await fsp.statfs(ctx.cfg.home);
    return s.bavail * s.bsize;
  }

  /** Whether to open the wizard on first launch: nothing in the library or maps, and not skipped before. */
  async function shouldShow(): Promise<boolean> {
    const [zims, maps, state] = await Promise.all([listFiles(ctx.cfg.dirs.zim, '.zim'), listFiles(ctx.cfg.dirs.maps, '.pmtiles'), readJson<State>(stateFile, {})]);
    return !state.setupDismissed && zims.length === 0 && maps.length === 0;
  }

  // Cheap check for page load; the full list below needs the catalog and takes seconds.
  r.get('/status', async (_req, res) => {
    res.json({ show: await shouldShow() });
  });

  r.get('/', async (_req, res) => {
    const [{ data, resolved }, zims, models, show, free] = await Promise.all([
      catalog(),
      listFiles(ctx.cfg.dirs.zim, '.zim'),
      ctx.ai.models(),
      shouldShow(),
      freeBytes(),
    ]);
    const zimNames = zims.map((f) => f.name);
    const have = new Set((models ?? []).map((m) => tagged(m.name)));
    res.json({
      show,
      free,
      canPullModels: ctx.ai.canManageModels,
      topics: resolved.topics.map((t) => ({ ...t, levels: t.levels.map((l) => ({ ...l, books: l.books.map((b) => ({ ...b, installed: bookInstalled(b, zimNames) })) })) })),
      wikipedia: resolved.wikipedia.map((w) => ({ ...w, installed: bookInstalled(w, zimNames) })),
      dropped: resolved.dropped,
      models: data.models.map((m) => ({ ...m, installed: have.has(tagged(m.name)) })),
      maps: data.maps,
      shared: !LOOPBACK.has(ctx.cfg.host),
    });
  });

  // Wi-Fi sharing: Outpost listens on every network instead of this Mac only. Takes effect after a restart.
  r.post('/share', async (req, res) => {
    const on = req.body?.on === true;
    if (on && !ctx.cfg.pass && UserStore.count(ctx.cfg.home) === 0) {
      throw new HttpError(409, 'Create an account first, so only people you know can use Outpost.');
    }
    await setEnv(ctx.cfg.envFile, 'OUTPOST_HOST', on ? '0.0.0.0' : '127.0.0.1');
    res.json({ restarting: ctx.restart() });
  });

  r.post('/dismiss', async (_req, res) => {
    await writeJsonAtomic(stateFile, { ...(await readJson<State>(stateFile, {})), setupDismissed: true });
    res.json({ ok: true });
  });

  r.post('/map-estimate', async (req, res) => {
    const bbox = parseBbox(req.body?.bbox);
    const maxzoom = parseMaxzoom(req.body?.maxzoom);
    const source = await latestPlanet(ctx.cfg);
    res.json({ bytes: await estimateExtract(ctx.cfg, source, bbox, maxzoom), source });
  });

  r.post('/start', async (req, res) => {
    const body = (req.body ?? {}) as { topics?: unknown; wikipedia?: unknown; map?: { preset?: string; bbox?: unknown; maxzoom?: unknown; name?: string } | null; models?: unknown };
    const { data, resolved } = await catalog();
    const zimNames = (await listFiles(ctx.cfg.dirs.zim, '.zim')).map((f) => f.name);

    // Books: only ones the live catalog resolved, never URLs from the browser. A level brings the levels before it.
    const picks = body.topics && typeof body.topics === 'object' && !Array.isArray(body.topics) ? Object.entries(body.topics as Record<string, unknown>) : [];
    const chosen: ResolvedBook[] = picks.flatMap(([topicId, levelId]) => {
      const t = resolved.topics.find((x) => x.id === topicId);
      if (!t) throw new HttpError(400, `Unknown topic "${topicId.slice(0, 40)}"`);
      const l = t.levels.find((x) => x.id === String(levelId));
      if (!l) throw new HttpError(400, `${t.title} has no level "${String(levelId).slice(0, 40)}"`);
      return l.books;
    });
    if (body.wikipedia != null) {
      const w = resolved.wikipedia.find((x) => x.id === String(body.wikipedia));
      if (!w) throw new HttpError(400, `Unknown Wikipedia choice "${String(body.wikipedia).slice(0, 40)}"`);
      chosen.push(w);
    }
    const books = [...new Map(chosen.map((b) => [b.fileName, b])).values()].filter((b) => !bookInstalled(b, zimNames));

    // Map: the world preset or a chosen area, cut from the newest planet build.
    let map: { source: string; bbox: [number, number, number, number]; maxzoom: number | null; name: string; size: number } | null = null;
    if (body.map) {
      const preset = body.map.preset ? data.maps[body.map.preset] : null;
      if (body.map.preset && !preset) throw new HttpError(400, `Unknown map preset "${body.map.preset}"`);
      const bbox = preset ? preset.bbox : parseBbox(body.map.bbox);
      const maxzoom = preset ? preset.maxzoom : parseMaxzoom(body.map.maxzoom);
      const name = preset ? `${body.map.preset}.pmtiles` : safeFileName(String(body.map.name || 'my-region.pmtiles'), ['.pmtiles']);
      if (!name) throw new HttpError(400, 'Map name must end in .pmtiles and use plain characters');
      const source = await latestPlanet(ctx.cfg);
      map = { source, bbox, maxzoom, name, size: await estimateExtract(ctx.cfg, source, bbox, maxzoom) };
    }

    // Models: from the curated list only, skipping ones already installed.
    const installed = new Set(((await ctx.ai.models()) ?? []).map((m) => tagged(m.name)));
    const names = Array.isArray(body.models) ? body.models.map(String) : [];
    const models = names.map((n) => {
      const m = data.models.find((x) => x.name === n);
      if (!m) throw new HttpError(400, `Unknown model "${n}"`);
      return m;
    }).filter((m) => !installed.has(tagged(m.name)));
    if (models.length && !(ctx.ai instanceof OllamaClient)) throw new HttpError(409, 'Models can only be downloaded from here with Ollama. Load them in your AI server instead.');

    const total = books.reduce((n, b) => n + (b.size ?? 0), 0) + (map?.size ?? 0) + models.reduce((n, m) => n + m.size, 0);
    const free = await freeBytes();
    if (total > free) {
      throw new HttpError(507, `This needs ${GB(total)} but only ${GB(free)} is free on the disk that holds ${ctx.cfg.home}. Choose less, or free up space.`);
    }

    const jobs: Job[] = [];
    for (const b of books) jobs.push(ctx.jobs.startDownload(b.url, path.join(ctx.cfg.dirs.zim, b.fileName), b.fileName, () => ctx.kiwix.sync()));
    if (map) jobs.push(ctx.jobs.startExtract(map.source, path.join(ctx.cfg.dirs.maps, map.name), map.bbox, map.maxzoom, map.name, () => void ctx.places.build(map.name)));
    const ollama = ctx.ai;
    for (const m of models) {
      jobs.push(
        ctx.jobs.startTask('model-pull', `AI model ${m.name}`, (job, signal) =>
          (ollama as OllamaClient).pull(m.name, signal, (status, completed, totalBytes) => {
            job.message = status;
            if (totalBytes) {
              job.received = completed;
              job.total = totalBytes;
            }
          }),
        ),
      );
    }
    await writeJsonAtomic(stateFile, { ...(await readJson<State>(stateFile, {})), setupDismissed: true });
    res.status(202).json({ jobs, total });
  });

  return r;
}

/** Sets one KEY=value line in the settings file, keeping every other line. Owner-only: it can hold keys. */
export async function setEnv(file: string, key: string, value: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const old = await fsp.readFile(file, 'utf8').catch(() => '');
  const lines = old.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));
  const at = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  await fsp.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fsp.chmod(file, 0o600);
}
