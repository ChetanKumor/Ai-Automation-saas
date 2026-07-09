'use strict';

// Route-level tests for the Issue 25 tenant-detail admin API. Exercises the real
// routes over HTTP against a throwaway scratch DB (same genesis pattern as
// configService.integration.test.js), with an authenticated session. UI stays
// thin — the coverage lives here. Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { renderSystemPrompt, estimateTokens } = require('../../src/modules/prompts');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon_test_%'");
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
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

describe('tenant detail admin API (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, app, server, cookie;
  const OLD_PW = process.env.ADMIN_PASSWORD;

  before(async () => {
    await sweep();
    scratchName = 'zyon_test_' + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind the pooled db module (and everything requiring it) to the scratch DB
    // BEFORE first require. adminRoutes → db/configService/tenantService inherit it.
    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');

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

  async function newTenant(extra = {}) {
    const { rows } = await db.query(
      `INSERT INTO tenants (business_name, active, ai_prompt) VALUES ($1, true, $2) RETURNING id`,
      [extra.name || 'T', extra.ai_prompt || null]);
    return rows[0].id;
  }
  const P = (id, suffix = '') => `/admin/api/tenants/${id}${suffix}`;

  // ── Auth + CSRF ─────────────────────────────────────────────────────────────
  it('GET config → 401 unauthenticated', async () => {
    const t = await newTenant();
    const res = await req(server, { method: 'GET', path: P(t, '/config') });
    assert.equal(res.status, 401);
  });

  it('PUT config without CSRF header → 403', async () => {
    const t = await newTenant();
    const res = await req(server, { method: 'PUT', path: P(t, '/config'), cookie, body: { config: {}, expected_version: 0 } });
    assert.equal(res.status, 403);
  });

  it('POST defaults without CSRF header → 403', async () => {
    const t = await newTenant();
    const res = await req(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    assert.equal(res.status, 403);
  });

  // ── Not-found states ────────────────────────────────────────────────────────
  it('malformed tenant id → clean 404', async () => {
    const res = await req(server, { method: 'GET', path: P('not-a-uuid', '/config'), cookie });
    assert.equal(res.status, 404);
  });

  it('well-formed but absent tenant id → 404', async () => {
    const res = await req(server, { method: 'GET', path: P('00000000-0000-0000-0000-0000000000ff', '/config'), cookie });
    assert.equal(res.status, 404);
  });

  // ── Defaults seeding ────────────────────────────────────────────────────────
  it('seed defaults works once (201), 409 on the second attempt', async () => {
    const t = await newTenant();
    const first = await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    assert.equal(first.status, 201);
    assert.equal(first.body.version, 1);

    const second = await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    assert.equal(second.status, 409);
  });

  // ── GET config shape ────────────────────────────────────────────────────────
  it('GET config reports has_config false → true and surfaces ai_prompt presence', async () => {
    const t = await newTenant({ ai_prompt: 'legacy prompt here' });
    let res = await req(server, { method: 'GET', path: P(t, '/config'), cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.has_config, false);
    assert.equal(res.body.has_ai_prompt, true, 'legacy override flagged');
    assert.equal(res.body.version, null);

    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    res = await req(server, { method: 'GET', path: P(t, '/config'), cookie });
    assert.equal(res.body.has_config, true);
    assert.equal(res.body.version, 1);
    assert.ok(res.body.config && res.body.config.business);
  });

  // ── PUT happy path ──────────────────────────────────────────────────────────
  it('PUT happy path bumps version and snapshots a revision', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie }); // v1
    const cfg = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;
    cfg.retention_days = 200;

    const put = await mutate(server, { method: 'PUT', path: P(t, '/config'), cookie, body: { config: cfg, expected_version: 1 } });
    assert.equal(put.status, 200);
    assert.equal(put.body.version, 2);

    const n = (await db.query('SELECT count(*)::int AS n FROM tenant_config_revisions WHERE tenant_id=$1', [t])).rows[0].n;
    assert.equal(n, 2, 'a revision per write');
    const head = (await db.query('SELECT config FROM tenant_configs WHERE tenant_id=$1', [t])).rows[0].config;
    assert.equal(head.retention_days, 200);
  });

  // ── 422 with Zod paths ──────────────────────────────────────────────────────
  it('PUT a known-bad config → 422 carrying path-level issues', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie }); // v1
    const cfg = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;
    cfg.retention_days = 5; // schema min is 30

    const put = await mutate(server, { method: 'PUT', path: P(t, '/config'), cookie, body: { config: cfg, expected_version: 1 } });
    assert.equal(put.status, 422);
    assert.ok(Array.isArray(put.body.issues) && put.body.issues.length > 0);
    assert.ok(put.body.issues.some((i) => i.path === 'retention_days'), 'issue names the offending path');
  });

  // ── 409 optimistic concurrency ──────────────────────────────────────────────
  it('two saves against the same expected_version → second is 409 with current_version', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie }); // v1
    const cfg = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;

    const a = await mutate(server, { method: 'PUT', path: P(t, '/config'), cookie, body: { config: cfg, expected_version: 1 } });
    assert.equal(a.status, 200);
    assert.equal(a.body.version, 2);

    const b = await mutate(server, { method: 'PUT', path: P(t, '/config'), cookie, body: { config: cfg, expected_version: 1 } });
    assert.equal(b.status, 409);
    assert.equal(b.body.current_version, 2);
  });

  // ── Restore (append-only) ───────────────────────────────────────────────────
  it('restore revision N creates version N+1 equal to N, source admin', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie }); // v1
    const v1cfg = (await req(server, { method: 'GET', path: P(t, `/revisions/1`), cookie })).body;

    // Move head forward so restore is a real rewind-of-content, not a no-op.
    const cfg = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;
    cfg.retention_days = 111;
    await mutate(server, { method: 'PUT', path: P(t, '/config'), cookie, body: { config: cfg, expected_version: 1 } }); // v2

    const res = await mutate(server, { method: 'POST', path: P(t, '/revisions/1/restore'), cookie });
    assert.equal(res.status, 201);
    assert.equal(res.body.version, 3, 'append-only: new version, not a rewind');

    const rev3 = (await db.query('SELECT config, source FROM tenant_config_revisions WHERE tenant_id=$1 AND version=3', [t])).rows[0];
    assert.equal(rev3.source, 'admin');
    assert.deepEqual(rev3.config, v1cfg, 'restored config equals revision 1');
  });

  it('restore of an absent revision → 404', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    const res = await mutate(server, { method: 'POST', path: P(t, '/revisions/99/restore'), cookie });
    assert.equal(res.status, 404);
  });

  // ── Prompt preview parity + non-persistence ─────────────────────────────────
  it('preview equals renderSystemPrompt for the same inputs', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    const cfg = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;

    for (const channel of ['whatsapp', 'voice']) {
      const res = await req(server, { method: 'GET', path: P(t, `/prompt-preview?channel=${channel}`), cookie });
      assert.equal(res.status, 200);
      const expected = renderSystemPrompt(cfg, { channel });
      assert.equal(res.body.prompt, expected, `${channel} prompt matches renderer`);
      assert.equal(res.body.est_tokens, estimateTokens(expected));
    }
  });

  it('lang override previews but never persists', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: P(t, '/config/defaults'), cookie });
    const before = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;
    assert.equal(before.languages.default, 'en');

    const overridden = renderSystemPrompt(Object.assign(structuredClone(before), { languages: Object.assign({}, before.languages, { default: 'hi' }) }), { channel: 'whatsapp' });
    const res = await req(server, { method: 'GET', path: P(t, `/prompt-preview?channel=whatsapp&lang=hi`), cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.prompt, overridden, 'preview reflects the lang override');

    const after = (await req(server, { method: 'GET', path: P(t, '/config'), cookie })).body.config;
    assert.equal(after.languages.default, 'en', 'stored default unchanged — override was copy-only');
  });

  it('preview on a configless tenant → 404', async () => {
    const t = await newTenant();
    const res = await req(server, { method: 'GET', path: P(t, '/prompt-preview?channel=whatsapp'), cookie });
    assert.equal(res.status, 404);
  });
});
