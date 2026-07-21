'use strict';

// Route-level tests for /portal/api/doctors (PORTAL-P3-S8) — the first portal
// surface whose data is NOT a tenant_configs section. Exercises the real /portal
// router over HTTP against a throwaway scratch DB (same genesis pattern as the
// other portal suites). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pdoc_) so it can run in parallel with the auth /
// readiness / identity / hours / pricing suites without dropping their scratch DBs.
//
// The contract under test:
//   • ANTI-DIVERGENCE (the test that matters): editing a doctor through the portal
//     changes what appointmentService.checkAvailability offers. This is what proves
//     the page writes the SAME storage booking reads — a parallel doctors table or
//     a doctors config section would still pass every other test in this file.
//   • archiving removes a doctor from availability; restoring puts them back,
//   • a doctor with appointments is ARCHIVED rather than deleted (their history
//     still names them); one without is deleted outright,
//   • schedules reaching outside clinic hours are ALLOWED and warned about, and
//     availability still returns only the intersection (F-006 behavior unchanged),
//   • the doctor.schedule readiness check flips as doctors come and go,
//   • validation failures → 4xx with NO write,
//   • tenant scope (INV-1): a crafted id / tenantId is inert on read AND write.
//
// Booking assertions call appointmentService directly — that is the same module,
// and the same getSchedules read, the live WhatsApp/voice brains call through the
// check_availability tool.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pdoc_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pdoc\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror the other portal route tests) ───────────────────────
function req(server, { method = 'GET', path = '/', headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const h = Object.assign({}, headers);
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('portal.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }
function buildPortalApp() {
  const express = require('express');
  const app = express();
  delete require.cache[require.resolve('../../src/portal/routes')];
  app.use('/portal', require('../../src/portal/routes'));
  return app;
}
async function start() { return listen(buildPortalApp()); }
function login(server, email, password) {
  return req(server, { method: 'POST', path: '/portal/api/login', body: { email, password } });
}
async function authedCookie(server, email, password) {
  return sid((await login(server, email, password)).setCookie);
}

// A date that is a given weekday, far enough out to clear same-day/buffer rules
// but inside the 30-day default advance window. Computed in the IST calendar
// frame, the frame checkAvailability answers in.
function nextWeekday(dayName, minDaysAhead = 3) {
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [y, m, d] = today.split('-').map(Number);
  for (let i = minDaysAhead; i < minDaysAhead + 7; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    if (NAMES[dt.getUTCDay()] === dayName) return dt.toISOString().slice(0, 10);
  }
  throw new Error('no such weekday');
}

describe('portal doctors — doctor schedules (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, appointmentService, validationService;
  let ownerA, ownerB;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Required only AFTER the env swap so the shared pool binds to the scratch DB
    // (the S1 lesson: an eager import binds to the wrong database).
    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
    appointmentService = require('../../src/modules/appointment/appointmentService');
    validationService = require('../../src/modules/validation/validationService');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });

    // A opens 09:00–18:00 Mon–Sat and is CLOSED Sunday — the frame every
    // intersection assertion below is measured against.
    await configService.writeTenantConfig(ownerA.tenantId, {
      business: { display_name: 'Sunrise Dental' },
      hours: {
        mon: { open: '09:00', close: '18:00' }, tue: { open: '09:00', close: '18:00' },
        wed: { open: '09:00', close: '18:00' }, thu: { open: '09:00', close: '18:00' },
        fri: { open: '09:00', close: '18:00' }, sat: { open: '09:00', close: '18:00' },
        sun: { closed: true }, holidays: [],
      },
    }, 'cli');
    await configService.writeTenantConfig(ownerB.tenantId, {}, 'cli');
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  async function seedOwner({ tenantName, email, password }) {
    const t = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [tenantName]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    return { tenantId, userId: u.rows[0].id, email, password };
  }

  // Read the storage DIRECTLY — this is the row shape appointmentService reads.
  async function rawSchedules(tenantId, type = 'schedule') {
    const { rows } = await db.query(
      'SELECT id, type, data FROM tenant_entities WHERE tenant_id=$1 AND type=$2 ORDER BY created_at',
      [tenantId, type]);
    return rows;
  }
  async function clearDoctors(tenantId) {
    await db.query("DELETE FROM tenant_entities WHERE tenant_id=$1 AND type LIKE 'schedule%'", [tenantId]);
  }
  const doctorCheck = async (tenantId) => {
    const run = await validationService.validateTenant(tenantId, {
      skip: ['turn.scripted', 'whatsapp.live', 'kb.populated', 'kb.retrieval'],
      deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' },
    });
    return run.checks.find((c) => c.name === 'doctor.schedule');
  };

  const VALID = {
    name: 'Dr. Sharma',
    specialization: 'Dentist',
    languages: ['te', 'en'],
    days: ['Mon', 'Wed', 'Fri'],
    start: '10:00',
    end: '17:00',
  };

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/doctors' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'POST', path: '/portal/api/doctors', body: VALID });
      assert.equal(res.status, 401);
      assert.equal((await rawSchedules(ownerA.tenantId)).length, 0, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns an empty list and the tenant’s enabled languages', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/doctors', cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.doctors, []);
      assert.deepEqual(res.body.languages, ['te', 'hi', 'en'], 'the toggles offer the clinic’s own languages');
    } finally { server.close(); }
  });

  // ── Create → the storage booking reads ──────────────────────────────────────
  it('POST creates a doctor in tenant_entities type=schedule, in the shape booking reads', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'POST', path: '/portal/api/doctors', cookie, body: VALID });

      assert.equal(res.status, 200);
      assert.equal(res.body.doctor.name, 'Dr. Sharma');
      assert.deepEqual(res.body.doctor.days, ['Mon', 'Wed', 'Fri']);
      assert.equal(res.body.doctor.bookable, true);
      assert.ok(res.body.readiness, 'readiness snapshot returned for the header/ring');

      // The row is EXACTLY what appointmentService.getSchedules expects: a `doctor`
      // string, a `days` array of 'Mon'-style tokens, and one start/end pair.
      const rows = await rawSchedules(ownerA.tenantId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, 'schedule');
      assert.deepEqual(rows[0].data.days, ['Mon', 'Wed', 'Fri']);
      assert.equal(rows[0].data.doctor, 'Dr. Sharma');
      assert.equal(rows[0].data.start, '10:00');
      assert.equal(rows[0].data.end, '17:00');

      // …and the service itself sees it.
      const scheds = await appointmentService.getSchedules(ownerA.tenantId);
      assert.equal(scheds.length, 1);
      assert.equal(scheds[0].doctor, 'Dr. Sharma');
    } finally { server.close(); }
  });

  // ── THE ANTI-DIVERGENCE TEST ────────────────────────────────────────────────
  it('editing a doctor’s hours through the portal changes what check_availability OFFERS', async () => {
    // If this page ever wrote a parallel doctors table or a config section, every
    // other test here would still pass and this one would fail. It is the proof
    // that portal truth and booking truth are the same truth.
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const id = (await rawSchedules(ownerA.tenantId))[0].id;
      const monday = nextWeekday('Mon');

      const before = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.ok(before.available, 'a Monday doctor is offered on Monday');
      assert.equal(before.available[0].doctor, 'Dr. Sharma');
      assert.equal(before.available[0].free_slots[0], '10:00', 'slots start at the doctor’s 10:00');
      assert.ok(!before.available[0].free_slots.includes('09:00'), 'nothing before the doctor starts');

      // Move the start 10:00 → 09:00 through the PORTAL route.
      const res = await req(server, {
        method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie,
        body: { ...VALID, start: '09:00' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.doctor.start, '09:00');

      const after = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.equal(after.available[0].free_slots[0], '09:00',
        'the portal edit moved the first offered slot — same storage, no divergence');

      // Restore the original window for the tests that follow.
      await req(server, { method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie, body: VALID });
      const back = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.equal(back.available[0].free_slots[0], '10:00');
    } finally { server.close(); }
  });

  it('a day removed through the portal makes that day unbookable', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const id = (await rawSchedules(ownerA.tenantId))[0].id;
      const wednesday = nextWeekday('Wed');

      assert.ok((await appointmentService.checkAvailability(ownerA.tenantId, wednesday)).available,
        'Wednesday is offered while it is in the doctor’s days');

      const res = await req(server, {
        method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie,
        body: { ...VALID, days: ['Mon', 'Fri'] },
      });
      assert.equal(res.status, 200);

      const after = await appointmentService.checkAvailability(ownerA.tenantId, wednesday);
      assert.equal(after.reason, 'no_doctors_on_day', 'removing the day removed the offer');

      await req(server, { method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie, body: VALID });
    } finally { server.close(); }
  });

  // ── Hours outside the clinic's: allowed, warned, intersected ────────────────
  it('a schedule reaching outside clinic hours is ALLOWED, warned about, and only the intersection is offered', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const id = (await rawSchedules(ownerA.tenantId))[0].id;
      const monday = nextWeekday('Mon');

      // The clinic closes at 18:00; give the doctor 08:00–20:00 on both sides of it.
      const res = await req(server, {
        method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie,
        body: { ...VALID, start: '08:00', end: '20:00' },
      });
      assert.equal(res.status, 200, 'never hard-blocked — the owner may know something we do not');
      assert.ok(res.body.doctor.warnings.length > 0, 'but it is surfaced');
      assert.match(res.body.doctor.warnings.join(' '), /Outside your clinic hours/);

      // F-006 behavior is unchanged by this page: availability is the INTERSECTION.
      const avail = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      const slots = avail.available[0].free_slots;
      assert.ok(!slots.includes('08:00'), 'before the clinic opens is never offered');
      assert.equal(slots[0], '09:00', 'the clinic’s opening time wins');
      assert.ok(!slots.some((s) => s >= '18:00'), 'nothing at or after the clinic closes');

      await req(server, { method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie, body: VALID });
    } finally { server.close(); }
  });

  it('working a day the clinic is closed → warned, and that day is still refused', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const id = (await rawSchedules(ownerA.tenantId))[0].id;

      const res = await req(server, {
        method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie,
        body: { ...VALID, days: ['Mon', 'Wed', 'Fri', 'Sun'] },
      });
      assert.equal(res.status, 200);
      assert.match(res.body.doctor.warnings.join(' '), /closed on Sunday/);

      const sunday = nextWeekday('Sun');
      const avail = await appointmentService.checkAvailability(ownerA.tenantId, sunday);
      assert.equal(avail.reason, 'closed_day', 'the clinic being shut still wins over a doctor’s day');

      await req(server, { method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie, body: VALID });
    } finally { server.close(); }
  });

  // ── Zero working days: allowed, flagged, not bookable ───────────────────────
  it('a doctor with zero working days saves, is flagged not bookable, and is never offered', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie,
        body: { name: 'Dr. Idle', days: [], start: '10:00', end: '16:00', languages: [], specialization: '' },
      });
      assert.equal(res.status, 200, 'honest, not blocking');
      assert.equal(res.body.doctor.bookable, false);
      assert.deepEqual(res.body.doctor.warnings, [], 'a doctor who is never offered gets no hours warning');

      const monday = nextWeekday('Mon');
      const avail = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.ok(!avail.available.some((a) => a.doctor === 'Dr. Idle'), 'never offered');

      // …and readiness says so, without failing the clinic outright.
      const check = await doctorCheck(ownerA.tenantId);
      assert.equal(check.severity, 'warn');
      assert.match(check.detail, /1 with no working days/);

      await req(server, { method: 'DELETE', path: `/portal/api/doctors/${res.body.doctor.id}`, cookie });
    } finally { server.close(); }
  });

  // ── Archive / restore ───────────────────────────────────────────────────────
  it('DELETE with no appointments removes the doctor outright', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const created = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie,
        body: { ...VALID, name: 'Dr. Mistake' },
      });
      const id = created.body.doctor.id;

      const res = await req(server, { method: 'DELETE', path: `/portal/api/doctors/${id}`, cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.outcome, 'deleted');
      assert.ok(!res.body.doctors.some((d) => d.name === 'Dr. Mistake'));
      const { rows } = await db.query('SELECT 1 FROM tenant_entities WHERE id=$1', [id]);
      assert.equal(rows.length, 0, 'the row is gone');
    } finally { server.close(); }
  });

  it('DELETE with appointments ARCHIVES instead of deleting, and the doctor leaves availability', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const created = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie,
        body: { ...VALID, name: 'Dr. Booked' },
      });
      const id = created.body.doctor.id;
      const monday = nextWeekday('Mon');

      const before = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.ok(before.available.some((a) => a.doctor === 'Dr. Booked'), 'offered while active');

      // A real appointment on the books, exactly as bookAppointment would leave it.
      const cust = await db.query(
        "INSERT INTO customers (tenant_id, phone, name) VALUES ($1,'+919000000009','Patient') RETURNING id",
        [ownerA.tenantId]);
      await db.query(
        `INSERT INTO appointments (tenant_id, customer_id, doctor_name, appointment_time, status)
         VALUES ($1,$2,'Dr. Booked',$3,'booked')`,
        [ownerA.tenantId, cust.rows[0].id, `${monday}T11:00:00+05:30`]);

      const res = await req(server, { method: 'DELETE', path: `/portal/api/doctors/${id}`, cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.outcome, 'archived', 'history that names this doctor is not orphaned');

      // The row survives, moved out of the type booking reads.
      const { rows } = await db.query('SELECT type FROM tenant_entities WHERE id=$1', [id]);
      assert.equal(rows[0].type, 'schedule_archived');

      const after = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.ok(!after.available.some((a) => a.doctor === 'Dr. Booked'), 'archived → never offered');

      // …and the booking WRITE refuses them too, naming who is available instead.
      const book = await appointmentService.bookAppointment(
        ownerA.tenantId, cust.rows[0].id, 'Dr. Booked', `${monday}T12:00:00+05:30`, 'Patient');
      assert.equal(book.success, false);
      assert.equal(book.reason, 'doctor_not_found');

      // Restore puts them back in front of patients.
      const restored = await req(server, { method: 'POST', path: `/portal/api/doctors/${id}/restore`, cookie });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.doctor.archived, false);
      const back = await appointmentService.checkAvailability(ownerA.tenantId, monday);
      assert.ok(back.available.some((a) => a.doctor === 'Dr. Booked'), 'offered again');

      await req(server, { method: 'DELETE', path: `/portal/api/doctors/${id}`, cookie }); // re-archive
    } finally { server.close(); }
  });

  // ── Readiness ───────────────────────────────────────────────────────────────
  it('the doctor.schedule readiness check flips as doctors come and go', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerB.email, ownerB.password);

      // B starts bare — no doctors at all.
      let check = await doctorCheck(ownerB.tenantId);
      assert.equal(check.severity, 'fail');
      assert.match(check.detail, /no doctor schedules configured/);

      const created = await req(server, { method: 'POST', path: '/portal/api/doctors', cookie, body: VALID });
      assert.equal(created.status, 200);

      check = await doctorCheck(ownerB.tenantId);
      assert.equal(check.severity, 'pass', 'adding a doctor with hours turns the check green');
      assert.match(check.detail, /1 doctor\(s\) with weekly hours/);

      // Archiving the only doctor takes the clinic back to unbookable.
      await req(server, { method: 'DELETE', path: `/portal/api/doctors/${created.body.doctor.id}`, cookie });
      check = await doctorCheck(ownerB.tenantId);
      assert.equal(check.severity, 'fail', 'the last doctor leaving fails the check again');

      await clearDoctors(ownerB.tenantId);
    } finally { server.close(); }
  });

  it('doctor.schedule is appended to the catalog; the frozen names are unchanged', () => {
    assert.deepEqual(validationService.CHECK_NAMES, [
      'config.exists', 'config.schema', 'prompt.renders', 'hours.sane', 'numbers.e164',
      'consent.lines', 'kb.populated', 'kb.retrieval', 'whatsapp.config', 'whatsapp.live',
      'voice.config', 'tenant.legacy_prompt', 'doctor.schedule', 'turn.scripted',
    ]);
  });

  it('doctor.schedule skips when the tenant does not book at all', async () => {
    const noBooking = await seedOwner({
      tenantName: 'No Booking Clinic', email: 'nb@nobooking.test', password: 'nb-pass-9' });
    await configService.writeTenantConfig(noBooking.tenantId, { tools: { booking: false } }, 'cli');
    const run = await validationService.validateTenant(noBooking.tenantId, {
      skip: ['turn.scripted', 'whatsapp.live', 'kb.populated', 'kb.retrieval'],
      deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' },
    });
    const skipped = run.skipped.find((s) => s.name === 'doctor.schedule');
    assert.ok(skipped, 'a clinic that does not book does not need doctors');
    assert.equal(skipped.reason, 'tools.booking is false');
  });

  // ── Validation → 4xx, no write ──────────────────────────────────────────────
  it('a missing name → 400 with no write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = (await rawSchedules(ownerA.tenantId)).length;
      const res = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie, body: { ...VALID, name: '   ' },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'name'));
      assert.equal((await rawSchedules(ownerA.tenantId)).length, before, 'nothing written');
    } finally { server.close(); }
  });

  it('end at or before start → 400 with no write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = (await rawSchedules(ownerA.tenantId)).length;
      for (const body of [{ ...VALID, name: 'Dr. Backwards', start: '17:00', end: '10:00' },
                          { ...VALID, name: 'Dr. Zero', start: '10:00', end: '10:00' }]) {
        const res = await req(server, { method: 'POST', path: '/portal/api/doctors', cookie, body });
        assert.equal(res.status, 400);
        assert.ok(res.body.fields.some((f) => f.field === 'hours'));
      }
      assert.equal((await rawSchedules(ownerA.tenantId)).length, before, 'nothing written');
    } finally { server.close(); }
  });

  it('a duplicate doctor name → 400 with a clear message and no write', async () => {
    // Booking resolves a doctor by NAME (appointments carry no doctor id), so two
    // active doctors sharing one would make bookAppointment's .find() arbitrary.
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = (await rawSchedules(ownerA.tenantId)).length;
      const res = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie, body: { ...VALID, name: 'dr. sharma' },
      });
      assert.equal(res.status, 400, 'case-insensitive — "dr. sharma" is the same person');
      assert.match(res.body.fields[0].message, /already have a doctor with this name/);
      assert.equal((await rawSchedules(ownerA.tenantId)).length, before, 'nothing written');
    } finally { server.close(); }
  });

  it('an unknown day token → 400 with no write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = (await rawSchedules(ownerA.tenantId)).length;
      const res = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie,
        body: { ...VALID, name: 'Dr. Bogus', days: ['Mon', 'Funday'] },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'days'));
      assert.equal((await rawSchedules(ownerA.tenantId)).length, before, 'nothing written');
    } finally { server.close(); }
  });

  it('PATCH of an unknown id → 404', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'PATCH', path: `/portal/api/doctors/${crypto.randomUUID()}`, cookie, body: VALID });
      assert.equal(res.status, 404);
    } finally { server.close(); }
  });

  it('a malformed id is treated as unknown, not a 500', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'DELETE', path: '/portal/api/doctors/not-a-uuid', cookie });
      assert.equal(res.status, 404);
    } finally { server.close(); }
  });

  // ── INV-1: cross-tenant (mandatory) ─────────────────────────────────────────
  it('READ is scoped to the session tenant; a crafted tenantId is inert (INV-1)', async () => {
    const server = await start();
    try {
      // Give B a doctor of its own, so a leak would be unmistakable.
      const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
      await req(server, { method: 'POST', path: '/portal/api/doctors', cookie: cookieB,
        body: { ...VALID, name: 'Dr. BravoOnly' } });

      const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'GET', path: `/portal/api/doctors?tenantId=${ownerB.tenantId}`, cookie: cookieA });
      assert.equal(res.status, 200);
      assert.ok(!res.body.doctors.some((d) => d.name === 'Dr. BravoOnly'),
        'A sees only its own doctors, never B’s');
    } finally { server.close(); }
  });

  it('owner A cannot read, edit, or delete tenant B’s doctor by id (INV-1)', async () => {
    const server = await start();
    try {
      const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
      const bDoctor = (await rawSchedules(ownerB.tenantId))[0];
      assert.ok(bDoctor, 'B has a doctor to attack');

      // Every verb, with B's REAL id in the path, from A's session.
      const patch = await req(server, {
        method: 'PATCH', path: `/portal/api/doctors/${bDoctor.id}`, cookie: cookieA,
        body: { ...VALID, name: 'Hijacked' } });
      assert.equal(patch.status, 404, 'another tenant’s doctor simply does not exist');

      const del = await req(server, {
        method: 'DELETE', path: `/portal/api/doctors/${bDoctor.id}`, cookie: cookieA });
      assert.equal(del.status, 404);

      const restore = await req(server, {
        method: 'POST', path: `/portal/api/doctors/${bDoctor.id}/restore`, cookie: cookieA });
      assert.equal(restore.status, 404);

      // B's row is byte-identical and still active.
      const after = (await rawSchedules(ownerB.tenantId))[0];
      assert.equal(after.type, 'schedule');
      assert.deepEqual(after.data, bDoctor.data, 'B’s doctor is completely untouched');
    } finally { server.close(); }
  });

  it('a crafted tenantId in the body cannot redirect a write (INV-1)', async () => {
    const server = await start();
    try {
      const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
      const bBefore = await rawSchedules(ownerB.tenantId);

      const res = await req(server, {
        method: 'POST', path: '/portal/api/doctors', cookie: cookieA,
        body: { ...VALID, name: 'Dr. Injected', tenantId: ownerB.tenantId, tenant_id: ownerB.tenantId },
      });
      assert.equal(res.status, 200);

      // The doctor landed on A, the session tenant — B is unchanged.
      const aRows = await rawSchedules(ownerA.tenantId);
      assert.ok(aRows.some((r) => r.data.doctor === 'Dr. Injected'), 'written to the SESSION tenant');
      const bAfter = await rawSchedules(ownerB.tenantId);
      assert.equal(bAfter.length, bBefore.length, 'B gained nothing');
      assert.ok(!bAfter.some((r) => r.data.doctor === 'Dr. Injected'));

      await req(server, { method: 'DELETE', path: `/portal/api/doctors/${res.body.doctor.id}`, cookie: cookieA });
    } finally { server.close(); }
  });
});
