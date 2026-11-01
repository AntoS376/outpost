import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface Config {
  home: string;
  host: string;
  port: number;
  /** Outpost's own HTTPS, so phones can share GPS with the map. On whenever Outpost is shared (OUTPOST_HTTPS=0 turns it off). */
  https: { on: boolean; port: number };
  /** Where books, Education and apps are served: same host, their own ports, so their pages can't act as Outpost. */
  content: { port: number; httpsPort: number };
  kiwixPort: number;
  /** Kolibri (education): its virtualenv, data folder, and the two loopback ports it serves on. */
  kolibri: { venv: string; home: string; port: number; zipPort: number };
  kiwixBin: string;
  pmtilesBin: string;
  /**
   * Offline directions: where OSRM's programs are (a folder, or '' to look on the PATH), its car/foot/bicycle
   * profiles (default: next to the programs, as Homebrew installs them), osmium, and Geofabrik's list of regions.
   */
  routing: { osrmDir: string; profiles: string; osmiumBin: string; indexUrl: string };
  /** Docker apps (admins run containers from the Apps page): off unless OUTPOST_DOCKER=1. */
  docker: { enabled: boolean; bin: string };
  /** macOS's caffeinate, for keeping the Mac awake while Outpost serves. */
  caffeinateBin: string;
  /** macOS's ioreg, for the live GPU gauge on the Assistant page. */
  ioregBin: string;
  ai: {
    provider: AiProviderKind;
    /** Ollama root (http://127.0.0.1:11434) or an OpenAI-style API root ending in /v1. */
    baseUrl: string;
    /** Sent as a Bearer token to openai-compatible servers. Never returned by the API or logged. */
    apiKey: string | null;
  };
  /** Extra host names Outpost answers to (besides IP addresses, localhost, .local names and the Mac's host name). */
  allowedHosts: string[];
  user: string;
  pass: string | null;
  allowOpen: boolean;
  /** Outpost's settings file (~/.config/outpost/env), read at start by scripts/run.sh. */
  envFile: string;
  embedModel: string;
  /** Most text parts the document index holds across all documents (memory grows with it). */
  ragMaxChunks: number;
  /** Largest PDF accepted for document chat, in bytes. */
  pdfMaxBytes: number;
  catalogUrl: string;
  /** Curated collections for the first-run wizard (bundled data/collections.json unless overridden). */
  collectionsFile: string;
  /** Apps shelf catalog (bundled data/apps.json unless overridden). */
  appsFile: string;
  /** Where the opt-in update checker looks. repo is "owner/name" of Outpost's GitHub repository, or "" to skip. */
  updates: { repo: string; githubApi: string; registry: string };
  /** Protomaps list of planet builds; the newest is used for map extracts. */
  mapBuildsUrl: string;
  dirs: { zim: string; maps: string; notes: string; docs: string; rag: string; assets: string; routing: string };
}

export type AiProviderKind = 'ollama' | 'openai-compatible';
const AI_PROVIDERS: AiProviderKind[] = ['ollama', 'openai-compatible'];

export const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = path.resolve(expandHome(env.OUTPOST_HOME ?? path.join(os.homedir(), 'Outpost')));
  const provider = (env.OUTPOST_AI_PROVIDER || 'ollama') as AiProviderKind;
  if (!AI_PROVIDERS.includes(provider)) {
    throw new Error(`OUTPOST_AI_PROVIDER must be "ollama" or "openai-compatible", not "${provider}".`);
  }
  let baseUrl = env.OUTPOST_AI_BASE_URL || (provider === 'ollama' ? env.OLLAMA_URL || 'http://127.0.0.1:11434' : '');
  if (!baseUrl) {
    throw new Error('OUTPOST_AI_BASE_URL is required with OUTPOST_AI_PROVIDER=openai-compatible, for example http://127.0.0.1:1234/v1 for LM Studio.');
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  const pdfMaxMb = Number(env.OUTPOST_PDF_MAX_MB || 50);
  const ragMaxChunks = Number(env.OUTPOST_RAG_MAX_CHUNKS || 20_000);
  if (!Number.isInteger(ragMaxChunks) || ragMaxChunks < 1) throw new Error(`OUTPOST_RAG_MAX_CHUNKS must be a whole number above 0, not "${env.OUTPOST_RAG_MAX_CHUNKS}".`);
  if (!(pdfMaxMb > 0)) throw new Error(`OUTPOST_PDF_MAX_MB must be a positive number of megabytes, not "${env.OUTPOST_PDF_MAX_MB}".`);
  return {
    home,
    host: env.OUTPOST_HOST ?? '127.0.0.1',
    port: Number(env.OUTPOST_PORT ?? 8080),
    allowedHosts: String(env.OUTPOST_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    caffeinateBin: env.OUTPOST_CAFFEINATE_BIN || '/usr/bin/caffeinate',
    ioregBin: env.OUTPOST_IOREG_BIN || '/usr/sbin/ioreg',
    content: { port: Number(env.OUTPOST_CONTENT_PORT ?? 8090), httpsPort: Number(env.OUTPOST_CONTENT_HTTPS_PORT ?? 8453) },
    https: { on: env.OUTPOST_HTTPS !== '0' && !LOOPBACK.has(env.OUTPOST_HOST ?? '127.0.0.1'), port: Number(env.OUTPOST_HTTPS_PORT ?? 8443) },
    kiwixPort: Number(env.OUTPOST_KIWIX_PORT ?? 8081),
    kolibri: {
      venv: path.join(home, 'kolibri-venv'),
      home: path.join(home, 'kolibri'),
      port: Number(env.OUTPOST_KOLIBRI_PORT ?? 8082),
      zipPort: Number(env.OUTPOST_KOLIBRI_ZIP_PORT ?? 8083),
    },
    kiwixBin: env.OUTPOST_KIWIX_BIN ?? 'kiwix-serve',
    pmtilesBin: env.OUTPOST_PMTILES_BIN ?? 'pmtiles',
    docker: { enabled: env.OUTPOST_DOCKER === '1', bin: env.OUTPOST_DOCKER_BIN || 'docker' },
    routing: {
      osrmDir: env.OUTPOST_OSRM_DIR ?? '',
      profiles: env.OUTPOST_OSRM_PROFILES ?? '',
      osmiumBin: env.OUTPOST_OSMIUM_BIN ?? 'osmium',
      indexUrl: env.OUTPOST_GEOFABRIK_INDEX || 'https://download.geofabrik.de/index-v1.json',
    },
    ai: { provider, baseUrl, apiKey: env.OUTPOST_AI_API_KEY || null },
    user: env.OUTPOST_USER ?? 'outpost',
    pass: env.OUTPOST_PASSWORD ? env.OUTPOST_PASSWORD : null,
    allowOpen: env.OUTPOST_ALLOW_OPEN === '1',
    envFile: env.OUTPOST_ENV_FILE || path.join(os.homedir(), '.config', 'outpost', 'env'),
    embedModel: env.OUTPOST_EMBED_MODEL ?? 'nomic-embed-text',
    ragMaxChunks,
    pdfMaxBytes: Math.round(pdfMaxMb * 1024 * 1024),
    collectionsFile: env.OUTPOST_COLLECTIONS_FILE || fileURLToPath(new URL('../data/collections.json', import.meta.url)),
    appsFile: env.OUTPOST_APPS_FILE || fileURLToPath(new URL('../data/apps.json', import.meta.url)),
    updates: {
      repo: (env.OUTPOST_UPDATE_REPO ?? '').trim(),
      githubApi: (env.OUTPOST_GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
      registry: (env.OUTPOST_OLLAMA_REGISTRY || 'https://registry.ollama.ai').replace(/\/+$/, ''),
    },
    mapBuildsUrl: env.OUTPOST_MAP_BUILDS_URL || 'https://build-metadata.protomaps.dev/builds.json',
    catalogUrl: (env.OUTPOST_CATALOG_URL ?? 'https://library.kiwix.org/catalog/v2').replace(/\/+$/, ''),
    dirs: {
      zim: path.join(home, 'zim'),
      maps: path.join(home, 'maps'),
      notes: path.join(home, 'notes'),
      docs: path.join(home, 'docs'),
      rag: path.join(home, 'rag'),
      assets: path.join(home, 'assets'),
      routing: path.join(home, 'routing'),
    },
  };
}

export async function ensureDirs(cfg: Config): Promise<void> {
  for (const dir of Object.values(cfg.dirs)) await fsp.mkdir(dir, { recursive: true });
  // Notes, chats and documents live inside: other accounts on this Mac have no business reading them.
  await fsp.chmod(cfg.home, 0o700);
}

/** True when one folder contains the other. Case-insensitive, because macOS disks are (~/outpost is ~/Outpost). */
export function foldersOverlap(a: string, b: string): boolean {
  const x = path.resolve(a).toLowerCase() + path.sep;
  const y = path.resolve(b).toLowerCase() + path.sep;
  return x.startsWith(y) || y.startsWith(x);
}
