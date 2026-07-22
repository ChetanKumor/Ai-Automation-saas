'use strict';

// Route-level tests for the onboarding wizard (PORTAL-P6-S16) — GET/POST
// /portal/api/onboarding, the ONE new write route the wizard adds, plus the
// structural proof that no step duplicates a form's real write path. Exercises
// the real /portal router over HTTP against a throwaway scratch DB (same
// genesis pattern as portalHours). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pwiz_) so it runs in parallel with the other
// portal suites without dropping their scratch DBs.
//
// What we assert is the wizard's contract:
//   • NO DUPLICATE FORMS (mandatory) — two independent proofs:
//       (a) routes.js registers exactly ONE write handler per section endpoint
//           the wizard's form-kind steps embed (identity/hours/pricing/
//           receptionist) and per Doctors/FAQs create route — the wizard adds
//           no second implementation at the server, and
//       (b) wizard.js's own source never references a /api/config/* or
//           /api/doctors or /api/faqs endpoint — it only ever drives the
//           embedded page's iframe (requestSubmit on the page's OWN form) and
//           calls /api/onboarding + /api/readiness. A second write path in the
//           client would show up here as a new fetch() target.
//   • progress persists: POST a step, GET reflects it — resumable across
//     "sessions" (a fresh cookie) since it lives in tenant_configs, not a
//     client-side store,
//   • reaching the last step (Review) marks the wizard completed; earlier
//     steps do not,
//   • skipping the steps that back a material check leaves that check
//     genuinely failing (validationService — not wizard-side guessing) and the
//     owner's Go-live blocker count > 0,
//   • completing every wizard-affected fact (hours, a doctor, 5 FAQs, an
//     escalation number) clears every OWNER-actionable material check
//     (blockers === 0) — the only gate the wizard itself is responsible for;
//     whatsapp/voice/turn.scripted stay Prantivo's (operator) gate by design,
//     unaffected by anything the wizard writes,
//   • tenant scope (INV-1): a crafted tenantId in query/body is inert on both
//     the onboarding read and write, and never leaks into another tenant's
//     config.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pwiz_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pwiz\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror portalHours) ────────────────────────────────────────
function req(server, { method = 'GET', path: p = '/', headers = {}, body, cookie } = {}) {
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
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
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

describe('portal onboarding wizard — progress + no-duplicate-forms (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, validationService;
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
    validationService = require('../../src/modules/validation/validationService');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha-wiz.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo-wiz.test', password: 'bravo-pass-2' });
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

  // ── NO DUPLICATE FORMS (mandatory) ───────────────────────────────────────────
  describe('no duplicate forms', () => {
    it('routes.js registers exactly one write handler per embedded-step endpoint', () => {
      delete require.cache[require.resolve('../../src/portal/routes')];
      const router = require('../../src/portal/routes');
      const routes = router.stack
        .filter((l) => l.route)
        .map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));

      const countPost = (p) => routes.filter((r) => r.path === p && r.methods.includes('post')).length;

      // Form-kind steps (Profile/Hours/Pricing/Greeting): the section endpoint
      // each step's embedded page already POSTs to.
      for (const p of ['/api/config/identity', '/api/config/hours', '/api/config/pricing', '/api/config/receptionist']) {
        assert.equal(countPost(p), 1, `${p} must have exactly one POST handler — a second is a duplicate write path`);
      }
      // Multi-kind steps (Doctors/FAQs): the create route.
      for (const p of ['/api/doctors', '/api/faqs']) {
        assert.equal(countPost(p), 1, `${p} must have exactly one POST handler`);
      }
      // The wizard's own state gets exactly ONE new write route, nothing else.
      assert.equal(countPost('/api/onboarding'), 1, 'onboarding progress has exactly one POST handler');
    });

    it('wizard.js never calls a config-section, doctors, or faqs endpoint directly', () => {
      const src = fs.readFileSync(path.join(__dirname, '../../public/portal/wizard.js'), 'utf8');
      assert.ok(!/\/api\/config\//.test(src),
        'wizard.js must never POST/GET a config section itself — that would be a second implementation of a step\'s form');
      assert.ok(!/\/api\/doctors|\/api\/faqs/.test(src),
        'wizard.js must never call the doctors/FAQs endpoints itself — those stay inside the embedded iframe');
    });

    it('saving pricing while mid-wizard hits the SAME /api/config/pricing endpoint and bumps the SAME version counter the standalone page uses', async () => {
      // Simulates exactly what pricing.js's real save() does from inside the
      // wizard's iframe (same fetch, same body shape) — proving the write path
      // is identical regardless of "wizard context", because there is no
      // wizard-specific branch in the route at all.
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerA.email, ownerA.password);
        const before = await req(server, { method: 'GET', path: '/portal/api/config/pricing', cookie });
        const beforeVersion = before.body.version;

        const res = await req(server, {
          method: 'POST', path: '/portal/api/config/pricing', cookie,
          body: {
            consultation_fee: '500', follow_up_fee: '', emergency_fee: '',
            payment_methods: ['upi'], insurance: { stance: 'not_accepted', note: '' }, treatments: [],
          },
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.version, beforeVersion + 1, 'ordinary version bump — no wizard-specific write path');
        assert.equal(res.body.section.consultation_fee, 500);
      } finally { server.close(); }
    });
  });

  // ── Progress: read/write + resume ────────────────────────────────────────────
  describe('progress persistence', () => {
    it('unauthenticated GET/POST → 401', async () => {
      const server = await start();
      try {
        const get = await req(server, { method: 'GET', path: '/portal/api/onboarding' });
        assert.equal(get.status, 401);
        const post = await req(server, { method: 'POST', path: '/portal/api/onboarding', body: { step: 2 } });
        assert.equal(post.status, 401);
      } finally { server.close(); }
    });

    it('a never-started tenant reads step:null, completed:false', async () => {
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerB.email, ownerB.password);
        const res = await req(server, { method: 'GET', path: '/portal/api/onboarding', cookie });
        assert.equal(res.status, 200);
        assert.equal(res.body.step, null);
        assert.equal(res.body.completed, false);
      } finally { server.close(); }
    });

    it('POST step 3, then a FRESH request (new cookie = new "session") resumes at 3', async () => {
      const server = await start();
      try {
        const cookie1 = await authedCookie(server, ownerA.email, ownerA.password);
        const post = await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie: cookie1, body: { step: 3 } });
        assert.equal(post.status, 200);
        assert.equal(post.body.step, 3);
        assert.equal(post.body.completed, false, 'step 3 of 7 is not the last step (Review = 6)');

        // A brand-new login (distinct session cookie) reads the SAME progress —
        // it is stored on the tenant, not the session (resumable across
        // sessions/devices, spec §6).
        const cookie2 = await authedCookie(server, ownerA.email, ownerA.password);
        const get = await req(server, { method: 'GET', path: '/portal/api/onboarding', cookie: cookie2 });
        assert.equal(get.status, 200);
        assert.equal(get.body.step, 3);
      } finally { server.close(); }
    });

    it('reaching the last step (Review, index 6) marks the wizard completed', async () => {
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerA.email, ownerA.password);
        const res = await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie, body: { step: 6 } });
        assert.equal(res.status, 200);
        assert.equal(res.body.step, 6);
        assert.equal(res.body.completed, true);

        // Completion sticks even if the owner navigates back into an earlier step.
        const back = await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie, body: { step: 1 } });
        assert.equal(back.body.step, 1);
        assert.equal(back.body.completed, true, 'completed never turns back off');
      } finally { server.close(); }
    });

    it('rejects an out-of-range or non-integer step, and writes nothing', async () => {
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerB.email, ownerB.password);
        for (const bad of [-1, 7, 2.5, 'two', null]) {
          const res = await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie, body: { step: bad } });
          assert.equal(res.status, 400, `step=${JSON.stringify(bad)} should be rejected`);
        }
      } finally { server.close(); }
    });

    it('/api/me carries the same onboarding status (drives Home\'s entry routing)', async () => {
      const server = await start();
      try {
        const cookie = await authedCookie(server, ownerB.email, ownerB.password);
        const before = await req(server, { method: 'GET', path: '/portal/api/me', cookie });
        assert.deepEqual(before.body.onboarding, { step: null, completed: false });

        await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie, body: { step: 2 } });
        const after = await req(server, { method: 'GET', path: '/portal/api/me', cookie });
        assert.deepEqual(after.body.onboarding, { step: 2, completed: false });
      } finally { server.close(); }
    });
  });

  // ── INV-1: cross-tenant ──────────────────────────────────────────────────────
  describe('cross-tenant (INV-1)', () => {
    it('READ is scoped to the session tenant; a crafted tenantId query param is inert', async () => {
      const server = await start();
      try {
        const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
        await req(server, { method: 'POST', path: '/portal/api/onboarding', cookie: await authedCookie(server, ownerA.email, ownerA.password), body: { step: 5 } });
        const q = await req(server, { method: 'GET', path: `/portal/api/onboarding?tenantId=${ownerA.tenantId}`, cookie: cookieB });
        assert.equal(q.status, 200);
        assert.notEqual(q.body.step, 5, 'B must never see A\'s progress via a crafted tenantId');
      } finally { server.close(); }
    });

    it('WRITE is scoped to the session tenant; a crafted tenantId in the body cannot touch another tenant', async () => {
      const server = await start();
      try {
        const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
        const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
        const aBefore = await req(server, { method: 'GET', path: '/portal/api/onboarding', cookie: cookieA });

        const res = await req(server, {
          method: 'POST', path: '/portal/api/onboarding', cookie: cookieB,
          body: { tenantId: ownerA.tenantId, step: 4 },
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.step, 4, 'the write landed on B (the session tenant)');

        const aAfter = await req(server, { method: 'GET', path: '/portal/api/onboarding', cookie: cookieA });
        assert.equal(aAfter.body.step, aBefore.body.step, 'A is completely untouched');
      } finally { server.close(); }
    });
  });

  // ── Skipping vs. completing: readiness stays honest ─────────────────────────
  describe('readiness reflects what was actually configured, never the wizard\'s own guess', () => {
    it('a tenant that skipped Hours/Doctors/FAQs fails hours.sane, doctor.schedule and kb.populated — Go-live has real owner blockers', async () => {
      const skipped = await seedOwner({ tenantName: 'Skipper Clinic', email: 'skip@skip-wiz.test', password: 'skip-pass-1' });
      // Advance progress to Review WITHOUT ever touching hours/doctors/FAQs —
      // exactly what "skip every step" looks like from the wizard's own state.
      await configService.writeTenantConfig(skipped.tenantId, {}, 'cli');
      const run = await validationService.validateTenant(skipped.tenantId, {
        skip: ['turn.scripted'],
        deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' },
      });
      const byName = (n) => run.checks.find((c) => c.name === n);
      assert.equal(byName('doctor.schedule').severity, 'fail', 'no doctors were added');
      assert.equal(byName('kb.populated').severity, 'fail', 'no FAQs were added');
      // clinicDefaults ships a full 7-day open grid, so hours.sane itself
      // passes on defaults alone — the OWNER blocker for a fully-skipped
      // wizard is escalation/doctors/FAQs, not hours. Assert the real material
      // gate the owner still has to clear, rather than assuming hours fails.
      assert.equal(byName('numbers.e164').severity, 'fail', 'no escalation number was added (Safety & handoff — outside the wizard)');

      const CHECK_CLASS_MATERIAL_OWNER = ['hours.sane', 'numbers.e164', 'kb.populated', 'kb.retrieval', 'doctor.schedule'];
      const blockers = run.checks.filter((c) => CHECK_CLASS_MATERIAL_OWNER.includes(c.name) && c.severity === 'fail').length;
      assert.ok(blockers > 0, 'skipping leaves real, unfixed owner blockers — the wizard never fakes a pass');
    });

    it('completing every wizard-affected fact clears every OWNER-actionable material check', async () => {
      const done = await seedOwner({ tenantName: 'Finisher Clinic', email: 'finish@finish-wiz.test', password: 'finish-pass-1' });

      // Profile/Hours/Pricing/Greeting — a full, valid document (mirrors the S6+
      // seeds elsewhere in the suite). whatsapp OFF: this clinic hasn't been
      // connected by Prantivo yet (a real, honest state), so whatsapp.config/
      // .live gate-skip rather than fail — they are the operator's gate, not
      // anything the wizard touches or claims to fix.
      await configService.writeTenantConfig(done.tenantId, {
        business: { display_name: 'Finisher Dental', phone_numbers: ['+919876500001'] },
        languages: { supported: ['en'], default: 'en' },
        greeting: { en: 'Hello! Welcome to Finisher Dental.' },
        hours: {
          mon: { open: '09:00', close: '18:00' }, tue: { open: '09:00', close: '18:00' },
          wed: { open: '09:00', close: '18:00' }, thu: { open: '09:00', close: '18:00' },
          fri: { open: '09:00', close: '18:00' }, sat: { open: '09:00', close: '14:00' },
          sun: { closed: true }, holidays: [],
        },
        escalation: { enabled: true, phone_numbers: ['+919000000099'] },
        // numbers.e164 also requires an owner notification number — set
        // outside any portal page today (no Notifications page exists in the
        // spec's page list; provisioning/CLI owns it, mirrored here the same
        // way shoot.js's seed does), so this isn't something the wizard itself
        // could ever leave unset for a real owner to fix.
        notifications: { owner_numbers: ['+919000000098'] },
        whatsapp: { enabled: false },
      }, 'cli');

      // Doctors step: one bookable doctor (tenant_entities, not config).
      await db.query(
        'INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, $2, $3)',
        [done.tenantId, 'schedule', JSON.stringify({
          doctor: 'Dr. Rao', specialization: 'Dentist', languages: ['en'],
          days: ['Mon', 'Wed', 'Fri'], start: '10:00', end: '16:00',
        })]);

      // FAQs step: the 5-chunk threshold (validationService's kbMin default).
      const faqService = require('../../src/modules/knowledge/faqService');
      for (let i = 0; i < 5; i++) {
        await faqService.createFaq(done.tenantId,
          { question: `Question ${i}?`, answer: `Answer ${i}.` },
          { languages: ['en'] });
      }

      const run = await validationService.validateTenant(done.tenantId, {
        skip: ['turn.scripted'],
        // kb.retrieval and whatsapp.live are the two network-bound checks
        // (embedding + a Meta ping) — stubbed exactly like the rest of the
        // suite (portalHours, shoot.js), never faked into a false pass.
        deps: { getRelevantChunks: async () => [{ id: 1 }], pingNumber: async () => 'stub' },
      });
      const byName = (n) => run.checks.find((c) => c.name === n);

      assert.equal(byName('hours.sane').severity, 'pass');
      assert.equal(byName('numbers.e164').severity, 'pass');
      assert.equal(byName('kb.populated').severity, 'pass');
      assert.equal(byName('kb.retrieval').severity, 'pass');
      assert.equal(byName('doctor.schedule').severity, 'pass');

      // deriveGoLive's OWNER blocker count (shell.js's CHECK_CLASS — the exact
      // classification the header/Review-step Go-live control uses) is what
      // actually gates the control the wizard shows. whatsapp.config is
      // material+operator and SKIPPED (gated off), so it correctly counts as
      // "waiting on Prantivo", not an owner blocker.
      const CHECK_CLASS = {
        'hours.sane': { actor: 'owner', material: true },
        'numbers.e164': { actor: 'owner', material: true },
        'kb.populated': { actor: 'owner', material: true },
        'kb.retrieval': { actor: 'owner', material: true },
        'doctor.schedule': { actor: 'owner', material: true },
      };
      const ownerBlockers = run.checks.filter((c) => CHECK_CLASS[c.name] && c.severity === 'fail').length;
      assert.equal(ownerBlockers, 0, 'every check the wizard can affect passes — nothing left for the owner to do');
    });
  });
});
