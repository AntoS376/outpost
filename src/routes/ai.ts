import { Readable } from 'node:stream';
import express, { Router } from 'express';
import type { AppContext } from '../context.js';
import { HttpError } from '../util.js';
import { upstreamError } from '../services/ai.js';
import { OllamaClient } from '../services/ollama.js';
import { pdfToText, readLimited } from '../services/pdf.js';

const MODEL_RE = /^[\w.\-:/]{1,120}$/;
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

function validMessages(input: unknown): Msg[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new HttpError(400, 'messages must be a non-empty array (max 100)');
  return input.map((m) => {
    const role = (m as Msg)?.role;
    const content = (m as Msg)?.content;
    if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') throw new HttpError(400, 'Invalid message');
    return { role, content: content.slice(0, 32_000) };
  });
}

/** Pipes an upstream NDJSON stream to the client, aborting upstream if the client leaves. */
async function relay(up: Response, res: express.Response, ctrl: AbortController): Promise<void> {
  if (!up.ok || !up.body) throw await upstreamError(up, 'Ollama');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.on('close', () => ctrl.abort());
  try {
    for await (const chunk of Readable.fromWeb(up.body as never)) res.write(chunk);
  } catch {
    /* client went away or upstream aborted */
  }
  res.end();
}

function docName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!/^[^/\\]{1,200}$/.test(name)) throw new HttpError(400, 'A file name is required (?name=notes.md)');
  return name;
}

/** Model downloads and removal go through Ollama's own API; other servers manage models themselves. */
function ollamaOnly(ctx: AppContext): OllamaClient {
  if (!(ctx.ai instanceof OllamaClient)) {
    throw new HttpError(409, 'Model downloads and removal only work with Ollama. Manage models in your AI server (for example LM Studio) instead.');
  }
  return ctx.ai;
}

export function aiRoutes(ctx: AppContext): Router {
  const r = Router();

  // The live GPU gauge: how busy the GPU is, its memory, and (with Ollama) which model is loaded and how much is on the GPU.
  r.get('/gpu', async (_req, res) => {
    const [gpu, loaded] = await Promise.all([ctx.gpu.read(), ctx.ai instanceof OllamaClient ? ctx.ai.loaded() : Promise.resolve(null)]);
    res.set('Cache-Control', 'no-store').json({ gpu, loaded });
  });

  r.get('/models', async (_req, res) => {
    const models = await ctx.ai.models();
    res.json({
      provider: ctx.ai.kind,
      label: ctx.ai.label,
      canManageModels: ctx.ai.canManageModels,
      reachable: models !== null,
      url: ctx.ai.url,
      embedModel: ctx.cfg.embedModel,
      models: models ?? [],
    });
  });

  r.post('/pull', async (req, res) => {
    const ollama = ollamaOnly(ctx);
    const name = String((req.body ?? {}).name ?? '');
    if (!MODEL_RE.test(name)) throw new HttpError(400, 'Invalid model name');
    const ctrl = new AbortController();
    const up = await ollama.stream('/api/pull', { model: name, name, stream: true }, ctrl.signal);
    await relay(up, res, ctrl);
  });

  r.delete('/models/:name', async (req, res) => {
    const ollama = ollamaOnly(ctx);
    const name = String(req.params.name);
    if (!MODEL_RE.test(name)) throw new HttpError(400, 'Invalid model name');
    await ollama.deleteModel(name);
    res.json({ ok: true });
  });

  r.post('/chat', async (req, res) => {
    const body = (req.body ?? {}) as { model?: string; messages?: unknown; useDocs?: boolean };
    const model = String(body.model ?? '');
    if (!MODEL_RE.test(model)) throw new HttpError(400, 'Choose a model first');
    let messages = validMessages(body.messages);
    let sources: { doc: string; excerpt: string }[] = [];
    if (body.useDocs) {
      const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const hits = question ? await ctx.rag.search(question, 4) : [];
      if (hits.length) {
        sources = hits.map((h) => ({ doc: h.doc, excerpt: h.text.slice(0, 220) }));
        const context = hits.map((h, i) => `[${i + 1}] (${h.doc})\n${h.text}`).join('\n\n');
        // Excerpts go in the latest question, not the system message: on llama3.2:3b that took answers grounded in
        // the right excerpt from 17 to 24 out of 24 (three first-aid questions, three unrelated excerpts alongside).
        const last = messages.map((m) => m.role).lastIndexOf('user');
        messages = [
          {
            role: 'system',
            content:
              "You answer questions using excerpts from the user's own offline documents. Base your answer on the excerpts, " +
              'name the document you used, and keep it short. Only if the excerpts truly do not cover the question, say so plainly instead of guessing.',
          },
          ...messages.map((m, i) => (i === last ? { role: m.role, content: `Excerpts from my documents:\n\n${context}\n\nQuestion: ${m.content}` } : m)),
        ];
      }
    }
    const ctrl = new AbortController();
    const pieces = await ctx.ai.chat(model, messages, ctrl.signal);
    // Every provider is re-emitted in one shape: {sources}, then {message:{content}} lines, then {done:true}.
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.on('close', () => ctrl.abort());
    res.write(JSON.stringify({ sources }) + '\n');
    try {
      for await (const content of pieces) res.write(JSON.stringify({ message: { role: 'assistant', content }, done: false }) + '\n');
      res.write(JSON.stringify({ done: true }) + '\n');
    } catch (e) {
      if (!ctrl.signal.aborted) res.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) + '\n');
    }
    res.end();
  });

  // Documents for "chat with my files"
  r.get('/docs', async (_req, res) => res.json(await ctx.rag.list()));

  r.post('/docs', async (req, res, next) => {
    const name = docName(req.query.name);
    if (!name.toLowerCase().endsWith('.pdf')) return next();
    const { text } = await pdfToText(await readLimited(req, ctx.cfg.pdfMaxBytes));
    res.status(201).json(await ctx.rag.add(name, text));
  });

  r.post('/docs', express.text({ type: '*/*', limit: '8mb' }), async (req, res) => {
    const name = docName(req.query.name);
    if (typeof req.body !== 'string') throw new HttpError(400, 'Send the file content as the request body');
    res.status(201).json(await ctx.rag.add(name, req.body));
  });

  // Re-embeds documents indexed with another model or format, as a job in the transfers tray.
  r.post('/docs/reindex', async (_req, res) => {
    const running = ctx.jobs.running('reindex');
    if (running) return void res.status(202).json({ job: running });
    if ((await ctx.rag.staleCount()) === 0) throw new HttpError(409, `Every document is already indexed with ${ctx.cfg.embedModel}.`);
    const job = ctx.jobs.startTask('reindex', 'Re-index documents', (j, signal) => ctx.rag.reindex(j, signal), 'Cancelled. Progress is kept; start again to continue.');
    res.status(202).json({ job });
  });

  r.delete('/docs/:id', async (req, res) => {
    if (!(await ctx.rag.remove(String(req.params.id)))) throw new HttpError(404, 'Document not found');
    res.json({ ok: true });
  });

  return r;
}
