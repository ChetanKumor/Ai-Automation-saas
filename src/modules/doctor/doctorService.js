'use strict';

// Doctor service (PORTAL-P3-S8) — the owner of doctor schedules.
//
// THE MAPPING (verified against appointmentService as it stands after F-006):
// doctor schedules are NOT a tenant_configs section and NOT their own table. They
// are rows in `tenant_entities` with `type = 'schedule'`, payload in `data` JSONB:
//
//   { doctor: 'Dr. Sharma', days: ['Mon','Wed','Fri'], start: '10:00', end: '17:00' }
//
// appointmentService.getSchedules reads exactly `SELECT data FROM tenant_entities
// WHERE tenant_id = $1 AND type = 'schedule'`, and BOTH checkAvailability (which
// slots to offer) and bookAppointment (which times to accept) run off that read.
// This module is therefore the single portal-facing writer of live booking
// behavior — not of a document. Everything here is shaped by that fact:
//
//  • ONE window per doctor, not per day. The stored shape carries a single
//    start/end plus a `days` array; there is no per-day map. Splitting a doctor
//    across TWO rows to fake per-day hours is a trap, not a workaround:
//    checkAvailability loops over ALL rows (it would offer both windows) while
//    bookAppointment does a single `.find()` on the doctor name (it would only
//    ever consult the first). Slots offered from the second row would then be
//    refused as `doctor_day_off` — the exact offer-vs-write divergence F-006
//    closed. One doctor is one row. Per-day hours is a storage change plus an
//    appointmentService change, and belongs in its own issue.
//
//  • ARCHIVE, never a flag. There is no `active` column and getSchedules does not
//    filter on anything inside `data`, so an `active: false` key would be read
//    straight past — a "deactivated" doctor would still be offered and booked.
//    Archiving instead moves the row to `type = 'schedule_archived'`, which the
//    existing WHERE clause already excludes. Booking honors it with zero change
//    to appointmentService, it is reversible, and bookAppointment then answers
//    `doctor_not_found` naming the doctors who ARE available — the right sentence
//    for someone who has left.
//
//  • NO leave dates. Booking has no concept of doctor absence (evaluateDay knows
//    past / same-day / advance window / holiday / closed day, and nothing else).
//    Shipping a leave UI here would promise a refusal booking does not make.
//    Deferred to its own issue, where the storage and the enforcement land
//    together.
//
// INV-1: every statement filters `tenant_id`, and an id belonging to another
// tenant simply matches no row (→ null → 404 at the route). INV-4: tenant_entities
// has no actor column and this session adds no DDL, so the acting user is recorded
// in the log line for each write rather than in the row.

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');

// The row types. `TYPE_ACTIVE` is the literal appointmentService.getSchedules
// filters on — changing it silently unbooks every doctor.
const TYPE_ACTIVE = 'schedule';
const TYPE_ARCHIVED = 'schedule_archived';

// Day tokens, EXACTLY as appointmentService's DAY_NAMES emits them
// (`new Date(...).getUTCDay()` → 'Sun'..'Sat'), listed Monday-first because that
// is the order the page shows and the order we store them in. A mismatch in case
// or spelling means `sched.days.includes(dayName)` silently never matches.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_ORDER = new Map(DAY_NAMES.map((d, i) => [d, i]));

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_NAME = 120;
const MAX_SPECIALIZATION = 120;
const MAX_DOCTORS = 25;

class DoctorValidationError extends Error {
  constructor(issues) {
    super('doctor payload failed validation');
    this.name = 'DoctorValidationError';
    this.issues = issues;
  }
}

// Row → the shape every caller sees. `archived` is derived from the row TYPE, not
// from anything inside `data`, because the type is what booking actually reads.
function project(row) {
  const d = row.data || {};
  return {
    id: row.id,
    name: typeof d.doctor === 'string' ? d.doctor : '',
    specialization: typeof d.specialization === 'string' ? d.specialization : '',
    languages: Array.isArray(d.languages) ? d.languages.slice() : [],
    days: Array.isArray(d.days) ? d.days.filter((x) => DAY_ORDER.has(x)) : [],
    start: typeof d.start === 'string' ? d.start : '',
    end: typeof d.end === 'string' ? d.end : '',
    archived: row.type === TYPE_ARCHIVED,
  };
}

function sortDays(days) {
  return days.slice().sort((a, b) => DAY_ORDER.get(a) - DAY_ORDER.get(b));
}

// Structural validation. The route validates first with owner-friendly copy; this
// is the gate that holds regardless of caller (there is no Zod schema behind this
// storage the way configService backs the config pages).
function normalize(input, opts = {}) {
  const issues = [];
  const out = {};

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) issues.push({ path: 'name', message: 'name is required' });
  else if (name.length > MAX_NAME) issues.push({ path: 'name', message: `name must be ≤ ${MAX_NAME} characters` });
  out.doctor = name;

  // Zero working days is ALLOWED — an owner mid-setup, or a doctor who has
  // stopped taking appointments but is not gone. It is surfaced as "not bookable"
  // rather than blocked, because it is honest data, not broken data.
  const rawDays = Array.isArray(input.days) ? input.days : [];
  const days = [];
  for (const d of rawDays) {
    if (!DAY_ORDER.has(d)) { issues.push({ path: 'days', message: `unknown day: ${String(d)}` }); break; }
    if (!days.includes(d)) days.push(d);
  }
  out.days = sortDays(days);

  const start = typeof input.start === 'string' ? input.start.trim() : '';
  const end = typeof input.end === 'string' ? input.end.trim() : '';
  if (!HHMM_RE.test(start)) issues.push({ path: 'start', message: 'start must be HH:MM' });
  if (!HHMM_RE.test(end)) issues.push({ path: 'end', message: 'end must be HH:MM' });
  if (HHMM_RE.test(start) && HHMM_RE.test(end) && start >= end) {
    issues.push({ path: 'end', message: 'end must be later than start' });
  }
  out.start = start;
  out.end = end;

  const spec = typeof input.specialization === 'string' ? input.specialization.trim() : '';
  if (spec.length > MAX_SPECIALIZATION) {
    issues.push({ path: 'specialization', message: `specialization must be ≤ ${MAX_SPECIALIZATION} characters` });
  }
  out.specialization = spec;

  // Languages are stored as the tenant's own language codes. NOTE: nothing reads
  // these yet — neither booking nor the prompt renderer. They are captured here
  // because §5.5 asks for them and a later renderer session will state them
  // ("Dr. Rao speaks Telugu and English"); until then they are inert data, not
  // behavior.
  const allowed = Array.isArray(opts.languages) ? opts.languages : null;
  const langs = [];
  for (const l of (Array.isArray(input.languages) ? input.languages : [])) {
    if (typeof l !== 'string') continue;
    if (allowed && !allowed.includes(l)) continue;
    if (!langs.includes(l)) langs.push(l);
  }
  out.languages = langs;

  if (issues.length) throw new DoctorValidationError(issues);
  return out;
}

// Every doctor for a tenant, active first then archived, name-ordered within each
// group. Archived rows are included so the page can show and restore them.
async function listDoctors(tenantId) {
  const { rows } = await db.query(
    `SELECT id, type, data FROM tenant_entities
     WHERE tenant_id = $1 AND type IN ($2, $3)
     ORDER BY type = $3, data->>'doctor', created_at`,
    [tenantId, TYPE_ACTIVE, TYPE_ARCHIVED]
  );
  return rows.map(project);
}

// One doctor, tenant-scoped. Returns null when the id belongs to another tenant —
// which is what makes a crafted id inert rather than an information leak (INV-1).
async function getDoctor(tenantId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    `SELECT id, type, data FROM tenant_entities
     WHERE tenant_id = $1 AND id = $2 AND type IN ($3, $4)`,
    [tenantId, id, TYPE_ACTIVE, TYPE_ARCHIVED]
  );
  return rows[0] ? project(rows[0]) : null;
}

// A malformed id would make Postgres throw on the uuid cast; treat it as "no such
// doctor" so a garbage path segment 404s like any other unknown id.
function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// Is this name already taken by another ACTIVE doctor? Booking resolves a doctor
// by name (there is no id in `appointments`), so two active doctors sharing a name
// would make `bookAppointment`'s `.find()` pick one arbitrarily. Archived names are
// free to reuse — same rule as archived treatments in S6.
async function nameTaken(tenantId, name, exceptId) {
  const { rows } = await db.query(
    `SELECT id FROM tenant_entities
     WHERE tenant_id = $1 AND type = $2 AND lower(data->>'doctor') = lower($3)`,
    [tenantId, TYPE_ACTIVE, name]
  );
  return rows.some((r) => r.id !== exceptId);
}

async function countActive(tenantId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM tenant_entities WHERE tenant_id = $1 AND type = $2',
    [tenantId, TYPE_ACTIVE]
  );
  return rows[0].n;
}

async function createDoctor(tenantId, input, opts = {}) {
  const data = normalize(input, opts);
  if (await nameTaken(tenantId, data.doctor, null)) {
    throw new DoctorValidationError([{ path: 'name', message: 'a doctor with this name already exists' }]);
  }
  if (await countActive(tenantId) >= MAX_DOCTORS) {
    throw new DoctorValidationError([{ path: 'name', message: `at most ${MAX_DOCTORS} doctors` }]);
  }
  const { rows } = await db.query(
    `INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, $2, $3)
     RETURNING id, type, data`,
    [tenantId, TYPE_ACTIVE, JSON.stringify(data)]
  );
  logger.info(
    { scope: 'doctor_write', action: 'create', tenant_id: tenantId, doctor_id: rows[0].id,
      actor_user_id: opts.actorUserId || null }, // INV-4: no actor column on tenant_entities
    'doctor created'
  );
  return project(rows[0]);
}

// Full replace of one doctor's payload. UNKNOWN keys already in `data` are
// preserved (the seed scripts wrote a vestigial `slot_minutes`; an edit through
// the portal must not silently drop whatever another writer put there).
async function updateDoctor(tenantId, id, input, opts = {}) {
  const existing = await getDoctorRow(tenantId, id);
  if (!existing) return null;

  const data = normalize(input, opts);
  if (await nameTaken(tenantId, data.doctor, id)) {
    throw new DoctorValidationError([{ path: 'name', message: 'a doctor with this name already exists' }]);
  }
  const merged = { ...existing.data, ...data };

  const { rows } = await db.query(
    `UPDATE tenant_entities SET data = $3
     WHERE tenant_id = $1 AND id = $2 RETURNING id, type, data`,
    [tenantId, id, JSON.stringify(merged)]
  );
  logger.info(
    { scope: 'doctor_write', action: 'update', tenant_id: tenantId, doctor_id: id,
      actor_user_id: opts.actorUserId || null },
    'doctor updated'
  );
  return project(rows[0]);
}

async function getDoctorRow(tenantId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    `SELECT id, type, data FROM tenant_entities
     WHERE tenant_id = $1 AND id = $2 AND type IN ($3, $4)`,
    [tenantId, id, TYPE_ACTIVE, TYPE_ARCHIVED]
  );
  return rows[0] || null;
}

// Move a doctor between the active and archived types. This is the deactivation
// primitive: the type flip is what booking reads, so an archived doctor stops
// being offered and stops being bookable the moment this commits.
async function setArchived(tenantId, id, archived, opts = {}) {
  const existing = await getDoctorRow(tenantId, id);
  if (!existing) return null;

  // Restoring into a name another active doctor now holds would recreate the
  // ambiguity nameTaken exists to prevent.
  if (!archived) {
    const name = (existing.data && existing.data.doctor) || '';
    if (await nameTaken(tenantId, name, id)) {
      throw new DoctorValidationError([{ path: 'name', message: 'a doctor with this name already exists' }]);
    }
  }

  const { rows } = await db.query(
    `UPDATE tenant_entities SET type = $3
     WHERE tenant_id = $1 AND id = $2 RETURNING id, type, data`,
    [tenantId, id, archived ? TYPE_ARCHIVED : TYPE_ACTIVE]
  );
  logger.info(
    { scope: 'doctor_write', action: archived ? 'archive' : 'restore', tenant_id: tenantId,
      doctor_id: id, actor_user_id: opts.actorUserId || null },
    archived ? 'doctor archived' : 'doctor restored'
  );
  return project(rows[0]);
}

// Does any appointment reference this doctor? `appointments.doctor_name` is plain
// TEXT with no foreign key, but bookAppointment normalizes the requested name to
// `sched.doctor` before inserting, so the stored string is always exactly the
// schedule's name — an exact match is the right test.
async function hasAppointments(tenantId, doctorName) {
  const { rows } = await db.query(
    'SELECT 1 FROM appointments WHERE tenant_id = $1 AND doctor_name = $2 LIMIT 1',
    [tenantId, doctorName]
  );
  return rows.length > 0;
}

// "Remove this doctor", resolved honestly by what the data allows: a doctor with
// appointments on the books is ARCHIVED (their history keeps naming someone the
// tenant can still account for), a doctor with none is deleted outright (an owner
// who mistyped a name deserves to be rid of it). Either way they leave booking.
// Returns { outcome: 'deleted' | 'archived', doctor } or null when not found.
async function removeDoctor(tenantId, id, opts = {}) {
  const existing = await getDoctorRow(tenantId, id);
  if (!existing) return null;
  const name = (existing.data && existing.data.doctor) || '';

  if (await hasAppointments(tenantId, name)) {
    const doctor = await setArchived(tenantId, id, true, opts);
    return { outcome: 'archived', doctor };
  }

  await db.query('DELETE FROM tenant_entities WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  logger.info(
    { scope: 'doctor_write', action: 'delete', tenant_id: tenantId, doctor_id: id,
      actor_user_id: opts.actorUserId || null },
    'doctor deleted'
  );
  return { outcome: 'deleted', doctor: project(existing) };
}

module.exports = {
  listDoctors,
  getDoctor,
  createDoctor,
  updateDoctor,
  setArchived,
  removeDoctor,
  hasAppointments,
  DoctorValidationError,
  DAY_NAMES,
  MAX_DOCTORS,
  TYPE_ACTIVE,
  TYPE_ARCHIVED,
};
