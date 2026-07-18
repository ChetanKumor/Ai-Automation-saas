'use strict';

// Route-level tests for GET/POST /portal/api/config/identity (PORTAL-P2-S4) — the
// first owner-writable config surface. Exercises the real /portal router over HTTP
// against a throwaway scratch DB (same genesis pattern as the other portal tests).
// Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pidn_) so it can run in parallel with the auth /
// readiness suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • write goes THROUGH configService (new version + revision recording the
//     acting owner, INV-4) and invalidates the cache (a re-read shows the change),
//   • phone fields pass normalizePhone (INV-6): a valid one is normalized (not
//     "rewritten"), a malformed one is rejected 400 with NO write,
//   • languages ≥ 1 and name bounds are enforced 400 with NO write,
//   • tenant scope (INV-1): a crafted tenantId in query/body is inert on read AND
//     write,
//   • the saved change flows all the way into the rendered system prompt.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pidn_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pidn\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror the other portal route tests) ───────────────────────
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

describe('portal clinic profile — identity config (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, renderSystemPrompt;
  let ownerA, ownerB, ownerC;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // db + config + prompts required only AFTER the env swap so the shared pool
    // binds to the scratch DB (S1 lesson: eager import binds to the wrong DB).
    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
    renderSystemPrompt = require('../../src/modules/prompts').renderSystemPrompt;

    // A: mutated by the happy-path + INV-1-write tests. B: the cross-tenant
    // victim, given a DISTINCT name so any leak is obvious. C: the invalid-input
    // tenant — every 400 must leave it at version 1.
    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    ownerC = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });

    // Seed each with a real config (version 1). B gets a distinct name.
    await configService.writeTenantConfig(ownerA.tenantId, {}, 'cli');
    await configService.writeTenantConfig(ownerB.tenantId, { business: { display_name: 'Bravo Clinic Pvt' } }, 'cli');
    await configService.writeTenantConfig(ownerC.tenantId, {}, 'cli');
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

  async function seedOwner({ tenantName, email, password }) {
    const t = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [tenantName]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    return { tenantId, userId: u.rows[0].id, email, password };
  }
  async function versionOf(tenantId) {
    const r = await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [tenantId]);
    return r.rows[0] ? r.rows[0].version : 0;
  }
  async function latestRevision(tenantId) {
    const r = await db.query(
      'SELECT version, source, actor_user_id FROM tenant_config_revisions WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',
      [tenantId]);
    return r.rows[0];
  }

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/config/identity' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const before = await versionOf(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/config/identity', body: { display_name: 'Hacker', languages: ['en'] } });
      assert.equal(res.status, 401);
      assert.equal(await versionOf(ownerA.tenantId), before, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns the session tenant’s identity (seeded defaults)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/config/identity', cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.identity.display_name, 'New Clinic');
      assert.equal(res.body.identity.timezone, 'Asia/Kolkata');
      assert.deepEqual(res.body.identity.languages.sort(), ['en', 'hi', 'te']);
      assert.deepEqual(res.body.identity.phone_numbers, []);
      assert.equal(res.body.version, 1);
    } finally { server.close(); }
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('POST valid identity → new version, revision records the acting owner, cache invalidated, readiness returned', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/identity', cookie,
        body: {
          display_name: 'Sunrise Dental',
          address: '12 MG Road, Hyderabad',
          landmark: 'near Metro station',
          website: 'https://sunrise.example',
          phone_numbers: ['+91 98765 43210', '+91 90000 00000'],
          languages: ['te', 'en'],
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.version, 2, 'version bumped 1 → 2');
      assert.equal(res.body.section.display_name, 'Sunrise Dental');
      assert.equal(res.body.section.address, '12 MG Road, Hyderabad');
      assert.equal(res.body.section.website, 'https://sunrise.example');
      // INV-6: valid numbers are NORMALIZED to E.164 (spaces stripped), not rewritten away.
      assert.deepEqual(res.body.section.phone_numbers, ['+919876543210', '+919000000000']);
      assert.deepEqual(res.body.section.languages.sort(), ['en', 'te']);
      assert.ok(res.body.readiness, 'readiness snapshot returned for the header/ring');
      assert.ok('status' in res.body.readiness);

      // INV-4: the revision is attributed to the acting owner, source 'portal'.
      const rev = await latestRevision(ownerA.tenantId);
      assert.equal(rev.version, 2);
      assert.equal(rev.source, 'portal');
      assert.equal(rev.actor_user_id, ownerA.userId);

      // Cache invalidated → a fresh GET shows the new values (not a stale cache hit).
      const get = await req(server, { method: 'GET', path: '/portal/api/config/identity', cookie });
      assert.equal(get.body.identity.display_name, 'Sunrise Dental');
      assert.equal(get.body.version, 2);

      // Other sections were preserved (not reset to defaults by a partial write):
      // booking.advance_days is a default we never touched.
      const cfg = await configService.getTenantConfig(ownerA.tenantId);
      assert.equal(cfg.booking.advance_days, 30, 'untouched section survives the identity write');
    } finally { server.close(); }
  });

  it('the saved clinic name flows into the rendered system prompt (config → prompt)', async () => {
    const cfg = await configService.getTenantConfig(ownerA.tenantId);
    const prompt = renderSystemPrompt(cfg, { channel: 'whatsapp' });
    assert.match(prompt, /Sunrise Dental/, 'prompt preview reflects the saved clinic name');
  });

  // ── Validation: 400 + NO write ──────────────────────────────────────────────
  it('malformed phone → 400 with a field error and NO write (INV-6)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/identity', cookie,
        body: { display_name: 'Charlie Clinic', phone_numbers: ['not a phone'], languages: ['en'] },
      });
      assert.equal(res.status, 400);
      assert.ok(Array.isArray(res.body.fields));
      assert.ok(res.body.fields.some((f) => f.field.indexOf('phone_numbers') === 0), 'a phone field error is named');
      assert.equal(await versionOf(ownerC.tenantId), before, 'invalid phone writes nothing');
    } finally { server.close(); }
  });

  it('zero languages → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/identity', cookie,
        body: { display_name: 'Charlie Clinic', languages: [] },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'languages'));
      assert.equal(await versionOf(ownerC.tenantId), before, 'zero languages writes nothing');
    } finally { server.close(); }
  });

  it('empty name and over-long name → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);

      const empty = await req(server, {
        method: 'POST', path: '/portal/api/config/identity', cookie,
        body: { display_name: '   ', languages: ['en'] },
      });
      assert.equal(empty.status, 400);
      assert.ok(empty.body.fields.some((f) => f.field === 'display_name'));

      const long = await req(server, {
        method: 'POST', path: '/portal/api/config/identity', cookie,
        body: { display_name: 'x'.repeat(121), languages: ['en'] },
      });
      assert.equal(long.status, 400);
      assert.ok(long.body.fields.some((f) => f.field === 'display_name'));

      assert.equal(await versionOf(ownerC.tenantId), before, 'neither invalid name writes anything');
    } finally { server.close(); }
  });

  // ── INV-1: cross-tenant (mandatory) ─────────────────────────────────────────
  it('READ is scoped to the session tenant; a crafted tenantId is inert (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      // Query, header, and body injections of B's id must all be ignored.
      const q = await req(server, { method: 'GET', path: `/portal/api/config/identity?tenantId=${ownerB.tenantId}`, cookie });
      assert.equal(q.status, 200);
      assert.notEqual(q.body.identity.display_name, 'Bravo Clinic Pvt', 'must never surface B’s identity');
      assert.equal(q.body.identity.display_name, 'Sunrise Dental', 'A sees only its own');

      const h = await req(server, { method: 'GET', path: '/portal/api/config/identity', cookie, headers: { 'X-Tenant-Id': ownerB.tenantId } });
      assert.equal(h.body.identity.display_name, 'Sunrise Dental');
    } finally { server.close(); }
  });

  it('WRITE is scoped to the session tenant; a crafted tenantId in the body cannot touch another tenant (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const bBefore = await versionOf(ownerB.tenantId);

      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/identity', cookie,
        body: { tenantId: ownerB.tenantId, display_name: 'Injected Name', languages: ['en'] },
      });
      assert.equal(res.status, 200);
      // The write landed on A (the session tenant), not B.
      assert.equal(res.body.section.display_name, 'Injected Name');
      const revA = await latestRevision(ownerA.tenantId);
      assert.equal(revA.actor_user_id, ownerA.userId);

      // B is completely untouched: same version, same name.
      assert.equal(await versionOf(ownerB.tenantId), bBefore, 'B’s version is unchanged');
      const bCfg = await configService.getTenantConfig(ownerB.tenantId);
      assert.equal(bCfg.business.display_name, 'Bravo Clinic Pvt', 'B’s identity is unchanged');
    } finally { server.close(); }
  });
});
