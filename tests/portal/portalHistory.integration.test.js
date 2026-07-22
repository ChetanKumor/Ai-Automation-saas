'use strict';

// Route-level tests for GET /portal/api/history, GET /portal/api/history/:version,
// and POST /portal/api/history/:version/restore (PORTAL-P6-S17) — configuration
// history + restore-as-new-version. Exercises the real /portal router over HTTP
// against a throwaway scratch DB (same genesis pattern as the other portal
// suites). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_phst_) so it can run in parallel with the other
// portal suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • revisions list newest-first with correct actor attribution (owner email/
//     "You" vs "Prantivo" for a NULL actor),
//   • the changed-section summary reflects what actually changed between
//     adjacent versions,
//   • WIZARD NOISE (mandatory, PORTAL-P6-S16 known gap): onboarding step
//     transitions never appear as revisions,
//   • restore writes a NEW version copying the old one — the old revision row
//     is untouched, config content matches, readiness is re-read,
//   • restore without the confirmation flag → 400, nothing written,
//   • NO RAW CONFIG (mandatory): the version-detail response carries only the
//     owner-safe projection, never raw config keys/internal field names,
//   • tenant scope (INV-1, mandatory): a crafted tenantId/version from another
//     tenant is inert — list, detail, and restore all 404/scope correctly.

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
const PREFIX = 'zyon_phst_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_phst\\_%'");
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

// Raw config keys that must NEVER cross the version-detail wire — internal
// field/section names an owner never sees (S15 precedent).
const RAW_CONFIG_KEYS = ['tools', 'crm', 'whatsapp', 'recording_consent', 'notifications', 'meta'];

describe('portal history — configuration history + restore (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService;
  let ownerA, ownerB;

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
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha-hist.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo-hist.test', password: 'bravo-pass-2' });
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

  // ── Unauthenticated ──────────────────────────────────────────────────────────
  it('unauthenticated GET/POST → 401 on all three routes', async () => {
    const server = await start();
    try {
      assert.equal((await req(server, { method: 'GET', path: '/portal/api/history' })).status, 401);
      assert.equal((await req(server, { method: 'GET', path: '/portal/api/history/1' })).status, 401);
      assert.equal((await req(server, { method: 'POST', path: '/portal/api/history/1/restore', body: { confirm: true } })).status, 401);
    } finally { server.close(); }
  });

  // ── Empty state ──────────────────────────────────────────────────────────────
  it('a tenant with no config writes yet has an empty history list', async () => {
    const fresh = await seedOwner({ tenantName: 'Fresh Clinic', email: 'fresh@fresh-hist.test', password: 'fresh-pass-1' });
    const server = await start();
    try {
      const cookie = await authedCookie(server, fresh.email, fresh.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/history', cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.revisions, []);
    } finally { server.close(); }
  });

  // ── List: attribution + section summary ─────────────────────────────────────
  describe('list: attribution + changed-section summary', () => {
    it('operator/CLI writes attribute to "Prantivo"; portal writes attribute to "You"', async () => {
      const t = await seedOwner({ tenantName: 'Delta Clinic', email: 'delta@delta-hist.test', password: 'delta-pass-1' });
      await configService.writeTenantConfig(t.tenantId, {}, 'cli'); // v1, actor NULL
      await configService.writeTenantConfig(t.tenantId,
        { business: { display_name: 'Delta Dental' } }, 'portal', { actorUserId: t.userId }); // v2, actor = owner

      const server = await start();
      try {
        const cookie = await authedCookie(server, t.email, t.password);
        const res = await req(server, { method: 'GET', path: '/portal/api/history', cookie });
        assert.equal(res.status, 200);
        assert.equal(res.body.revisions.length, 2);
        // newest first
        assert.equal(res.body.revisions[0].version, 2);
        assert.equal(res.body.revisions[0].actor, 'You');
        assert.equal(res.body.revisions[0].current, true);
        assert.equal(res.body.revisions[1].version, 1);
        assert.equal(res.body.revisions[1].actor, 'Prantivo');
        assert.equal(res.body.revisions[1].current, false);
      } finally { server.close(); }
    });

    it('the changed-section summary names the page(s) that actually changed', async () => {
      const t = await seedOwner({ tenantName: 'Echo Clinic', email: 'echo@echo-hist.test', password: 'echo-pass-1' });
      await configService.writeTenantConfig(t.tenantId, {}, 'cli'); // v1 baseline
      await configService.writeTenantConfig(t.tenantId,
        { pricing: { consultation_fee: 500 } }, 'portal', { actorUserId: t.userId }); // v2: pricing only
      await configService.writeTenantConfig(t.tenantId,
        { hours: { mon: { open: '10:00', close: '14:00' } }, business: { display_name: 'Echo Dental' } },
        'portal', { actorUserId: t.userId }); // v3: hours + clinic profile

      const server = await start();
      try {
        const cookie = await authedCookie(server, t.email, t.password);
        const res = await req(server, { method: 'GET', path: '/portal/api/history', cookie });
        const byVersion = (v) => res.body.revisions.find((r) => r.version === v);

        assert.equal(byVersion(1).summary, 'Configuration created', 'first-ever revision has no prior version to diff');

        assert.deepEqual(byVersion(2).sections, ['Pricing']);
        assert.ok(byVersion(2).fields.includes('consultation_fee'));

        const v3sections = byVersion(3).sections;
        assert.ok(v3sections.includes('Hours & holidays'));
        assert.ok(v3sections.includes('Clinic profile'));
      } finally { server.close(); }
    });
  });

  // ── WIZARD NOISE (mandatory — PORTAL-P6-S16 known gap, fixed at the source) ──
  it('onboarding step navigation never creates a revision', async () => {
    const t = await seedOwner({ tenantName: 'Foxtrot Clinic', email: 'fox@fox-hist.test', password: 'fox-pass-1' });
    const server = await start();
    try {
      const cookie = await authedCookie(server, t.email, t.password);

      // Walk the whole wizard (Back/Continue style — repeated, non-monotonic).
      for (const step of [0, 1, 2, 3, 2, 3, 4, 5, 6]) {
        const res = await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie, body: { step } });
        assert.equal(res.status, 200);
      }

      const history = await req(server, { method: 'GET', path: '/portal/api/history', cookie });
      assert.deepEqual(history.body.revisions, [], 'nine step transitions produced zero revisions');

      const revCount = (await db.query(
        'SELECT count(*)::int AS n FROM tenant_config_revisions WHERE tenant_id=$1', [t.tenantId])).rows[0].n;
      assert.equal(revCount, 0);

      // A real section save still versions normally, and shows up exactly once.
      await configService.writeTenantConfig(t.tenantId, { business: { display_name: 'Foxtrot Dental' } },
        'portal', { actorUserId: t.userId });
      const after = await req(server, { method: 'GET', path: '/portal/api/history', cookie });
      assert.equal(after.body.revisions.length, 1);
    } finally { server.close(); }
  });

  // ── Version detail: owner-safe projection, no raw config ────────────────────
  describe('version detail', () => {
    it('returns the owner-safe snapshot of a PAST version, not the current one', async () => {
      const t = await seedOwner({ tenantName: 'Golf Clinic', email: 'golf@golf-hist.test', password: 'golf-pass-1' });
      await configService.writeTenantConfig(t.tenantId,
        { pricing: { consultation_fee: 400 } }, 'portal', { actorUserId: t.userId }); // v1
      await configService.writeTenantConfig(t.tenantId,
        { pricing: { consultation_fee: 900 } }, 'portal', { actorUserId: t.userId }); // v2 (current)

      const server = await start();
      try {
        const cookie = await authedCookie(server, t.email, t.password);
        const v1 = await req(server, { method: 'GET', path: '/portal/api/history/1', cookie });
        assert.equal(v1.status, 200);
        assert.equal(v1.body.sections.pricing.fees.consultation_fee, 400, 'v1 snapshot shows v1 price, not the live one');
        assert.equal(v1.body.is_current, false);

        const v2 = await req(server, { method: 'GET', path: '/portal/api/history/2', cookie });
        assert.equal(v2.body.sections.pricing.fees.consultation_fee, 900);
        assert.equal(v2.body.is_current, true);
      } finally { server.close(); }
    });

    it('never exposes raw config keys, doctors, FAQs, or protections (owner-safe projection only)', async () => {
      const t = await seedOwner({ tenantName: 'Hotel Clinic', email: 'hotel@hotel-hist.test', password: 'hotel-pass-1' });
      await configService.writeTenantConfig(t.tenantId, {
        tools: { booking: true }, crm: { extraction: { voice: 'per_message' } },
        whatsapp: { enabled: true }, notifications: { owner_numbers: ['+919000000099'] },
      }, 'portal', { actorUserId: t.userId });

      const server = await start();
      try {
        const cookie = await authedCookie(server, t.email, t.password);
        const res = await req(server, { method: 'GET', path: '/portal/api/history/1', cookie });
        assert.equal(res.status, 200);
        const raw = JSON.stringify(res.body);
        for (const key of RAW_CONFIG_KEYS) {
          assert.ok(!raw.includes(`"${key}"`), `raw config key "${key}" must never cross the wire`);
        }
        assert.equal(res.body.sections.doctors, undefined, 'doctors have no revision trail — never shown as historical');
        assert.equal(res.body.sections.faqs, undefined, 'FAQs have no revision trail — never shown as historical');
        assert.equal(res.body.sections.protections, undefined);
      } finally { server.close(); }
    });

    it('404s on a non-existent version', async () => {
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerA.email, ownerA.password);
        const res = await req(server, { method: 'GET', path: '/portal/api/history/999', cookie });
        assert.equal(res.status, 404);
      } finally { server.close(); }
    });
  });

  // ── Restore ──────────────────────────────────────────────────────────────────
  describe('restore', () => {
    it('writes a NEW version copying the old one; the old revision is untouched', async () => {
      const t = await seedOwner({ tenantName: 'India Clinic', email: 'india@india-hist.test', password: 'india-pass-1' });
      await configService.writeTenantConfig(t.tenantId,
        { business: { display_name: 'India Dental v1' } }, 'portal', { actorUserId: t.userId }); // v1
      await configService.writeTenantConfig(t.tenantId,
        { business: { display_name: 'India Dental v2' } }, 'portal', { actorUserId: t.userId }); // v2 (current)

      const v1Before = (await db.query(
        'SELECT config FROM tenant_config_revisions WHERE tenant_id=$1 AND version=1', [t.tenantId])).rows[0].config;

      const server = await start();
      try {
        const cookie = await authedCookie(server, t.email, t.password);
        const res = await req(server, {
          method: 'POST', path: '/portal/api/history/1/restore', cookie, body: { confirm: true },
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.version, 3, 'restore APPENDS a new version, never overwrites');
        assert.ok(res.body.readiness, 'readiness is re-read and returned');

        const revCount = (await db.query(
          'SELECT count(*)::int AS n FROM tenant_config_revisions WHERE tenant_id=$1', [t.tenantId])).rows[0].n;
        assert.equal(revCount, 3, 'v1 and v2 are both still there — restore never deletes');

        const v1After = (await db.query(
          'SELECT config FROM tenant_config_revisions WHERE tenant_id=$1 AND version=1', [t.tenantId])).rows[0].config;
        assert.deepEqual(v1After, v1Before, 'the restored-FROM revision is byte-identical afterward — append-only');

        const v3 = (await db.query(
          'SELECT config FROM tenant_config_revisions WHERE tenant_id=$1 AND version=3', [t.tenantId])).rows[0].config;
        assert.equal(v3.business.display_name, 'India Dental v1', 'the new version carries v1\'s content');

        const head = (await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [t.tenantId])).rows[0];
        assert.equal(head.version, 3, 'the live document now points at the restored content');
      } finally { server.close(); }
    });

    it('without the confirmation flag → 400, nothing written', async () => {
      const t = await seedOwner({ tenantName: 'Juliet Clinic', email: 'juliet@juliet-hist.test', password: 'juliet-pass-1' });
      await configService.writeTenantConfig(t.tenantId, {}, 'cli'); // v1

      const server = await start();
      try {
        const cookie = await authedCookie(server, t.email, t.password);
        for (const body of [{}, { confirm: false }, { confirm: 'yes' }]) {
          const res = await req(server, { method: 'POST', path: '/portal/api/history/1/restore', cookie, body });
          assert.equal(res.status, 400);
        }
        const head = (await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [t.tenantId])).rows[0];
        assert.equal(head.version, 1, 'nothing written without confirmation');
      } finally { server.close(); }
    });

    it('404s restoring a non-existent version', async () => {
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerA.email, ownerA.password);
        const res = await req(server, {
          method: 'POST', path: '/portal/api/history/999/restore', cookie, body: { confirm: true },
        });
        assert.equal(res.status, 404);
      } finally { server.close(); }
    });
  });

  // ── INV-1: cross-tenant ──────────────────────────────────────────────────────
  describe('cross-tenant (INV-1)', () => {
    it('list is scoped to the session tenant; a crafted tenantId query param is inert', async () => {
      const t = await seedOwner({ tenantName: 'Kilo Clinic', email: 'kilo@kilo-hist.test', password: 'kilo-pass-1' });
      await configService.writeTenantConfig(t.tenantId, { business: { display_name: 'Kilo Dental' } }, 'cli');

      const server = await start();
      try {
        const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
        const res = await req(server, {
          method: 'GET', path: `/portal/api/history?tenantId=${t.tenantId}`, cookie: cookieB,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.revisions, [], 'B sees B\'s own (empty) history, never Kilo\'s');
      } finally { server.close(); }
    });

    it('detail on another tenant\'s version → 404, never that tenant\'s data', async () => {
      const t = await seedOwner({ tenantName: 'Lima Clinic', email: 'lima@lima-hist.test', password: 'lima-pass-1' });
      await configService.writeTenantConfig(t.tenantId, { business: { display_name: 'Lima Secret Name' } }, 'cli'); // v1

      const server = await start();
      try {
        const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
        const res = await req(server, { method: 'GET', path: '/portal/api/history/1', cookie: cookieB });
        assert.equal(res.status, 404);
      } finally { server.close(); }
    });

    it('restore on another tenant\'s version → 404, nothing written to either tenant', async () => {
      const t = await seedOwner({ tenantName: 'Mike Clinic', email: 'mike@mike-hist.test', password: 'mike-pass-1' });
      await configService.writeTenantConfig(t.tenantId, { business: { display_name: 'Mike Dental' } }, 'cli'); // v1

      const server = await start();
      try {
        const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
        const res = await req(server, {
          method: 'POST', path: '/portal/api/history/1/restore', cookie: cookieB, body: { confirm: true },
        });
        assert.equal(res.status, 404);

        const head = (await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [t.tenantId])).rows[0];
        assert.equal(head.version, 1, 'Mike\'s tenant is completely untouched by B\'s crafted restore');
      } finally { server.close(); }
    });
  });
});
