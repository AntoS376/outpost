import { Router } from 'express';
import type { AppContext } from '../context.js';
import { detectHardware } from '../services/hardware.js';
import { detectedLabel } from '../services/benchmark.js';
import { HttpError, OUTPOST_VERSION } from '../util.js';

/** Run the local benchmark (as a job in Transfers) and read its history. Nothing is uploaded. */
export function benchmarkRoutes(ctx: AppContext): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    const [history, hardware] = await Promise.all([ctx.benchmark.history(), detectHardware()]);
    res.json({ history, hardware, running: ctx.benchmark.running() });
  });
  r.get('/tag', async (_req, res) => {
    res.json({ ...(await ctx.benchmark.tag()), detected: detectedLabel(await detectHardware()) });
  });
  r.put('/tag', async (req, res) => {
    res.json({ ...(await ctx.benchmark.setTag(req.body ?? {})), detected: detectedLabel(await detectHardware()) });
  });

  // One result as a file to keep or share by hand. Outpost never uploads it.
  r.get('/:id/export.json', async (req, res) => {
    const result = await ctx.benchmark.get(String(req.params.id));
    if (!result) throw new HttpError(404, 'No benchmark result with that id');
    const day = new Date(result.at).toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="outpost-benchmark-${day}-${result.score}.json"`);
    res.json({ outpost: { version: OUTPOST_VERSION, exported: new Date().toISOString() }, result });
  });

  r.post('/start', (req, res) => {
    const running = ctx.benchmark.running();
    if (running) return void res.status(202).json({ job: running });
    const opts = { quick: req.body?.quick === true, model: typeof req.body?.model === 'string' ? req.body.model : undefined };
    const job = ctx.jobs.startTask('benchmark', opts.quick ? 'Quick benchmark' : 'Benchmark', (j, signal) => ctx.benchmark.run(j, signal, opts));
    res.status(202).json({ job: ctx.benchmark.track(job) });
  });
  r.delete('/:id', async (req, res) => {
    if (!(await ctx.benchmark.remove(String(req.params.id)))) throw new HttpError(404, 'No benchmark result with that id');
    res.json({ ok: true });
  });
  return r;
}
