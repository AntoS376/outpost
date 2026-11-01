import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError } from '../util.js';

export interface NoteInfo {
  id: string;
  title: string;
  updated: number;
  size: number;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/;
const MAX_BYTES = 1024 * 1024;
/** Notes per person, so one account can't fill the disk. */
export const MAX_NOTES = 1000;

/** Moves files from one folder into another, never overwriting: a clash gets "-2", "-3"… before its extension. */
export async function moveFilesSafely(from: string, to: string, only?: (name: string) => boolean): Promise<number> {
  let moved = 0;
  const names = await fsp.readdir(from, { withFileTypes: true }).catch(() => []);
  for (const e of names) {
    if (!e.isFile() || (only && !only(e.name))) continue;
    await fsp.mkdir(to, { recursive: true });
    const ext = path.extname(e.name);
    const stem = e.name.slice(0, e.name.length - ext.length);
    let target = path.join(to, e.name);
    for (let n = 2; await fsp.stat(target).then(() => true, () => false); n++) target = path.join(to, `${stem}-${n}${ext}`);
    await fsp.rename(path.join(from, e.name), target);
    moved++;
  }
  return moved;
}

/** Markdown notes stored as plain files, so they stay readable outside Outpost. One folder per person. */
export class NotesStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid note id');
    return path.join(this.dir, `${id}.md`);
  }

  private titleOf(content: string, id: string): string {
    const first = content.split('\n').find((l) => l.trim()) ?? '';
    return first.replace(/^#+\s*/, '').trim().slice(0, 120) || id;
  }

  async list(): Promise<NoteInfo[]> {
    const out: NoteInfo[] = [];
    for (const name of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.md')) continue;
      const id = name.slice(0, -3);
      if (!ID_RE.test(id)) continue;
      const p = path.join(this.dir, name);
      const [st, content] = await Promise.all([fsp.stat(p), fsp.readFile(p, 'utf8')]);
      out.push({ id, title: this.titleOf(content, id), updated: st.mtimeMs, size: st.size });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async get(id: string): Promise<{ id: string; content: string; updated: number }> {
    const p = this.file(id);
    try {
      const [st, content] = await Promise.all([fsp.stat(p), fsp.readFile(p, 'utf8')]);
      return { id, content, updated: st.mtimeMs };
    } catch {
      throw new HttpError(404, 'Note not found');
    }
  }

  async put(id: string, content: string): Promise<NoteInfo> {
    if (Buffer.byteLength(content) > MAX_BYTES) throw new HttpError(413, 'Note too large (1 MB max)');
    const p = this.file(id);
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(p, content);
    const st = await fsp.stat(p);
    return { id, title: this.titleOf(content, id), updated: st.mtimeMs, size: st.size };
  }

  async create(title: string): Promise<NoteInfo> {
    const count = (await fsp.readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith('.md')).length;
    if (count >= MAX_NOTES) throw new HttpError(409, `You have ${MAX_NOTES} notes, the most one person can keep. Delete some first.`);
    let base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
    let id = base;
    for (let n = 2; await fsp.stat(path.join(this.dir, `${id}.md`)).then(() => true, () => false); n++) id = `${base}-${n}`;
    return this.put(id, `# ${title.trim() || 'Untitled'}\n\n`);
  }

  async remove(id: string): Promise<void> {
    await fsp.rm(this.file(id), { force: true });
  }
}
