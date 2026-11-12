import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, readJson, writeJsonAtomic } from '../util.js';

export interface VoiceMessage {
  id: string;
  /** Who sent it (their Outpost account name). */
  name: string;
  /** When it was sent (ms since epoch). */
  at: number;
  /** Length in seconds, from the WAV header. */
  seconds: number;
}

/** A clip goes away by itself after this long. */
export const VOICE_TTL_MS = 24 * 3_600_000;
export const VOICE_MAX_SECONDS = 60;
/** One person may send at most one clip this often. */
export const VOICE_SEND_GAP_MS = 2_000;
/** 60 s of 16-bit mono at up to 16 kHz, plus a little room for the header. */
export const VOICE_MAX_BYTES = 44 + 16_000 * 2 * VOICE_MAX_SECONDS + 4_096;

const ID_RE = /^[0-9a-f-]{36}$/;
const DEVICE_RE = /^[\w-]{8,64}$/;
/** A device counts as on the channel while it checks in at least this often (it does every 3 s). */
export const VOICE_ONLINE_MS = 10_000;

export interface VoicePresence {
  name: string;
  /** How many of their devices have Outpost open. */
  devices: number;
  /** How many of those have voice turned on, so they hear new messages as they arrive. */
  listening: number;
}

/**
 * The seconds of audio in a WAV file the browser recorded: PCM, mono, 16-bit, 8–48 kHz. Anything else is refused,
 * so every clip plays on every phone and computer.
 */
export function wavSeconds(buf: Uint8Array): number {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  const bad = () => new HttpError(400, 'A voice message must be a WAV recording (mono, 16-bit).');
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw bad();
  let rate = 0;
  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      if (size < 16) throw bad();
      const format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16 || rate < 8_000 || rate > 48_000) throw bad();
    } else if (id === 'data') {
      if (!rate) throw bad();
      const bytes = Math.min(size, buf.byteLength - body);
      return bytes / (rate * 2);
    }
    o = body + size + (size % 2);
  }
  throw bad();
}

/**
 * Voice messages on one shared channel: everyone signed in can send and hear them. Clips live in {home}/voice as WAV
 * files with a small index, so they outlast a restart, and each one is removed after 24 hours.
 */
export class VoiceStore {
  private index: VoiceMessage[] | null = null;
  private lastSent = new Map<string, number>();
  /** Who has Outpost open, per device: kept in memory only, and forgotten soon after a device stops checking in. */
  private seen = new Map<string, { name: string; on: boolean; at: number }>();

  constructor(private dir: string, private now: () => number = Date.now) {}

  private get indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private async load(): Promise<VoiceMessage[]> {
    this.index ??= await readJson<VoiceMessage[]>(this.indexFile, []);
    return this.index;
  }

  private async save(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.indexFile, this.index ?? []);
  }

  /** Path of a clip's file; only ids Outpost made, so nothing outside the folder can be asked for. */
  fileOf(id: string): string {
    if (!ID_RE.test(id)) throw new HttpError(404, 'No such voice message.');
    return path.join(this.dir, `${id}.wav`);
  }

  async add(name: string, wav: Uint8Array): Promise<VoiceMessage> {
    const seconds = wavSeconds(wav);
    if (seconds < 0.3) throw new HttpError(400, 'That was too short to hear. Hold the button while you talk.');
    if (seconds > VOICE_MAX_SECONDS + 0.5) throw new HttpError(400, `Voice messages can be up to ${VOICE_MAX_SECONDS} seconds.`);
    const now = this.now();
    const last = this.lastSent.get(name);
    if (last != null && now - last < VOICE_SEND_GAP_MS) {
      throw Object.assign(new HttpError(429, 'One moment: you just sent a voice message.'), { retryAfter: Math.ceil((VOICE_SEND_GAP_MS - (now - last)) / 1000) });
    }
    this.lastSent.set(name, now);
    const list = await this.prune();
    const msg: VoiceMessage = { id: randomUUID(), name, at: now, seconds: Math.round(seconds * 10) / 10 };
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.fileOf(msg.id), wav, { mode: 0o600 });
    list.push(msg);
    await this.save();
    return msg;
  }

  /** Clips from the last 24 hours, oldest first; with `after`, only those sent after that one. */
  async list(after?: string): Promise<VoiceMessage[]> {
    const list = await this.prune();
    const i = after ? list.findIndex((m) => m.id === after) : -1;
    return i >= 0 ? list.slice(i + 1) : list.slice();
  }

  /** A device checking in; `device` is a random id the device keeps, so one person's phone and Mac count apart. */
  see(name: string, device: unknown, on: boolean): void {
    if (typeof device === 'string' && DEVICE_RE.test(device)) this.seen.set(`${name}\n${device}`, { name, on, at: this.now() });
  }

  /** People on the channel now, by name, with how many devices and how many of those are listening. */
  online(): VoicePresence[] {
    const cutoff = this.now() - VOICE_ONLINE_MS;
    const people = new Map<string, VoicePresence>();
    for (const [key, s] of this.seen) {
      if (s.at < cutoff) {
        this.seen.delete(key);
        continue;
      }
      const p = people.get(s.name) ?? { name: s.name, devices: 0, listening: 0 };
      p.devices++;
      if (s.on) p.listening++;
      people.set(s.name, p);
    }
    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Only the sender or an admin may delete a clip. */
  async remove(id: string, name: string, admin: boolean): Promise<void> {
    const list = await this.prune();
    const i = list.findIndex((m) => m.id === id);
    if (i < 0) throw new HttpError(404, 'No such voice message.');
    if (list[i]!.name !== name && !admin) throw new HttpError(403, 'Only the person who sent this, or an admin, can delete it.');
    list.splice(i, 1);
    await fsp.rm(this.fileOf(id), { force: true });
    await this.save();
  }

  /** Drops clips older than 24 hours, file and all. */
  private async prune(): Promise<VoiceMessage[]> {
    const list = await this.load();
    const cutoff = this.now() - VOICE_TTL_MS;
    const old = list.filter((m) => m.at < cutoff);
    if (old.length) {
      for (const m of old) await fsp.rm(this.fileOf(m.id), { force: true });
      this.index = list.filter((m) => m.at >= cutoff);
      await this.save();
    }
    for (const [who, t] of this.lastSent) if (t < this.now() - VOICE_SEND_GAP_MS) this.lastSent.delete(who);
    return this.index!;
  }
}
