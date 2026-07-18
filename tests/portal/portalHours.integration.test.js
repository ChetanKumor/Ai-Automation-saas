'use strict';

// Route-level tests for GET/POST /portal/api/config/hours (PORTAL-P2-S5) — the
// second owner-writable config surface. Exercises the real /portal router over
// HTTP against a throwaway scratch DB (same genesis pattern as portalIdentity).
// Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_phrs_) so it runs in parallel with the other
// portal suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • a valid save goes THROUGH configService (new version + revision recording
//     the acting owner, INV-4) and invalidates the cache (a re-read shows it),
//   • the discriminated-union write works BOTH ways — closing a default-open day
//     and opening the default-closed Sunday — without polluting the schema
//     (this is the S5 write-path catch; without the configService fix these 422),
//   • close ≤ open → 400 no write; duplicate holiday date → 400 no write,
//   • READ-MERGE REGRESSION (the S4 catch): saving hours leaves identity untouched,
//   • tenant scope (INV-1): a crafted tenantId in query/body is inert on read AND
//     write,
//   • save → readiness: after a valid save + a validation run, hours.sane passes;
//     an all-closed week fails it.

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
const PREFIX = 'zyon_phrs_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_phrs\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror portalIdentity) ─────────────────────────────────────
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

// A full, valid 7-day payload the tests start from (mon–sat open, sun closed).
function baseDays() {
  return {
    mon: { closed: false, open: '09:00', close: '18:00' },
    tue: { closed: false, open: '09:00', close: '18:00' },
    wed: { closed: false, open: '09:00', close: '18:00' },
    thu: { closed: false, open: '09:00', close: '18:00' },
    fri: { closed: false, open: '09:00', close: '18:00' },
    sat: { closed: false, open: '09:00', close: '14:00' },
    sun: { closed: true },
  };
}

describe('portal hours & holidays — hours config (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, validationService;
  let ownerA, ownerB, ownerC;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
    validationService = require('../../src/modules/validation/validationService');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    ownerC = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });

    // A carries REAL identity so the read-merge regression has something to protect.
    await configService.writeTenantConfig(ownerA.tenantId, {
      business: { display_name: 'Alpha Dental', address: '9 Park Rd', phone_numbers: ['+919876500000'] },
      languages: { supported: ['te', 'en'], default: 'te' },
    }, 'cli');
    // B is the cross-tenant victim, given a DISTINCT closed-Saturday so any leak shows.
    await configService.writeTenantConfig(ownerB.tenantId, {
      hours: { ...baseDaysStored(), sat: { closed: true } },
    }, 'cli');
    await configService.writeTenantConfig(ownerC.tenantId, {}, 'cli');
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

  // Stored day-shapes (no owner-facing `closed:false`) for seeding via configService.
  function baseDaysStored() {
    return {
      mon: { open: '09:00', close: '18:00' }, tue: { open: '09:00', close: '18:00' },
      wed: { open: '09:00', close: '18:00' }, thu: { open: '09:00', close: '18:00' },
      fri: { open: '09:00', close: '18:00' }, sat: { open: '09:00', close: '14:00' },
      sun: { closed: true }, holidays: [],
    };
  }
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

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/config/hours' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const before = await versionOf(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/config/hours', body: { days: baseDays(), holidays: [] } });
      assert.equal(res.status, 401);
      assert.equal(await versionOf(ownerA.tenantId), before, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns the session tenant’s hours (seeded defaults)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/config/hours', cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.hours.days.length, 7);
      const mon = res.body.hours.days.find((d) => d.key === 'mon');
      const sun = res.body.hours.days.find((d) => d.key === 'sun');
      assert.equal(mon.closed, false);
      assert.equal(mon.open, '09:00');
      assert.equal(sun.closed, true, 'Sunday is closed in the defaults');
      assert.deepEqual(res.body.hours.holidays, []);
      assert.equal(res.body.version, 1);
    } finally { server.close(); }
  });

  // ── Happy path: the discriminated-union write, BOTH directions ───────────────
  it('POST closing a default-open day + opening Sunday + a holiday → new version, revision actor, cache invalidated, readiness returned', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const days = baseDays();
      days.mon = { closed: true };                         // close a normally-open day
      days.sun = { closed: false, open: '10:00', close: '13:00' }; // open the normally-closed day
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days, holidays: [{ date: '2026-01-26', name: 'Republic Day' }] },
      });
      assert.equal(res.status, 200, 'branch-switch write must not 422');
      assert.equal(res.body.version, 2, 'version bumped 1 → 2');

      const secMon = res.body.section.days.find((d) => d.key === 'mon');
      const secSun = res.body.section.days.find((d) => d.key === 'sun');
      assert.equal(secMon.closed, true, 'Monday saved closed');
      assert.equal(secSun.closed, false, 'Sunday saved open');
      assert.equal(secSun.open, '10:00');
      assert.deepEqual(res.body.section.holidays, [{ date: '2026-01-26', name: 'Republic Day' }]);
      assert.ok(res.body.readiness && 'status' in res.body.readiness, 'readiness snapshot returned');

      // INV-4: revision attributed to the acting owner, source 'portal'.
      const rev = await latestRevision(ownerA.tenantId);
      assert.equal(rev.version, 2);
      assert.equal(rev.source, 'portal');
      assert.equal(rev.actor_user_id, ownerA.userId);

      // Stored doc has clean union members (no polluted {open,close,closed:true}).
      const cfg = await configService.getTenantConfig(ownerA.tenantId);
      assert.deepEqual(cfg.hours.mon, { closed: true });
      assert.deepEqual(cfg.hours.sun, { open: '10:00', close: '13:00' });

      // Cache invalidated → a fresh GET reflects it.
      const get = await req(server, { method: 'GET', path: '/portal/api/config/hours', cookie });
      assert.equal(get.body.version, 2);
      assert.equal(get.body.hours.days.find((d) => d.key === 'mon').closed, true);
    } finally { server.close(); }
  });

  // ── READ-MERGE REGRESSION (mandatory — the S4 catch) ─────────────────────────
  it('saving hours leaves the identity section UNTOUCHED (read-merge)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days: baseDays(), holidays: [] },
      });
      assert.equal(res.status, 200);

      const cfg = await configService.getTenantConfig(ownerA.tenantId);
      assert.equal(cfg.business.display_name, 'Alpha Dental', 'identity name survives the hours write');
      assert.equal(cfg.business.address, '9 Park Rd', 'identity address survives');
      assert.deepEqual(cfg.business.phone_numbers, ['+919876500000'], 'identity phones survive');
      assert.deepEqual(cfg.languages.supported.slice().sort(), ['en', 'te'], 'enabled languages survive');
    } finally { server.close(); }
  });

  // ── Validation: 400 + NO write ──────────────────────────────────────────────
  it('close ≤ open → 400 with a day error and NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const days = baseDays();
      days.wed = { closed: false, open: '18:00', close: '09:00' };
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days, holidays: [] },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'days.wed'), 'the offending day is named');
      assert.equal(await versionOf(ownerC.tenantId), before, 'invalid interval writes nothing');
    } finally { server.close(); }
  });

  it('duplicate holiday date → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days: baseDays(), holidays: [{ date: '2026-08-15', name: 'A' }, { date: '2026-08-15', name: 'B' }] },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'holidays.1'), 'the duplicate row is named');
      assert.equal(await versionOf(ownerC.tenantId), before, 'duplicate holiday writes nothing');
    } finally { server.close(); }
  });

  it('malformed holiday date → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days: baseDays(), holidays: [{ date: '2026-13-45', name: 'Nope' }] },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'holidays.0'));
      assert.equal(await versionOf(ownerC.tenantId), before);
    } finally { server.close(); }
  });

  it('past-dated holiday is allowed (saves, not an error)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days: baseDays(), holidays: [{ date: '2020-01-01', name: 'Old holiday' }] },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.version, before + 1);
      assert.deepEqual(res.body.section.holidays, [{ date: '2020-01-01', name: 'Old holiday' }]);
    } finally { server.close(); }
  });

  // ── save → readiness (hours.sane) ────────────────────────────────────────────
  it('after a valid save + validation run, hours.sane passes; an all-closed week fails it', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);

      // Valid week → hours.sane passes.
      await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days: baseDays(), holidays: [] },
      });
      let run = await validationService.validateTenant(ownerC.tenantId, { skip: ['turn.scripted'], deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' } });
      let hoursCheck = run.checks.find((c) => c.name === 'hours.sane');
      assert.equal(hoursCheck.severity, 'pass', 'a valid week passes hours.sane');

      // All days closed (schema-valid, but zero open days) → hours.sane fails.
      const allClosed = {};
      for (const k of Object.keys(baseDays())) allClosed[k] = { closed: true };
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { days: allClosed, holidays: [] },
      });
      assert.equal(res.status, 200, 'an all-closed week is a permissible save (readiness gates it, not the write)');
      run = await validationService.validateTenant(ownerC.tenantId, { skip: ['turn.scripted'], deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' } });
      hoursCheck = run.checks.find((c) => c.name === 'hours.sane');
      assert.equal(hoursCheck.severity, 'fail', 'zero open days fails hours.sane');
    } finally { server.close(); }
  });

  // ── INV-1: cross-tenant (mandatory) ─────────────────────────────────────────
  it('READ is scoped to the session tenant; a crafted tenantId is inert (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      // B has Saturday CLOSED; A has Saturday OPEN. A query-injection of B's id must
      // never surface B's Saturday.
      const q = await req(server, { method: 'GET', path: `/portal/api/config/hours?tenantId=${ownerB.tenantId}`, cookie });
      assert.equal(q.status, 200);
      assert.equal(q.body.hours.days.find((d) => d.key === 'sat').closed, false, 'A sees its own Saturday (open), never B’s');
    } finally { server.close(); }
  });

  it('WRITE is scoped to the session tenant; a crafted tenantId in the body cannot touch another tenant (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const bBefore = await versionOf(ownerB.tenantId);
      const bCfgBefore = await configService.getTenantConfig(ownerB.tenantId);

      const days = baseDays();
      days.fri = { closed: true };
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/hours', cookie,
        body: { tenantId: ownerB.tenantId, days, holidays: [] },
      });
      assert.equal(res.status, 200);
      // The write landed on A (the session tenant), not B.
      assert.equal(res.body.section.days.find((d) => d.key === 'fri').closed, true);
      const revA = await latestRevision(ownerA.tenantId);
      assert.equal(revA.actor_user_id, ownerA.userId);

      // B is completely untouched.
      assert.equal(await versionOf(ownerB.tenantId), bBefore, 'B’s version is unchanged');
      const bCfgAfter = await configService.getTenantConfig(ownerB.tenantId);
      assert.deepEqual(bCfgAfter.hours, bCfgBefore.hours, 'B’s hours are unchanged');
    } finally { server.close(); }
  });
});
