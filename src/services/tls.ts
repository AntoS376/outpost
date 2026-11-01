import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate, createHash } from 'node:crypto';
import type { SecureContextOptions } from 'node:tls';
import type { Config } from '../config.js';

const run = promisify(execFile);
const OPENSSL = '/usr/bin/openssl';

/** Private IPv4 ranges the CA may vouch for (its name constraints), as [network, mask]. */
const PRIVATE: [string, string][] = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];
const ip4 = (s: string) => s.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
// `&` gives a signed 32-bit number, so turn it back into an unsigned one before comparing.
export const isPrivateIp = (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && PRIVATE.some(([net, mask]) => ((ip4(ip) & ip4(mask)) >>> 0) === ip4(net));

/** The name other devices reach this Mac by as <name>.local (System Settings → General → Sharing → Local hostname). */
function bonjourName(): string {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 2000 }).toString().trim();
  } catch {
    return os.hostname().replace(/\..*$/, ''); // not macOS, or not set: the router's name without its domain
  }
}

/** Leaf certificates last 825 days, the most Apple accepts for a certificate from a CA you installed yourself. */
const LEAF_DAYS = 825;

/**
 * Outpost's own HTTPS: a certificate authority made on this Mac, limited by name constraints to private addresses
 * and .local names (so even a stolen key can't impersonate real websites), and a server certificate for this
 * Mac's current addresses, re-issued when they change. Phones trust the CA once; browsers then allow GPS.
 */
export class LocalTls {
  readonly dir: string;
  private names = '';

  constructor(cfg: Config) {
    this.dir = path.join(cfg.home, 'tls');
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /** The addresses and names this Mac answers to right now (only those the CA is allowed to vouch for). */
  currentNames(): { ips: string[]; dns: string[] } {
    const ips = new Set(['127.0.0.1']);
    for (const n of Object.values(os.networkInterfaces()).flat()) if (n && n.family === 'IPv4' && isPrivateIp(n.address)) ips.add(n.address);
    const host = bonjourName().toLowerCase();
    const dns = ['localhost', ...(/^[a-z0-9-]{1,63}$/.test(host) ? [`${host}.local`] : [])];
    return { ips: [...ips].sort(), dns };
  }

  private async ensureCa(): Promise<void> {
    try {
      await fsp.access(this.file('ca.pem'));
      await fsp.access(this.file('ca.key'));
      return;
    } catch {
      /* make one */
    }
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const permitted = [...PRIVATE.map(([net, mask]) => `permitted;IP:${net}/${mask}`), 'permitted;DNS:local', 'permitted;DNS:localhost'].join(',');
    const cnf = this.file('ca.cnf');
    await fsp.writeFile(
      cnf,
      `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = Outpost local CA (${os.hostname().replace(/[^\w.-]/g, '')})\nO = Outpost\n` +
        `[ext]\nbasicConstraints = critical,CA:TRUE,pathlen:0\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\nnameConstraints = critical,${permitted}\n`,
    );
    await run(OPENSSL, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', this.file('ca.key')]);
    await fsp.chmod(this.file('ca.key'), 0o600);
    await run(OPENSSL, ['req', '-new', '-x509', '-key', this.file('ca.key'), '-sha256', '-days', '3650', '-config', cnf, '-extensions', 'ext', '-out', this.file('ca.pem')]);
    await fsp.rm(cnf, { force: true });
  }

  /** Issues a server certificate for `names`, signed by the CA. */
  private async issue(names: { ips: string[]; dns: string[] }): Promise<void> {
    const san = [...names.ips.map((ip) => `IP:${ip}`), ...names.dns.map((d) => `DNS:${d}`)].join(',');
    const ext = this.file('server.cnf');
    await fsp.writeFile(ext, `[ext]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = ${san}\nauthorityKeyIdentifier = keyid\n`);
    const key = this.file('server.key.new');
    const csr = this.file('server.csr');
    try {
      await run(OPENSSL, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
      await fsp.chmod(key, 0o600);
      await run(OPENSSL, ['req', '-new', '-key', key, '-subj', '/CN=Outpost', '-out', csr]);
      await run(OPENSSL, ['x509', '-req', '-in', csr, '-CA', this.file('ca.pem'), '-CAkey', this.file('ca.key'), '-set_serial', `0x${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 16)}`, '-sha256', '-days', String(LEAF_DAYS), '-extfile', ext, '-extensions', 'ext', '-out', this.file('server.pem')]);
      await fsp.rename(key, this.file('server.key'));
    } finally {
      await Promise.all([ext, csr, key].map((f) => fsp.rm(f, { force: true })));
    }
  }

  /** Makes the CA and a current server certificate if needed; returns what an HTTPS server needs. */
  async ensure(): Promise<SecureContextOptions> {
    await this.ensureCa();
    const names = this.currentNames();
    let fresh = false;
    try {
      const cert = new X509Certificate(await fsp.readFile(this.file('server.pem')));
      const ca = new X509Certificate(await fsp.readFile(this.file('ca.pem')));
      const covers = names.ips.every((ip) => cert.checkIP(ip)) && names.dns.every((d) => cert.checkHost(d));
      const expiring = new Date(cert.validTo).getTime() - Date.now() < 30 * 86_400_000;
      fresh = covers && !expiring && cert.verify(ca.publicKey);
    } catch {
      /* none yet */
    }
    if (!fresh) await this.issue(names);
    this.names = JSON.stringify(names);
    return { key: await fsp.readFile(this.file('server.key')), cert: await fsp.readFile(this.file('server.pem')) };
  }

  /** Re-issues the server certificate when this Mac's addresses change (it joined another Wi-Fi), and swaps it in. */
  watch(apply: (ctx: SecureContextOptions) => void, everyMs = 30_000): NodeJS.Timeout {
    const t = setInterval(() => {
      if (JSON.stringify(this.currentNames()) === this.names) return;
      this.ensure().then(apply, (e) => console.error('Could not renew the HTTPS certificate:', e));
    }, everyMs);
    t.unref();
    return t;
  }

  /** The CA certificate in DER form, which iPhones and Android phones install as a profile or CA certificate. */
  async caDer(): Promise<Buffer | null> {
    try {
      return new X509Certificate(await fsp.readFile(this.file('ca.pem'))).raw;
    } catch {
      return null;
    }
  }

  /** SHA-256 fingerprint of the CA, for comparing on the phone before trusting it. */
  async caFingerprint(): Promise<string | null> {
    try {
      return new X509Certificate(await fsp.readFile(this.file('ca.pem'))).fingerprint256;
    } catch {
      return null;
    }
  }
}
