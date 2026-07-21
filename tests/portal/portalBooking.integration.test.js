'use strict';

// Route-level tests for GET/POST /portal/api/config/booking (PORTAL-P3-S9) — the
// fourth owner-writable config surface. Exercises the real /portal router over
// HTTP against a throwaway scratch DB (same genesis pattern as the other portal
// tests). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pbkg_) so it can run in parallel with the auth /
// readiness / identity / hours / pricing / doctors suites without dropping their
// scratch DBs.
//
// What we assert is the route's contract:
//   • write goes THROUGH configService (new version + revision recording the
//     acting owner, INV-4) and invalidates the cache (a re-read shows the change),
//   • READ-MERGE: saving booking rules leaves identity, hours AND pricing untouched
//     (the S4 catch — writeTenantConfig materialises against clinicDefaults, not
//     the live document),
//   • every bound whose enforcement meaning is undefined is refused with NO write —
//     `advance_days: 0` especially, which the schema rejects and which
//     resolveBookingRules would silently replace with the default 30,
//   • tenant scope (INV-1): a crafted tenantId in query/body is inert on read AND
//     write,
//   • ENFORCEMENT: what this page saves is what appointmentService actually does.
//     This is the test that matters — it proves the page drives F-006's rules
//     rather than editing a parallel copy of them,
//   • the policy texts flow verbatim into the rendered system prompt, and an
//     unwritten policy renders no block at all (the S6 silence-on-empty precedent).
//
// The config → prompt assertions call renderSystemPrompt(getTenantConfig(id))
// directly, exactly as the pricing suite does.
//
// TIME: the enforcement block runs under a FROZEN clock (node:test Date mocking,
// the F-006 convention) so "today has slots" is an exact assertion rather than a
// race with the wall clock — the same suite run at 23:59 IST would otherwise see
// an empty grid and fail for the wrong reason. Only the appointmentService calls
// are frozen; every HTTP request runs on the real clock so session expiry is
// never computed against a fake now.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pbkg_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pbkg\\_%'");
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

// ── Frozen-clock frame for the enforcement assertions ────────────────────────
// 10:00 IST on Tuesday 2026-07-21 — mid-morning, so "today" still has hours left
// in it and "today has no slots" can only mean a rule refused them.
const NOW_ISO = '2026-07-21T04:30:00Z';
const TODAY = '2026-07-21';
const DAY_40 = '2026-08-30'; // today + 40 days: outside a 30-day window, inside a 60-day one
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
// Run `fn` with Date frozen at NOW_ISO. Only Date is mocked — real timers keep
// running, so pg's sockets and the pool are untouched.
async function atFrozenNow(fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW_ISO).getTime() });
  try { return await fn(); } finally { mock.timers.reset(); }
}

describe('portal booking — booking rules config (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, renderSystemPrompt, appointmentService;
  let ownerA, ownerB, ownerC, ownerD, ownerE;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // db + config + prompts + appointments required only AFTER the env swap so the
    // shared pool binds to the scratch DB (S1 lesson: eager import binds to the
    // wrong DB).
    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
    renderSystemPrompt = require('../../src/modules/prompts').renderSystemPrompt;
    appointmentService = require('../../src/modules/appointment/appointmentService');

    // A: the happy path + read-merge victim. B: the cross-tenant victim, given
    // distinct rules so any leak is obvious. C: the invalid-input tenant — every
    // 400 must leave it at its seeded version. D: the enforcement tenant.
    // E: the odd stored slot length.
    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    ownerC = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });
    ownerD = await seedOwner({ tenantName: 'Delta Clinic', email: 'dan@delta.test', password: 'delta-pass-4' });
    ownerE = await seedOwner({ tenantName: 'Echo Clinic', email: 'eve@echo.test', password: 'echo-pass-5' });

    // Seed A with identity, hours AND pricing already set, so the read-merge
    // regression has real neighbouring sections to lose if the booking write is
    // wrong.
    await configService.writeTenantConfig(ownerA.tenantId, {
      business: { display_name: 'Sunrise Dental', address: '12 MG Road, Hyderabad' },
      hours: { sun: { open: '10:00', close: '13:00' }, holidays: [{ date: '2026-08-15', name: 'Independence Day' }] },
      pricing: { consultation_fee: 500, treatments: [{ name: 'Root canal', price: 4000 }] },
    }, 'cli');
    await configService.writeTenantConfig(ownerB.tenantId, {
      booking: { slot_minutes: 15, advance_days: 7, buffer_minutes: 90, allow_same_day: false },
    }, 'cli');
    await configService.writeTenantConfig(ownerC.tenantId, {}, 'cli');
    await configService.writeTenantConfig(ownerE.tenantId, {
      booking: { slot_minutes: 45 }, // set through the admin JSON editor — outside the page's four choices
    }, 'cli');

    // D is the enforcement fixture: open every day 09:00–18:00 with one doctor
    // working every day, so nothing but the rule under test can remove a slot.
    const allDays = {};
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) allDays[d] = { open: '09:00', close: '18:00' };
    await configService.writeTenantConfig(ownerD.tenantId, {
      hours: { ...allDays, holidays: [] },
      booking: { slot_minutes: 30, advance_days: 30, buffer_minutes: 0, allow_same_day: true },
    }, 'cli');
    await db.query(
      "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, 'schedule', $2)",
      [ownerD.tenantId, JSON.stringify({
        doctor: 'Dr. Rao',
        days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        start: '09:00',
        end: '18:00',
      })]
    );
  });

  after(async () => {
    mock.timers.reset();
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
  async function versionOf(tenantId) {
    const r = await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [tenantId]);
    return r.rows[0] ? r.rows[0].version : 0;
  }
  async function latestRevision(tenantId) {
    const r = await db.query(
      'SELECT version, source, actor_user_id FROM tenant_config_revisions WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',
      [tenantId]);
    return r.rows[0];
  }
  // The exact work the admin prompt-preview endpoint does.
  async function preview(tenantId, channel = 'whatsapp') {
    return renderSystemPrompt(await configService.getTenantConfig(tenantId), { channel });
  }
  // POST as an owner, one login per call — keeps each test independent.
  async function post(owner, body) {
    const server = await start();
    try {
      const cookie = await authedCookie(server, owner.email, owner.password);
      return await req(server, { method: 'POST', path: '/portal/api/config/booking', cookie, body });
    } finally { server.close(); }
  }

  const VALID = {
    slot_minutes: '20',
    advance_days: '45',
    buffer_minutes: '120',
    allow_same_day: false,
    cancellation_policy: 'Please call at least 4 hours before your appointment.',
    reschedule_policy: 'You can move your appointment once, up to a day before, free of charge.',
    walk_in_policy: '',
  };

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/config/booking' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const before = await versionOf(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/config/booking', body: VALID });
      assert.equal(res.status, 401);
      assert.equal(await versionOf(ownerA.tenantId), before, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns the session tenant’s booking rules, defaulted so no control is ever blank', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/config/booking', cookie });
      assert.equal(res.status, 200);
      // These are clinicDefaults — the SAME values resolveBookingRules falls back
      // to, so the form shows what booking is actually doing.
      assert.equal(res.body.booking.slot_minutes, 30);
      assert.equal(res.body.booking.advance_days, 30);
      assert.equal(res.body.booking.buffer_minutes, 0);
      assert.equal(res.body.booking.allow_same_day, true);
      assert.equal(res.body.booking.cancellation_policy, '');
      assert.equal(res.body.booking.reschedule_policy, '');
      assert.equal(res.body.booking.walk_in_policy, '');
      assert.equal(res.body.version, 1);
    } finally { server.close(); }
  });

  it('a clinic with no policies written renders NO policy block in its prompt', async () => {
    const prompt = await preview(ownerC.tenantId);
    assert.ok(!prompt.includes('Appointment policies'),
      'nothing written → no block, so the "I’ll check with the clinic" fallback stands');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('POST valid rules → new version, revision records the acting owner, cache invalidated, readiness returned', async () => {
    const before = await versionOf(ownerA.tenantId);
    const res = await post(ownerA, VALID);

    assert.equal(res.status, 200);
    assert.equal(res.body.version, before + 1, 'version bumped');
    assert.equal(res.body.section.slot_minutes, 20, 'string input stored as an integer');
    assert.equal(res.body.section.advance_days, 45);
    assert.equal(res.body.section.buffer_minutes, 120);
    assert.equal(res.body.section.allow_same_day, false);
    assert.equal(res.body.section.cancellation_policy, VALID.cancellation_policy);
    assert.ok(res.body.readiness, 'readiness snapshot returned for the header/ring');
    assert.ok('status' in res.body.readiness);

    // INV-4: the revision is attributed to the acting owner, source 'portal'.
    const rev = await latestRevision(ownerA.tenantId);
    assert.equal(rev.version, res.body.version);
    assert.equal(rev.source, 'portal');
    assert.equal(rev.actor_user_id, ownerA.userId);

    // Cache invalidated → a fresh GET shows the new values.
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const get = await req(server, { method: 'GET', path: '/portal/api/config/booking', cookie });
      assert.equal(get.body.booking.advance_days, 45);
      assert.equal(get.body.version, res.body.version);
    } finally { server.close(); }
  });

  // ── READ-MERGE regression (mandatory) ───────────────────────────────────────
  it('saving booking rules leaves identity, hours and pricing completely unchanged (read-merge)', async () => {
    // writeTenantConfig materialises against clinicDefaults, NOT the live document
    // (the S4 catch). A booking write that forgot to read-merge would silently
    // reset the clinic's name, its Sunday hours, its holidays and its price list.
    const cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.business.display_name, 'Sunrise Dental', 'identity survives a booking write');
    assert.equal(cfg.business.address, '12 MG Road, Hyderabad');
    assert.deepEqual(cfg.hours.sun, { open: '10:00', close: '13:00' }, 'a non-default Sunday survives');
    assert.equal(cfg.hours.holidays.length, 1, 'holidays survive');
    assert.equal(cfg.hours.holidays[0].name, 'Independence Day');
    assert.equal(cfg.pricing.consultation_fee, 500, 'prices survive');
    assert.equal(cfg.pricing.treatments.length, 1);
    assert.equal(cfg.pricing.treatments[0].name, 'Root canal');
  });

  it('clearing a policy actually clears it (the section is replaced, not key-merged)', async () => {
    const res = await post(ownerA, { ...VALID, cancellation_policy: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.section.cancellation_policy, '', 'a deleted sentence does not survive the merge');
    const cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.booking.cancellation_policy, '');
    assert.equal(cfg.booking.reschedule_policy, VALID.reschedule_policy, 'the untouched policy is still there');
  });

  // ── Bounds ──────────────────────────────────────────────────────────────────
  // Every one of these must be a 400 with NO write: an undefined value that
  // reached storage would be silently replaced by resolveBookingRules' fallback,
  // and the owner would be running rules they never chose.
  const REJECTED = [
    ['advance_days: 0 (no defined meaning — NOT "booking closed")', { advance_days: '0' }, 'advance_days'],
    ['advance_days above the 365 cap', { advance_days: '366' }, 'advance_days'],
    ['advance_days as a non-integer', { advance_days: '1.5' }, 'advance_days'],
    ['advance_days in exponent notation (Number() would read 1e2 as 100)', { advance_days: '1e2' }, 'advance_days'],
    ['advance_days blank', { advance_days: '' }, 'advance_days'],
    ['buffer_minutes above the 240 cap', { buffer_minutes: '241' }, 'buffer_minutes'],
    ['buffer_minutes negative', { buffer_minutes: '-5' }, 'buffer_minutes'],
    ['slot_minutes outside the offered set', { slot_minutes: '25' }, 'slot_minutes'],
    ['slot_minutes zero', { slot_minutes: '0' }, 'slot_minutes'],
    ['allow_same_day as a string instead of a boolean', { allow_same_day: 'false' }, 'allow_same_day'],
    ['a policy containing markup', { cancellation_policy: 'Call us <b>4 hours</b> before.' }, 'cancellation_policy'],
    ['a policy over the 500-character cap', { walk_in_policy: 'x'.repeat(501) }, 'walk_in_policy'],
  ];

  for (const [label, patch, field] of REJECTED) {
    it(`rejects ${label} → 400, no write`, async () => {
      const before = await versionOf(ownerC.tenantId);
      const res = await post(ownerC, { ...VALID, ...patch });
      assert.equal(res.status, 400, label);
      assert.ok(Array.isArray(res.body.fields), 'field-level messages for the form');
      assert.ok(res.body.fields.some((f) => f.field === field), `error names ${field}`);
      assert.equal(await versionOf(ownerC.tenantId), before, 'nothing was written');
    });
  }

  it('buffer_minutes 0 is accepted — it means "book right up to the start time"', async () => {
    const res = await post(ownerC, { ...VALID, buffer_minutes: '0' });
    assert.equal(res.status, 200);
    assert.equal(res.body.section.buffer_minutes, 0);
  });

  it('a stored slot length outside the offered set is accepted unchanged', async () => {
    // Otherwise saving an unrelated field on this page would silently re-grid a
    // 45-minute clinic to 30 — a rule change nobody asked for.
    const res = await post(ownerE, { ...VALID, slot_minutes: '45' });
    assert.equal(res.status, 200);
    assert.equal(res.body.section.slot_minutes, 45);
    // …but changing it still requires one of the four offered lengths.
    const bad = await post(ownerE, { ...VALID, slot_minutes: '50' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.fields.some((f) => f.field === 'slot_minutes'));
  });

  it('a multi-line policy is stored as one line, and the response shows exactly what was stored', async () => {
    const res = await post(ownerC, { ...VALID, walk_in_policy: 'Walk-ins welcome\nbefore 11am.\n\nYou may wait.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.section.walk_in_policy, 'Walk-ins welcome before 11am. You may wait.',
      'the prompt block is one line per policy — the sentence is unchanged, the line breaks are not');
  });

  // ── Cross-tenant (INV-1) ────────────────────────────────────────────────────
  it('a crafted tenantId is inert on read AND write — the session decides the tenant', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const bVersion = await versionOf(ownerB.tenantId);

      const get = await req(server, {
        method: 'GET', path: `/portal/api/config/booking?tenantId=${ownerB.tenantId}`, cookie,
      });
      assert.equal(get.status, 200);
      assert.notEqual(get.body.booking.slot_minutes, 15, 'B’s 15-minute grid never crosses over');
      assert.equal(get.body.booking.advance_days, 45, 'A sees A’s own rules');

      const write = await req(server, {
        method: 'POST', path: '/portal/api/config/booking', cookie,
        body: { ...VALID, tenantId: ownerB.tenantId, tenant_id: ownerB.tenantId, advance_days: '99' },
      });
      assert.equal(write.status, 200);
      assert.equal(await versionOf(ownerB.tenantId), bVersion, 'B was not written');

      const bCfg = await configService.getTenantConfig(ownerB.tenantId);
      assert.equal(bCfg.booking.slot_minutes, 15, 'B’s rules are untouched');
      assert.equal(bCfg.booking.advance_days, 7);
      assert.equal(bCfg.booking.buffer_minutes, 90);
      assert.equal(bCfg.booking.allow_same_day, false);
    } finally { server.close(); }
  });

  // ── ENFORCEMENT (the test that matters) ─────────────────────────────────────
  // Saving through the portal must change what appointmentService offers. If these
  // ever pass while the availability assertions do not, the page is editing a
  // parallel copy of the rules rather than the ones F-006 enforces.
  it('allow_same_day saved through the portal decides whether today is bookable', async () => {
    // Off: today is refused with the structured reason, not "no slots free".
    const off = await post(ownerD, {
      slot_minutes: '30', advance_days: '30', buffer_minutes: '0', allow_same_day: false,
      cancellation_policy: '', reschedule_policy: '', walk_in_policy: '',
    });
    assert.equal(off.status, 200);

    await atFrozenNow(async () => {
      const res = await appointmentService.checkAvailability(ownerD.tenantId, TODAY);
      assert.equal(res.reason, 'same_day_not_allowed', 'the saved rule refuses today');
      assert.equal(res.earliest_date, addDays(TODAY, 1), 'and points at the next bookable day');
      assert.ok(!res.available, 'no slots are offered at all');
    });

    // On: today comes back, with real slots.
    const on = await post(ownerD, {
      slot_minutes: '30', advance_days: '30', buffer_minutes: '0', allow_same_day: true,
      cancellation_policy: '', reschedule_policy: '', walk_in_policy: '',
    });
    assert.equal(on.status, 200);

    await atFrozenNow(async () => {
      const res = await appointmentService.checkAvailability(ownerD.tenantId, TODAY);
      assert.ok(res.available, `today is bookable again (got ${JSON.stringify(res)})`);
      assert.ok(res.available[0].free_slots.length > 0, 'and real slots are offered');
      assert.ok(res.available[0].free_slots.includes('10:00'), 'starting at the frozen now');
    });
  });

  it('advance_days saved through the portal moves the far edge of the window', async () => {
    // 30 days: a date 40 days out is beyond the window.
    await atFrozenNow(async () => {
      const res = await appointmentService.checkAvailability(ownerD.tenantId, DAY_40);
      assert.equal(res.reason, 'beyond_advance_window');
      assert.equal(res.advance_days, 30);
      assert.equal(res.latest_bookable_date, addDays(TODAY, 30));
    });

    const widened = await post(ownerD, {
      slot_minutes: '30', advance_days: '60', buffer_minutes: '0', allow_same_day: true,
      cancellation_policy: '', reschedule_policy: '', walk_in_policy: '',
    });
    assert.equal(widened.status, 200);

    await atFrozenNow(async () => {
      const res = await appointmentService.checkAvailability(ownerD.tenantId, DAY_40);
      assert.ok(res.available, `the same date is now bookable (got ${JSON.stringify(res)})`);
      assert.ok(res.available[0].free_slots.length > 0);
    });
  });

  it('slot_minutes saved through the portal re-grids the offered times', async () => {
    const res = await post(ownerD, {
      slot_minutes: '20', advance_days: '60', buffer_minutes: '0', allow_same_day: true,
      cancellation_policy: '', reschedule_policy: '', walk_in_policy: '',
    });
    assert.equal(res.status, 200);

    await atFrozenNow(async () => {
      const avail = await appointmentService.checkAvailability(ownerD.tenantId, addDays(TODAY, 3));
      assert.ok(avail.available);
      const slots = avail.available[0].free_slots;
      assert.deepEqual(slots.slice(0, 4), ['09:00', '09:20', '09:40', '10:00'], '20-minute grid');
    });
  });

  it('buffer_minutes saved through the portal removes the slots that are too soon', async () => {
    const res = await post(ownerD, {
      slot_minutes: '30', advance_days: '60', buffer_minutes: '120', allow_same_day: true,
      cancellation_policy: '', reschedule_policy: '', walk_in_policy: '',
    });
    assert.equal(res.status, 200);

    await atFrozenNow(async () => {
      const avail = await appointmentService.checkAvailability(ownerD.tenantId, TODAY);
      assert.ok(avail.available);
      const slots = avail.available[0].free_slots;
      // Frozen at 10:00 IST + 2h notice → nothing before 12:00 is offered.
      assert.ok(!slots.includes('11:30'), 'a slot inside the notice window is gone');
      assert.equal(slots[0], '12:00', 'the first offered slot is exactly now + the notice');
    });
  });

  // ── Prompt ──────────────────────────────────────────────────────────────────
  it('policy texts reach the rendered prompt verbatim, on both channels', async () => {
    const res = await post(ownerD, {
      slot_minutes: '30', advance_days: '60', buffer_minutes: '0', allow_same_day: true,
      cancellation_policy: 'Please call at least 4 hours before your appointment.',
      reschedule_policy: '',
      walk_in_policy: 'Walk-ins are welcome before 11am.',
    });
    assert.equal(res.status, 200);

    for (const channel of ['whatsapp', 'voice']) {
      const prompt = await preview(ownerD.tenantId, channel);
      assert.ok(prompt.includes('Appointment policies'), `${channel}: the block renders`);
      assert.ok(prompt.includes('- Cancellations: Please call at least 4 hours before your appointment.'),
        `${channel}: the owner’s sentence is quoted verbatim`);
      assert.ok(prompt.includes('- Walk-ins: Walk-ins are welcome before 11am.'), `${channel}: and so is this one`);
      assert.ok(!prompt.includes('- Rescheduling:'), `${channel}: an unwritten policy renders no line`);
      assert.ok(prompt.includes('do not make up a rule'), `${channel}: the block closes with its own fallback`);
    }
  });

  it('clearing every policy removes the block entirely', async () => {
    const res = await post(ownerD, {
      slot_minutes: '30', advance_days: '60', buffer_minutes: '0', allow_same_day: true,
      cancellation_policy: '', reschedule_policy: '', walk_in_policy: '',
    });
    assert.equal(res.status, 200);
    const prompt = await preview(ownerD.tenantId);
    assert.ok(!prompt.includes('Appointment policies'),
      'an emptied policy set renders no heading — silence, not an empty block');
  });
});
