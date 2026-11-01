import type { Config } from '../config.js';
import { HttpError } from '../util.js';
import { displayUrl, lines, upstreamError, type AiModel, type AiProvider, type ChatMessage } from './ai.js';

/** Common embedding model names: nomic-embed-text, text-embedding-3-small, bge-m3, all-MiniLM-L6-v2, e5-large. */
const EMBED_NAME = /embed|(^|[/_-])(bge|e5|gte)[-_]|minilm/i;

/**
 * Client for servers that speak the OpenAI API: LM Studio (http://127.0.0.1:1234/v1), llama.cpp's llama-server
 * (http://127.0.0.1:8080/v1) and similar. Models are managed in those apps, not from Outpost.
 */
export class OpenAiCompatibleClient implements AiProvider {
  readonly kind = 'openai-compatible' as const;
  readonly label = 'the AI server';
  readonly canManageModels = false;

  constructor(private cfg: Config) {}

  get url(): string {
    return displayUrl(this.cfg.ai.baseUrl);
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.cfg.ai.apiKey) h.Authorization = `Bearer ${this.cfg.ai.apiKey}`;
    return h;
  }

  private unreachable(): HttpError {
    return new HttpError(502, `The AI server at ${this.url} is not reachable. Start its local server (for example in LM Studio, or llama-server) and check OUTPOST_AI_BASE_URL.`);
  }

  async models(): Promise<AiModel[] | null> {
    try {
      const res = await fetch(`${this.cfg.ai.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { id: string }[] };
      // The OpenAI API has no capability list, so embedding models are recognised by name. Matching
      // OUTPOST_EMBED_MODEL is not enough: llama-server serves one model for both chat and embeddings.
      return (data.data ?? []).map((m) => ({ name: m.id, size: null, embedding: EMBED_NAME.test(m.id) }));
    } catch {
      return null;
    }
  }

  async chat(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<AsyncIterable<string>> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ model, messages, stream: true }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw this.unreachable();
    }
    if (!res.ok || !res.body) throw await upstreamError(res, 'The AI server');
    const body = res.body;
    // Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
    return (async function* () {
      for await (const line of lines(body)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        const o = JSON.parse(payload) as { error?: { message?: string } | string; choices?: { delta?: { content?: string | null } }[] };
        if (o.error) throw new Error(typeof o.error === 'string' ? o.error : (o.error.message ?? 'The AI server reported an error'));
        const piece = o.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
    })();
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.ai.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw this.unreachable();
    }
    if (!res.ok) {
      const err = await upstreamError(res, 'The AI server');
      if (res.status === 404 || /not found|not loaded|no model/i.test(err.message)) {
        throw new HttpError(412, `Embedding model "${model}" isn't available at ${this.url}. Load it in your AI server, or set OUTPOST_EMBED_MODEL to one it has.`);
      }
      throw new HttpError(502, `Embedding failed: ${err.message}`);
    }
    const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!data.data || data.data.length !== input.length) throw new HttpError(502, 'Unexpected embedding response');
    return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
