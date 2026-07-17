'use strict';

// Route-level tests for the portal owner-auth API (PORTAL-P1-S1). Exercises the
// real /portal routes over HTTP against a throwaway scratch DB (same genesis
// pattern as tenantDetail.test.js). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pauth_) — deliberately NOT starting with
// `zyon_test_`, which tenantDetail.test.js / configService sweep as `zyon_test_%`
// and would otherwise drop our scratch DB mid-run. Our own sweep escapes the
// underscores so it only ever targets our prefix.

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
const PREFIX = 'zyon_pauth_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pauth\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror adminSecurity.test.js) ──────────────────────────────
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
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], body: json, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
// Portal session cookie (distinct from the admin connect.sid).
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('portal.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

// Fresh app per test → fresh in-memory limiter buckets + session store, so the
// 5/15min login cap in one test never bleeds into another. The scratch DB and
// seeded rows are shared (built once in before()); only the router is rebuilt.
function buildPortalApp() {
  const express = require('express');
  const app = express();
  delete require.cache[require.resolve('../../src/portal/routes')];
  app.use('/portal', require('../../src/portal/routes'));
  return app;
}
async function start() { return listen(buildPortalApp()); }
function login(server, email, password, cookie) {
  return req(server, { method: 'POST', path: '/portal/api/login', body: { email, password }, cookie });
}

describe('portal owner auth (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
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

    // Bind db (and everything requiring it, incl. the portal router) to scratch
    // BEFORE first require.
    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
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
      `INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [tenantId, email, hashPassword(password), role]);
    return { tenantId, userId: u.rows[0].id, tenantName, email, password };
  }

  // ── Unauthenticated ──────────────────────────────────────────────────────
  it('unauthenticated /me → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/me' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Unauthorized');
    } finally { server.close(); }
  });

  // ── Login success + session works ────────────────────────────────────────
  it('login success sets a portal.sid cookie; /me returns the owner + their tenant', async () => {
    const server = await start();
    try {
      const res = await login(server, ownerA.email, ownerA.password);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const cookie = sid(res.setCookie);
      assert.ok(cookie, 'expected a portal.sid session cookie');
      const raw = res.setCookie.find((s) => s.startsWith('portal.sid='));
      assert.match(raw, /HttpOnly/i);
      assert.match(raw, /SameSite=Strict/i);
      assert.ok(!/Secure/i.test(raw), 'Secure must be off in dev');

      const me = await req(server, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.id, ownerA.userId);
      assert.equal(me.body.user.role, 'owner');
      assert.equal(me.body.tenant.id, ownerA.tenantId);
      assert.equal(me.body.tenant.name, 'Alpha Clinic');
    } finally { server.close(); }
  });

  it('login regenerates the session id (fixation defense)', async () => {
    const server = await start();
    try {
      const first = await login(server, ownerA.email, ownerA.password);
      const sidA = sid(first.setCookie);
      assert.ok(sidA);
      const second = await login(server, ownerA.email, ownerA.password, sidA);
      const sidB = sid(second.setCookie);
      assert.ok(sidB, 'regeneration should emit a new Set-Cookie');
      assert.notEqual(sidA, sidB, 'session id must change across login');
    } finally { server.close(); }
  });

  it('records last_login_at on a successful login', async () => {
    const server = await start();
    try {
      const before = (await db.query('SELECT last_login_at FROM users WHERE id=$1', [ownerB.userId])).rows[0].last_login_at;
      assert.equal(before, null, 'seeded owner starts with no last_login_at');

      const res = await login(server, ownerB.email, ownerB.password);
      assert.equal(res.status, 200);

      // Stamp is fire-and-forget; poll briefly for it to land.
      let stamped = null;
      for (let i = 0; i < 20 && stamped == null; i++) {
        stamped = (await db.query('SELECT last_login_at FROM users WHERE id=$1', [ownerB.userId])).rows[0].last_login_at;
        if (stamped == null) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(stamped != null, 'last_login_at should be set after login');
    } finally { server.close(); }
  });

  // ── Login failures: generic, no oracle, no cookie ────────────────────────
  it('wrong password → 401 generic, sets no session cookie', async () => {
    const server = await start();
    try {
      const res = await login(server, ownerA.email, 'not-the-password');
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid credentials');
      assert.equal(sid(res.setCookie), null, 'no session cookie on failure');
    } finally { server.close(); }
  });

  it('unknown email → 401 with the SAME generic message (no user-existence oracle)', async () => {
    const server = await start();
    try {
      const res = await login(server, 'nobody@nowhere.test', 'whatever');
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid credentials');
    } finally { server.close(); }
  });

  it('login rate limit trips on the 6th attempt in the window', async () => {
    const server = await start();
    try {
      let last;
      for (let i = 0; i < 6; i++) {
        last = await login(server, ownerA.email, 'wrong-on-purpose');
      }
      assert.equal(last.status, 429);
      assert.ok(last.headers['retry-after'], 'expected Retry-After header');
    } finally { server.close(); }
  });

  // ── Logout ───────────────────────────────────────────────────────────────
  it('logout destroys the session → /me returns 401', async () => {
    const server = await start();
    try {
      const cookie = sid((await login(server, ownerA.email, ownerA.password)).setCookie);
      assert.ok(cookie);
      const out = await req(server, { method: 'POST', path: '/portal/api/logout', cookie });
      assert.equal(out.status, 200);
      const me = await req(server, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(me.status, 401);
    } finally { server.close(); }
  });

  // ── INV-1: cross-tenant negative (mandatory) ─────────────────────────────
  it('owner A sees ONLY tenant A; a tenant id in query/header/body is inert (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = sid((await login(server, ownerA.email, ownerA.password)).setCookie);
      assert.ok(cookie);

      const plain = await req(server, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(plain.body.tenant.id, ownerA.tenantId);

      // Query injection of tenant B's id — must be ignored.
      const q = await req(server, { method: 'GET', path: `/portal/api/me?tenantId=${ownerB.tenantId}`, cookie });
      assert.equal(q.status, 200);
      assert.equal(q.body.tenant.id, ownerA.tenantId, 'query tenantId must not override session scope');
      assert.notEqual(q.body.tenant.id, ownerB.tenantId);

      // Header injection — must be ignored.
      const h = await req(server, { method: 'GET', path: '/portal/api/me', cookie, headers: { 'X-Tenant-Id': ownerB.tenantId } });
      assert.equal(h.body.tenant.id, ownerA.tenantId, 'header tenant id must not override session scope');

      // Body injection on the request — must be ignored (no parser, never read).
      const b = await req(server, { method: 'GET', path: '/portal/api/me', cookie, body: { tenantId: ownerB.tenantId } });
      assert.equal(b.body.tenant.id, ownerA.tenantId, 'body tenant id must not override session scope');
    } finally { server.close(); }
  });

  it('owner B sees ONLY tenant B (scope is per-account)', async () => {
    const server = await start();
    try {
      const cookie = sid((await login(server, ownerB.email, ownerB.password)).setCookie);
      const me = await req(server, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(me.body.tenant.id, ownerB.tenantId);
      assert.equal(me.body.tenant.name, 'Bravo Clinic');
      assert.notEqual(me.body.tenant.id, ownerA.tenantId);
    } finally { server.close(); }
  });

  it('two owners sharing an email across tenants → login fails closed (INV-1)', async () => {
    // email is unique only per tenant; a cross-tenant collision is ambiguous, so
    // login must refuse rather than guess a tenant.
    const dupEmail = 'dup@collision.test';
    const dupPass = 'shared-pass-9';
    await seedOwner({ tenantName: 'Collide One', email: dupEmail, password: dupPass });
    await seedOwner({ tenantName: 'Collide Two', email: dupEmail, password: dupPass });

    const server = await start();
    try {
      const res = await login(server, dupEmail, dupPass);
      assert.equal(res.status, 401, 'ambiguous email must not authenticate');
      assert.equal(sid(res.setCookie), null);
    } finally { server.close(); }
  });

  // ── Security headers parity with admin ───────────────────────────────────
  it('portal responses carry the admin-parity security headers', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/me' }); // 401, still headered
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    } finally { server.close(); }
  });
});
