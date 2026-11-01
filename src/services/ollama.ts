import type { Config } from '../config.js';
import { HttpError } from '../util.js';
import { displayUrl, lines, upstreamError, type AiModel, type AiProvider, type ChatMessage } from './ai.js';

interface RawModel {
  name: string;
  size: number;
  capabilities?: string[];
  details?: { family?: string; families?: string[] };
}

const base = (name: string) => name.split(':')[0]!;

/** Client for a local Ollama server. The only provider that can download and remove models. */
export class OllamaClient implements AiProvider {
  readonly kind = 'ollama' as const;
  readonly label = 'Ollama';
  readonly canManageModels = true;

  constructor(private cfg: Config) {}

  get url(): string {
    return displayUrl(this.cfg.ai.baseUrl);
  }

  private unreachable(): HttpError {
    return new HttpError(502, `Ollama is not reachable at ${this.url}. Start it with "ollama serve" or open the Ollama app.`);
  }

  async models(): Promise<AiModel[] | null> {
    try {
      const res = await fetch(`${this.cfg.ai.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const data = (await res.json()) as { models?: RawModel[] };
      return (data.models ?? []).map((m) => ({
        name: m.name,
        size: m.size ?? null,
        // Ollama 0.6+ lists capabilities; older versions only give the family (embedders are BERT-based).
        embedding: m.capabilities
          ? m.capabilities.includes('embedding') && !m.capabilities.includes('completion')
          : [m.details?.family, ...(m.details?.families ?? [])].some((f) => f?.includes('bert')) || base(m.name) === base(this.cfg.embedModel),
      }));
    } catch {
      return null;
    }
  }

  /** Models Ollama has in memory right now, and how much of each sits on the GPU (null if it can't say). */
  async loaded(): Promise<{ name: string; size: number; onGpu: number }[] | null> {
    try {
      const res = await fetch(`${this.cfg.ai.baseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const data = (await res.json()) as { models?: { name: string; size?: number; size_vram?: number }[] };
      return (data.models ?? []).map((m) => ({ name: m.name, size: m.size ?? 0, onGpu: m.size_vram ?? 0 }));
    } catch {
      return null;
    }
  }

  /** Installed models with their manifest digests (sha256 of the registry manifest they came from). */
  async digests(): Promise<{ name: string; digest: string }[] | null> {
    try {
      const res = await fetch(`${this.cfg.ai.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return (((await res.json()) as { models?: { name: string; digest?: string }[] }).models ?? []).filter((m) => m.digest).map((m) => ({ name: m.name, digest: m.digest! }));
    } catch {
      return null;
    }
  }

  /** Streaming POST; returns the upstream Response (NDJSON body). */
  async stream(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.cfg.ai.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw this.unreachable();
    }
  }

  /** Downloads a model, reporting bytes of the layer in progress. Resolves when Ollama reports success. */
  async pull(name: string, signal: AbortSignal, onProgress: (status: string, completed: number, total: number | null) => void): Promise<void> {
    const res = await this.stream('/api/pull', { model: name, name, stream: true }, signal);
    if (!res.ok || !res.body) throw await upstreamError(res, 'Ollama');
    for await (const line of lines(res.body)) {
      const o = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number };
      if (o.error) throw new Error(o.error);
      onProgress(o.status ?? '', o.completed ?? 0, o.total ?? null);
      if (o.status === 'success') return;
    }
    throw new Error(`Ollama stopped before ${name} finished downloading. Try again; it continues where it stopped.`);
  }

  async chat(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<AsyncIterable<string>> {
    const res = await this.stream('/api/chat', { model, messages, stream: true }, signal);
    if (!res.ok || !res.body) throw await upstreamError(res, 'Ollama');
    const body = res.body;
    return (async function* () {
      for await (const line of lines(body)) {
        const o = JSON.parse(line) as { error?: string; message?: { content?: string }; done?: boolean };
        if (o.error) throw new Error(o.error);
        if (o.message?.content) yield o.message.content;
        if (o.done) return;
      }
    })();
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.ai.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw this.unreachable();
    }
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) throw new HttpError(412, `Embedding model "${model}" is not installed. Pull it first (ollama pull ${model}).`);
      throw new HttpError(502, `Embedding failed: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== input.length) throw new HttpError(502, 'Unexpected embedding response');
    return data.embeddings;
  }

  async deleteModel(name: string): Promise<void> {
    const res = await fetch(`${this.cfg.ai.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, name }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res) throw this.unreachable();
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Could not delete model (HTTP ${res.status})`);
  }
}
