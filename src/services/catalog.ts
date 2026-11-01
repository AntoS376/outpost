import path from 'node:path';
import type { Config } from '../config.js';
import { XMLParser } from 'fast-xml-parser';
import { HttpError } from '../util.js';

export interface CatalogEntry {
  id: string;
  title: string;
  name: string;
  description: string;
  language: string;
  size: number | null;
  url: string;
  fileName: string;
  updated: string;
  /** "maxi", "nopic", "mini", or "" when the book comes in one form only. */
  flavour: string;
  category: string;
  /** Semicolon-separated, e.g. "medicine;_pictures:yes". */
  tags: string;
  articleCount: number | null;
}

type XmlNode = Record<string, unknown>;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false, // keep "2025-01" or "eng" as strings, not numbers
  parseAttributeValue: false,
  isArray: (tagName) => tagName === 'entry' || tagName === 'link',
});

const navXml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (tagName) => tagName === 'entry' });

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'object' && v && '#text' in v ? String(v['#text']).trim() : '');

/** Parses the Kiwix OPDS (Atom) feed into plain entries. Tolerant: unknown fields are ignored. */
export function parseCatalog(body: string): CatalogEntry[] {
  let doc: XmlNode;
  try {
    doc = xml.parse(body) as XmlNode;
  } catch {
    return [];
  }
  const entries = ((doc.feed as XmlNode | undefined)?.entry ?? []) as XmlNode[];
  const out: CatalogEntry[] = [];
  for (const e of entries) {
    const link = ((e.link ?? []) as Record<string, string>[]).find(
      (l) => l.href && ((l.type ?? '').includes('zim') || (l.rel ?? '').includes('acquisition')),
    );
    if (!link) continue;
    const url = link.href!.replace(/\.meta4$/, '');
    let fileName: string;
    try {
      fileName = path.basename(new URL(url).pathname);
    } catch {
      continue;
    }
    const len = Number(link.length);
    const title = text(e.title);
    out.push({
      id: text(e.id),
      title,
      name: text(e.name) || title,
      description: text(e.summary),
      language: text(e.language),
      size: Number.isFinite(len) && len > 0 ? len : null,
      url,
      fileName,
      updated: text(e.updated),
      flavour: text(e.flavour),
      category: text(e.category),
      tags: text(e.tags),
      articleCount: Number(text(e.articleCount)) || null,
    });
  }
  return out;
}

export interface Language {
  code: string;
  /** In the language itself, as the catalog lists it (e.g. "français"). */
  name: string;
  count: number;
}

/** Parses the catalog's /languages navigation feed. */
export function parseLanguages(body: string): Language[] {
  try {
    const entries = (((navXml.parse(body) as XmlNode).feed as XmlNode | undefined)?.entry ?? []) as XmlNode[];
    return entries
      .map((e) => ({ code: text(e['dc:language']), name: text(e.title), count: Number(text(e['thr:count'])) || 0 }))
      .filter((l) => l.code);
  } catch {
    return [];
  }
}

/** Parses the catalog's /categories navigation feed into category names. */
export function parseCategories(body: string): string[] {
  try {
    const entries = (((navXml.parse(body) as XmlNode).feed as XmlNode | undefined)?.entry ?? []) as XmlNode[];
    return entries.map((e) => text(e.title)).filter(Boolean);
  } catch {
    return [];
  }
}

/** Number of matches the catalog reports for a query (more than one page may hold). */
export function parseTotal(body: string): number | null {
  const m = body.match(/<totalResults>(\d+)<\/totalResults>/);
  return m ? Number(m[1]) : null;
}

export async function searchCatalog(cfg: Config, q: string, lang: string, count: number): Promise<CatalogEntry[]> {
  return (await browseCatalog(cfg, { q, lang, count })).entries;
}

/** One page of catalog entries matching a search, language and category. */
export async function browseCatalog(
  cfg: Config,
  opts: { q?: string; lang?: string; category?: string; start?: number; count?: number },
): Promise<{ entries: CatalogEntry[]; total: number }> {
  const params: Record<string, string> = { count: String(Math.min(Math.max(opts.count ?? 20, 1), 60)) };
  if (opts.q) params.q = opts.q;
  if (opts.lang) params.lang = opts.lang;
  if (opts.category) params.category = opts.category;
  if (opts.start) params.start = String(opts.start);
  const body = await fetchFeed(cfg, '/entries', params);
  const entries = parseCatalog(body);
  return { entries, total: parseTotal(body) ?? entries.length };
}

/** The catalog's language and category lists, for filter menus. */
export async function catalogFilters(cfg: Config): Promise<{ languages: Language[]; categories: string[] }> {
  const [langs, cats] = await Promise.all([fetchFeed(cfg, '/languages', {}), fetchFeed(cfg, '/categories', {})]);
  return { languages: parseLanguages(langs), categories: parseCategories(cats) };
}

/** The newest catalog entry with exactly this name and flavour, or null if the catalog no longer has it. */
export async function findBook(cfg: Config, name: string, flavour: string): Promise<CatalogEntry | null> {
  const entries = parseCatalog(await fetchFeed(cfg, '/entries', { name, count: '20' }));
  const matches = entries.filter((e) => e.name === name && e.flavour === flavour);
  return matches.sort((a, b) => b.updated.localeCompare(a.updated))[0] ?? null;
}

async function fetchFeed(cfg: Config, feed: string, params: Record<string, string>): Promise<string> {
  const u = new URL(`${cfg.catalogUrl}${feed}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/atom+xml, application/xml, text/xml' } });
  } catch {
    throw new HttpError(502, 'Could not reach the Kiwix catalog. Are you online? You can still paste a direct .zim URL.');
  }
  if (!res.ok) throw new HttpError(502, `Kiwix catalog answered HTTP ${res.status}`);
  return res.text();
}
