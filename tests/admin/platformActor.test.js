'use strict';

// The admin session resolves to a bootstrap operator row (ADMIN-S3b C3, D-022).
//
// WHAT THIS PINS. Admin identity used to be a boolean: `req.session.admin = true`
// and nothing else, which is why every admin-originated audit row recorded a NULL
// or constant actor. A successful ADMIN_PASSWORD comparison now also resolves a
// platform_users row and puts its id in the session. The CREDENTIAL is unchanged
// — same safeEqual, same limiter, same session regeneration — and the boolean
// stays, so requireAuth and the `/` redirect are untouched.
//
// THE RATE LIMITER IS THE REASON FOR buildApp(). loginLimiter caps logins at 5
// per IP per 15 minutes and its buckets are module-level state, so a suite that
// shares one app across tests runs out of logins partway through and starts
// asserting against 429s. Each test builds a fresh app (fresh require, fresh
// buckets), exactly as adminSecurity.test.js does.
//
// NEVER server.js: that schedules reminderCron, which sends real patient
// WhatsApp messages. adminRoutes on a bare express app with a session, against a
// throwaway scratch database.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const BOOTSTRAP_EMAIL = 'bootstrap@veprio.invalid';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

// Disjoint, escaped prefix — node --test runs files concurrently and a shared
// prefix lets one suite's sweep DROP another's live scratch DB mid-test.
async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pact\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

function req(server, { method = 'GET', path = '/', headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers: h },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch (_) { json = null; }
          resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: json, raw: data });
        });
      });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
const login = (server, password = 'correct-horse') =>
  req(server, { method: 'POST', path: '/admin/login', body: { password } });

describe('admin session resolves a bootstrap operator row (C3)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db;
  const OLD_URL = process.env.DATABASE_URL;
  const OLD_PW = process.env.ADMIN_PASSWORD;
  const OLD_KEY = process.env.ENCRYPTION_KEY;
  const servers = [];

  // Fresh app per test: fresh limiter buckets (see the header).
  async function buildApp() {
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
    // Reads the REAL session the admin router wrote, through the same session
    // middleware. The store is in-process MemoryStore, so there is no other way
    // to see what login put there.
    app.get('/__probe', (r, s) => s.json({
      admin: r.session.admin === true,
      platformUserId: r.session.platformUserId || null,
    }));
    const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    servers.push(server);
    return server;
  }

  async function q(sql, params) {
    const c = new Client({ connectionString: scratchCs, ssl: SSL });
    await c.connect();
    try { return await c.query(sql, params); } finally { await c.end(); }
  }
  const bootstrapRows = () =>
    q('SELECT id, email, role, last_login_at, disabled_at FROM platform_users ORDER BY email')
      .then((r) => r.rows);

  before(async () => {
    await sweep();
    scratchName = 'zyon_pact_' + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind the pooled db module to the scratch DB BEFORE first require.
    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
  });

  after(async () => {
    for (const s of servers) { try { s.close(); } catch (_) { /* already closed */ } }
    if (db && db.close) { try { await db.close(); } catch (_) { /* noop */ } }
    process.env.DATABASE_URL = OLD_URL;
    process.env.ADMIN_PASSWORD = OLD_PW;
    process.env.ENCRYPTION_KEY = OLD_KEY;
    await sweep();
  });

  it('a successful login creates exactly ONE bootstrap operator row', async () => {
    await q('DELETE FROM platform_users');
    const server = await buildApp();

    const res = await login(server);
    assert.equal(res.status, 200, 'login still succeeds');
    assert.equal(res.body.ok, true, 'response body unchanged');

    const rows = await bootstrapRows();
    assert.equal(rows.length, 1, 'exactly one row');
    assert.equal(rows[0].email, BOOTSTRAP_EMAIL);
    assert.equal(rows[0].role, 'operator', "the bootstrap row is an operator");
    assert.ok(rows[0].last_login_at, 'last_login_at stamped on creation, not left NULL');
    assert.equal(rows[0].disabled_at, null, 'created active');
  });

  it('a second login creates NO second row and moves last_login_at forward', async () => {
    await q('DELETE FROM platform_users');
    const first = await buildApp();
    await login(first);

    // Push the stamp an hour back so "moved forward" is unambiguous rather than
    // dependent on clock resolution between two transactions milliseconds apart.
    await q("UPDATE platform_users SET last_login_at = NOW() - INTERVAL '1 hour'");
    const before = (await bootstrapRows())[0];

    const second = await buildApp();
    const res = await login(second);
    assert.equal(res.status, 200);

    const rows = await bootstrapRows();
    assert.equal(rows.length, 1, 'still exactly one row — the resolve is idempotent');
    assert.equal(rows[0].id, before.id, 'and it is the SAME row, not a replacement');
    assert.ok(rows[0].last_login_at > before.last_login_at, 'last_login_at moved forward');
  });

  // SIXTEEN, and the number is measured rather than chosen. At four there is no
  // contention at all: this test was written with four and stayed GREEN when the
  // atomic upsert was deliberately replaced by a non-atomic SELECT-then-INSERT,
  // which is the one defect it exists to catch. At sixteen the defect is detected
  // 5/5 and the fix is clean 5/5.
  //
  // AND THE SYMPTOM IS NOT DUPLICATE ROWS. The UNIQUE index on email means the
  // losers of a non-atomic race cannot insert a second row — they raise 23505 and
  // the route answers 500. So a row count alone can never catch this; the status
  // assertion is the one that bites, and 8-12 of the 16 logins fail without the
  // upsert. Both assertions stay: together they say "one row, and nobody was
  // turned away getting there".
  it('sixteen CONCURRENT logins create exactly one row, and none of them fails', async () => {
    await q('DELETE FROM platform_users');
    // Separate apps so separate limiter buckets are not the thing under test;
    // the race is on the INSERT, not on the limiter.
    const apps = await Promise.all(Array.from({ length: 16 }, () => buildApp()));
    const results = await Promise.all(apps.map((s) => login(s)));

    const failed = results.filter((r) => r.status !== 200).length;
    assert.equal(failed, 0,
      `${failed}/16 concurrent logins failed — the resolve is not atomic`);
    const rows = await bootstrapRows();
    assert.equal(rows.length, 1,
      'ON CONFLICT (email) DO UPDATE makes the resolve concurrency-safe: the losers ' +
      'of the race take the update branch instead of colliding on the unique index');
  });

  it('the session carries the platform user id ALONGSIDE the unchanged boolean', async () => {
    await q('DELETE FROM platform_users');
    const server = await buildApp();
    const res = await login(server);
    const cookie = sid(res.setCookie);
    assert.ok(cookie, 'authenticated session cookie');

    const probe = await req(server, { path: '/__probe', cookie });
    assert.equal(probe.body.admin, true, 'req.session.admin is STILL true — requireAuth is unchanged');

    const rows = await bootstrapRows();
    assert.equal(probe.body.platformUserId, rows[0].id,
      'and the session carries the id of the row that was just resolved');
  });

  it('a wrong password creates no row and no session', async () => {
    await q('DELETE FROM platform_users');
    const server = await buildApp();
    const res = await login(server, 'nope');
    assert.equal(res.status, 401, 'still a generic 401');

    assert.deepEqual(await bootstrapRows(), [],
      'the failed credential path never touches platform_users');
    assert.equal(sid(res.setCookie), null, 'and mints no session cookie');
  });

  it('a login that cannot resolve the row fails 500 — it does NOT mint an actorless session', async () => {
    await q('DELETE FROM platform_users');
    // Hide the table rather than dropping it: reversible, and it reproduces the
    // real failure (the INSERT raises) without destroying the suite's schema.
    await q('ALTER TABLE platform_users RENAME TO platform_users_hidden');
    try {
      const server = await buildApp();
      const res = await login(server);
      assert.equal(res.status, 500, 'the login fails');
      assert.equal(sid(res.setCookie), null, 'no authenticated session is issued');
    } finally {
      await q('ALTER TABLE platform_users_hidden RENAME TO platform_users');
    }
    // Fail-soft (carry on with a NULL actor) was considered and REJECTED: a
    // silently unattributed audit row is the exact defect D-022 was written to
    // remove, and every route behind requireAuth needs this same database anyway.
  });
});
