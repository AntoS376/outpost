import type { Config } from '../config.js';
import { HttpError } from '../util.js';

export interface AiModel {
  name: string;
  /** Bytes on disk, when the server reports it. */
  size: number | null;
  /** True for embedding-only models (e.g. nomic-embed-text), which can't chat. */
  embedding: boolean;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** What the AI page needs from a model server. Ollama and OpenAI-style servers (LM Studio, llama.cpp) implement it. */
export interface AiProvider {
  readonly kind: Config['ai']['provider'];
  /** Short name for messages, e.g. "Ollama" or "the AI server". */
  readonly label: string;
  /** Base URL with any credentials removed, safe to show. */
  readonly url: string;
  /** Whether models can be downloaded and removed from Outpost (Ollama only). */
  readonly canManageModels: boolean;
  /** null when the server can't be reached. */
  models(): Promise<AiModel[] | null>;
  /**
   * Starts a streaming chat. Resolves once the server has accepted the request (so errors still become HTTP
   * errors), then yields text pieces as they arrive.
   */
  chat(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<AsyncIterable<string>>;
  embed(model: string, input: string[]): Promise<number[][]>;
}

/** Strips user:password@ so a base URL can be shown or logged. */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

/** Splits a fetch body into lines (NDJSON and server-sent events are both line-based). */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf.trim();
}

/** Turns an upstream error response into an HttpError with the server's own message when it has one. */
export async function upstreamError(res: Response, label: string): Promise<HttpError> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 300);
  try {
    const e = (JSON.parse(text) as { error?: string | { message?: string } }).error;
    message = (typeof e === 'string' ? e : e?.message) ?? message;
  } catch {
    /* plain text */
  }
  return new HttpError(res.status === 404 ? 404 : 502, message || `${label} answered HTTP ${res.status}`);
}
