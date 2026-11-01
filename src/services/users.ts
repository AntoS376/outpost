import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { HttpError } from '../util.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export type Role = 'admin' | 'member';
export interface User {
  name: string;
  role: Role;
}
interface StoredUser extends User {
  hash: string;
  created: number;
}
interface Session {
  user: string;
  /** Signed in with the settings-file password rather than a users.json account. */
  env: boolean;
  expires: number;
}

/** "auth mode": open (no password, no accounts), password (settings-file admin only), or accounts. */
export type AuthMode = 'open' | 'password' | 'accounts';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 8;

/** Lowercases and checks a user name. Names become folder names, so anything but [a-z0-9_-] is refused. */
export function validName(raw: unknown): string {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Names use 1–32 letters a–z, digits, "-" or "_", starting with a letter or digit.');
  return name;
}

function validPassword(raw: unknown): string {
  const pw = String(raw ?? '');
  if (pw.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 200) throw new HttpError(400, 'That password is too long (200 characters at most).');
  return pw;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyHash(pw: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameText = (a: string, b: string) => {
  const x = Buffer.from(sha(a));
  const y = Buffer.from(sha(b));
  return timingSafeEqual(x, y); // equal-length digests, so the comparison takes the same time either way
};

/** Writes a file that only its owner can read (users and sessions hold secrets). */
async function writePrivate(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, file);
}

/** Fails sign-ins for a name (and an address) after too many wrong passwords in a window. */
class RateLimit {
  private fails = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  /** Seconds to wait, or 0 if allowed. */
  wait(key: string): number {
    const now = Date.now();
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, recent);
    return recent.length >= this.max ? Math.ceil((recent[0]! + this.windowMs - now) / 1000) : 0;
  }
  fail(key: string): void {
    this.fails.set(key, [...(this.fails.get(key) ?? []), Date.now()]);
  }
  clear(key: string): void {
    this.fails.delete(key);
  }
}

/** Accounts in ~/Outpost/users.json, sessions in ~/Outpost/sessions.json (both 0600), plus sign-in checks. */
export class UserStore {
  private usersFile: string;
  private sessionsFile: string;
  private users: StoredUser[] = [];
  private sessions = new Map<string, Session>(); // sha256(token) -> session
  private byName = new RateLimit(5, 15 * 60_000);
  private byAddress = new RateLimit(20, 15 * 60_000);
  private dummy: Promise<string>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private cfg: Config) {
    this.usersFile = path.join(cfg.home, 'users.json');
    this.sessionsFile = path.join(cfg.home, 'sessions.json');
    this.dummy = hashPassword(randomBytes(12).toString('hex'));
  }

  /** Reads users.json synchronously (also used at startup, before the server exists). */
  static count(home: string): number {
    try {
      return (JSON.parse(fs.readFileSync(path.join(home, 'users.json'), 'utf8')) as { users?: unknown[] }).users?.length ?? 0;
    } catch {
      return 0;
    }
  }

  async load(): Promise<void> {
    try {
      this.users = (JSON.parse(await fsp.readFile(this.usersFile, 'utf8')) as { users: StoredUser[] }).users ?? [];
    } catch {
      this.users = [];
    }
    try {
      const saved = JSON.parse(await fsp.readFile(this.sessionsFile, 'utf8')) as Record<string, Session>;
      const now = Date.now();
      for (const [k, v] of Object.entries(saved)) if (v.expires > now) this.sessions.set(k, v);
    } catch {
      /* no sessions yet */
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private saveUsers(): Promise<void> {
    return writePrivate(this.usersFile, { version: 1, users: this.users });
  }
  private saveSessions(): Promise<void> {
    return writePrivate(this.sessionsFile, Object.fromEntries(this.sessions));
  }

  mode(): AuthMode {
    return this.users.length ? 'accounts' : this.cfg.pass ? 'password' : 'open';
  }

  list(): (User & { created: number })[] {
    return this.users.map(({ name, role, created }) => ({ name, role, created }));
  }

  firstAdmin(): string | null {
    return this.users.find((u) => u.role === 'admin')?.name ?? null;
  }

  get(name: string): User | null {
    const u = this.users.find((x) => x.name === name);
    return u ? { name: u.name, role: u.role } : null;
  }

  /** The settings-file admin (OUTPOST_USER/OUTPOST_PASSWORD), when a password is set and no account has that name. */
  private envAdmin(): string | null {
    return this.cfg.pass && !this.users.some((u) => u.name === this.cfg.user) ? this.cfg.user : null;
  }

  /** Checks a name and password. Same answer and similar time for unknown names, wrong passwords and locked names. */
  async verify(nameRaw: unknown, password: unknown, address: string): Promise<{ user: User; env: boolean }> {
    const name = String(nameRaw ?? '').trim().toLowerCase();
    const pw = String(password ?? '');
    const wait = Math.max(this.byName.wait(`n:${name}`), this.byAddress.wait(`a:${address}`));
    if (wait) {
      throw Object.assign(new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`), { retryAfter: wait });
    }
    const stored = this.users.find((u) => u.name === name);
    const env = !stored && this.envAdmin() === name;
    const ok = stored ? await verifyHash(pw, stored.hash) : env ? sameText(pw, this.cfg.pass!) : (await verifyHash(pw, await this.dummy), false);
    if (!ok) {
      this.byName.fail(`n:${name}`);
      this.byAddress.fail(`a:${address}`);
      throw new HttpError(401, 'Name or password is incorrect.');
    }
    this.byName.clear(`n:${name}`);
    return { user: stored ? { name: stored.name, role: stored.role } : { name, role: 'admin' }, env };
  }

  async startSession(user: User, env: boolean): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha(token), { user: user.name, env, expires: Date.now() + SESSION_DAYS * 86_400_000 });
    await this.serial(() => this.saveSessions());
    return token;
  }

  /** The signed-in user for a session token, or null if it's unknown, expired, or the account is gone. */
  fromSession(token: string): User | null {
    const s = this.sessions.get(sha(token));
    if (!s || s.expires < Date.now()) return null;
    if (s.env) return this.envAdmin() === s.user ? { name: s.user, role: 'admin' } : null;
    return this.get(s.user);
  }

  async endSession(token: string): Promise<void> {
    if (this.sessions.delete(sha(token))) await this.serial(() => this.saveSessions());
  }

  private async endSessionsOf(name: string, except?: string): Promise<void> {
    const keep = except ? sha(except) : null;
    for (const [k, s] of this.sessions) if (s.user === name && k !== keep) this.sessions.delete(k);
    await this.saveSessions();
  }

  isReservedName(name: string): boolean {
    return !!this.cfg.pass && name === this.cfg.user;
  }

  create(nameRaw: unknown, password: unknown, roleRaw: unknown): Promise<User> {
    return this.serial(async () => {
      const name = validName(nameRaw);
      const pw = validPassword(password);
      const role = roleRaw === 'admin' ? 'admin' : roleRaw === 'member' ? 'member' : null;
      if (!role) throw new HttpError(400, 'Role must be "admin" or "member".');
      if (!this.users.length && role !== 'admin') throw new HttpError(400, 'The first account must be an admin, so someone can manage the others.');
      if (this.users.some((u) => u.name === name)) throw new HttpError(409, `There is already an account called ${name}.`);
      if (this.isReservedName(name)) throw new HttpError(409, `${name} is the admin from the settings file (OUTPOST_USER). Choose another name.`);
      this.users.push({ name, role, hash: await hashPassword(pw), created: Date.now() });
      await this.saveUsers();
      return { name, role };
    });
  }

  update(nameRaw: unknown, change: { role?: unknown; password?: unknown }): Promise<User> {
    return this.serial(async () => {
      const name = validName(nameRaw);
      const u = this.users.find((x) => x.name === name);
      if (!u) throw new HttpError(404, `No account called ${name}.`);
      if (change.role !== undefined) {
        if (change.role !== 'admin' && change.role !== 'member') throw new HttpError(400, 'Role must be "admin" or "member".');
        if (u.role === 'admin' && change.role === 'member' && this.users.filter((x) => x.role === 'admin').length === 1) {
          throw new HttpError(409, `${name} is the only admin. Make someone else an admin first.`);
        }
        u.role = change.role;
      }
      if (change.password !== undefined) {
        u.hash = await hashPassword(validPassword(change.password));
        await this.endSessionsOf(name); // a reset signs them out everywhere
      }
      await this.saveUsers();
      return { name: u.name, role: u.role };
    });
  }

  remove(nameRaw: unknown): Promise<void> {
    return this.serial(async () => {
      const name = validName(nameRaw);
      const u = this.users.find((x) => x.name === name);
      if (!u) throw new HttpError(404, `No account called ${name}.`);
      if (u.role === 'admin' && this.users.filter((x) => x.role === 'admin').length === 1) {
        throw new HttpError(409, `${name} is the only admin and can't be removed.`);
      }
      this.users = this.users.filter((x) => x.name !== name);
      await this.saveUsers();
      await this.endSessionsOf(name);
    });
  }

  /** Changes your own password after checking the current one; your other sessions are signed out. */
  async changeOwn(user: User, current: unknown, next: unknown, keepToken: string | null, address: string): Promise<void> {
    if (!this.users.some((u) => u.name === user.name)) {
      throw new HttpError(400, 'This admin signs in with the password in ~/.config/outpost/env. Change it there.');
    }
    await this.verify(user.name, current, address);
    await this.serial(async () => {
      const u = this.users.find((x) => x.name === user.name)!;
      u.hash = await hashPassword(validPassword(next));
      await this.saveUsers();
      await this.endSessionsOf(user.name, keepToken ?? undefined);
    });
  }
}
