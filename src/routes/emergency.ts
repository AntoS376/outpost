import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { userOf } from '../auth.js';
import { HttpError, readJson } from '../util.js';

/** One person's emergency card and kit checklists. Medical details, so the file is readable by its owner only. */
export interface EmergencyData {
  card: {
    name: string;
    born: string;
    bloodType: string;
    allergies: string;
    conditions: string;
    medications: string;
    contacts: { name: string; relation: string; phone: string }[];
    meetingPoints: string[];
    notes: string;
  };
  /** Ticked items per list, e.g. { gobag: ["water", …] }, and items people added themselves. */
  kits: { checked: Record<string, string[]>; extra: Record<string, string[]> };
}

const BLOOD = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'];
const LISTS = ['gobag', 'home', 'car'];
const empty = (): EmergencyData => ({
  card: { name: '', born: '', bloodType: '', allergies: '', conditions: '', medications: '', contacts: [], meetingPoints: [], notes: '' },
  kits: { checked: {}, extra: {} },
});

const text = (v: unknown, max: number, field: string) => {
  const s = String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (s.length > max) throw new HttpError(400, `${field} can be at most ${max} characters.`);
  return s;
};
const list = (v: unknown, max: number, field: string) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new HttpError(400, `${field} must be a list of at most ${max}.`);
  return v;
};

function validate(body: Partial<EmergencyData>): EmergencyData {
  const c = (body.card ?? {}) as Partial<EmergencyData['card']>;
  const bloodType = text(c.bloodType, 8, 'Blood type');
  if (!BLOOD.includes(bloodType)) throw new HttpError(400, `Blood type must be one of ${BLOOD.filter(Boolean).join(', ')}.`);
  const k = (body.kits ?? {}) as Partial<EmergencyData['kits']>;
  const perList = (o: unknown, max: number, len: number, field: string) => {
    const out: Record<string, string[]> = {};
    for (const [name, items] of Object.entries((o ?? {}) as Record<string, unknown>)) {
      if (!LISTS.includes(name)) throw new HttpError(400, `Unknown checklist "${name}".`);
      out[name] = list(items, max, field).map((x) => text(x, len, field)).filter(Boolean);
    }
    return out;
  };
  return {
    card: {
      name: text(c.name, 80, 'Name'),
      born: text(c.born, 40, 'Date of birth'),
      bloodType,
      allergies: text(c.allergies, 500, 'Allergies'),
      conditions: text(c.conditions, 500, 'Conditions'),
      medications: text(c.medications, 800, 'Medications'),
      contacts: list(c.contacts, 8, 'Contacts').map((x: { name?: unknown; relation?: unknown; phone?: unknown }) => ({
        name: text(x?.name, 80, 'Contact name'),
        relation: text(x?.relation, 40, 'Relation'),
        phone: text(x?.phone, 40, 'Phone'),
      })),
      meetingPoints: list(c.meetingPoints, 4, 'Meeting points').map((x) => text(x, 200, 'Meeting point')),
      notes: text(c.notes, 1000, 'Notes'),
    },
    kits: { checked: perList(k.checked, 200, 60, 'Checklist item'), extra: perList(k.extra, 50, 120, 'Your own item') },
  };
}

/** /api/emergency: the signed-in person's own card and checklists. */
export function emergencyRoutes(ctx: AppContext): Router {
  const r = Router();
  const dir = path.join(ctx.cfg.home, 'emergency');
  const file = (res: Parameters<typeof userOf>[0]) => path.join(dir, `${userOf(res).name}.json`); // names are [a-z0-9_-]

  r.get('/', async (_req, res) => res.json({ ...empty(), ...(await readJson<EmergencyData | null>(file(res), null)) }));

  r.put('/', async (req, res) => {
    const data = validate(req.body ?? {});
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file(res)}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file(res));
    res.json(data);
  });
  return r;
}
