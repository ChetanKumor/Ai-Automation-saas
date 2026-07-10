'use strict';

// Route-level tests for the Issue 17 lifecycle admin API (validate/activate/pause).
// Real routes over HTTP against a throwaway scratch DB, with an authenticated
// session — mirrors tests/admin/tenantDetail.test.js.
//
// Disjoint DB-name prefix (zyon_lcr_): NOT `zyon_test_*`, which tenantDetail.test.js
// sweeps wholesale. Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { encrypt } = require('../../src/utils/encryption');
const { clinicDefaults } = require('../../src/modules/config/defaults');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_lcr_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_lcr\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

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
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const mutate = (server, opts) =>
  req(server, Object.assign({}, opts, { headers: Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {}) }));
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });

const ZERO_VEC = '[' + Array(768).fill(0).join(',') + ']';

describe('tenant lifecycle admin API (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, app, server, cookie, deepMerge;
  let seq = 0;
  const OLD_PW = process.env.ADMIN_PASSWORD;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    ({ deepMerge } = require('../../src/modules/config/configService'));

    const express = require('express');
    const session = require('express-session');
    app = express();
    app.use(session({
      secret: 'test-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    delete require.cache[require.resolve('../../src/admin/adminRoutes')];
    app.use('/admin', require('../../src/admin/adminRoutes'));
    server = await listen(app);

    const login = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    cookie = sid(login.setCookie);
    assert.ok(cookie, 'expected an authenticated session cookie');
  });

  after(async () => {
    if (server) server.close();
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

  // A tenant that passes every static check (turn.scripted + whatsapp.live are
  // skipped by the route body's `skip`).
  async function newTenant() {
    const n = ++seq;
    const doc = structuredClone(deepMerge(clinicDefaults, {
      business: { display_name: 'Sunrise Dental' },
      notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
      escalation: { enabled: true, phone_numbers: ['+919000000002'] },
    }));
    const { rows } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, wa_token, waba_id, active, status)
       VALUES ($1,$2,$3,$4,$5,false,'draft') RETURNING id`,
      ['Sunrise Dental', `r-${n}-${crypto.randomBytes(3).toString('hex')}`,
        '3000000000' + String(n).padStart(4, '0'), encrypt('tok' + n), 'WABA' + n]);
    const id = rows[0].id;
    await db.query('INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1,1,$2)', [id, JSON.stringify(doc)]);
    await db.query("INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1,1,$2,'test')", [id, JSON.stringify(doc)]);
    for (let i = 0; i < 5; i++) {
      await db.query("INSERT INTO knowledge_chunks (tenant_id, content, embedding, source) VALUES ($1,$2,$3::vector,'test')",
        [id, `chunk ${i}`, ZERO_VEC]);
    }
    return id;
  }

  const P = (id, verb) => `/admin/api/tenants/${id}/${verb}`;
  // kb.retrieval hits live embeddings; skip it along with the network + dynamic checks.
  const SKIP = { skip: ['whatsapp.live', 'turn.scripted', 'kb.populated', 'kb.retrieval'] };

  const doValidate = (id) => mutate(server, { method: 'POST', path: P(id, 'validate'), cookie, body: SKIP });
  const doActivate = (id) => mutate(server, { method: 'POST', path: P(id, 'activate'), cookie, body: {} });
  const doPause = (id) => mutate(server, { method: 'POST', path: P(id, 'pause'), cookie, body: {} });

  // ── Auth + CSRF ─────────────────────────────────────────────────────────────

  it('401 unauthenticated on every lifecycle verb', async () => {
    const id = await newTenant();
    for (const verb of ['validate', 'activate', 'pause']) {
      const res = await mutate(server, { method: 'POST', path: P(id, verb), body: {} });
      assert.equal(res.status, 401, `${verb} must require auth`);
    }
  });

  it('403 without the CSRF header, authenticated', async () => {
    const id = await newTenant();
    for (const verb of ['validate', 'activate', 'pause']) {
      const res = await req(server, { method: 'POST', path: P(id, verb), cookie, body: {} });
      assert.equal(res.status, 403, `${verb} must require the admin header`);
    }
  });

  it('404 for a malformed or absent tenant id', async () => {
    assert.equal((await mutate(server, { method: 'POST', path: P('not-a-uuid', 'activate'), cookie, body: {} })).status, 404);
    const res = await mutate(server, { method: 'POST', path: P('00000000-0000-0000-0000-000000000000', 'activate'), cookie, body: {} });
    assert.equal(res.status, 404);
  });

  // ── Structured guard errors ─────────────────────────────────────────────────

  it('unknown skip name → 400, never a silent no-op that runs the live check', async () => {
    const id = await newTenant();
    const res = await mutate(server, { method: 'POST', path: P(id, 'validate'), cookie, body: { skip: ['trun.scripted'] } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unknown skip name 'trun\.scripted'/);
    assert.ok(res.body.valid.includes('turn.scripted') && res.body.valid.includes('turn'));

    const { rows } = await db.query('SELECT count(*)::int n FROM validation_runs WHERE tenant_id=$1', [id]);
    assert.equal(rows[0].n, 0, 'a rejected skip list must not have run the catalog');
  });

  it('skip aliases (kb / turn) expand exactly like the CLI', async () => {
    const id = await newTenant();
    const res = await mutate(server, { method: 'POST', path: P(id, 'validate'), cookie, body: { skip: ['kb', 'turn', 'whatsapp.live'] } });
    assert.equal(res.status, 200);
    const skipped = res.body.run.skipped.map((s) => s.name);
    for (const n of ['kb.populated', 'kb.retrieval', 'turn.scripted', 'whatsapp.live']) {
      assert.ok(skipped.includes(n), `${n} should be skipped`);
    }
  });

  it('activate on a draft → 409 NOT_VALIDATED', async () => {
    const id = await newTenant();
    const res = await doActivate(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOT_VALIDATED');
    assert.match(res.body.error, /run validate first/);
    assert.equal(res.body.from, 'draft');
  });

  it('pause on a draft → 409 INVALID_TRANSITION', async () => {
    const id = await newTenant();
    const res = await doPause(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'INVALID_TRANSITION');
  });

  it('validate → 200 with the run; activate → 200 live; pause → 200 paused', async () => {
    const id = await newTenant();

    const v = await doValidate(id);
    assert.equal(v.status, 200);
    assert.equal(v.body.to, 'validated');
    assert.equal(v.body.active, false);
    assert.equal(v.body.run.passed, true);
    // Panel-reader compatibility: the run carries the same shape the history route serves.
    assert.ok(Array.isArray(v.body.run.checks) && v.body.run.checks[0].name);
    assert.ok(Array.isArray(v.body.run.skipped));

    const a = await doActivate(id);
    assert.equal(a.status, 200);
    assert.equal(a.body.to, 'live');
    assert.equal(a.body.active, true);

    const p = await doPause(id);
    assert.equal(p.status, 200);
    assert.equal(p.body.to, 'paused');
    assert.equal(p.body.active, false);
  });

  it('validate failure → 409 VALIDATION_FAILED:<check> carrying the run', async () => {
    const id = await newTenant();
    // Break a check the static catalog will catch: drop the owner numbers.
    const { rows } = await db.query('SELECT config FROM tenant_configs WHERE tenant_id=$1', [id]);
    const broken = rows[0].config;
    broken.notifications.owner_numbers = [];
    await db.query('UPDATE tenant_configs SET config=$2 WHERE tenant_id=$1', [id, JSON.stringify(broken)]);

    const res = await doValidate(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'VALIDATION_FAILED:numbers.e164');
    assert.equal(res.body.run.passed, false);
    assert.ok(res.body.run.checks.find((c) => c.name === 'numbers.e164' && c.severity === 'fail'));

    const { rows: t } = await db.query('SELECT status FROM tenants WHERE id=$1', [id]);
    assert.equal(t[0].status, 'draft', 'a failed validation never moves status');
  });

  it('config edit after validation → activate 409 STALE_VALIDATION with both timestamps', async () => {
    const id = await newTenant();
    assert.equal((await doValidate(id)).status, 200);

    // A real versioned write through the admin PUT — bumps tenant_configs.updated_at.
    const { rows } = await db.query('SELECT config, version FROM tenant_configs WHERE tenant_id=$1', [id]);
    const cfg = rows[0].config;
    cfg.personality.custom_instructions = 'Be extra gentle.';
    const put = await mutate(server, {
      method: 'PUT', path: `/admin/api/tenants/${id}/config`, cookie,
      body: { config: cfg, expected_version: rows[0].version },
    });
    assert.equal(put.status, 200);

    const res = await doActivate(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'STALE_VALIDATION');
    assert.match(res.body.error, /config changed since validation — re-validate/);
    assert.ok(res.body.validated_at && res.body.config_updated_at);
  });

  it('activate on an already-live tenant → 409 INVALID_TRANSITION (no idempotent no-op)', async () => {
    const id = await newTenant();
    await doValidate(id);
    await doActivate(id);
    const res = await doActivate(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'INVALID_TRANSITION');
    assert.match(res.body.error, /already live/);
  });
});
