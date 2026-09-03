'use strict';

// Admin config writes record their actor (ADMIN-S3b C5, D-022).
//
// Before this, all three admin config writes called writeTenantConfig with no
// actor at all, so every admin-originated revision recorded actor_user_id NULL —
// indistinguishable in the data from a provisioning write, which is what F-A018
// filed and what ARCHITECTURE.md's "attributable to a person" claim was wrong
// about. They now pass actorPlatformUserId, and the revision row carries it.
//
// THE PORTAL HALF IS AS IMPORTANT AS THE ADMIN HALF. actorPlatformUserId is
// purely ADDITIVE: the portal's eleven call sites pass actorUserId, are not
// touched by this session, and must keep recording exactly what they recorded
// before — tenant actor set, platform column NULL. The last test pins that, and
// pins the refusal when a caller tries to set both.
//
// NEVER server.js (reminderCron sends real patient WhatsApp messages):
// adminRoutes on a bare express app with a session, against a scratch database.

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
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_cact\\_%'");
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

describe('admin config writes record their actor (C5)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, server, cookie, operatorId;
  const OLD_URL = process.env.DATABASE_URL;
  const OLD_PW = process.env.ADMIN_PASSWORD;
  const OLD_KEY = process.env.ENCRYPTION_KEY;

  async function q(sql, params) {
    const c = new Client({ connectionString: scratchCs, ssl: SSL });
    await c.connect();
    try { return await c.query(sql, params); } finally { await c.end(); }
  }
  // The actor columns of a tenant's revisions, newest first.
  async function actors(tenantId) {
    const { rows } = await q(
      `SELECT version, source, actor_user_id, actor_platform_user_id
         FROM tenant_config_revisions WHERE tenant_id = $1 ORDER BY version DESC`, [tenantId]);
    return rows;
  }
  async function newTenant() {
    const r = await q(`INSERT INTO tenants (business_name) VALUES ('C5 Clinic') RETURNING id`);
    return r.rows[0].id;
  }

  before(async () => {
    await sweep();
    scratchName = 'zyon_cact_' + crypto.randomBytes(6).toString('hex');
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
    configService = require('../../src/modules/config/configService');

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
    assert.equal(rows.length, 1, 'the login resolved exactly one operator row');
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

  it('PUT /config records the acting operator, and leaves the tenant actor NULL', async () => {
    const t = await newTenant();
    await mutate(server, {
      method: 'POST', path: `/admin/api/tenants/${t}/config/defaults`, cookie,
    });
    const seeded = await actors(t);

    const res = await mutate(server, {
      method: 'PUT', path: `/admin/api/tenants/${t}/config`, cookie,
      body: { config: { business: { display_name: 'Edited' } }, expected_version: seeded[0].version },
    });
    assert.equal(res.status, 200, res.raw);

    const rows = await actors(t);
    assert.equal(rows[0].version, seeded[0].version + 1, 'a new revision was appended');
    assert.equal(rows[0].source, 'admin');
    assert.equal(rows[0].actor_platform_user_id, operatorId, 'attributed to the operator row');
    assert.equal(rows[0].actor_user_id, null, 'and NOT to a tenant user');
  });

  it('POST /config/defaults records the acting operator', async () => {
    const t = await newTenant();
    const res = await mutate(server, {
      method: 'POST', path: `/admin/api/tenants/${t}/config/defaults`, cookie,
    });
    assert.equal(res.status, 201, res.raw);

    const rows = await actors(t);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_platform_user_id, operatorId, 'seeding defaults is an operator action');
    assert.equal(rows[0].actor_user_id, null);
  });

  it('POST /revisions/:version/restore records the acting operator on the NEW revision', async () => {
    const t = await newTenant();
    await mutate(server, { method: 'POST', path: `/admin/api/tenants/${t}/config/defaults`, cookie });
    await mutate(server, {
      method: 'PUT', path: `/admin/api/tenants/${t}/config`, cookie,
      body: { config: { business: { display_name: 'Second' } }, expected_version: 1 },
    });

    const res = await mutate(server, {
      method: 'POST', path: `/admin/api/tenants/${t}/revisions/1/restore`, cookie,
    });
    assert.equal(res.status, 201, res.raw);

    const rows = await actors(t);
    assert.equal(rows[0].version, 3, 'restore appends rather than rewinding');
    assert.equal(rows[0].actor_platform_user_id, operatorId,
      'the restore is attributed to whoever performed it, not to the original author');
    assert.equal(rows[0].actor_user_id, null);
  });

  it('a portal-shaped write is UNCHANGED: tenant actor set, platform column NULL, and both is refused', async () => {
    const t = await newTenant();
    const { rows: u } = await q(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, 'owner@c5.test', 'h', 'owner') RETURNING id`, [t]);
    const ownerId = u[0].id;

    // Byte-for-byte the shape the portal's eleven call sites use:
    // writeTenantConfig(tenantId, next, 'portal', { actorUserId: req.portalUser.id }).
    await configService.writeTenantConfig(t, { business: { display_name: 'Owner Edit' } }, 'portal',
      { actorUserId: ownerId });

    const rows = await actors(t);
    assert.equal(rows[0].source, 'portal');
    assert.equal(rows[0].actor_user_id, ownerId, 'the owner is still recorded exactly as before');
    assert.equal(rows[0].actor_platform_user_id, null,
      'and the new column stays NULL — C5 is additive, the portal path is untouched');

    // Neither is still legal: that is the provisioning case, and the CHECK accepts it.
    await configService.writeTenantConfig(t, {}, 'cli');
    assert.equal((await actors(t))[0].actor_user_id, null);
    assert.equal((await actors(t))[0].actor_platform_user_id, null);

    // Both is a programming error and reads as one, rather than arriving as a
    // bare 23514 rendered as a 500.
    await assert.rejects(
      () => configService.writeTenantConfig(t, {}, 'portal',
        { actorUserId: ownerId, actorPlatformUserId: operatorId }),
      /at most one actor/);
  });
});
