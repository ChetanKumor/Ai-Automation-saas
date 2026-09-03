'use strict';

// Validation runs record their actor (ADMIN-S3b C6, D-022).
//
// THE PROBE BOUNDARY IS THE WHOLE PROBLEM. validateTenant deliberately switches
// into a fresh `probe_` correlation context (Issue 21) so every log line a run
// causes is distinguishable from real traffic. requestContext.runWith REPLACES
// the store — it does not merge — so the validation_runs INSERT, which happens
// inside that new context, sees whatever validateTenant put there and nothing
// else. Wiring the column without carrying the actor across the switch produces a
// run that records NULL while every other test in the session still passes. That
// failure is silent, which is why the crossing has a test of its own rather than
// being folded into "the admin route records an actor".
//
// NEVER server.js (reminderCron sends real patient WhatsApp messages).

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

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_vact\\_%'");
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
const mutate = (server, opts) => req(server, Object.assign({}, opts, {
  headers: Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {}),
}));
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}

// Mirrors resetOwnerPassword.test.js: merges the mixin the way logger.js
// documents pino merging it, so entry.obj.correlation_id is what would really
// have been written rather than an approximation.
function captureLogs(logger) {
  const entries = [];
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const orig = {};
  for (const lvl of levels) {
    orig[lvl] = logger[lvl];
    logger[lvl] = function (a, b, ...rest) {
      const merged = (a !== null && typeof a === 'object')
        ? Object.assign(logger._mixin(), a) : logger._mixin();
      entries.push({ level: lvl, obj: merged, msg: typeof a === 'string' ? a : b });
      return orig[lvl].apply(logger, [a, b, ...rest]);
    };
  }
  return { entries, restore() { for (const lvl of levels) logger[lvl] = orig[lvl]; } };
}

describe('validation runs record their actor (C6)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, validationService, requestContext, logger, server, cookie, operatorId;
  const OLD_URL = process.env.DATABASE_URL;
  const OLD_PW = process.env.ADMIN_PASSWORD;
  const OLD_KEY = process.env.ENCRYPTION_KEY;

  async function q(sql, params) {
    const c = new Client({ connectionString: scratchCs, ssl: SSL });
    await c.connect();
    try { return await c.query(sql, params); } finally { await c.end(); }
  }
  async function runsFor(tenantId) {
    const { rows } = await q(
      `SELECT passed, actor_user_id, actor_platform_user_id
         FROM validation_runs WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
    return rows;
  }
  async function newTenant() {
    const r = await q(`INSERT INTO tenants (business_name) VALUES ('C6 Clinic') RETURNING id`);
    return r.rows[0].id;
  }

  before(async () => {
    await sweep();
    scratchName = 'zyon_vact_' + crypto.randomBytes(6).toString('hex');
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
    validationService = require('../../src/modules/validation/validationService');
    requestContext = require('../../src/core/requestContext');
    logger = require('../../src/infra/logging/logger');

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
    server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });

    const login = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    assert.equal(login.status, 200);
    cookie = sid(login.setCookie);
    const { rows } = await q('SELECT id FROM platform_users');
    operatorId = rows[0].id;
  });

  after(async () => {
    if (server) server.close();
    if (db && db.close) { try { await db.close(); } catch (_) { /* noop */ } }
    process.env.DATABASE_URL = OLD_URL;
    process.env.ADMIN_PASSWORD = OLD_PW;
    process.env.ENCRYPTION_KEY = OLD_KEY;
    await sweep();
  });

  it('an admin-triggered validation run records the acting operator', async () => {
    const t = await newTenant();
    const res = await mutate(server, {
      method: 'POST', path: `/admin/api/tenants/${t}/validate`, cookie, body: {},
    });
    // The run's OUTCOME is irrelevant here. A bare tenant fails config.exists, and
    // the route answers through lifecycleService, which renders a failing run as
    // 409 VALIDATION_FAILED. The run is persisted on every one of those paths, and
    // the row naming who caused it is the only thing asserted.
    assert.ok([200, 409, 422].includes(res.status), `unexpected status ${res.status}: ${res.raw}`);

    const runs = await runsFor(t);
    assert.equal(runs.length, 1, 'the run was persisted');
    assert.equal(runs[0].actor_platform_user_id, operatorId,
      'and it names the operator whose session triggered it');
  });

  // ── A2's required test: the carry-through, not just the column ──
  it('the actor SURVIVES the probe boundary — recorded through a context switch that replaces the store', async () => {
    const t = await newTenant();
    const outerId = requestContext.newCorrelationId('adm');

    // Observe the context AT THE MOMENT OF THE INSERT. Log capture cannot do this:
    // "validation run starting" is emitted BEFORE the switch by design (so it
    // carries the caller's id), and nothing on this path logs from inside the run,
    // so a log-based check finds no probe_ line and proves nothing. validationService
    // calls db.query on the shared module object, so replacing that property is
    // visible to it — unlike a module-local function, which a spy cannot reach.
    const origQuery = db.query;
    let ctxAtInsert;
    db.query = function (sql, params) {
      if (/INSERT INTO validation_runs/.test(String(sql))) ctxAtInsert = requestContext.get();
      return origQuery.call(db, sql, params);
    };

    let inner = null;
    try {
      // Exactly the shape the admin router establishes around a request.
      await requestContext.runWith(
        { correlationId: outerId, channel: 'admin', platformUserId: operatorId },
        async () => {
          await validationService.validateTenant(t);
          inner = requestContext.get();
        });
    } finally { db.query = origQuery; }

    // The switch really happened: at the insert the context is a FRESH probe_ id,
    // not the adm_ id we entered with. Without this the assertion below would pass
    // in a world where no boundary was ever crossed.
    assert.ok(ctxAtInsert, 'the insert ran inside a context');
    assert.match(ctxAtInsert.correlationId, /^probe_[0-9a-f]{16}$/,
      'the run entered a fresh probe_ context');
    assert.notEqual(ctxAtInsert.correlationId, outerId);
    assert.equal(inner.correlationId, outerId, 'and the caller context was restored afterwards');

    // And the actor crossed it anyway — this is the carry-through.
    assert.equal(ctxAtInsert.platformUserId, operatorId,
      'the operator survived a runWith that REPLACES the store');
    const runs = await runsFor(t);
    assert.equal(runs[0].actor_platform_user_id, operatorId,
      'and reached the row');
  });

  it('a run with no ambient actor records NULL — the lifecycle CLI and the portal today', async () => {
    const t = await newTenant();
    await validationService.validateTenant(t);   // no surrounding context at all

    const runs = await runsFor(t);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].actor_platform_user_id, null, 'no actor to record, and none invented');
    assert.equal(runs[0].actor_user_id, null);
  });

  it('validation_runs.actor_user_id has NO writer yet — a recorded gap, not an assumption', async () => {
    // The column exists because C2 gave both audit tables the same pair. Its
    // writer would be the portal, which triggers runs at portal/routes.js and
    // which ADMIN-S3b must leave byte-unchanged (I3), so nothing sets it.
    //
    // This test is a TRIPWIRE. When the portal starts attributing its runs it
    // will fail, and that failure is the point: the session doing that work
    // should delete this test deliberately rather than discover months later
    // that a column shipped with no writer, which is exactly how
    // tenants.owner_notify_phone got a silent no-op (B1).
    const { rows } = await q(
      'SELECT count(*)::int AS n FROM validation_runs WHERE actor_user_id IS NOT NULL');
    assert.equal(rows[0].n, 0,
      'nothing in the codebase writes validation_runs.actor_user_id yet');
  });
});
