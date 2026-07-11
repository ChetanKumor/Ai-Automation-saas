'use strict';

// Admin trace query routes (Issue 22) — auth, filter validation, ordering,
// 404s. Runs over HTTP against a scratch DB bootstrapped by GENESIS from
// schema.sql — which is itself the lockstep proof that schema.sql carries
// turn_traces (the migrate path is proven on the dev DB by db:migrate + the
// capture suite). Same idiom as tenantDetail.test.js. Skips without
// DATABASE_URL. Disjoint scratch prefix: zyon_test_tr_.

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
const PREFIX = 'zyon_test_tr_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_tr\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirrors adminSecurity.test.js) ─────────────────────────────
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
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: json });
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
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

describe('turn trace admin routes (Issue 22)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, server, cookie;
  let tenantId, otherTenantId, conversationId;
  const turnIds = [];
  const CORR = 'wa_' + crypto.randomBytes(8).toString('hex');
  const OLD_PW = process.env.ADMIN_PASSWORD;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    // Lockstep proof (genesis path): schema.sql alone must produce turn_traces.
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

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
      cookie: { httpOnly: true, sameSite: 'strict' },
    }));
    app.use('/admin', require('../../src/admin/adminRoutes'));
    server = await listen(app);

    const login = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    assert.equal(login.status, 200);
    cookie = sid(login.setCookie);

    // Seed: two tenants, one conversation, four traces with a spread of
    // created_at values (ordering) and one shared correlation id.
    const { rows: [t1] } = await db.query(
      `INSERT INTO tenants (business_name) VALUES ('Trace Routes Clinic') RETURNING id`);
    tenantId = t1.id;
    const { rows: [t2] } = await db.query(
      `INSERT INTO tenants (business_name) VALUES ('Other Clinic') RETURNING id`);
    otherTenantId = t2.id;

    const { rows: [cust] } = await db.query(
      `INSERT INTO customers (tenant_id, phone) VALUES ($1, '+919000002240') RETURNING id`, [tenantId]);
    const { rows: [conv] } = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`, [tenantId, cust.id]);
    conversationId = conv.id;

    // Oldest → newest; index 3 is newest. Traces 0-2 on tenant 1; trace 3 on tenant 2.
    for (let i = 0; i < 4; i++) {
      const id = crypto.randomUUID();
      turnIds.push(id);
      await db.query(
        `INSERT INTO turn_traces
           (turn_id, tenant_id, conversation_id, channel, correlation_id, stage_timings, created_at)
         VALUES ($1, $2, $3, 'whatsapp', $4, $5, NOW() - make_interval(hours => $6))`,
        [id,
          i === 3 ? otherTenantId : tenantId,
          i === 3 ? null : conversationId,
          i < 2 ? CORR : 'wa_' + crypto.randomBytes(8).toString('hex'),
          JSON.stringify({ total_ms: 100 + i }),
          10 - i]);
    }
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    process.env.ADMIN_PASSWORD = OLD_PW;
    if (server) await new Promise((r) => server.close(r));
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  it('genesis (schema.sql) produced turn_traces with its three indexes — lockstep holds', async () => {
    const { rows } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'turn_traces' ORDER BY indexname`);
    const names = rows.map((r) => r.indexname);
    for (const idx of ['idx_turn_traces_tenant_created', 'idx_turn_traces_conversation', 'idx_turn_traces_correlation']) {
      assert.ok(names.includes(idx), `${idx} present`);
    }
  });

  it('requires auth on both endpoints', async () => {
    assert.equal((await req(server, { path: `/admin/api/traces?tenant_id=${tenantId}` })).status, 401);
    assert.equal((await req(server, { path: `/admin/api/traces/${turnIds[0]}` })).status, 401);
  });

  it('lists by tenant_id, newest first', async () => {
    const r = await req(server, { path: `/admin/api/traces?tenant_id=${tenantId}`, cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 3);
    assert.deepEqual(r.body.map((t) => t.turn_id), [turnIds[2], turnIds[1], turnIds[0]], 'newest first');
  });

  it('filters by conversation_id and by correlation_id; filters combine (AND)', async () => {
    const byConv = await req(server, { path: `/admin/api/traces?conversation_id=${conversationId}`, cookie });
    assert.equal(byConv.body.length, 3);

    const byCorr = await req(server, { path: `/admin/api/traces?correlation_id=${CORR}`, cookie });
    assert.equal(byCorr.body.length, 2);
    assert.ok(byCorr.body.every((t) => t.correlation_id === CORR));

    const combined = await req(server, {
      path: `/admin/api/traces?tenant_id=${otherTenantId}&correlation_id=${CORR}`, cookie });
    assert.equal(combined.body.length, 0, 'AND semantics — no tenant-2 trace has the shared correlation id');
  });

  it('honors limit', async () => {
    const r = await req(server, { path: `/admin/api/traces?tenant_id=${tenantId}&limit=1`, cookie });
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].turn_id, turnIds[2], 'the newest');
  });

  it('400s on garbage: no filter, bad uuid, bad correlation shape, bad limit', async () => {
    assert.equal((await req(server, { path: '/admin/api/traces', cookie })).status, 400);
    assert.equal((await req(server, { path: '/admin/api/traces?tenant_id=not-a-uuid', cookie })).status, 400);
    assert.equal((await req(server, { path: '/admin/api/traces?conversation_id=123', cookie })).status, 400);
    assert.equal((await req(server, { path: `/admin/api/traces?correlation_id=${encodeURIComponent("';DROP TABLE--")}`, cookie })).status, 400);
    assert.equal((await req(server, { path: `/admin/api/traces?tenant_id=${tenantId}&limit=0`, cookie })).status, 400);
    assert.equal((await req(server, { path: `/admin/api/traces?tenant_id=${tenantId}&limit=999`, cookie })).status, 400);
    assert.equal((await req(server, { path: `/admin/api/traces?tenant_id=${tenantId}&limit=abc`, cookie })).status, 400);
  });

  it('fetches one trace by turn_id; 404 unknown; 400 malformed', async () => {
    const ok = await req(server, { path: `/admin/api/traces/${turnIds[0]}`, cookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.turn_id, turnIds[0]);
    assert.equal(ok.body.stage_timings.total_ms, 100);

    assert.equal((await req(server, { path: `/admin/api/traces/${crypto.randomUUID()}`, cookie })).status, 404);
    assert.equal((await req(server, { path: '/admin/api/traces/nope', cookie })).status, 400);
  });
});
