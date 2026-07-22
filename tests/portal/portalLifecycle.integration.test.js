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

  const latestRun = async (tenantId) =>
    (await db.query(
      'SELECT passed, result FROM validation_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
      [tenantId])).rows[0];

  // ── Auth ───────────────────────────────────────────────────────────────────
  it('unauthenticated → 401 on all three lifecycle routes', async () => {
    const server = await start();
    try {
      for (const action of ['activate', 'pause', 'resume']) {
        const res = await req(server, { method: 'POST', path: `/portal/api/lifecycle/${action}`, body: { confirm: true } });
        assert.equal(res.status, 401, `${action} must require a session`);
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
  });
});
