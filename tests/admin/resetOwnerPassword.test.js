'use strict';

// F3-R1 — operator-side owner password reset, and the portal session epoch.
//
// public/portal/login.html has promised since F3 that an owner who forgets their
// password can message Prantivo and have it reset. Nothing could honour that:
// the create route 409s when an account exists, and the only `UPDATE users` in
// the repository was last_login_at.
//
// The load-bearing half is NOT the new hash. Phase 0 established that
// requirePortalAuth never re-reads password_hash and that the session payload was
// `{ userId }` alone, so rotating the password left every live portal.sid
// authenticated for the rest of its 12h window. An owner who asks for a reset is
// frequently an owner who suspects compromise, so that reset would have been
// worse than nothing in exactly the case that matters. Migration 027's
// password_changed_at is the session epoch that fixes it, and the assertion this
// whole session turns on is `a live portal session is invalidated by a reset` —
// a real authenticated request before and after, never a hash comparison.
//
// Runs both real surfaces against one throwaway scratch DB, mirroring
// createOwner.test.js. Disjoint DB-name prefix (zyon_pwr_) — not zyon_own_ (that
// suite), not zyon_rs_ / zyon_prdy_ / zyon_pauth_. The sweep escapes the
// underscores so it can only ever target our own prefix.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const logger = require('../../src/infra/logging/logger');
const { verifyPassword, sessionEpochMatches, passwordEpoch } = require('../../src/portal/auth');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pwr_';
const SESSION_SECRET = 'test-secret-abcdefghijklmnopqrstuvwx';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pwr\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror createOwner.test.js) ────────────────────────────────
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

// Fresh portal app per call → fresh in-memory login-limiter buckets, so the
// 5/15min cap never bleeds across tests.
function buildPortalApp() {
  const express = require('express');
  const app = express();
  delete require.cache[require.resolve('../../src/portal/routes')];
  app.use('/portal', require('../../src/portal/routes'));
  return app;
}
function portalStart() { return listen(buildPortalApp()); }

// ── Log capture ──────────────────────────────────────────────────────────────
// Patches the logger singleton's level methods. adminRoutes captured a reference
// to this same object at require time, so replacing methods on it intercepts its
// lines. The mixin is evaluated AT CAPTURE TIME, inside the still-live ALS
// request context, and merged the way logger.js:8-9 documents pino merging it
// (mixin result as the target) — so `entry.obj` is what pino would actually have
// written, correlation_id included, rather than an approximation of it.
function captureLogs() {
  const entries = [];
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const orig = {};
  for (const lvl of levels) {
    orig[lvl] = logger[lvl];
    logger[lvl] = function (a, b, ...rest) {
      const merged = (a !== null && typeof a === 'object')
        ? Object.assign(logger._mixin(), a)
        : logger._mixin();
      entries.push({
        level: lvl,
        obj: merged,
        msg: typeof a === 'string' ? a : b,
        // Every argument, stringified — what a "does the password appear in any
        // log line" search must actually run against.
        text: [a, b, ...rest].map((x) => {
          try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (_) { return String(x); }
        }).join(' '),
      });
      return orig[lvl].apply(logger, [a, b, ...rest]);
    };
  }
  return {
    entries,
    restore() { for (const lvl of levels) logger[lvl] = orig[lvl]; },
  };
}

describe('operator owner password reset + session epoch (F3-R1)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
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

    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use(session({
      secret: SESSION_SECRET,
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

  // ── Fixtures ───────────────────────────────────────────────────────────────
  let seq = 0;
  async function newTenant(name = 'Reset Clinic') {
    const { rows } = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [name]);
    return rows[0].id;
  }
  const OWNER = (id) => `/admin/api/tenants/${id}/owner`;
  const RESET = (id) => `/admin/api/tenants/${id}/owner/reset`;

  // Operator creates an owner through the REAL route, so every test starts from
  // the same account-creation path a real clinic does.
  async function newOwner(tenantId) {
    const email = `owner${++seq}@reset.example`;
    const res = await mutate(adminServer, {
      method: 'POST', path: OWNER(tenantId), cookie: adminCookie, body: { email },
    });
    assert.equal(res.status, 201, 'fixture: owner account created');
    return { email, password: res.body.password, userId: res.body.user_id };
  }

  async function login(portal, email, password) {
    return req(portal, { method: 'POST', path: '/portal/api/login', body: { email, password } });
  }

  // ── 1. Auth — the route inherits exactly what every admin route has ────────
  it('reset without an admin session → 401', async () => {
    const t = await newTenant();
    await newOwner(t);
    const res = await mutate(adminServer, { method: 'POST', path: RESET(t) });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  it('reset without the admin CSRF header → 403', async () => {
    const t = await newTenant();
    await newOwner(t);
    const res = await req(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    assert.equal(res.status, 403);
  });

  it('the verification route requires an admin session → 401', async () => {
    const t = await newTenant();
    await newOwner(t);
    const res = await req(adminServer, { method: 'GET', path: OWNER(t) });
    assert.equal(res.status, 401);
  });

  // ── 2. THE HAPPY PATH — real login attempts, not hash comparison ───────────
  it('after a reset the old password no longer authenticates and the new one does', async () => {
    const t = await newTenant('Happy Path Dental');
    const owner = await newOwner(t);

    let portal = await portalStart();
    try {
      // The temp password works before the reset — otherwise the assertion below
      // would pass against an account that never worked at all.
      const before = await login(portal, owner.email, owner.password);
      assert.equal(before.status, 200, 'the created account authenticates before the reset');
    } finally { portal.close(); }

    const reset = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.email, owner.email, 'the response names the account that was reset');
    assert.ok(reset.body.password && reset.body.password.length >= 12, 'a new password is returned');
    assert.notEqual(reset.body.password, owner.password, 'the new password is not the old one');

    portal = await portalStart();
    try {
      const old = await login(portal, owner.email, owner.password);
      assert.equal(old.status, 401, 'the OLD password must no longer authenticate');

      const fresh = await login(portal, owner.email, reset.body.password);
      assert.equal(fresh.status, 200, 'the NEW password authenticates');
      assert.ok(portalSid(fresh.setCookie), 'and yields a portal session');
    } finally { portal.close(); }
  });

  // ── 3. THE ASSERTION THIS SESSION TURNS ON ────────────────────────────────
  it('a live portal session is INVALIDATED by a reset', async () => {
    const t = await newTenant('Session Evict Dental');
    const owner = await newOwner(t);

    const portal = await portalStart();
    try {
      const signedIn = await login(portal, owner.email, owner.password);
      assert.equal(signedIn.status, 200);
      const cookie = portalSid(signedIn.setCookie);
      assert.ok(cookie);

      // A real authenticated request BEFORE.
      const before = await req(portal, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(before.status, 200, 'the session authenticates before the reset');
      assert.equal(before.body.tenant.id, t);

      const reset = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
      assert.equal(reset.status, 200);

      // The SAME cookie, a real authenticated request AFTER. This is the whole
      // point: an attacker holding a stolen portal.sid must not keep it through
      // the reset the owner asked for precisely because they suspect compromise.
      const after = await req(portal, { method: 'GET', path: '/portal/api/me', cookie });
      assert.equal(after.status, 401, 'the pre-reset session must NOT survive the reset');
      assert.equal(after.body.error, 'Unauthorized');
    } finally { portal.close(); }
  });

  it("a reset does not disturb another tenant's owner session", async () => {
    // Non-vacuity for the test above: the eviction must be the epoch, not some
    // blunt global effect like the store being cleared.
    const tA = await newTenant('Clinic A');
    const tB = await newTenant('Clinic B');
    const ownerA = await newOwner(tA);
    const ownerB = await newOwner(tB);

    const portal = await portalStart();
    try {
      const sessA = await login(portal, ownerA.email, ownerA.password);
      const sessB = await login(portal, ownerB.email, ownerB.password);
      const cookieA = portalSid(sessA.setCookie);
      const cookieB = portalSid(sessB.setCookie);

      const reset = await mutate(adminServer, { method: 'POST', path: RESET(tA), cookie: adminCookie });
      assert.equal(reset.status, 200);

      const afterA = await req(portal, { method: 'GET', path: '/portal/api/me', cookie: cookieA });
      assert.equal(afterA.status, 401, "the reset tenant's session is evicted");

      const afterB = await req(portal, { method: 'GET', path: '/portal/api/me', cookie: cookieB });
      assert.equal(afterB.status, 200, "an unrelated tenant's session is untouched");
      assert.equal(afterB.body.tenant.id, tB);
    } finally { portal.close(); }
  });

  // ── 4. The deploy case — a session with no epoch must NEVER be admitted ────
  it('a session carrying no epoch is rejected, not tolerated (no permanent bypass)', async () => {
    const t = await newTenant('Legacy Session Dental');
    const owner = await newOwner(t);
    const { rows } = await db.query('SELECT password_changed_at FROM users WHERE id=$1', [owner.userId]);
    const realEpoch = passwordEpoch(rows[0]);

    // A pre-migration cookie is a session whose payload is `{ userId }` and
    // nothing else — exactly what portal login wrote before F3-R1. It cannot be
    // produced through the real login any more, so it is planted directly, which
    // is a faithful reproduction of a cookie minted before the deploy.
    const express = require('express');
    const session = require('express-session');
    const { requirePortalAuth } = require('../../src/portal/auth');
    const app = express();
    app.use(session({
      secret: SESSION_SECRET, resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    app.use(express.json());
    app.post('/plant', (rq, rs) => {
      rq.session.portal = rq.body;           // whatever shape the test asks for
      rq.session.save(() => rs.json({ ok: true }));
    });
    app.get('/guarded', requirePortalAuth, (rq, rs) => rs.json({ tenantId: rq.portalUser.tenantId }));
    const srv = await listen(app);

    try {
      // (a) legacy shape — userId only, no epoch at all.
      const legacy = await req(srv, { method: 'POST', path: '/plant', body: { userId: owner.userId } });
      let cookie = (legacy.setCookie[0] || '').split(';')[0];
      let res = await req(srv, { method: 'GET', path: '/guarded', cookie });
      assert.equal(res.status, 401, 'a session with NO epoch must be refused');

      // (b) null / (c) a string that would loosely equal the number / (d) wrong number.
      for (const [label, pwAt] of [
        ['null', null],
        ['a stringified epoch', String(realEpoch)],
        ['a stale epoch', realEpoch - 1000],
      ]) {
        const planted = await req(srv, { method: 'POST', path: '/plant', body: { userId: owner.userId, pwAt } });
        cookie = (planted.setCookie[0] || '').split(';')[0];
        res = await req(srv, { method: 'GET', path: '/guarded', cookie });
        assert.equal(res.status, 401, `a session with ${label} must be refused`);
      }

      // Non-vacuity: the correct epoch DOES pass, so the four refusals above are
      // the epoch check working and not the harness being broken.
      const good = await req(srv, { method: 'POST', path: '/plant', body: { userId: owner.userId, pwAt: realEpoch } });
      cookie = (good.setCookie[0] || '').split(';')[0];
      res = await req(srv, { method: 'GET', path: '/guarded', cookie });
      assert.equal(res.status, 200, 'the correct epoch authenticates');
      assert.equal(res.body.tenantId, t);
    } finally { srv.close(); }
  });

  it('sessionEpochMatches is strict about type and value', async () => {
    const row = { password_changed_at: new Date('2026-08-07T10:00:00.000Z') };
    const epoch = passwordEpoch(row);

    assert.equal(sessionEpochMatches({ pwAt: epoch }, row), true);
    assert.equal(sessionEpochMatches({ pwAt: String(epoch) }, row), false, 'a string never matches');
    assert.equal(sessionEpochMatches({ pwAt: epoch + 1 }, row), false);
    assert.equal(sessionEpochMatches({}, row), false, 'a missing epoch never matches');
    assert.equal(sessionEpochMatches(undefined, row), false);
    assert.equal(sessionEpochMatches(null, row), false);
    // A row without the column can never be matched by any session value —
    // including by a session that also has none.
    assert.equal(sessionEpochMatches({ pwAt: epoch }, { password_changed_at: null }), false);
    assert.equal(sessionEpochMatches({}, { password_changed_at: null }), false);
  });

  // ── 5. Tenant scoping — the route parameter is the only scope ─────────────
  it("an operator cannot reset tenant A's owner through tenant B's route parameter", async () => {
    const tA = await newTenant('Isolation A');
    const tB = await newTenant('Isolation B');
    const ownerA = await newOwner(tA);   // A has an owner; B has none

    const { rows: beforeRows } = await db.query(
      'SELECT password_hash, password_changed_at FROM users WHERE id=$1', [ownerA.userId]);

    // B's route parameter must not reach A's owner, even though A's is the only
    // owner account in the database.
    const res = await mutate(adminServer, { method: 'POST', path: RESET(tB), cookie: adminCookie });
    assert.equal(res.status, 404, "tenant B has no owner — A's must not be found");
    assert.equal(res.body.password, undefined, 'no password is issued');

    const { rows: afterRows } = await db.query(
      'SELECT password_hash, password_changed_at FROM users WHERE id=$1', [ownerA.userId]);
    assert.equal(afterRows[0].password_hash, beforeRows[0].password_hash, "A's hash is untouched");
    assert.deepEqual(afterRows[0].password_changed_at, beforeRows[0].password_changed_at, "A's epoch is untouched");

    // And A's own password still works — proven by a real login, not by the hash.
    const portal = await portalStart();
    try {
      const still = await login(portal, ownerA.email, ownerA.password);
      assert.equal(still.status, 200, "A's password still authenticates");
    } finally { portal.close(); }
  });

  it('a well-formed but absent tenant id → 404, and a tenant with no owner → 404', async () => {
    const absent = await mutate(adminServer, {
      method: 'POST', path: '/admin/api/tenants/00000000-0000-0000-0000-0000000000ff/owner/reset',
      cookie: adminCookie,
    });
    assert.equal(absent.status, 404);
    assert.match(absent.body.error, /Tenant not found/);

    const t = await newTenant('No Owner Yet');
    const none = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    assert.equal(none.status, 404);
    assert.match(none.body.error, /no owner account/i);
  });

  it('a tenant with two active owner accounts is refused, never guessed', async () => {
    const t = await newTenant('Two Owners');
    await newOwner(t);
    await newOwner(t);   // UNIQUE is (tenant_id, email), so a second owner is legal

    const res = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /2 active owner accounts/);
    assert.equal(res.body.password, undefined, 'no password is issued on a refusal');
  });

  // ── 6. Hashing — the same path as account creation, compared not assumed ───
  it('the reset hash is produced by the same scrypt path as account creation', async () => {
    const t = await newTenant('Same Hash Dental');
    const owner = await newOwner(t);

    const { rows: created } = await db.query('SELECT password_hash FROM users WHERE id=$1', [owner.userId]);
    const createdHash = created[0].password_hash;

    const reset = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    assert.equal(reset.status, 200);
    const { rows: after } = await db.query('SELECT password_hash FROM users WHERE id=$1', [owner.userId]);
    const resetHash = after[0].password_hash;

    // Stored format is `scrypt$N$r$p$salt$hash` — self-describing, so the cost
    // factors are compared rather than assumed.
    const c = createdHash.split('$');
    const r = resetHash.split('$');
    assert.equal(c.length, 6);
    assert.equal(r.length, 6);
    assert.equal(r[0], 'scrypt', 'same library/algorithm marker');
    assert.deepEqual(r.slice(0, 4), c.slice(0, 4), 'same algorithm and same N/r/p cost factors');
    assert.notEqual(r[4], c[4], 'a fresh salt (never a reused one)');
    assert.notEqual(r[5], c[5], 'and therefore a different digest');

    // The stored value verifies against the NEW password and not the old one.
    assert.equal(verifyPassword(reset.body.password, resetHash), true);
    assert.equal(verifyPassword(owner.password, resetHash), false);
  });

  // ── 7. The audit record, per the amended verification item 7 ──────────────
  it('password_changed_at moves and the log line carries tenant + actor + correlation id, never the password', async () => {
    const t = await newTenant('Audit Dental');
    const owner = await newOwner(t);

    const { rows: before } = await db.query(
      'SELECT password_changed_at, updated_at FROM users WHERE id=$1', [owner.userId]);

    const cap = captureLogs();
    let reset;
    try {
      reset = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    } finally { cap.restore(); }
    assert.equal(reset.status, 200);

    // The durable record: a column that moves for exactly one reason. updated_at
    // cannot say this — the login path UPDATEs the same row (last_login_at) and
    // fires the same trigger, so it cannot tell a reset from a sign-in.
    const { rows: after } = await db.query(
      'SELECT password_changed_at FROM users WHERE id=$1', [owner.userId]);
    assert.ok(
      new Date(after[0].password_changed_at) > new Date(before[0].password_changed_at),
      'password_changed_at moved forward');

    // The log line.
    const line = cap.entries.find((e) => e.msg === 'owner portal password reset');
    assert.ok(line, 'the reset emitted its audit line');
    assert.equal(line.level, 'info');
    assert.equal(line.obj.tenantId, t, 'names WHICH TENANT');
    assert.equal(line.obj.userId, owner.userId, 'names which account');
    assert.equal(line.obj.actor, 'admin_session',
      'names the actor honestly — admin auth has no operator identity, so it must not name a human');
    assert.match(String(line.obj.correlation_id), /^adm_[0-9a-f]{16}$/,
      'carries the correlation id the admin router installs');

    // WHEN: pino stamps its own `time`; the durable answer is the column above,
    // which is asserted to have moved past a timestamp read before the request.

    // And NOT the password — checked across every captured line, not just this one.
    for (const e of cap.entries) {
      assert.ok(!e.text.includes(reset.body.password), `password leaked into a log line: ${e.msg}`);
    }
  });

  // ── 8. The password reaches no log, no error body, and no database column ──
  it('the generated password appears in no log line, no error response, and nowhere in the database', async () => {
    const t = await newTenant('Leak Check Dental');
    const owner = await newOwner(t);

    const cap = captureLogs();
    let reset;
    try {
      reset = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    } finally { cap.restore(); }
    assert.equal(reset.status, 200);
    const password = reset.body.password;
    assert.ok(password);

    // (a) No log line — every argument of every captured call, stringified.
    for (const e of cap.entries) {
      assert.ok(!e.text.includes(password), `password appeared in a ${e.level} line: ${e.msg}`);
    }

    // (b) No error response. Drive the failure paths and read the actual bodies.
    const failures = [
      await mutate(adminServer, { method: 'POST', path: RESET(t) }),                                   // 401
      await req(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie }),                 // 403
      await mutate(adminServer, { method: 'POST', path: RESET(await newTenant()), cookie: adminCookie }), // 404
    ];
    for (const f of failures) {
      assert.ok(!String(f.raw).includes(password), `password appeared in a ${f.status} body`);
    }

    // (c) Nowhere in the database. Every text-ish column of every table in the
    // scratch DB is searched for the literal — this is the search the brief asks
    // for, run against the real storage rather than reasoned about. `position`
    // is used instead of LIKE because the base64url alphabet contains `_`, which
    // LIKE would treat as a wildcard and quietly turn into a weaker search.
    // This also covers turn_traces, so "no trace row" is asserted by the same sweep.
    const { rows: cols } = await db.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('text','character varying','jsonb','json','character')
       ORDER BY table_name, column_name`);
    assert.ok(cols.length > 50, `expected a populated schema to search, saw ${cols.length} columns`);

    const hits = [];
    for (const c of cols) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM "${c.table_name}" WHERE position($1 in "${c.column_name}"::text) > 0`,
        [password]);
      if (rows[0].n > 0) hits.push(`${c.table_name}.${c.column_name} (${rows[0].n} row(s))`);
    }
    assert.deepEqual(hits, [], `plaintext password found in the database: ${hits.join(', ')}`);

    // Non-vacuity: the same sweep DOES find a value that really is stored, so an
    // empty result above means "absent", not "the search never worked".
    const { rows: probe } = await db.query(
      "SELECT count(*)::int AS n FROM tenants WHERE position($1 in business_name::text) > 0",
      ['Leak Check Dental']);
    assert.equal(probe[0].n, 1, 'the sweep technique finds a value that IS present');

    // And the stored hash verifies against the password without containing it.
    const { rows: stored } = await db.query('SELECT password_hash FROM users WHERE id=$1', [owner.userId]);
    assert.ok(stored[0].password_hash.startsWith('scrypt$'));
    assert.ok(!stored[0].password_hash.includes(password));
    assert.equal(verifyPassword(password, stored[0].password_hash), true);
  });

  // ── 9. The verification route (0.9) ───────────────────────────────────────
  it('the verification route returns the owner email and the labelled verify number, never password_hash', async () => {
    const t = await newTenant('Verify Card Dental');
    const owner = await newOwner(t);

    // Give the tenant a config carrying the owner alert number — B1 established
    // this is the real recipient and therefore the number to verify against.
    const configService = require('../../src/modules/config/configService');
    const defaults = require('../../src/modules/config/defaults');
    const config = structuredClone(defaults.clinicDefaults);
    config.notifications.owner_numbers = ['+919000000123', '+919000000999'];
    await configService.writeTenantConfig(t, config, 'admin');

    const res = await req(adminServer, { method: 'GET', path: OWNER(t), cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.owner_count, 1);
    assert.equal(res.body.email, owner.email, 'the operator can see WHICH account they would reset');
    assert.equal(res.body.verify_number, '+919000000123', 'owner_numbers[0]');
    assert.equal(res.body.verify_number_source, 'config.notifications.owner_numbers[0]',
      'the field is labelled with where it came from');

    // No password material and no other user fields.
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, 'password_hash'));
    assert.ok(!String(res.raw).includes('scrypt$'), 'no hash material anywhere in the payload');
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ['email', 'owner_count', 'verify_number', 'verify_number_source'],
      'exactly these four fields — no other user columns');
  });

  it('the verification route is tenant-scoped from the route parameter', async () => {
    const tA = await newTenant('Scoped A');
    const tB = await newTenant('Scoped B');
    const ownerA = await newOwner(tA);

    const a = await req(adminServer, { method: 'GET', path: OWNER(tA), cookie: adminCookie });
    assert.equal(a.body.email, ownerA.email);

    // B has no owner; A's must not leak through B's parameter.
    const b = await req(adminServer, { method: 'GET', path: OWNER(tB), cookie: adminCookie });
    assert.equal(b.status, 200);
    assert.equal(b.body.owner_count, 0);
    assert.equal(b.body.email, null);
    assert.ok(!String(b.raw).includes(ownerA.email), "A's email must not appear under B's id");

    const absent = await req(adminServer, {
      method: 'GET', path: '/admin/api/tenants/00000000-0000-0000-0000-0000000000ff/owner',
      cookie: adminCookie,
    });
    assert.equal(absent.status, 404);
  });

  it('a configless tenant reports no verify number rather than failing', async () => {
    const t = await newTenant('Configless Dental');
    const owner = await newOwner(t);
    const res = await req(adminServer, { method: 'GET', path: OWNER(t), cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, owner.email);
    assert.equal(res.body.verify_number, null, 'null, so the UI can say "none on file"');
  });

  // ── 10. The reset is repeatable, and each one evicts again ────────────────
  it('a second reset supersedes the first, and evicts the session the first one issued', async () => {
    const t = await newTenant('Twice Dental');
    const owner = await newOwner(t);

    const first = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
    assert.equal(first.status, 200);

    const portal = await portalStart();
    try {
      const signedIn = await login(portal, owner.email, first.body.password);
      assert.equal(signedIn.status, 200);
      const cookie = portalSid(signedIn.setCookie);
      assert.equal((await req(portal, { method: 'GET', path: '/portal/api/me', cookie })).status, 200);

      const second = await mutate(adminServer, { method: 'POST', path: RESET(t), cookie: adminCookie });
      assert.equal(second.status, 200);
      assert.notEqual(second.body.password, first.body.password);

      assert.equal((await req(portal, { method: 'GET', path: '/portal/api/me', cookie })).status, 401,
        'the session issued by the first reset is evicted by the second');
      assert.equal((await login(portal, owner.email, first.body.password)).status, 401,
        "the first reset's password no longer authenticates");
      assert.equal((await login(portal, owner.email, second.body.password)).status, 200,
        "the second reset's password does");
    } finally { portal.close(); }
  });
});
