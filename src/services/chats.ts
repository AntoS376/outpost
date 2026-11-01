import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, readJson, writeJsonAtomic } from '../util.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/;
/** Saved conversations per person, so one account can't fill the disk. */
export const MAX_CHATS = 500;
type Message = { role: 'user' | 'assistant' | 'system'; content: string };
export interface SavedChat {
  id: string;
  title: string;
  model: string;
  updated: number;
  messages: Message[];
}

/** One person's saved conversations: ~/Outpost/chats/<user>/<id>.json. */
export class ChatStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid conversation id');
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<{ id: string; title: string; model: string; updated: number; count: number }[]> {
    const out = [];
    for (const name of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json') || !ID_RE.test(name.slice(0, -5))) continue;
      const c = await readJson<SavedChat | null>(path.join(this.dir, name), null);
      if (c) out.push({ id: c.id, title: c.title, model: c.model, updated: c.updated, count: c.messages.length });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async get(id: string): Promise<SavedChat> {
    const c = await readJson<SavedChat | null>(this.file(id), null);
    if (!c) throw new HttpError(404, 'Conversation not found');
    return c;
  }

  async put(id: string, body: { title?: unknown; model?: unknown; messages?: unknown }): Promise<SavedChat> {
    const file = this.file(id);
    if (!Array.isArray(body.messages) || body.messages.length > 200) throw new HttpError(400, 'messages must be a list of at most 200');
    const messages = body.messages.map((m) => {
      const { role, content } = (m ?? {}) as Message;
      if (!['user', 'assistant', 'system'].includes(role) || typeof content !== 'string') throw new HttpError(400, 'Invalid message');
      return { role, content: content.slice(0, 32_000) };
    });
    const chat: SavedChat = {
      id,
      title: String(body.title ?? '').trim().slice(0, 120) || messages.find((m) => m.role === 'user')?.content.slice(0, 60) || 'Conversation',
      model: String(body.model ?? '').slice(0, 120),
      updated: Date.now(),
      messages,
    };
    await fsp.mkdir(this.dir, { recursive: true });
    const exists = await fsp.stat(file).then(() => true, () => false);
    if (!exists && (await fsp.readdir(this.dir)).filter((n) => n.endsWith('.json')).length >= MAX_CHATS) {
      throw new HttpError(409, `You have ${MAX_CHATS} saved conversations, the most one person can keep. Delete some first.`);
    }
    await writeJsonAtomic(file, chat);
    return chat;
  }

  async remove(id: string): Promise<void> {
    await fsp.rm(this.file(id), { force: true });
  }
}
