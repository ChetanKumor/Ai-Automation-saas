'use strict';

// PORTAL-P1-S3 — operator-side "create owner account" + hardening parity.
//
// End-to-end across BOTH surfaces against one throwaway scratch DB: the operator
// creates an owner account through the real admin route, then the owner logs into
// the real /portal with the returned temp password. Also covers the route's
// auth/CSRF/validation guards and the portal security-header regression.
//
// Disjoint DB-name prefix (zyon_own_) — NOT zyon_test_ (swept by tenantDetail /
// configService), NOT zyon_pauth_ / zyon_prdy_ (the other portal suites). Our own
// sweep escapes the underscores so it only ever targets our prefix.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { verifyPassword } = require('../../src/portal/auth');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_own_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_own\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror tenantDetail.test.js / portal suites) ───────────────
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
// Admin mutating call = attach the CSRF header adminFetch adds in the browser.
function mutate(server, opts) {
  return req(server, Object.assign({}, opts, { headers: Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {}) }));
}
function adminSid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
function portalSid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('portal.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

// Fresh portal app per call → fresh in-memory login-limiter buckets, so the 5/15min
// cap never bleeds across tests. Shares the (already scratch-bound) db pool.
function buildPortalApp() {
  const express = require('express');
  const app = express();
  delete require.cache[require.resolve('../../src/portal/routes')];
  app.use('/portal', require('../../src/portal/routes'));
  return app;
}
function portalStart() { return listen(buildPortalApp()); }

describe('operator create-owner + portal hardening (PORTAL-P1-S3)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, adminServer, adminCookie;
  const OLD_PW = process.env.ADMIN_PASSWORD;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind the pooled db module to scratch BEFORE first require; adminRoutes and the
    // portal router both inherit this same pool.
    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use(session({
      secret: 'test-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    delete require.cache[require.resolve('../../src/admin/adminRoutes')];
    app.use('/admin', require('../../src/admin/adminRoutes'));
    adminServer = await listen(app);

    const login = await req(adminServer, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    adminCookie = adminSid(login.setCookie);
    assert.ok(adminCookie, 'expected an authenticated admin session cookie');
  });

  after(async () => {
    if (adminServer) adminServer.close();
    process.env.ADMIN_PASSWORD = OLD_PW;
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  async function newTenant(name = 'Owner Clinic') {
    const { rows } = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [name]);
    return rows[0].id;
  }
  const OWNER = (id) => `/admin/api/tenants/${id}/owner`;

  // ── Auth + CSRF guards ─────────────────────────────────────────────────────
  it('unauthenticated create → 401', async () => {
    const t = await newTenant();
    const res = await mutate(adminServer, { method: 'POST', path: OWNER(t), body: { email: 'a@b.co' } });
    assert.equal(res.status, 401);
  });

  it('missing admin CSRF header → 403', async () => {
    const t = await newTenant();
    const res = await req(adminServer, { method: 'POST', path: OWNER(t), cookie: adminCookie, body: { email: 'a@b.co' } });
    assert.equal(res.status, 403);
  });

  // ── Validation ─────────────────────────────────────────────────────────────
  it('missing / malformed email → 400', async () => {
    const t = await newTenant();
    for (const email of [undefined, '', '   ', 'not-an-email', 'no@domain', 'a b@c.co']) {
      const res = await mutate(adminServer, { method: 'POST', path: OWNER(t), cookie: adminCookie, body: { email } });
      assert.equal(res.status, 400, `expected 400 for email=${JSON.stringify(email)}`);
    }
  });

  it('absent (well-formed) tenant id → 404', async () => {
    const res = await mutate(adminServer, {
      method: 'POST', path: '/admin/api/tenants/00000000-0000-0000-0000-0000000000ff/owner',
      cookie: adminCookie, body: { email: 'a@b.co' },
    });
    assert.equal(res.status, 404);
  });

  // ── Duplicate rejection ────────────────────────────────────────────────────
  it('duplicate email per tenant → 409 with a clear message', async () => {
    const t = await newTenant();
    const first = await mutate(adminServer, { method: 'POST', path: OWNER(t), cookie: adminCookie, body: { email: 'dup@clinic.example' } });
    assert.equal(first.status, 201);

    // Same email, different case → still a duplicate (stored + checked lowercased).
    const second = await mutate(adminServer, { method: 'POST', path: OWNER(t), cookie: adminCookie, body: { email: 'DUP@clinic.example' } });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already exists/i);
  });

  // ── Password hygiene: never stored plaintext ───────────────────────────────
  it('stored password is a scrypt hash of the returned temp password (not plaintext)', async () => {
    const t = await newTenant();
    const res = await mutate(adminServer, { method: 'POST', path: OWNER(t), cookie: adminCookie, body: { email: 'hash@clinic.example' } });
    assert.equal(res.status, 201);
    assert.ok(res.body.password && res.body.password.length >= 12, 'a temp password is returned');

    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [res.body.user_id]);
    const stored = rows[0].password_hash;
    assert.ok(stored.startsWith('scrypt$'), 'stored value is a scrypt-encoded string');
    assert.ok(!stored.includes(res.body.password), 'plaintext password must not appear in the stored hash');
    assert.equal(verifyPassword(res.body.password, stored), true, 'the hash verifies against the returned password');
  });

  // ── End-to-end: operator creates → owner logs into the portal ──────────────
  it('operator creates an account; the owner logs into the portal with the temp password', async () => {
    const t = await newTenant('Bright Smiles Dental');
    // Mixed-case email proves we normalise to lowercase (login lowercases input too).
    const created = await mutate(adminServer, { method: 'POST', path: OWNER(t), cookie: adminCookie, body: { email: 'Owner@Bright.Example' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.email, 'owner@bright.example', 'email normalised to lowercase');
    const tempPassword = created.body.password;

    const portal = await portalStart();
    try {
      // Wrong password must NOT authenticate.
      const bad = await req(portal, { method: 'POST', path: '/portal/api/login', body: { email: 'owner@bright.example', password: 'not-it' } });
      assert.equal(bad.status, 401);

      // The real temp password (any input casing of the email) logs in.
      const good = await req(portal, { method: 'POST', path: '/portal/api/login', body: { email: 'OWNER@bright.example', password: tempPassword } });
      assert.equal(good.status, 200);
      const cookie = portalSid(good.setCookie);
      assert.ok(cookie, 'expected a portal.sid cookie');

      // The session scopes to exactly this tenant (INV-1).
      const me = await req(portal, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(me.status, 200);
      assert.equal(me.body.tenant.id, t);
      assert.equal(me.body.tenant.name, 'Bright Smiles Dental');
      assert.equal(me.body.user.role, 'owner');
    } finally { portal.close(); }
  });

  // ── Hardening parity: portal responses carry the admin security headers ─────
  // x-frame-options is SAMEORIGIN here, not admin's DENY (PORTAL-P6-S16): the
  // onboarding wizard embeds a step's own standalone page in a same-origin
  // <iframe> rather than re-implementing its form, so the portal relaxes
  // framing to itself only — every other origin is still blocked exactly like
  // before (see routes.js's override, right after securityHeaders). Admin's
  // own DENY (security.js) is untouched.
  it('every /portal response carries the admin-parity security headers (nosniff/SAMEORIGIN/no-referrer)', async () => {
    const portal = await portalStart();
    try {
      const responses = [
        await req(portal, { method: 'GET', path: '/portal/api/me' }),                 // 401
        await req(portal, { method: 'GET', path: '/portal/api/readiness' }),           // 401
        await req(portal, { method: 'POST', path: '/portal/api/login', body: { email: 'x@y.co', password: 'nope' } }), // 401
      ];
      for (const res of responses) {
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
      }
    } finally { portal.close(); }
  });
});
