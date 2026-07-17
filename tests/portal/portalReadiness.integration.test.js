'use strict';

// Route-level tests for GET /portal/api/readiness (PORTAL-P1-S2). Exercises the
// real /portal router over HTTP against a throwaway scratch DB (same genesis
// pattern as portalAuth.integration.test.js). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_prdy_) — NOT zyon_test_ (swept by configService/
// tenantDetail) and NOT zyon_pauth_ (the S1 auth test's prefix). Our sweep
// escapes the underscores so it only ever targets our own prefix; the readiness
// and auth suites can run in parallel without dropping each other's scratch DB.
//
// The endpoint only READS the latest validation_runs row, so the test seeds that
// row directly (INSERT) rather than running validateTenant — deterministic, and
// it never touches the embedding API. What we assert is the endpoint's contract:
// tenant scope (INV-1), the owner-safe projection (name+severity only, no
// operator `detail`), lifecycle status pass-through, and the empty state.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_prdy_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_prdy\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror portalAuth.integration.test.js) ─────────────────────
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
        let json;
        try { json = JSON.parse(data); } catch (_) { json = null; }
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

// A representative stored run: passes + fails + a warn (advisory) + skipped, each
// check carrying an operator `detail` string the owner endpoint must strip.
const RUN_B = {
  checks: [
    { name: 'config.exists', severity: 'pass', passed: true, detail: 'tenant_configs row present' },
    { name: 'hours.sane', severity: 'pass', passed: true, detail: '3 open day(s), all intervals valid' },
    { name: 'numbers.e164', severity: 'fail', passed: false, detail: 'at least one owner notification number is required' },
    { name: 'kb.populated', severity: 'fail', passed: false, detail: 'only 0 knowledge chunk(s); need >= 5' },
    { name: 'whatsapp.config', severity: 'fail', passed: false, detail: 'WhatsApp enabled but missing: phone_number_id' },
    { name: 'tenant.legacy_prompt', severity: 'warn', passed: true, detail: 'legacy ai_prompt is set' },
  ],
  skipped: [
    { name: 'voice.config', reason: 'voice.enabled is false' },
    { name: 'turn.scripted', reason: 'tools.booking is false' },
  ],
  duration_ms: 42,
  service_version: '1.0.0',
};

describe('portal readiness (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, ownerA, ownerB;

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

    // Tenant A: draft, NO validation run (empty-state path).
    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    // Tenant B: validated, WITH a stored run.
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    await db.query("UPDATE tenants SET status='validated' WHERE id=$1", [ownerB.tenantId]);
    await db.query('INSERT INTO validation_runs (tenant_id, passed, result) VALUES ($1,$2,$3)',
      [ownerB.tenantId, false, JSON.stringify(RUN_B)]);
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

  async function seedOwner({ tenantName, email, password, role = 'owner' }) {
    const t = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [tenantName]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), role]);
    return { tenantId, userId: u.rows[0].id, tenantName, email, password };
  }

  it('unauthenticated /api/readiness → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/readiness' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Unauthorized');
    } finally { server.close(); }
  });

  it('empty state: a tenant with no validation run → status draft, run null', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.run, null, 'no run yet → run is null (empty-state)');
    } finally { server.close(); }
  });

  it('returns the latest run with lifecycle status; projection is name+severity only (no operator detail)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerB.email, ownerB.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'validated');
      assert.ok(res.body.run, 'expected a run');
      assert.equal(res.body.run.passed, false);
      assert.ok(Array.isArray(res.body.run.checks));
      assert.equal(res.body.run.checks.length, RUN_B.checks.length);

      // Owner-safe projection: each check has EXACTLY name + severity — the
      // operator `detail`/`passed` fields must never cross the wire.
      for (const c of res.body.run.checks) {
        assert.deepEqual(Object.keys(c).sort(), ['name', 'severity']);
        assert.equal(c.detail, undefined, 'detail must be stripped');
      }
      const numbers = res.body.run.checks.find((c) => c.name === 'numbers.e164');
      assert.equal(numbers.severity, 'fail');

      // Skipped: names only, no reason string.
      assert.deepEqual(res.body.run.skipped.map((s) => s.name).sort(), ['turn.scripted', 'voice.config']);
      for (const s of res.body.run.skipped) {
        assert.deepEqual(Object.keys(s), ['name']);
      }
    } finally { server.close(); }
  });

  // ── INV-1: cross-tenant negative (mandatory) ───────────────────────────────
  it('owner A never sees tenant B’s run; an injected tenant id is inert (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);

      // Query injection of B's id — must be ignored; A still has no run.
      const q = await req(server, { method: 'GET', path: `/portal/api/readiness?tenantId=${ownerB.tenantId}`, cookie });
      assert.equal(q.status, 200);
      assert.equal(q.body.status, 'draft', 'A is draft, not B’s validated');
      assert.equal(q.body.run, null, 'query tenantId must not surface B’s run');

      // Header injection.
      const h = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie, headers: { 'X-Tenant-Id': ownerB.tenantId } });
      assert.equal(h.body.status, 'draft');
      assert.equal(h.body.run, null);

      // Body injection.
      const b = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie, body: { tenantId: ownerB.tenantId } });
      assert.equal(b.body.status, 'draft');
      assert.equal(b.body.run, null);
    } finally { server.close(); }
  });
});
