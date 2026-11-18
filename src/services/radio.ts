import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import type { Config } from '../config.js';
import { childEnv } from './process.js';
import { CallLog, wavFile } from './radioCalls.js';
import { messageRate, readAircraft, validSite, type Site } from './planes.js';
import { SENSOR_FREQS, SensorBoard } from './sensors.js';
import { APRS_FREQS, AprsBoard } from './aprs.js';

/** What else can hold the dongle instead of the receiver. */
type Side = 'planes' | 'sensors' | 'aprs';
import { HttpError, readJson, resolveBin, writeJsonAtomic } from '../util.js';

export const RADIO_MODES = ['wbfm', 'fm', 'am', 'usb', 'lsb'] as const;
export type RadioMode = (typeof RADIO_MODES)[number];
export interface Tuning {
  /** Hz. */
  freq: number;
  mode: RadioMode;
  /** 0 (off) to 10. */
  squelch: number;
}
/** What the dongle reports: there, missing, or held by another program (iNTERCEPT, SDR++…). */
export type RadioDevice = 'ok' | 'none' | 'busy';

/** Every mode is sent to browsers as 16-bit mono PCM at this rate. */
export const RADIO_RATE = 24_000;
/**
 * What an RTL-SDR Blog V3 covers: its R820T/R860 tuner from 24 MHz up, and below that (AM radio, shortwave) direct
 * sampling on the Q branch, with no gain control and images of strong signals above 14.4 MHz.
 */
export const RADIO_MIN_HZ = 500_000;
export const RADIO_MAX_HZ = 1_766_000_000;
export const DIRECT_BELOW_HZ = 24_000_000;
/** rtl_fm squelch levels for 0–10. Measured on a V3 with automatic gain: empty channels sit near 100–150, stations above 1,000. */
const SQUELCH = [0, 120, 160, 220, 300, 400, 550, 750, 1000, 1500, 2200];
/** A listener this far behind is cut off rather than buffered forever. */
const MAX_BACKLOG = 512 * 1024;
/** The dongle is let go this long after the last listener leaves (a page reload or retune keeps it). */
const IDLE_MS = 5_000;
/** A channel counts as busy this far above the noise floor. */
export const SIGNAL_DB = 8;
/** Auto-scan stays on a channel until it has been quiet this long, and leaves after DWELL_MAX_MS anyway. */
const HANG_MS = 3_000;
const DWELL_MAX_MS = 120_000;
/** A call ends after this much silence (with squelch on, rtl_fm sends nothing while nobody talks). */
const CALL_GAP_MS = 1_500;
/** Shorter bursts are noise, not speech; longer calls are cut at a minute (Voice's limit). */
const CALL_MIN_S = 1;
const CALL_MAX_BYTES = RADIO_RATE * 2 * 60;
/** Station names: this long at most, and this many. */
const NAME_MAX = 40;
const NAMES_MAX = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT: Tuning = { freq: 27_185_000, mode: 'am', squelch: 3 };

export function validTuning(body: Record<string, unknown>, current: Tuning = DEFAULT): Tuning {
  const freq = body.freq === undefined ? current.freq : Math.round(Number(body.freq));
  if (!Number.isFinite(freq) || freq < RADIO_MIN_HZ || freq > RADIO_MAX_HZ) throw new HttpError(400, 'The frequency must be from 0.5 to 1,766 MHz.');
  const mode = body.mode === undefined ? current.mode : body.mode;
  if (!RADIO_MODES.includes(mode as RadioMode)) throw new HttpError(400, `Mode must be one of ${RADIO_MODES.join(', ')}.`);
  const squelch = body.squelch === undefined ? current.squelch : Number(body.squelch);
  if (!Number.isInteger(squelch) || squelch < 0 || squelch > 10) throw new HttpError(400, 'Squelch must be a whole number from 0 to 10.');
  return { freq, mode: mode as RadioMode, squelch };
}

export function rtlFmArgs(t: Tuning): string[] {
  // Wide FM sets its own input rate and no squelch (broadcast stations are always on); -r brings it to RADIO_RATE.
  const rate = t.mode === 'wbfm' ? ['-r', String(RADIO_RATE)] : ['-s', String(RADIO_RATE), ...(t.squelch ? ['-l', String(SQUELCH[t.squelch])] : [])];
  // Below 24 MHz the tuner can't go: the V3 samples the antenna directly, on its Q branch.
  const direct = t.freq < DIRECT_BELOW_HZ ? ['-E', 'direct2'] : [];
  return ['-f', String(t.freq), '-M', t.mode, ...rate, ...direct, '-'];
}

/** Most points one scan reports: all of airband in 25 kHz steps is 761. */
export const SCAN_MAX = 1024;

/** Checks a scan request: channel centres (Hz) and how wide each one is. */
export function validScan(body: Record<string, unknown>): { freqs: number[]; width: number } {
  const freqs = Array.isArray(body.freqs) ? body.freqs.map((f) => Math.round(Number(f))) : [];
  if (!freqs.length || freqs.length > SCAN_MAX || freqs.some((f) => !Number.isFinite(f) || f < DIRECT_BELOW_HZ || f > RADIO_MAX_HZ)) {
    // rtl_power's direct sampling (-D) uses the I branch, which the V3 doesn't wire to the antenna: below 24 MHz it would sweep noise.
    throw new HttpError(400, `Send 1 to ${SCAN_MAX} frequencies from 24 to 1,766 MHz: scans can't go below 24 MHz.`);
  }
  const width = Math.round(Number(body.width));
  if (!(width >= 2_000 && width <= 2_000_000)) throw new HttpError(400, 'The channel width must be from 2 kHz to 2 MHz.');
  if (Math.max(...freqs) - Math.min(...freqs) > 30_000_000) throw new HttpError(400, 'A scan can cover 30 MHz at most.');
  return { freqs, width };
}

/** rtl_power over the channels, one sweep, with bins small enough to tell channels apart. */
export function rtlPowerArgs(freqs: number[], width: number): string[] {
  const lo = Math.max(DIRECT_BELOW_HZ, Math.min(...freqs) - width);
  const hi = Math.min(RADIO_MAX_HZ, Math.max(...freqs) + width);
  const bin = Math.round(Math.max(1_000, width / 4, (hi - lo) / 4_000));
  return ['-f', `${lo}:${hi}:${bin}`, '-i', '1', '-1', '-'];
}

/**
 * Reads rtl_power's CSV (date, time, Hz low, Hz high, Hz step, samples, then one dB value per bin) into the strongest
 * reading on each channel, and the noise floor (the median of all bins) to draw them against.
 */
export function scanLevels(csv: string, freqs: number[], width: number): { levels: (number | null)[]; floor: number | null } {
  const bins: { f: number; db: number }[] = [];
  for (const line of csv.split('\n')) {
    const cells = line.split(',').map((c) => c.trim());
    const low = Number(cells[2]);
    const step = Number(cells[4]);
    if (cells.length < 7 || !Number.isFinite(low) || !(step > 0)) continue;
    cells.slice(6).forEach((v, i) => {
      const db = Number(v);
      if (Number.isFinite(db)) bins.push({ f: low + (i + 0.5) * step, db });
    });
  }
  const sorted = bins.map((b) => b.db).sort((a, b) => a - b);
  const floor = sorted.length ? sorted[sorted.length >> 1]! : null;
  const levels = freqs.map((c) => {
    const near = bins.filter((b) => Math.abs(b.f - c) <= width / 2);
    return near.length ? Math.round(Math.max(...near.map((b) => b.db)) * 10) / 10 : null;
  });
  return { levels, floor: floor === null ? null : Math.round(floor * 10) / 10 };
}

/** The busiest channel in a sweep: the strongest one at least SIGNAL_DB above the floor, or -1. */
export function bestChannel(levels: (number | null)[], floor: number | null): number {
  let best = -1;
  levels.forEach((db, i) => {
    if (db != null && floor != null && db - floor >= SIGNAL_DB && (best < 0 || db > levels[best]!)) best = i;
  });
  return best;
}

/** rtl_test's answer, in a word. */
export function deviceFrom(output: string): RadioDevice {
  if (/claimed by second instance|usb_claim_interface/i.test(output)) return 'busy';
  return /Found [1-9]\d* device/.test(output) ? 'ok' : 'none';
}

/**
 * The receiver: one rtl_fm on the RTL-SDR dongle, its audio shared with every device listening. It runs only while
 * someone listens, and retuning restarts it (rtl_fm can't change frequency while running).
 */
export class RadioService {
  private tuning: Tuning = DEFAULT;
  private child: ChildProcess | null = null;
  private listeners = new Set<Response>();
  private idle: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private checked: { at: number; device: RadioDevice } | null = null;
  private error = '';
  /** Off: Outpost leaves the dongle alone entirely (no listening, scanning or checks), so another program can use it. */
  private enabled = true;
  private file: string;
  /** Auto-scan: the channels it cycles through, and where it has stopped (null while sweeping). */
  private scanner: { freqs: number[]; width: number; mode: RadioMode; squelch: number; run: number; on: number | null } | null = null;
  private scanRun = 0;
  private lastAudio = 0;
  private call: { at: number; freq: number; mode: RadioMode; parts: Buffer[]; bytes: number } | null = null;
  private callTimer: NodeJS.Timeout | null = null;
  private lastCall = 0;
  readonly calls: CallLog;
  /** Planes or sensors: dump1090 or rtl_433 on the dongle instead of the receiver, one at a time. */
  private side: { kind: Side; child: ChildProcess; extra: ChildProcess[] } | null = null;
  readonly aprsBoard = new AprsBoard();
  private aprsFreq: (typeof APRS_FREQS)[number] = '144.800M';
  private aprsDir: string;
  private aprsLog: string;
  /** How far into direwolf's log aprsReport() has read. */
  private aprsRead = 0;
  readonly sensorBoard = new SensorBoard();
  private sensorFreq: (typeof SENSOR_FREQS)[number] = '433.92M';
  /** Names people gave frequencies ("Radio Liban", "Family"), by Hz; shared by everyone, kept in radio.json. */
  private names: Record<string, string> = {};
  /** A recording someone started with Record: everything heard, squelch or not, for up to a minute. */
  private manual: { at: number; freq: number; mode: RadioMode; parts: Buffer[]; bytes: number; timer: NodeJS.Timeout } | null = null;
  private planesDir: string;
  /** Where the antenna is: set by an admin on the Planes map, remembered in radio.json. */
  private site: Site | null = null;
  /** dump1090's running message total, read over the last minute, for "messages a minute". */
  private samples: { now: number; messages: number }[] = [];

  constructor(private cfg: Config) {
    this.file = path.join(cfg.home, 'radio.json');
    this.calls = new CallLog(path.join(cfg.home, 'radio-calls'));
    this.planesDir = path.join(cfg.home, 'planes');
    this.aprsDir = path.join(cfg.home, 'aprs');
    this.aprsLog = path.join(this.aprsDir, 'packets.csv');
  }

  async load(): Promise<void> {
    const saved = await readJson<Record<string, unknown>>(this.file, {});
    this.tuning = validTuning(saved, DEFAULT);
    this.enabled = saved.enabled !== false;
    this.site = saved.site && typeof saved.site === 'object' ? validSite(saved.site as Record<string, unknown>) : null;
    if (saved.names && typeof saved.names === 'object') {
      for (const [k, v] of Object.entries(saved.names as Record<string, unknown>)) if (/^\d+$/.test(k) && typeof v === 'string') this.names[k] = v.slice(0, NAME_MAX);
    }
    if (SENSOR_FREQS.includes(saved.sensorFreq as never)) this.sensorFreq = saved.sensorFreq as (typeof SENSOR_FREQS)[number];
    if (APRS_FREQS.includes(saved.aprsFreq as never)) this.aprsFreq = saved.aprsFreq as (typeof APRS_FREQS)[number];
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private bin = (name: 'fm' | 'test' | 'power' | 'planes' | 'sensors' | 'aprs') =>
    resolveBin({ fm: this.cfg.radio.rtlFmBin, test: this.cfg.radio.rtlTestBin, power: this.cfg.radio.rtlPowerBin, planes: this.cfg.radio.dump1090Bin, sensors: this.cfg.radio.rtl433Bin, aprs: this.cfg.radio.direwolfBin }[name]);

  async status() {
    const tools = !!this.bin('fm');
    return { tools, enabled: this.enabled, device: tools && this.enabled ? await this.device() : null, tuning: this.tuning, on: !!this.child, listeners: this.listeners.size, error: this.error, rate: RADIO_RATE,
      autoscan: this.scanner ? { on: this.scanner.on } : null, lastCall: this.lastCall, names: this.names,
      recording: this.manual ? Math.round((Date.now() - this.manual.at) / 1000) : null,
      planes: this.side?.kind === 'planes', planesTool: !!this.bin('planes'), sensors: this.side?.kind === 'sensors', sensorsTool: !!this.bin('sensors'),
      aprs: this.side?.kind === 'aprs', aprsTool: !!this.bin('aprs') };
  }

  /** Asks rtl_test whether the dongle is there; not while rtl_fm holds it, and at most every few seconds. */
  private device(): Promise<RadioDevice> {
    if (this.child || this.side) return Promise.resolve('ok');
    if (this.checked && Date.now() - this.checked.at < 4_000) return Promise.resolve(this.checked.device);
    return this.serial(
      () =>
        new Promise<RadioDevice>((resolve) => {
          const bin = this.bin('test');
          if (!bin || this.child) return resolve(this.child ? 'ok' : 'none');
          execFile(bin, ['-t'], { timeout: 5_000, env: childEnv() }, (_err, out, err) => {
            const device = deviceFrom(`${out}${err}`);
            this.checked = { at: Date.now(), device };
            resolve(device);
          });
        }),
    );
  }

  async tune(body: Record<string, unknown>): Promise<Tuning> {
    const next = validTuning(body, this.tuning);
    this.endScanner(); // tuning by hand takes over from auto-scan
    await this.serial(async () => {
      this.tuning = next;
      await this.save();
      if (this.child || (this.listeners.size && this.enabled)) {
        await this.halt();
        this.launch();
      }
    });
    return this.tuning;
  }

  private save(): Promise<void> {
    return writeJsonAtomic(this.file, { ...this.tuning, enabled: this.enabled, site: this.site, sensorFreq: this.sensorFreq, aprsFreq: this.aprsFreq, names: this.names });
  }

  /** Names a frequency for everyone ("Radio Liban"); an empty name removes it. */
  async setName(body: Record<string, unknown>): Promise<Record<string, string>> {
    const freq = Math.round(Number(body.freq));
    if (!Number.isFinite(freq) || freq < RADIO_MIN_HZ || freq > RADIO_MAX_HZ) throw new HttpError(400, 'The frequency must be from 0.5 to 1,766 MHz.');
    const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length > NAME_MAX) throw new HttpError(400, `Keep the name to ${NAME_MAX} characters.`);
    if (name && !this.names[freq] && Object.keys(this.names).length >= NAMES_MAX) throw new HttpError(409, `There are already ${NAMES_MAX} names. Remove some first.`);
    await this.serial(async () => {
      if (name) this.names[freq] = name;
      else delete this.names[freq];
      await this.save();
    });
    return this.names;
  }

  /** Record: keeps everything the receiver hears (squelch or not) for up to a minute, then adds it to the call log. */
  startRecording(): void {
    if (!this.child) throw new HttpError(409, 'Start listening first: the receiver is not running.');
    if (this.manual) return;
    const t = this.tuning;
    this.manual = { at: Date.now(), freq: t.freq, mode: t.mode, parts: [], bytes: 0, timer: setTimeout(() => void this.stopRecording(), 60_000) };
  }

  /** Stops a recording and saves it to the call log (if it caught at least a second). */
  async stopRecording(): Promise<void> {
    const rec = this.manual;
    this.manual = null;
    if (!rec) return;
    clearTimeout(rec.timer);
    const pcm = Buffer.concat(rec.parts).subarray(0, CALL_MAX_BYTES);
    const seconds = Math.round((pcm.length / 2 / RADIO_RATE) * 10) / 10;
    if (seconds < CALL_MIN_S) return;
    await this.calls.add({ at: rec.at, freq: rec.freq, mode: rec.mode, seconds }, wavFile(pcm, RADIO_RATE));
    this.lastCall = Date.now();
  }

  /** Turns the receiver on, or off: off stops listening for everyone and lets go of the dongle. */
  async setEnabled(on: unknown): Promise<boolean> {
    if (typeof on !== 'boolean') throw new HttpError(400, 'Send {"enabled": true} or {"enabled": false}.');
    if (!on) this.endScanner();
    await this.serial(async () => {
      this.enabled = on;
      this.checked = null;
      this.error = '';
      await this.save();
      if (!on) await Promise.all([this.halt(), this.haltSide()]);
    });
    if (!on) for (const res of this.listeners) res.end();
    return this.enabled;
  }

  /** The dongle is free for the receiver: switched on, and not showing planes or sensors. */
  private assertOn(): void {
    if (!this.enabled) throw new HttpError(409, 'The receiver is off. An admin can turn it on on the Radio page.');
    const name = this.side?.kind === 'aprs' ? 'APRS' : this.side?.kind;
    if (this.side) throw new HttpError(409, `The receiver is busy with ${name}. Stop ${name} first.`);
  }

  /**
   * Hands the dongle to a decoder (planes, sensors or APRS) until it is stopped: the receiver, auto-scan and any other
   * decoder stop first. `onLine` gets each line it prints. `pipe` is a second program fed its output (APRS: rtl_fm's
   * audio into direwolf). `logFile` holds the first program's messages when its stderr can't be read directly (rtl_fm
   * on a terminal); they make the error clear if it fails.
   */
  private async takeDongle(
    kind: Side,
    bin: string,
    args: string[],
    opts: { onLine?: (line: string) => void; env?: NodeJS.ProcessEnv; logFile?: string; pipe?: { bin: string; args: string[] } } = {},
  ): Promise<void> {
    if (!this.enabled) throw new HttpError(409, 'The receiver is off. An admin can turn it on on the Radio page.');
    if (this.side?.kind === kind) return;
    this.endScanner();
    await this.serial(async () => {
      await Promise.all([this.halt(), this.haltSide()]);
      for (const res of this.listeners) res.end();
      this.error = '';
      let tail = '';
      const env = { ...childEnv(), ...opts.env };
      const child = spawn(bin, args, { stdio: ['ignore', opts.onLine || opts.pipe ? 'pipe' : 'ignore', 'pipe'], env, detached: true });
      const extra = opts.pipe ? [spawn(opts.pipe.bin, opts.pipe.args, { stdio: ['pipe', 'ignore', 'pipe'], env, detached: true })] : [];
      this.side = { kind, child, extra };
      const fail = async (code: number | null, decoderTail = '') => {
        if (this.side?.child !== child) return; // stopped on purpose
        this.side = null;
        for (const x of extra) void this.kill(x);
        void this.kill(child);
        const all = `${tail}${opts.logFile ? await fsp.readFile(opts.logFile, 'utf8').catch(() => '') : ''}`;
        this.error =
          deviceFrom(all) === 'busy' || /usb_claim_interface/.test(all)
            ? `Another program is using the radio (for example iNTERCEPT). Stop it, then start ${kind} again.`
            : /No supported devices|no supported/i.test(all)
              ? `No radio found. Plug the RTL-SDR straight into the Mac, then start ${kind} again.`
              : `The ${kind} decoder stopped (exit code ${code}). ${`${all}${decoderTail}`.trim().split('\n').at(-1) ?? ''}`.trim();
      };
      if (opts.pipe) {
        const decoder = extra[0]!;
        let decoderTail = '';
        decoder.stdin!.on('error', () => undefined); // it may stop first; the close below explains why
        decoder.stderr!.on('data', (b: Buffer) => (decoderTail = (decoderTail + b.toString()).slice(-2000)));
        decoder.once('close', (code) => void fail(code, decoderTail));
        child.stdout!.pipe(decoder.stdin!);
      }
      let rest = '';
      if (opts.onLine) {
        child.stdout!.on('data', (b: Buffer) => {
          const lines = (rest + b.toString()).split('\n');
          rest = lines.pop()!.slice(-10_000);
          for (const line of lines) if (line.trim()) opts.onLine!(line);
        });
      }
      child.stderr!.on('data', (b: Buffer) => (tail = (tail + b.toString()).slice(-2000)));
      child.once('error', (e) => (tail += e.message));
      child.once('close', (code) => void fail(code));
    });
  }

  private haltSide(): Promise<void> {
    const side = this.side;
    this.side = null;
    return side ? Promise.all([side.child, ...side.extra].map((c) => this.kill(c))).then(() => undefined) : Promise.resolve();
  }

  /**
   * APRS: rtl_fm on the APRS frequency (narrow FM, no squelch: the decoder needs the whole signal) piped into
   * direwolf, which decodes the packets and logs each one, position worked out, to a CSV that aprsReport() reads.
   * Its network ports (AGW, KISS) are off, and it never transmits: its audio output goes nowhere.
   */
  async startAprs(body: Record<string, unknown> = {}): Promise<void> {
    const freq = body.freq === undefined ? this.aprsFreq : body.freq;
    if (!APRS_FREQS.includes(freq as never)) throw new HttpError(400, `The APRS frequency must be one of ${APRS_FREQS.join(', ')}.`);
    const fm = this.bin('fm');
    const dw = this.bin('aprs');
    if (!fm || !dw) throw new HttpError(409, 'The APRS decoder (direwolf) is not installed yet. An admin can install it on the Radio page.');
    if (freq !== this.aprsFreq) {
      this.aprsFreq = freq as (typeof APRS_FREQS)[number];
      await this.serial(() => this.save());
      if (this.side?.kind === 'aprs') await this.stopAprs(); // restart on the new frequency
    }
    if (this.side?.kind === 'aprs') return;
    this.aprsBoard.clear();
    this.aprsRead = 0;
    await fsp.mkdir(this.aprsDir, { recursive: true, mode: 0o700 });
    await fsp.rm(this.aprsLog, { force: true });
    await fsp.writeFile(path.join(this.aprsDir, 'direwolf.conf'), 'ADEVICE stdin null\nARATE 24000\nCHANNEL 0\nMODEM 1200\nAGWPORT 0\nKISSPORT 0\n');
    const log = path.join(this.cfg.home, 'radio.log');
    await this.takeDongle(
      'aprs',
      '/usr/bin/script',
      ['-q', '/dev/null', '/bin/sh', '-c', 'stty raw -echo; exec "$0" "$@" 2>"$RADIO_LOG"', fm, '-f', this.aprsFreq, '-M', 'fm', '-s', String(RADIO_RATE), '-'],
      {
        env: { RADIO_LOG: log },
        logFile: log,
        pipe: { bin: dw, args: ['-c', path.join(this.aprsDir, 'direwolf.conf'), '-r', String(RADIO_RATE), '-b', '16', '-n', '1', '-t', '0', '-q', 'hd', '-L', this.aprsLog, '-'] },
      },
    );
  }

  async stopAprs(): Promise<void> {
    if (this.side?.kind === 'aprs') await this.serial(() => this.haltSide());
  }

  /** What APRS mode has heard: stations (latest position and message each), and packets in the last 10 minutes. */
  async aprsReport() {
    if (this.side?.kind === 'aprs') {
      // Only what direwolf added since the last read: the log grows for as long as APRS runs.
      const fh = await fsp.open(this.aprsLog, 'r').catch(() => null);
      if (fh) {
        try {
          const { size } = await fh.stat();
          if (size > this.aprsRead) {
            const buf = Buffer.alloc(size - this.aprsRead);
            await fh.read(buf, 0, buf.length, this.aprsRead);
            const text = buf.toString('utf8');
            const upto = text.lastIndexOf('\n') + 1; // a half-written last line waits for the next read
            for (const line of text.slice(0, upto).split('\n')) if (line.trim()) this.aprsBoard.add(line);
            this.aprsRead += Buffer.byteLength(text.slice(0, upto));
          }
        } finally {
          await fh.close();
        }
      }
    }
    return { on: this.side?.kind === 'aprs', freq: this.aprsFreq, site: this.site, ...this.aprsBoard.list() };
  }

  /**
   * Sensors mode: hands the dongle to rtl_433, which decodes weather stations, thermometers, rain gauges and other
   * household sensors. `freq`: 433.92M (default), 868M or 915M, remembered for next time.
   */
  async startSensors(body: Record<string, unknown> = {}): Promise<void> {
    const freq = body.freq === undefined ? this.sensorFreq : body.freq;
    if (!SENSOR_FREQS.includes(freq as never)) throw new HttpError(400, `The sensor frequency must be one of ${SENSOR_FREQS.join(', ')}.`);
    const bin = this.bin('sensors');
    if (!bin) throw new HttpError(409, 'The sensors decoder (rtl_433) is not installed yet. An admin can install it on the Radio page.');
    if (freq !== this.sensorFreq) {
      this.sensorFreq = freq as (typeof SENSOR_FREQS)[number];
      await this.serial(() => this.save());
      if (this.side?.kind === 'sensors') await this.stopSensors(); // restart on the new frequency
    }
    if (this.side?.kind !== 'sensors') this.sensorBoard.clear();
    await this.takeDongle('sensors', bin, ['-f', this.sensorFreq, '-F', 'json', '-M', 'level'], { onLine: (line) => this.sensorBoard.add(line) });
  }

  async stopSensors(): Promise<void> {
    if (this.side?.kind === 'sensors') await this.serial(() => this.haltSide());
  }

  /** What sensors mode has heard: sensors with readings, and counts of passing cars' tyre sensors and other devices. */
  sensorReport() {
    return { on: this.side?.kind === 'sensors', freq: this.sensorFreq, ...this.sensorBoard.list() };
  }

  /**
   * Planes mode: hands the dongle to dump1090, which decodes aircraft positions (ADS-B, 1090 MHz) into aircraft.json.
   * Listening, scanning and auto-scan stop until planes are stopped. Networking stays off: no ports are opened.
   */
  async startPlanes(): Promise<void> {
    const bin = this.bin('planes');
    if (!bin) throw new HttpError(409, 'The planes decoder (dump1090) is not installed yet. An admin can install it on the Radio page.');
    if (this.side?.kind === 'planes') return;
    await fsp.rm(this.planesDir, { recursive: true, force: true });
    await fsp.mkdir(this.planesDir, { recursive: true, mode: 0o700 });
    this.samples = [];
    // Knowing where it is lets dump1090 place a plane from one message instead of waiting for a pair.
    const where = this.site ? ['--lat', String(this.site.lat), '--lon', String(this.site.lon)] : [];
    await this.takeDongle('planes', bin, ['--write-json', this.planesDir, '--write-json-every', '1', '--quiet', ...where]);
  }

  async stopPlanes(): Promise<void> {
    if (this.side?.kind === 'planes') await this.serial(() => this.haltSide());
  }

  /** The receiver's location for the map, and for dump1090 (it restarts with it when planes are running). */
  async setSite(body: Record<string, unknown>): Promise<Site | null> {
    const site = validSite(body);
    const restart = this.side?.kind === 'planes';
    await this.serial(async () => {
      this.site = site;
      await this.save();
    });
    if (restart) {
      await this.stopPlanes();
      await this.startPlanes();
    }
    return this.site;
  }

  /**
   * What planes mode sees now: aircraft with a recent position, those heard without one, messages a minute and the
   * strongest signal (so a silent antenna shows before the first plane would), and where the receiver is.
   */
  async aircraft() {
    const empty = { on: this.side?.kind === 'planes', site: this.site, planes: [], unplaced: [], rate: null as number | null, rssi: null as number | null };
    if (this.side?.kind !== 'planes') return empty;
    try {
      const file = readAircraft(JSON.parse(await fsp.readFile(path.join(this.planesDir, 'aircraft.json'), 'utf8')));
      if (file.now !== null && file.messages !== null && file.now !== this.samples.at(-1)?.now) {
        this.samples.push({ now: file.now, messages: file.messages });
        this.samples = this.samples.filter((x) => file.now! - x.now <= 60);
      }
      return { ...empty, planes: file.planes, unplaced: file.unplaced, rate: messageRate(this.samples), rssi: file.rssi };
    } catch {
      return empty; // not written yet
    }
  }

  /**
   * One sweep of rtl_power over the channels, for the activity bars. The dongle can't listen and sweep at once, so
   * listeners hear a gap of a second or two while it runs.
   */
  async scan(body: Record<string, unknown>): Promise<ReturnType<typeof scanLevels>> {
    const { freqs, width } = validScan(body);
    this.assertTools();
    if (this.scanner) throw new HttpError(409, 'Auto-scan is running. Stop it first.');
    return this.serial(async () => {
      try {
        return await this.sweep(freqs, width);
      } finally {
        if (this.listeners.size && !this.scanner) this.launch();
      }
    });
  }

  /** Stops whatever runs on the dongle and sweeps it once. Runs inside serial(). */
  private async sweep(freqs: number[], width: number): Promise<ReturnType<typeof scanLevels>> {
    await this.halt();
    const out = await new Promise<string>((resolve, reject) => {
      execFile(this.bin('power')!, rtlPowerArgs(freqs, width), { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: childEnv() }, (err, stdout, stderr) => {
        if (!err && stdout.trim()) return resolve(stdout);
        reject(
          new HttpError(
            409,
            deviceFrom(stderr) === 'busy' || /usb_claim_interface/.test(stderr)
              ? 'Another program is using the radio (for example iNTERCEPT). Stop it, then scan again.'
              : /No supported devices/.test(stderr)
                ? 'No radio found. Plug the RTL-SDR straight into the Mac, then scan again.'
                : `The scan didn't finish. ${stderr.trim().split('\n').at(-1) ?? ''}`.trim(),
          ),
        );
      });
    });
    return scanLevels(out, freqs, width);
  }

  private assertTools(): void {
    this.assertOn();
    if (!this.bin('fm') || !this.bin('power')) throw new HttpError(409, 'The radio tools are not installed yet.');
  }

  /**
   * Auto-scan: sweep the channels, tune to the busiest, stay while people talk, then sweep again, until stopped or
   * someone tunes by hand. It needs squelch to hear when a call ends, so squelch 0 becomes 3 while it runs.
   */
  async autoscan(body: Record<string, unknown>): Promise<void> {
    this.assertTools();
    const { freqs, width } = validScan(body);
    const mode = validTuning({ mode: body.mode }, this.tuning).mode;
    if (mode === 'wbfm') throw new HttpError(400, 'Auto-scan is for two-way radio channels, not broadcast stations.');
    this.endScanner();
    const run = ++this.scanRun;
    this.scanner = { freqs, width, mode, squelch: this.tuning.squelch || 3, run, on: null };
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    void this.scanLoop(run);
  }

  /** Stops auto-scan; listeners stay on the channel it was on. */
  async stopAutoscan(): Promise<void> {
    this.endScanner();
    await this.serial(async () => {
      if (!this.listeners.size) await this.halt();
      else if (!this.child && this.enabled) this.launch();
    });
  }

  private endScanner(): void {
    this.scanner = null;
    this.scanRun++;
  }

  private async scanLoop(run: number): Promise<void> {
    const live = () => this.scanner?.run === run && this.enabled;
    while (live()) {
      const s = this.scanner!;
      let found = -1;
      try {
        const { levels, floor } = await this.serial(() => this.sweep(s.freqs, s.width));
        found = bestChannel(levels, floor);
      } catch (e) {
        if (live()) {
          this.error = (e as Error).message;
          this.endScanner();
        }
        return;
      }
      if (found < 0 || !live()) continue;
      const started = Date.now();
      await this.serial(async () => {
        if (!live()) return;
        s.on = s.freqs[found]!;
        this.tuning = { freq: s.on, mode: s.mode, squelch: s.squelch };
        await this.halt();
        this.launch();
      });
      // Stay while people talk: until it has been quiet for HANG_MS (after a moment to tune in), or DWELL_MAX_MS.
      while (live() && Date.now() - started < DWELL_MAX_MS && Date.now() - Math.max(this.lastAudio, started + 1_500) < HANG_MS) await sleep(250);
      s.on = null;
    }
  }

  /** Streams the receiver's audio to one browser until it disconnects. */
  async listen(res: Response): Promise<void> {
    this.assertOn();
    if (!this.bin('fm')) throw new HttpError(409, 'The radio tools are not installed yet.');
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Sample-Rate': String(RADIO_RATE) });
    res.flushHeaders();
    this.listeners.add(res);
    res.on('close', () => {
      this.listeners.delete(res);
      if (!this.listeners.size && !this.idle && !this.scanner) {
        // Lets go of the receiver only: planes, if someone started them meanwhile, keep running.
        this.idle = setTimeout(() => {
          this.idle = null;
          if (!this.listeners.size && !this.scanner) void this.serial(() => this.halt());
        }, IDLE_MS);
      }
    });
    if (!this.child) await this.serial(async () => this.child || !this.enabled || this.scanner || this.launch());
  }

  /** Stops everything on the dongle: the receiver, auto-scan and planes (Outpost shutting down). */
  async stop(): Promise<void> {
    this.endScanner();
    await this.serial(() => this.haltSide());
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    await this.serial(() => this.halt());
    for (const res of this.listeners) res.end();
  }

  private launch(): void {
    this.error = '';
    this.checked = null;
    const log = path.join(this.cfg.home, 'radio.log');
    // rtl_fm never flushes, so into a pipe its audio comes in 64 KB bursts (1.4 s, and a short call can sit there
    // until the next one). On a terminal it writes as it goes: script(1) gives it one, set raw so no byte is changed.
    // Its messages go to radio.log, not into the audio.
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sh', '-c', 'stty raw -echo; exec "$0" "$@" 2>"$RADIO_LOG"', this.bin('fm')!, ...rtlFmArgs(this.tuning)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...childEnv(), RADIO_LOG: log },
      detached: true, // its own process group, so stopping it also stops rtl_fm
    });
    this.child = child;
    child.stdout!.on('data', (chunk: Buffer) => {
      this.lastAudio = Date.now();
      this.record(chunk);
      if (this.manual && this.manual.bytes < CALL_MAX_BYTES) {
        this.manual.parts.push(chunk);
        this.manual.bytes += chunk.length;
      }
      for (const res of this.listeners) {
        if (res.writableLength > MAX_BACKLOG) res.destroy();
        else res.write(chunk);
      }
    });
    child.once('error', (e) => (this.error = e.message));
    child.once('close', async (code) => {
      if (this.child !== child) return; // stopped on purpose (retune or idle)
      this.child = null;
      this.endScanner();
      const tail = await fsp.readFile(log, 'utf8').catch(() => '');
      this.error =
        deviceFrom(tail) === 'busy'
          ? 'Another program is using the radio (for example iNTERCEPT). Stop it, then listen again.'
          : /No supported devices/.test(tail)
            ? 'No radio found. Plug the RTL-SDR straight into the Mac, then listen again.'
            : `The receiver stopped (exit code ${code}). ${tail.trim().split('\n').at(-1) ?? ''}`.trim();
      for (const res of this.listeners) res.end();
    });
  }

  /** Adds received audio to the call in progress. Without squelch the audio never stops, so there are no calls. */
  private record(chunk: Buffer): void {
    const t = this.tuning;
    if (!t.squelch || t.mode === 'wbfm') return;
    this.call ??= { at: Date.now(), freq: t.freq, mode: t.mode, parts: [], bytes: 0 };
    if (this.call.bytes < CALL_MAX_BYTES) {
      this.call.parts.push(chunk);
      this.call.bytes += chunk.length;
    }
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = setTimeout(() => void this.endCall(), CALL_GAP_MS);
  }

  /** Saves the call in progress to the log, if it was long enough to be speech. */
  private async endCall(): Promise<void> {
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = null;
    const call = this.call;
    this.call = null;
    if (!call) return;
    const pcm = Buffer.concat(call.parts).subarray(0, CALL_MAX_BYTES);
    const seconds = Math.round((pcm.length / 2 / RADIO_RATE) * 10) / 10;
    if (seconds < CALL_MIN_S) return;
    try {
      await this.calls.add({ at: call.at, freq: call.freq, mode: call.mode, seconds }, wavFile(pcm, RADIO_RATE));
      this.lastCall = Date.now();
    } catch (e) {
      console.error('Radio call not saved:', e);
    }
  }

  private halt(): Promise<void> {
    void this.endCall(); // retuning or stopping ends the call in progress, and a recording
    void this.stopRecording();
    const child = this.child;
    this.child = null;
    return child ? this.kill(child) : Promise.resolve();
  }

  /** Stops a program and everything it started (its own process group), and waits until it has gone. */
  private kill(child: ChildProcess): Promise<void> {
    const group = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        /* already gone */
      }
    };
    return new Promise((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      const kill = setTimeout(() => group('SIGKILL'), 2_000);
      child.once('close', () => {
        clearTimeout(kill);
        resolve();
      });
      group('SIGTERM');
    });
  }
}
