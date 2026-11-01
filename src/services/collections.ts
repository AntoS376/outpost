import fsp from 'node:fs/promises';
import type { Config } from '../config.js';
import { HttpError } from '../util.js';
import { findBook } from './catalog.js';

export interface BookRef {
  name: string;
  /** "" when the catalog lists the book in one form only. */
  flavour: string;
  note: string;
}
export interface ModelChoice {
  name: string;
  /** Download size in bytes, from Ollama's registry when the list was made. */
  size: number;
  note: string;
  recommended?: boolean;
  embedding?: boolean;
}
export interface MapPreset {
  title: string;
  note: string;
  bbox: [number, number, number, number];
  maxzoom: number;
}
/** One level of a topic. Each level includes the books of the levels before it. */
export interface Level {
  id: string;
  title: string;
  description: string;
  books: BookRef[];
}
export interface Topic {
  id: string;
  title: string;
  description: string;
  levels: Level[];
}
/** One size of Wikipedia, from a quick reference to every article with pictures. */
export interface WikiChoice extends BookRef {
  id: string;
  title: string;
}
export interface Collections {
  topics: Topic[];
  wikipedia: WikiChoice[];
  models: ModelChoice[];
  maps: Record<string, MapPreset>;
}
export interface ResolvedBook extends BookRef {
  title: string;
  size: number | null;
  url: string;
  fileName: string;
}
export interface ResolvedLevel {
  id: string;
  title: string;
  description: string;
  /** This level's books and those of the levels before it, each once. */
  books: ResolvedBook[];
  size: number;
}
export interface Resolved {
  topics: { id: string; title: string; description: string; levels: ResolvedLevel[] }[];
  wikipedia: (ResolvedBook & { id: string; choice: string })[];
  /** "name (flavour)" for every listed book the live catalog no longer has. */
  dropped: string[];
}

export async function loadCollections(file: string): Promise<Collections> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Collections;
}

const label = (b: BookRef) => (b.flavour ? `${b.name} (${b.flavour})` : b.name);
const sizeOf = (books: ResolvedBook[]) => books.reduce((n, b) => n + (b.size ?? 0), 0);

/**
 * Looks every book up in the live Kiwix catalog. Books it no longer has are dropped, and so are levels that add
 * nothing and topics left empty.
 */
export async function resolveCollections(cfg: Config, data: Collections): Promise<Resolved> {
  const refs = new Map<string, BookRef>();
  for (const t of data.topics) for (const l of t.levels) for (const b of l.books) refs.set(label(b), b);
  for (const w of data.wikipedia) refs.set(label(w), w);
  const found = new Map<string, ResolvedBook | null>();
  const queue = [...refs.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, ref] = next;
      let entry;
      try {
        entry = await findBook(cfg, ref.name, ref.flavour);
      } catch {
        throw new HttpError(502, 'Setup needs an internet connection to look up the Kiwix catalog. Connect, then try again.');
      }
      found.set(key, entry ? { name: ref.name, flavour: ref.flavour, note: ref.note, title: entry.title, size: entry.size, url: entry.url, fileName: entry.fileName } : null);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const topics = data.topics
    .map((t) => {
      const sofar = new Map<string, ResolvedBook>();
      const levels: ResolvedLevel[] = [];
      for (const l of t.levels) {
        const own = l.books.map((b) => found.get(label(b))).filter((b): b is ResolvedBook => !!b);
        const fresh = own.filter((b) => !sofar.has(b.fileName));
        if (!fresh.length) continue;
        for (const b of own) sofar.set(b.fileName, { ...b, note: l.books.find((r) => label(r) === label(b))!.note });
        const books = [...sofar.values()];
        levels.push({ id: l.id, title: l.title, description: l.description, books, size: sizeOf(books) });
      }
      return { id: t.id, title: t.title, description: t.description, levels };
    })
    .filter((t) => t.levels.length > 0);
  const wikipedia = data.wikipedia.flatMap((w) => {
    const b = found.get(label(w));
    return b ? [{ ...b, id: w.id, choice: w.title }] : [];
  });
  const dropped = [...found.entries()].filter(([, v]) => !v).map(([k]) => k);
  return { topics, wikipedia, dropped };
}

/** True when a ZIM of this book (any date) is in the library folder. */
export function bookInstalled(book: BookRef, zimFiles: string[]): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(book.name)}${book.flavour ? `_${esc(book.flavour)}` : ''}_\\d{4}-\\d{2}\\.zim$`);
  return zimFiles.some((f) => re.test(f));
}
