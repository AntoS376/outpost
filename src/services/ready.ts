import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { safeFileName } from '../util.js';
import { BUILTIN_READY_CATALOG } from './readyBuiltin.js';

// The Ready.gov preparedness catalog: guides and plans kept as PDFs under docs/ready.
// The catalog file is written by whoever downloaded the PDFs, so the parser accepts a few shapes
// and keeps only what it can use. Nothing here invents a file name or a download link.

export const READY_GROUPS = ['plans', 'hazards', 'specialized', 'business', 'youth'] as const;
export type ReadyGroup = (typeof READY_GROUPS)[number];

export interface ReadyItem {
  id: string;
  title: string;
  description: string;
  category: string;
  group: ReadyGroup | null;
  tags: string[];
  file: string | null; // a plain PDF name under docs/ready, or null when the catalog gives none
  source: string | null; // the page on ready.gov, https only, shown as text
  download: string | null; // where the PDF can be fetched from: https on ready.gov or fema.gov only
}

export interface ReadyCatalog {
  categories: { name: string; group: ReadyGroup | null; count: number }[];
  items: ReadyItem[];
  builtin?: boolean; // true when no catalog file exists and the list that ships with Outpost is used
}

// The only hosts a guide may be downloaded from.
export const READY_HOSTS = ['ready.gov', 'www.ready.gov', 'fema.gov', 'www.fema.gov'];

const MAX_CATALOG = 5 * 1024 * 1024;
const MAX_ITEMS = 2000;

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function tagsOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(list.map((t) => str(t, 60).toLowerCase()).filter(Boolean))].slice(0, 30);
}

// Which pill an item belongs to: the category's own words first, then the item's tags.
export function groupOf(category: string, tags: string[] = [], explicit = ''): ReadyGroup | null {
  const want = explicit.toLowerCase();
  if ((READY_GROUPS as readonly string[]).includes(want)) return want as ReadyGroup;
  const test = (text: string): ReadyGroup | null => {
    if (/youth|kid|teen|child|school/.test(text)) return 'youth';
    if (/business|workplace|employer/.test(text)) return 'business';
    if (/speciali[sz]ed|disabilit|older adult|pet|animal|access/.test(text)) return 'specialized';
    if (/hazard|disaster/.test(text)) return 'hazards';
    if (/plan|action/.test(text)) return 'plans';
    return null;
  };
  return test(category.toLowerCase()) ?? test(tags.join(' '));
}

function fileOf(raw: Record<string, unknown>): string | null {
  for (const k of ['pdf', 'local_file', 'localFile', 'filename', 'file_name', 'fileName', 'file', 'path']) {
    const v = str(raw[k], 400);
    if (!v) continue;
    // Only the name counts: every file must sit directly in docs/ready.
    return safeFileName(path.posix.basename(v.replace(/\\/g, '/')), ['.pdf']);
  }
  return null;
}

function sourceOf(raw: Record<string, unknown>): string | null {
  for (const k of ['url', 'source', 'source_url', 'sourceUrl', 'page']) {
    const v = str(raw[k], 500);
    if (/^https:\/\/[^\s"'<>]+$/.test(v)) return v;
  }
  return null;
}

export function downloadOf(raw: Record<string, unknown>): string | null {
  for (const k of ['download', 'download_url', 'downloadUrl', 'pdf_url', 'pdfUrl']) {
    const v = str(raw[k], 500);
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
      if (!READY_HOSTS.includes(u.hostname.toLowerCase())) return null;
      if (!u.pathname.toLowerCase().endsWith('.pdf')) return null;
      return u.href;
    } catch {
      return null;
    }
  }
  return null;
}

function itemOf(raw: unknown, category: string, n: number): ReadyItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = str(o.title, 200) || str(o.name, 200);
  if (!title) return null;
  const cat = category || str(o.category, 120) || 'Other';
  const tags = tagsOf(o.tags);
  return {
    id: str(o.id, 80) || `item-${n}`,
    title,
    description: str(o.description) || str(o.summary),
    category: cat,
    group: groupOf(cat, tags, str(o.group, 20)),
    tags,
    file: fileOf(o),
    source: sourceOf(o),
    download: downloadOf(o),
  };
}

// Accepts {categories:[{name, items:[...]}]}, {items:[{category,...}]} or a plain array of items.
export function parseCatalog(data: unknown): ReadyCatalog {
  const items: ReadyItem[] = [];
  const push = (raw: unknown, category: string) => {
    if (items.length >= MAX_ITEMS) return;
    const it = itemOf(raw, category, items.length + 1);
    if (it) items.push(it);
  };
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (obj && Array.isArray(obj.categories)) {
    for (const c of obj.categories) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      const name = str(co.name, 120) || str(co.title, 120) || str(co.id, 120);
      for (const raw of Array.isArray(co.items) ? co.items : []) push(raw, name);
    }
  }
  const flat = Array.isArray(data) ? data : obj && Array.isArray(obj.items) ? obj.items : [];
  for (const raw of flat) push(raw, '');
  const seen = new Map<string, number>();
  for (const it of items) {
    const n = (seen.get(it.id) ?? 0) + 1;
    seen.set(it.id, n);
    if (n > 1) it.id = `${it.id}-${n}`;
  }
  const cats = new Map<string, { name: string; group: ReadyGroup | null; count: number }>();
  for (const it of items) {
    const c = cats.get(it.category) ?? { name: it.category, group: it.group, count: 0 };
    c.count++;
    cats.set(it.category, c);
  }
  return { categories: [...cats.values()], items };
}

// Every word of q must appear in the title, description, tags or category.
export function filterItems(items: ReadyItem[], opts: { group?: string; q?: string } = {}): ReadyItem[] {
  const words = String(opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    if (opts.group && it.group !== opts.group) return false;
    const hay = `${it.title} ${it.description} ${it.tags.join(' ')} ${it.category}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const readyDir = (cfg: Config): string => path.join(cfg.dirs.docs, 'ready');

// The catalog sits in the Outpost folder, or next to the PDFs. When neither exists, the list that
// ships with Outpost is used, so the guides can always be found and downloaded.
export async function loadCatalog(cfg: Config): Promise<ReadyCatalog> {
  for (const p of [path.join(cfg.home, 'ready_gov_catalog.json'), path.join(readyDir(cfg), 'ready_gov_catalog.json')]) {
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > MAX_CATALOG) throw new Error('The preparedness catalog is too large');
    return parseCatalog(JSON.parse(await fsp.readFile(p, 'utf8')));
  }
  return { ...parseCatalog(BUILTIN_READY_CATALOG), builtin: true };
}
