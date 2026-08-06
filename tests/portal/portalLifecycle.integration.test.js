'use strict';

// Route-level tests for POST /portal/api/lifecycle/{activate,pause,resume}
// (PORTAL-P6-S18) — the owner's go-live flow. Exercises the real /portal router
// over HTTP against a throwaway scratch DB (same genesis pattern as the other
// portal suites). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_plc_) so it can run in parallel with the other
// portal suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • a blocked go-live is REFUSED with the blocking checks named, and the
//     tenant's status is untouched,
//   • a clean go-live reaches `live` and flips tenants.active,
//   • NO-SKIP (mandatory, INV-3): a request carrying skip parameters in the
//     body AND the query string still runs the COMPLETE catalog — nothing is
//     recorded as explicitly skipped and the check the caller tried to skip
//     still ran and still blocked them,
//   • pause requires an explicit confirmation flag,
//   • pause → resume round-trips back to live,
//   • wrong-state transitions are refused in the owner's words,
//   • tenant scope (INV-1, mandatory): owner A acting cannot move tenant B.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

// ── Offline Gemini SDK ───────────────────────────────────────────────────────
// The portal's go-live path CANNOT skip a check — that is the entire point of
// INV-3 — so `kb.retrieval` genuinely runs, and it genuinely embeds its probe
// query through the Gemini SDK. Stub the SDK in the module cache BEFORE
// anything requires it, so the full catalog runs for real and offline. This is
// the ONLY way to test the no-skip path honestly: passing a skip to make the
// suite hermetic would test the exact thing we are proving impossible.
// `node --test` gives each test FILE its own process, so this never leaks into
// another suite.
const GENAI_PATH = require.resolve('@google/generative-ai');
require(GENAI_PATH);
const PROBE_VEC = Array(768).fill(0);
PROBE_VEC[0] = 1; // unit vector: cosine distance to an identical stored vector is 0
require.cache[GENAI_PATH].exports = {
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        embedContent: async () => ({ embedding: { values: PROBE_VEC } }),
        startChat: () => ({
          sendMessage: async () => ({
            response: { functionCalls: () => undefined, text: () => 'ok' },
          }),
        }),
      };
    }
  },
};

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
const PREFIX = 'zyon_plc_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_plc\\_%'");
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

// A config under which the FULL catalog passes without a single skip being
// granted to the caller. The three checks that would otherwise need live
// credentials or live model calls are gated OFF by the tenant's own config
// (whatsapp/voice disabled, booking disabled) — the catalog's own `gate`, not a
// skip. So "passed" here means every check that applies to this tenant actually
// ran, which is exactly what an owner-pressed go-live must mean.
const PASS_CONFIG = {
  business: { display_name: 'Sunrise Dental' },
  notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
  escalation: { enabled: true, phone_numbers: ['+919000000002'] },
  whatsapp: { enabled: false },
  voice: { enabled: false },
  tools: { booking: false },
};

describe('portal lifecycle — go live / pause / resume (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService;

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
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
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

  let seq = 0;
  async function seedOwner({ ready = false } = {}) {
    seq += 1;
    const t = await db.query(
      'INSERT INTO tenants (business_name, active) VALUES ($1, false) RETURNING id',
      ['Clinic ' + seq]);
    const tenantId = t.rows[0].id;
    const email = `owner${seq}@lc-portal.test`;
    const password = `pass-word-${seq}`;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    if (ready) await makeReady(tenantId);
    return { tenantId, userId: u.rows[0].id, email, password };
  }

  // Everything a tenant needs for the full catalog to pass: a valid config and
  // enough knowledge chunks for kb.populated (≥5) and kb.retrieval.
  async function makeReady(tenantId) {
    await configService.writeTenantConfig(tenantId, PASS_CONFIG, 'cli');
    const vec = '[' + PROBE_VEC.join(',') + ']';
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        'INSERT INTO knowledge_chunks (tenant_id, content, embedding, source) VALUES ($1,$2,$3::vector,$4)',
        [tenantId, `Clinic fact ${i}: we are open 9am to 6pm on weekdays.`, vec, 'faq']);
    }
  }

  const statusOf = async (tenantId) =>
    (await db.query('SELECT status, active FROM tenants WHERE id = $1', [tenantId])).rows[0];

  // F1-R1: an in-place edit must not change either count. A delete-and-reinsert
  // would raise max(created_at) on its own and prove nothing about the fix.
  const chunkCount = async (tenantId) =>
    (await db.query('SELECT count(*)::int AS n FROM knowledge_chunks WHERE tenant_id = $1',
      [tenantId])).rows[0].n;

  const entityCount = async (tenantId) =>
    (await db.query('SELECT count(*)::int AS n FROM tenant_entities WHERE tenant_id = $1',
      [tenantId])).rows[0].n;

  const latestRun = async (tenantId) =>
    (await db.query(
      'SELECT passed, result FROM validation_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
      [tenantId])).rows[0];

  // ── Auth ───────────────────────────────────────────────────────────────────
  // Covers the re-check route too (F1). Extended rather than duplicated: it is
  // one assertion about one middleware, and a second copy of it would drift.
  it('unauthenticated → 401 on every lifecycle route and on the re-check', async () => {
    const server = await start();
    try {
      const paths = [
        '/portal/api/lifecycle/activate',
        '/portal/api/lifecycle/pause',
        '/portal/api/lifecycle/resume',
        '/portal/api/readiness/check',
      ];
      for (const path of paths) {
        const res = await req(server, { method: 'POST', path, body: { confirm: true } });
        assert.equal(res.status, 401, `${path} must require a session`);
      }
    } finally { server.close(); }
  });

  // ── Blocked go-live ────────────────────────────────────────────────────────
  describe('go live, blocked', () => {
    it('refuses with the blocking checks named, and leaves the status untouched', async () => {
      const o = await seedOwner(); // no config, no knowledge → many checks fail
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'NOT_READY');
        assert.match(res.body.error, /ready to go live/i);

        // Names WHICH checks blocked it — by name only, never operator `detail`.
        assert.ok(Array.isArray(res.body.blocking) && res.body.blocking.length > 0);
        const names = res.body.blocking.map((b) => b.name);
        assert.ok(names.includes('config.exists'), 'a configless tenant is blocked on config.exists');
        for (const b of res.body.blocking) {
          assert.deepEqual(Object.keys(b), ['name'], 'only the check NAME crosses the wire');
        }

        const after = await statusOf(o.tenantId);
        assert.equal(after.status, 'draft', 'a refused go-live must not move the status');
        assert.equal(after.active, false);
        assert.equal(res.body.readiness.status, 'draft');
      } finally { server.close(); }
    });

    it('names every failing check, not just the first', async () => {
      const o = await seedOwner();
      // A config exists but escalation/owner numbers are missing AND there is no
      // knowledge → numbers.e164 and both kb checks fail together.
      await configService.writeTenantConfig(o.tenantId, {
        whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false },
      }, 'cli');
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        assert.equal(res.status, 409);
        const names = res.body.blocking.map((b) => b.name);
        assert.ok(names.includes('numbers.e164'), names.join(','));
        assert.ok(names.includes('kb.populated'), names.join(','));
        assert.ok(names.length >= 2, 'the refusal lists all blockers, not only the first');
      } finally { server.close(); }
    });
  });

  // ── INV-3: no skip path, at all ────────────────────────────────────────────
  describe('INV-3 — the owner path cannot skip a check', () => {
    it('skip parameters in the body AND the query string are inert: the full catalog still runs', async () => {
      const o = await seedOwner();
      await configService.writeTenantConfig(o.tenantId, {
        whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false },
        notifications: { owner_numbers: ['+919000000001'] },
        escalation: { enabled: true, phone_numbers: ['+919000000002'] },
      }, 'cli');
      // No knowledge chunks → kb.populated is the blocker. If ANY skip leaked
      // through, kb.populated would be skipped and the tenant would go live.
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, {
          method: 'POST',
          // Every shape an attacker/curious owner might try.
          path: '/portal/api/lifecycle/activate?skip=kb.populated&skip[]=kb.retrieval&validate[skip][]=kb.populated',
          cookie,
          body: {
            skip: ['kb.populated', 'kb.retrieval'],
            validate: { skip: ['kb.populated', 'kb.retrieval'] },
            opts: { validate: { skip: ['kb.populated'] } },
          },
        });

        assert.equal(res.status, 409, 'the skip attempt must not let a blocked tenant through');
        const names = res.body.blocking.map((b) => b.name);
        assert.ok(names.includes('kb.populated'), 'kb.populated still ran and still blocked');

        // And the persisted run proves it: nothing was recorded as an EXPLICIT
        // skip. (Gate-driven skips — whatsapp/voice/booking disabled — are the
        // catalog's own doing and are expected here.)
        const run = await latestRun(o.tenantId);
        assert.equal(run.passed, false);
        const explicit = (run.result.skipped || []).filter((s) => /--skip/.test(s.reason));
        assert.deepEqual(explicit, [], 'no check may ever be explicitly skipped from the portal');
        const ran = run.result.checks.map((c) => c.name);
        assert.ok(ran.includes('kb.populated') && ran.includes('kb.retrieval'),
          'both checks the caller tried to skip actually ran');

        assert.equal((await statusOf(o.tenantId)).status, 'draft');
      } finally { server.close(); }
    });

    it('a skip that WOULD have unblocked go-live still does not', async () => {
      // Same tenant shape, but this time everything except kb passes — so the
      // only thing between this owner and `live` is the check they tried to
      // skip. If the skip leaked, the status would read 'live' below.
      const o = await seedOwner();
      await configService.writeTenantConfig(o.tenantId, {
        ...PASS_CONFIG,
      }, 'cli'); // valid config, but NO knowledge chunks
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, {
          method: 'POST', path: '/portal/api/lifecycle/activate', cookie,
          body: { skip: ['kb.populated', 'kb.retrieval'] },
        });
        assert.equal(res.status, 409);
        assert.equal((await statusOf(o.tenantId)).status, 'draft', 'skip must not buy a go-live');
      } finally { server.close(); }
    });
  });

  // ── Clean go-live ──────────────────────────────────────────────────────────
  describe('go live, clean', () => {
    it('activates: status becomes live, the tenant becomes active, readiness reflects it', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.status, 'live');
        assert.equal(res.body.readiness.status, 'live');
        assert.equal(res.body.readiness.run.passed, true);

        const after = await statusOf(o.tenantId);
        assert.equal(after.status, 'live');
        assert.equal(after.active, true, 'live ⇔ active — the runtime gate opens');
      } finally { server.close(); }
    });

    it('the passing run really ran the catalog — no check was explicitly skipped', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        assert.equal((await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} })).status, 200);
        const run = await latestRun(o.tenantId);
        assert.equal(run.passed, true);
        assert.deepEqual((run.result.skipped || []).filter((s) => /--skip/.test(s.reason)), []);
        // The static checks an owner is responsible for all actually ran.
        const ran = run.result.checks.map((c) => c.name);
        for (const name of ['config.exists', 'config.schema', 'prompt.renders', 'hours.sane',
          'numbers.e164', 'kb.populated', 'kb.retrieval']) {
          assert.ok(ran.includes(name), `${name} must have run`);
        }
      } finally { server.close(); }
    });

    it('activating an already-live tenant is refused in the owner’s words', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        assert.equal((await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} })).status, 200);
        const again = await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        assert.equal(again.status, 409);
        assert.match(again.body.error, /already live/i);
        assert.equal((await statusOf(o.tenantId)).status, 'live');
      } finally { server.close(); }
    });
  });

  // ── Pause / resume ─────────────────────────────────────────────────────────
  describe('pause and resume', () => {
    it('pause without the confirmation flag → 400, and the receptionist stays live', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
          const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/pause', cookie, body });
          assert.equal(res.status, 400, JSON.stringify(body));
          assert.match(res.body.error, /confirm/i);
        }
        assert.equal((await statusOf(o.tenantId)).status, 'live', 'an unconfirmed pause changes nothing');
      } finally { server.close(); }
    });

    it('pause → paused + inactive; resume → live + active', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        const paused = await req(server, { method: 'POST', path: '/portal/api/lifecycle/pause', cookie, body: { confirm: true } });
        assert.equal(paused.status, 200);
        assert.equal(paused.body.status, 'paused');
        assert.equal(paused.body.readiness.status, 'paused');
        let s = await statusOf(o.tenantId);
        assert.equal(s.status, 'paused');
        assert.equal(s.active, false, 'paused must actually silence the tenant');

        const resumed = await req(server, { method: 'POST', path: '/portal/api/lifecycle/resume', cookie, body: {} });
        assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
        assert.equal(resumed.body.status, 'live');
        s = await statusOf(o.tenantId);
        assert.equal(s.status, 'live');
        assert.equal(s.active, true);
      } finally { server.close(); }
    });

    it('resume RE-VALIDATES: a tenant that broke while paused is refused, not waved through', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/pause', cookie, body: { confirm: true } });

        // Break it while paused — exactly the case lifecycleService's "resume is
        // not a transition" rule exists for.
        await db.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1', [o.tenantId]);

        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/resume', cookie, body: {} });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'NOT_READY');
        assert.ok(res.body.blocking.map((b) => b.name).includes('kb.populated'));
        assert.equal((await statusOf(o.tenantId)).status, 'paused', 'a refused resume leaves it paused');
      } finally { server.close(); }
    });
  });

  // ── Wrong-state refusals ───────────────────────────────────────────────────
  describe('wrong-state transitions', () => {
    it('resume on a draft tenant → 409, state unchanged', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/resume', cookie, body: {} });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'INVALID_TRANSITION');
        assert.match(res.body.error, /isn’t paused/i);
        assert.equal((await statusOf(o.tenantId)).status, 'draft');
      } finally { server.close(); }
    });

    it('resume on a LIVE tenant → 409 "already answering"', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/resume', cookie, body: {} });
        assert.equal(res.status, 409);
        assert.match(res.body.error, /already answering/i);
        assert.equal((await statusOf(o.tenantId)).status, 'live');
      } finally { server.close(); }
    });

    it('pause on a draft tenant → 409, state unchanged', async () => {
      const o = await seedOwner();
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const res = await req(server, { method: 'POST', path: '/portal/api/lifecycle/pause', cookie, body: { confirm: true } });
        assert.equal(res.status, 409);
        assert.match(res.body.error, /nothing to pause/i);
        assert.equal((await statusOf(o.tenantId)).status, 'draft');
      } finally { server.close(); }
    });
  });

  // ── INV-1: cross-tenant ────────────────────────────────────────────────────
  describe('INV-1 — tenant scope', () => {
    it('owner A cannot activate, pause or resume tenant B, however B is named', async () => {
      const a = await seedOwner();               // A is NOT ready → its own activate fails
      const b = await seedOwner({ ready: true }); // B is ready and paused-able
      const server = await start();
      try {
        // Put B live so there is something for A to try to pause.
        const bCookie = await authedCookie(server, b.email, b.password);
        assert.equal((await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie: bCookie, body: {} })).status, 200);

        const aCookie = await authedCookie(server, a.email, a.password);

        // Every shape a crafted tenant id could take.
        const crafted = [
          { tenantId: b.tenantId },
          { tenant_id: b.tenantId },
          { id: b.tenantId },
        ];
        for (const extra of crafted) {
          const act = await req(server, {
            method: 'POST', path: `/portal/api/lifecycle/activate?tenantId=${b.tenantId}`, cookie: aCookie, body: extra,
          });
          assert.equal(act.status, 409, 'A only ever acts on A — and A is not ready');
          assert.equal(act.body.code, 'NOT_READY');

          const pause = await req(server, {
            method: 'POST', path: `/portal/api/lifecycle/pause?tenantId=${b.tenantId}`,
            cookie: aCookie, body: { confirm: true, ...extra },
          });
          assert.equal(pause.status, 409, 'A cannot pause B; A itself is not live');

          const resume = await req(server, {
            method: 'POST', path: `/portal/api/lifecycle/resume?tenantId=${b.tenantId}`, cookie: aCookie, body: extra,
          });
          assert.equal(resume.status, 409);
        }

        // B is untouched throughout.
        const bAfter = await statusOf(b.tenantId);
        assert.equal(bAfter.status, 'live', 'B must still be live — A never reached it');
        assert.equal(bAfter.active, true);
        // And A never moved either.
        assert.equal((await statusOf(a.tenantId)).status, 'draft');
      } finally { server.close(); }
    });
  });

  // ── Readiness staleness (drives the Go-live control's enabled state) ───────
  describe('readiness staleness', () => {
    it('a run is fresh when nothing changed, and stale once config moves', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        let r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, false, 'a run taken after the last config write is fresh');

        // Any config write expires the run's verdict — the same invariant
        // lifecycleService enforces at activate (STALE_VALIDATION).
        await configService.writeTenantConfig(o.tenantId, { business: { display_name: 'Renamed' } }, 'portal',
          { actorUserId: o.userId });

        r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, true, 'config moved → the run no longer speaks for it');
      } finally { server.close(); }
    });

    // ── F1 ───────────────────────────────────────────────────────────────────
    // Staleness used to be computed from `tenant_configs.updated_at` ALONE, and
    // the catalog does not measure only config. These two tests pin the other
    // two storage homes it measures, one per write path, through the REAL portal
    // routes an owner uses — not by touching the tables directly, which would
    // prove the SQL and nothing about whether the product reaches it.
    //
    // The reported failure: six FAQs on file, a run that had counted four, and a
    // payload claiming that verdict was current. `deriveGoLive` then found a run
    // that had neither passed nor expired and rendered no Go-live control at all,
    // so go-live was unreachable with nothing on screen explaining why.
    it('a FAQ write expires the run — knowledge_chunks is what kb.populated counts', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        let r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, false, 'a run taken after the last write is fresh');

        const added = await req(server, {
          method: 'POST', path: '/portal/api/faqs', cookie,
          body: { question: 'Where can I park?', answer: 'Free parking is available in the basement.' },
        });
        assert.equal(added.status, 200, 'the FAQ was actually written');

        // The write's OWN response carries readiness, and it is the payload the
        // FAQ page re-renders its header from — so it has to say it too.
        assert.equal(added.body.readiness.run.stale, true,
          'the write response must not hand back a run it has just invalidated');

        r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, true, 'a FAQ write expires the run');
      } finally { server.close(); }
    });

    it('a doctor write expires the run — tenant_entities is what doctor.schedule reads', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        let r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, false);

        const added = await req(server, {
          method: 'POST', path: '/portal/api/doctors', cookie,
          body: {
            name: 'Dr. Anitha Rao', specialization: 'Endodontist',
            languages: ['te', 'en'], days: ['Mon', 'Tue', 'Wed'], start: '10:00', end: '17:00',
          },
        });
        assert.equal(added.status, 200, 'the doctor was actually written');
        assert.equal(added.body.readiness.run.stale, true);

        r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, true, 'a doctor write expires the run');
        // Note: PASS_CONFIG has tools.booking false, so doctor.schedule is GATED
        // OFF for this tenant and did not run. Staleness is deliberately
        // table-level, not check-level — making it config-aware would mean
        // loading the config on every readiness read to save an occasional
        // re-check offer. Conservative in the safe direction.
      } finally { server.close(); }
    });

    // ── F1-R1 ────────────────────────────────────────────────────────────────
    // F1's union read `max(created_at)` on both tables, and neither carried an
    // `updated_at` or a trigger. A timestamp only ever set at INSERT can only
    // rise at INSERT — so the three tests below were all GREEN-on-the-wrong-
    // answer before migration 026: every one of these writes is an in-place
    // UPDATE that left the measurement exactly where it was, and the run kept
    // reporting a verdict that had expired.
    //
    // This is F1 inverted. F1 was "you did the work and the portal says you
    // didn't". This is "you undid the work and the portal says you're fine", on
    // the surface that decides go-live.
    //
    // Each asserts the write really was an UPDATE — the row's id survives and
    // the row count does not move — because a delete-and-reinsert would raise
    // max(created_at) too and would prove nothing about this fix.
    it('an in-place FAQ EDIT expires the run — no create, no delete', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });

        const list = await req(server, { method: 'GET', path: '/portal/api/faqs', cookie });
        assert.equal(list.status, 200);
        assert.ok(list.body.faqs.length >= 1, 'the ready tenant has FAQs to edit');
        const id = list.body.faqs[0].id;
        assert.equal(list.body.readiness.run.stale, false, 'a run taken after the last write is fresh');

        const before = await chunkCount(o.tenantId);
        const edited = await req(server, {
          method: 'PATCH', path: `/portal/api/faqs/${id}`, cookie,
          body: { question: 'Do you take card payments?', answer: 'Yes — card, UPI and cash.' },
        });
        assert.equal(edited.status, 200, 'the FAQ was actually saved');

        // The write was an UPDATE: same row, same count.
        assert.equal(await chunkCount(o.tenantId), before, 'an edit must not add or remove a row');
        const stillThere = await db.query('SELECT content FROM knowledge_chunks WHERE id = $1', [id]);
        assert.match(stillThere.rows[0].content, /card, UPI and cash/, 'the SAME row now holds the new text');

        assert.equal(edited.body.readiness.run.stale, true,
          'the write response must not hand back a run it has just invalidated');
        const r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, true, 'an in-place FAQ edit expires the run');
      } finally { server.close(); }
    });

    it('an in-place doctor SCHEDULE EDIT expires the run — no create, no delete', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const created = await req(server, {
          method: 'POST', path: '/portal/api/doctors', cookie,
          body: {
            name: 'Dr. Meera Iyer', specialization: 'Orthodontist',
            languages: ['te', 'en'], days: ['Mon', 'Tue'], start: '10:00', end: '17:00',
          },
        });
        assert.equal(created.status, 200);
        const id = created.body.doctor.id;

        // Validate AFTER the doctor exists, so the run is newer than the insert
        // and staleness can only come from the edit below.
        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        let r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, false, 'a run taken after the doctor was added is fresh');

        const before = await entityCount(o.tenantId);
        const edited = await req(server, {
          method: 'PATCH', path: `/portal/api/doctors/${id}`, cookie,
          body: {
            name: 'Dr. Meera Iyer', specialization: 'Orthodontist',
            languages: ['te', 'en'], days: ['Mon', 'Tue', 'Wed', 'Thu'], start: '09:00', end: '18:30',
          },
        });
        assert.equal(edited.status, 200, 'the schedule was actually saved');

        assert.equal(await entityCount(o.tenantId), before, 'an edit must not add or remove a row');
        const row = await db.query("SELECT data->>'end' AS end_at FROM tenant_entities WHERE id = $1", [id]);
        assert.equal(row.rows[0].end_at, '18:30', 'the SAME row now holds the new hours');

        assert.equal(edited.body.readiness.run.stale, true);
        r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, true, 'an in-place schedule edit expires the run');
      } finally { server.close(); }
    });

    // The sharpest of the three, and the reason it gets its own test rather than
    // hiding inside "an edit": archiving is how an owner takes a doctor OUT of
    // booking. `doctorService.setArchived` flips `type` with an UPDATE, so on
    // created_at alone the register shrank while doctor.schedule kept reporting
    // the verdict it reached when that doctor was still bookable — the ring
    // reading one check HIGHER than the truth.
    //
    // DELETE /api/doctors resolves to archive-or-delete by what the data allows,
    // so the doctor is given an appointment first. That is deliberate: it is the
    // branch that UPDATEs. (The delete branch lowers max(updated_at) and is the
    // half F1-R1 leaves open — see lifecycleService.validationInputsChangedAt.)
    it('ARCHIVING a doctor expires the run — the archive is an UPDATE, not a delete', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const created = await req(server, {
          method: 'POST', path: '/portal/api/doctors', cookie,
          body: {
            name: 'Dr. Vikram Shah', specialization: 'Periodontist',
            languages: ['en'], days: ['Mon', 'Tue'], start: '10:00', end: '17:00',
          },
        });
        assert.equal(created.status, 200);
        const id = created.body.doctor.id;

        const cust = await db.query(
          'INSERT INTO customers (tenant_id, phone, name) VALUES ($1,$2,$3) RETURNING id',
          [o.tenantId, '+91900000' + String(1000 + seq), 'Booked Patient']);
        await db.query(
          `INSERT INTO appointments (tenant_id, customer_id, doctor_name, appointment_time)
           VALUES ($1, $2, 'Dr. Vikram Shah', NOW() + interval '2 days')`,
          [o.tenantId, cust.rows[0].id]);

        await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        let r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, false, 'a run taken after the doctor was added is fresh');

        const before = await entityCount(o.tenantId);
        const removed = await req(server, { method: 'DELETE', path: `/portal/api/doctors/${id}`, cookie });
        assert.equal(removed.status, 200);
        assert.equal(removed.body.outcome, 'archived',
          'the doctor has an appointment, so this is the ARCHIVE branch — an UPDATE, not a DELETE');

        // Proof it was an UPDATE: the row is still there, carrying the flipped type.
        assert.equal(await entityCount(o.tenantId), before, 'an archive must not remove the row');
        const row = await db.query('SELECT type FROM tenant_entities WHERE id = $1', [id]);
        assert.equal(row.rows[0].type, 'schedule_archived');

        assert.equal(removed.body.readiness.run.stale, true);
        r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.stale, true, 'archiving a doctor expires the run');
      } finally { server.close(); }
    });

    // The mechanism the three above ride on, asserted directly rather than
    // inferred: migration 026 attaches the EXISTING set_updated_at trigger, so
    // an UPDATE must move `updated_at` and must leave `created_at` alone. If
    // created_at ever moved, every ORDER BY created_at in the product (the FAQ
    // list, the doctor register's tiebreaker) would reshuffle on each edit.
    it('the trigger moves updated_at and leaves created_at alone, on both tables', async () => {
      const o = await seedOwner();

      const chunk = await db.query(
        `INSERT INTO knowledge_chunks (tenant_id, content, source) VALUES ($1, $2, 'faq')
         RETURNING id, created_at, updated_at`,
        [o.tenantId, 'Q: Are you open Sunday?\nA: No.']);
      const c0 = chunk.rows[0];
      assert.equal(+c0.created_at, +c0.updated_at, 'at INSERT both take the same NOW()');

      await db.query('UPDATE knowledge_chunks SET content = $2 WHERE id = $1',
        [c0.id, 'Q: Are you open Sunday?\nA: Yes, 10am–2pm.']);
      const c1 = (await db.query(
        'SELECT created_at, updated_at FROM knowledge_chunks WHERE id = $1', [c0.id])).rows[0];
      assert.equal(+c1.created_at, +c0.created_at, 'knowledge_chunks.created_at must not move on an UPDATE');
      assert.ok(+c1.updated_at > +c0.updated_at, 'knowledge_chunks.updated_at must move on an UPDATE');

      const ent = await db.query(
        `INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, 'schedule', $2)
         RETURNING id, created_at, updated_at`,
        [o.tenantId, JSON.stringify({ doctor: 'Dr. Trigger', days: ['Mon'], start: '10:00', end: '17:00' })]);
      const e0 = ent.rows[0];
      assert.equal(+e0.created_at, +e0.updated_at, 'at INSERT both take the same NOW()');

      await db.query("UPDATE tenant_entities SET type = 'schedule_archived' WHERE id = $1", [e0.id]);
      const e1 = (await db.query(
        'SELECT created_at, updated_at FROM tenant_entities WHERE id = $1', [e0.id])).rows[0];
      assert.equal(+e1.created_at, +e0.created_at, 'tenant_entities.created_at must not move on an UPDATE');
      assert.ok(+e1.updated_at > +e0.updated_at, 'tenant_entities.updated_at must move on an UPDATE');
    });
  });

  // ── POST /portal/api/readiness/check (F1) ──────────────────────────────────
  // The validate half of the go-live chain, on the owner's surface. Before this
  // route the portal could only re-run the catalog by ALSO trying to go live
  // (runGoLiveChain fuses validate → activate), so an owner whose run had expired
  // had no way to refresh it.
  describe('re-check without going live', () => {
    it('persists a run and leaves the lifecycle status untouched', async () => {
      const o = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const before = await statusOf(o.tenantId);
        assert.equal(before.status, 'draft');

        const res = await req(server, { method: 'POST', path: '/portal/api/readiness/check', cookie, body: {} });
        assert.equal(res.status, 200);

        const { rows } = await db.query(
          'SELECT count(*)::int n FROM validation_runs WHERE tenant_id = $1', [o.tenantId]);
        assert.equal(rows[0].n, 1, 'the run was persisted');
        assert.equal((await latestRun(o.tenantId)).passed, true, 'and it is the run this route just made');

        // The distinction from lifecycleService.transition(id, 'validate'), which
        // writes status='validated' on a pass. This route calls validateTenant
        // directly for exactly this reason: it can never move a receptionist
        // between states, which is what makes it safe beside a Pause button.
        const after = await statusOf(o.tenantId);
        assert.equal(after.status, 'draft', 'a passing re-check must NOT promote the tenant');
        assert.equal(after.active, false, 'and must not flip the runtime gate');
        assert.equal(res.body.status, 'draft', 'the response reports the real status');
        assert.equal(res.body.run.passed, true);
        assert.equal(res.body.run.stale, false, 'the run it just made is, by construction, fresh');
      } finally { server.close(); }
    });

    // THE F1 REGRESSION. The whole reported journey, end to end, with no manual
    // intervention: a run taken below the knowledge threshold, FAQs added past
    // it, and the owner's own re-check turning a dead end into an eligible
    // go-live. This is the test that fails on the old formula.
    it('the F1 journey: a run that predates the FAQs is stale, and Check again clears it', async () => {
      const o = await seedOwner();
      await configService.writeTenantConfig(o.tenantId, PASS_CONFIG, 'cli');
      const server = await start();
      try {
        const cookie = await authedCookie(server, o.email, o.password);
        const faq = (n) => req(server, {
          method: 'POST', path: '/portal/api/faqs', cookie,
          body: { question: `Question number ${n}?`, answer: `Answer number ${n} for this clinic.` },
        });

        for (let i = 0; i < 4; i += 1) assert.equal((await faq(i)).status, 200);

        // Go live is refused, and the refusal is what puts a run on record.
        const blocked = await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        assert.equal(blocked.status, 409);
        assert.deepEqual(blocked.body.blocking.map((b) => b.name), ['kb.populated'],
          'four chunks is one short of kbMin, and that is the only blocker');

        // The owner reads "Add at least 5 FAQs" and adds two more.
        assert.equal((await faq(4)).status, 200);
        assert.equal((await faq(5)).status, 200);

        let r = await req(server, { method: 'GET', path: '/portal/api/readiness', cookie });
        assert.equal(r.body.run.passed, false, 'the OLD run still says what it said');
        assert.equal(r.body.run.stale, true, 'but the portal now says it has expired');
        assert.equal(r.body.run.checks.find((c) => c.name === 'kb.populated').severity, 'fail');

        // Check again — the one action this session added.
        const rechecked = await req(server, { method: 'POST', path: '/portal/api/readiness/check', cookie, body: {} });
        assert.equal(rechecked.status, 200);
        assert.equal(rechecked.body.run.passed, true, 'six FAQs clears kb.populated');
        assert.equal(rechecked.body.run.stale, false);
        assert.equal(rechecked.body.run.checks.find((c) => c.name === 'kb.populated').severity, 'pass');
        assert.equal((await statusOf(o.tenantId)).status, 'draft', 'still not live — the owner has not asked to be');

        // And go-live is now actually reachable.
        const live = await req(server, { method: 'POST', path: '/portal/api/lifecycle/activate', cookie, body: {} });
        assert.equal(live.status, 200);
        assert.equal(live.body.status, 'live');
      } finally { server.close(); }
    });

    // INV-1, mandatory. The route takes its tenant from the SESSION and there is
    // no argument position a caller could occupy — asserted the way the go-live
    // no-skip test asserts INV-3, by firing the crafted request and proving it
    // landed nowhere.
    it('tenant scope (INV-1): a crafted tenantId in body and query cannot validate another tenant', async () => {
      const attacker = await seedOwner({ ready: true });
      const victim = await seedOwner({ ready: true });
      const server = await start();
      try {
        const cookie = await authedCookie(server, attacker.email, attacker.password);
        const res = await req(server, {
          method: 'POST',
          path: `/portal/api/readiness/check?tenantId=${victim.tenantId}&tenant_id=${victim.tenantId}`,
          cookie,
          body: { tenantId: victim.tenantId, tenant_id: victim.tenantId, id: victim.tenantId },
        });
        assert.equal(res.status, 200);

        const mine = await db.query('SELECT count(*)::int n FROM validation_runs WHERE tenant_id = $1', [attacker.tenantId]);
        const theirs = await db.query('SELECT count(*)::int n FROM validation_runs WHERE tenant_id = $1', [victim.tenantId]);
        assert.equal(mine.rows[0].n, 1, 'the run landed on the SESSION tenant');
        assert.equal(theirs.rows[0].n, 0, 'and nothing at all ran against the named one');
        assert.equal((await statusOf(victim.tenantId)).status, 'draft', 'the other tenant is untouched');
      } finally { server.close(); }
    });
  });
});
