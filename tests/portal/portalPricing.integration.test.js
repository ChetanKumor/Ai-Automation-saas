'use strict';

// Route-level tests for GET/POST /portal/api/config/pricing (PORTAL-P2-S6) — the
// third owner-writable config surface. Exercises the real /portal router over HTTP
// against a throwaway scratch DB (same genesis pattern as the other portal tests).
// Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pprc_) so it can run in parallel with the auth /
// readiness / identity / hours suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • write goes THROUGH configService (new version + revision recording the
//     acting owner, INV-4) and invalidates the cache (a re-read shows the change),
//   • READ-MERGE: saving pricing leaves identity and hours untouched (the S4 catch
//     — writeTenantConfig materialises against clinicDefaults, not the live doc),
//   • ARRAY-REPLACE: removing a treatment actually removes it (no ghost merge),
//   • invalid input (fees, caps, duplicate names, insurance detail) → 400, NO write,
//   • tenant scope (INV-1): a crafted tenantId in query/body is inert on read AND
//     write,
//   • the saved prices flow all the way into the rendered system prompt, and
//     clearing them removes the block entirely.
//
// The config → prompt assertions call renderSystemPrompt(getTenantConfig(id))
// directly: that is byte-for-byte the work the admin prompt-preview endpoint does
// (adminRoutes `GET /api/tenants/:id/prompt-preview`), without dragging admin auth
// into a portal suite.

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
const PREFIX = 'zyon_pprc_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pprc\\_%'");
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

describe('portal pricing — pricing config (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
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
    // victim, given distinct prices so any leak is obvious. C: the invalid-input
    // tenant — every 400 must leave it at its seeded version.
    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    ownerC = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });

    // Seed A with identity + hours ALREADY set, so the read-merge regression has
    // real neighbouring sections to lose if the pricing write is wrong.
    await configService.writeTenantConfig(ownerA.tenantId, {
      business: { display_name: 'Sunrise Dental', address: '12 MG Road, Hyderabad' },
      hours: { sun: { open: '10:00', close: '13:00' }, holidays: [{ date: '2026-08-15', name: 'Independence Day' }] },
    }, 'cli');
    await configService.writeTenantConfig(ownerB.tenantId, {
      pricing: { consultation_fee: 7777, treatments: [{ name: 'Bravo-only procedure', price: 8888 }] },
    }, 'cli');
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
  // The exact work the admin prompt-preview endpoint does.
  async function preview(tenantId, channel = 'whatsapp') {
    return renderSystemPrompt(await configService.getTenantConfig(tenantId), { channel });
  }
  const VALID = {
    consultation_fee: '500',
    follow_up_fee: '300',
    emergency_fee: '1200',
    payment_methods: ['upi', 'cash'],
    insurance: { stance: 'selected_insurers', note: 'Star Health, HDFC Ergo' },
    treatments: [
      { name: 'Root canal', price: '4000', price_from: true, duration_minutes: '45', notes: '', archived: false },
      { name: 'Teeth cleaning', price: '1500', price_from: false, duration_minutes: '', notes: 'includes polish', archived: false },
      { name: 'Retired scaling', price: '999', price_from: false, duration_minutes: '', notes: '', archived: true },
    ],
  };

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/config/pricing' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const before = await versionOf(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/config/pricing', body: VALID });
      assert.equal(res.status, 401);
      assert.equal(await versionOf(ownerA.tenantId), before, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns the session tenant’s pricing — empty by default, fees null not 0', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/config/pricing', cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.pricing.consultation_fee, null, 'unset fee is null, never coerced to 0');
      assert.equal(res.body.pricing.follow_up_fee, null);
      assert.deepEqual(res.body.pricing.payment_methods, []);
      assert.deepEqual(res.body.pricing.treatments, []);
      assert.equal(res.body.pricing.insurance.stance, 'not_accepted');
      assert.equal(res.body.version, 1);
    } finally { server.close(); }
  });

  it('a clinic with no prices renders NO pricing block in its prompt', async () => {
    const prompt = await preview(ownerA.tenantId);
    assert.ok(!prompt.includes('Prices'), 'nothing priced → no block, so the uncertainty fallback stands');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('POST valid pricing → new version, revision records the acting owner, cache invalidated, readiness returned', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = await versionOf(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/config/pricing', cookie, body: VALID });

      assert.equal(res.status, 200);
      assert.equal(res.body.version, before + 1, 'version bumped');
      assert.equal(res.body.section.consultation_fee, 500, 'string input stored as an integer');
      assert.equal(res.body.section.follow_up_fee, 300);
      assert.equal(res.body.section.emergency_fee, 1200);
      assert.deepEqual(res.body.section.payment_methods, ['upi', 'cash']);
      assert.equal(res.body.section.insurance.stance, 'selected_insurers');
      assert.equal(res.body.section.treatments.length, 3, 'archived rows are kept, never dropped');
      const root = res.body.section.treatments.find((t) => t.name === 'Root canal');
      assert.equal(root.price, 4000);
      assert.equal(root.price_from, true);
      assert.equal(root.duration_minutes, 45);
      assert.ok(res.body.readiness, 'readiness snapshot returned for the header/ring');
      assert.ok('status' in res.body.readiness);

      // INV-4: the revision is attributed to the acting owner, source 'portal'.
      const rev = await latestRevision(ownerA.tenantId);
      assert.equal(rev.version, res.body.version);
      assert.equal(rev.source, 'portal');
      assert.equal(rev.actor_user_id, ownerA.userId);

      // Cache invalidated → a fresh GET shows the new values.
      const get = await req(server, { method: 'GET', path: '/portal/api/config/pricing', cookie });
      assert.equal(get.body.pricing.consultation_fee, 500);
      assert.equal(get.body.version, res.body.version);
    } finally { server.close(); }
  });

  // ── READ-MERGE regression (mandatory) ───────────────────────────────────────
  it('saving pricing leaves identity and hours completely unchanged (read-merge)', async () => {
    // writeTenantConfig materialises against clinicDefaults, NOT the live document
    // (the S4 catch). A pricing write that forgot to read-merge would silently
    // reset the clinic's name, address, and Sunday hours back to defaults.
    const cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.business.display_name, 'Sunrise Dental', 'identity survives a pricing write');
    assert.equal(cfg.business.address, '12 MG Road, Hyderabad');
    assert.deepEqual(cfg.hours.sun, { open: '10:00', close: '13:00' }, 'a non-default Sunday survives');
    assert.equal(cfg.hours.holidays.length, 1, 'holidays survive');
    assert.equal(cfg.hours.holidays[0].name, 'Independence Day');
    assert.equal(cfg.booking.advance_days, 30, 'untouched section still at its default');
  });

  // ── config → prompt, end to end ─────────────────────────────────────────────
  it('the saved prices appear VERBATIM in the rendered prompt, immediately after save', async () => {
    const prompt = await preview(ownerA.tenantId);
    assert.ok(prompt.includes('- Consultation: ₹500'));
    assert.ok(prompt.includes('- Follow-up visit: ₹300'));
    assert.ok(prompt.includes('- Emergency visit: ₹1200'));
    assert.ok(prompt.includes('- Root canal: from ₹4000 (about 45 minutes)'));
    assert.ok(prompt.includes('- Teeth cleaning: ₹1500 (includes polish)'));
    assert.ok(prompt.includes('Payment accepted: UPI, cash.'));
    assert.ok(prompt.includes('Insurance: accepted from selected insurers — Star Health, HDFC Ergo'));
    assert.match(prompt, /If a price is not listed above, do not state a number/);
    // The archived row must never reach the prompt.
    assert.ok(!prompt.includes('Retired scaling'), 'archived treatment is not quotable');
    assert.ok(!prompt.includes('999'));
  });

  it('editing one treatment price is reflected in the next prompt render', async () => {
    // The v1 acceptance criterion: edit a price, and the receptionist quotes the
    // new one on the very next message.
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const body = JSON.parse(JSON.stringify(VALID));
      body.treatments[1].price = '1800'; // teeth cleaning 1500 → 1800
      const res = await req(server, { method: 'POST', path: '/portal/api/config/pricing', cookie, body });
      assert.equal(res.status, 200);

      const prompt = await preview(ownerA.tenantId);
      assert.ok(prompt.includes('- Teeth cleaning: ₹1800 (includes polish)'), 'new price quoted');
      assert.ok(!prompt.includes('₹1500'), 'old price is gone — no stale cache, no ghost');
    } finally { server.close(); }
  });

  // ── ARRAY-REPLACE ───────────────────────────────────────────────────────────
  it('removing a treatment actually removes it — arrays REPLACE, never element-merge', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const body = JSON.parse(JSON.stringify(VALID));
      body.treatments = [body.treatments[0]]; // keep Root canal only
      const res = await req(server, { method: 'POST', path: '/portal/api/config/pricing', cookie, body });

      assert.equal(res.status, 200);
      assert.equal(res.body.section.treatments.length, 1, 'the removed rows are gone from the response');
      assert.equal(res.body.section.treatments[0].name, 'Root canal');

      const cfg = await configService.getTenantConfig(ownerA.tenantId);
      assert.equal(cfg.pricing.treatments.length, 1, 'and gone from the stored document');

      const prompt = await preview(ownerA.tenantId);
      assert.ok(!prompt.includes('Teeth cleaning'), 'and gone from the prompt — no ghost merge');
    } finally { server.close(); }
  });

  it('clearing every price removes the pricing block from the prompt entirely', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: {
          consultation_fee: '', follow_up_fee: '', emergency_fee: '',
          payment_methods: [], insurance: { stance: 'not_accepted', note: '' }, treatments: [],
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.section.consultation_fee, null, 'a cleared fee becomes null, not 0');

      const prompt = await preview(ownerA.tenantId);
      assert.ok(!prompt.includes('Prices'), 'block gone entirely');
      assert.ok(!prompt.includes('not listed above'), 'and so is its rule');
      // The rest of the prompt is untouched.
      assert.ok(prompt.includes('Sunrise Dental'), 'identity still renders');
    } finally { server.close(); }
  });

  // ── Validation: 400 + NO write ──────────────────────────────────────────────
  it('negative and non-integer fees → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);

      for (const bad of ['-1', '500.5', 'abc', '1e5']) {
        const res = await req(server, {
          method: 'POST', path: '/portal/api/config/pricing', cookie,
          body: { consultation_fee: bad, treatments: [] },
        });
        assert.equal(res.status, 400, `fee "${bad}" rejected`);
        assert.ok(res.body.fields.some((f) => f.field === 'consultation_fee'), `fee "${bad}" names its field`);
      }
      assert.equal(await versionOf(ownerC.tenantId), before, 'no invalid fee writes anything');
    } finally { server.close(); }
  });

  it('more than 50 treatments → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const treatments = Array.from({ length: 51 }, (_, i) => ({ name: `Procedure ${i}`, price: '100' }));
      const res = await req(server, { method: 'POST', path: '/portal/api/config/pricing', cookie, body: { treatments } });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'treatments'));
      assert.equal(await versionOf(ownerC.tenantId), before, '51 treatments writes nothing');
    } finally { server.close(); }
  });

  it('exactly 50 treatments is accepted (the cap is inclusive)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const treatments = Array.from({ length: 50 }, (_, i) => ({ name: `Procedure ${i}`, price: String(100 + i) }));
      const res = await req(server, { method: 'POST', path: '/portal/api/config/pricing', cookie, body: { treatments } });
      assert.equal(res.status, 200);
      assert.equal(res.body.section.treatments.length, 50);
    } finally { server.close(); }
  });

  it('duplicate ACTIVE treatment names → 400 with NO write (case-insensitive)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { treatments: [{ name: 'Root canal', price: '4000' }, { name: 'root CANAL', price: '5000' }] },
      });
      assert.equal(res.status, 400, 'two live rows must not offer two prices for one question');
      assert.ok(res.body.fields.some((f) => f.field === 'treatments.1.name'), 'the SECOND row is flagged');
      assert.equal(await versionOf(ownerC.tenantId), before, 'duplicate names write nothing');
    } finally { server.close(); }
  });

  it('a duplicate name is allowed when one row is archived (a retired name can be reused)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: {
          treatments: [
            { name: 'Root canal', price: '4000', archived: true },
            { name: 'Root canal', price: '5500', archived: false },
          ],
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.section.treatments.length, 2);
      // Only the live one is quotable.
      const prompt = await preview(ownerC.tenantId);
      assert.ok(prompt.includes('- Root canal: ₹5500'), 'the live price is quoted');
      assert.ok(!prompt.includes('₹4000'), 'the archived price is not');
    } finally { server.close(); }
  });

  it('an ARCHIVED row is still validated — archiving is not an escape hatch for bad data', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { treatments: [{ name: 'Retired thing', price: '-5', archived: true }] },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'treatments.0.price'));
      assert.equal(await versionOf(ownerC.tenantId), before, 'a bad archived row writes nothing');
    } finally { server.close(); }
  });

  it('a treatment with a name but no price → 400 (a nameless, priceless row is just unfilled)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);

      const missing = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { treatments: [{ name: 'Root canal', price: '' }] },
      });
      assert.equal(missing.status, 400);
      assert.ok(missing.body.fields.some((f) => f.field === 'treatments.0.price'));
      assert.equal(await versionOf(ownerC.tenantId), before);

      // A wholly empty row is an unfilled input, not an error — it is dropped.
      const blank = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { treatments: [{ name: '', price: '' }] },
      });
      assert.equal(blank.status, 200);
      assert.deepEqual(blank.body.section.treatments, []);
    } finally { server.close(); }
  });

  it('an insurance stance that promises detail requires it → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);
      for (const stance of ['selected_insurers', 'note']) {
        const res = await req(server, {
          method: 'POST', path: '/portal/api/config/pricing', cookie,
          body: { insurance: { stance, note: '   ' }, treatments: [] },
        });
        assert.equal(res.status, 400, `${stance} with no detail is rejected`);
        assert.ok(res.body.fields.some((f) => f.field === 'insurance.note'));
      }
      assert.equal(await versionOf(ownerC.tenantId), before, 'no write');
    } finally { server.close(); }
  });

  it('unknown payment methods and stances → 400 with NO write', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);
      const before = await versionOf(ownerC.tenantId);

      const pay = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { payment_methods: ['upi', 'bitcoin'], treatments: [] },
      });
      assert.equal(pay.status, 400);
      assert.ok(pay.body.fields.some((f) => f.field === 'payment_methods'));

      const stance = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { insurance: { stance: 'free_for_all', note: 'x' }, treatments: [] },
      });
      assert.equal(stance.status, 400);
      assert.ok(stance.body.fields.some((f) => f.field === 'insurance.stance'));

      assert.equal(await versionOf(ownerC.tenantId), before, 'no write');
    } finally { server.close(); }
  });

  // ── INV-1: cross-tenant (mandatory) ─────────────────────────────────────────
  it('READ is scoped to the session tenant; a crafted tenantId is inert (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const q = await req(server, { method: 'GET', path: `/portal/api/config/pricing?tenantId=${ownerB.tenantId}`, cookie });
      assert.equal(q.status, 200);
      assert.notEqual(q.body.pricing.consultation_fee, 7777, 'must never surface B’s fee');
      assert.ok(!q.body.pricing.treatments.some((t) => t.name === 'Bravo-only procedure'), 'must never surface B’s treatments');

      const h = await req(server, { method: 'GET', path: '/portal/api/config/pricing', cookie, headers: { 'X-Tenant-Id': ownerB.tenantId } });
      assert.notEqual(h.body.pricing.consultation_fee, 7777);
    } finally { server.close(); }
  });

  it('WRITE is scoped to the session tenant; a crafted tenantId in the body cannot touch another tenant (INV-1)', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const bBefore = await versionOf(ownerB.tenantId);

      const res = await req(server, {
        method: 'POST', path: '/portal/api/config/pricing', cookie,
        body: { tenantId: ownerB.tenantId, consultation_fee: '111', treatments: [] },
      });
      assert.equal(res.status, 200);
      // The write landed on A (the session tenant), not B.
      assert.equal(res.body.section.consultation_fee, 111);
      const revA = await latestRevision(ownerA.tenantId);
      assert.equal(revA.actor_user_id, ownerA.userId);

      // B is completely untouched.
      assert.equal(await versionOf(ownerB.tenantId), bBefore, 'B’s version is unchanged');
      const bCfg = await configService.getTenantConfig(ownerB.tenantId);
      assert.equal(bCfg.pricing.consultation_fee, 7777, 'B’s fee is unchanged');
      assert.equal(bCfg.pricing.treatments[0].name, 'Bravo-only procedure', 'B’s treatments are unchanged');
    } finally { server.close(); }
  });
});
