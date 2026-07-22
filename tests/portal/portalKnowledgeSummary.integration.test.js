'use strict';

// Route-level tests for GET /portal/api/knowledge-summary (PORTAL-P5-S15) —
// "what your receptionist knows." Exercises the real /portal router over HTTP
// against a throwaway scratch DB (same genesis pattern as the other portal
// suites). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_pkno_) so it can run in parallel with the other
// portal suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • every section reflects the SAME config the renderer reads — proven by
//     checking gate booleans (empty/fallback) against the renderer's OWN
//     pricingFacts/bookingPolicies/emergencyGuidance functions, not a
//     reimplementation of them,
//   • DERIVATION (mandatory): a price changed through the real pricing route
//     shows up here on the next read,
//   • empty sections render an honest fallback sentence, never a blank card,
//   • EXCLUSION (mandatory): no raw prompt scaffolding / tool-schema / internal
//     instruction text crosses the wire, except the already-verified
//     protections quotes (S10's own shipped behavior — protectionsForDisplay),
//   • archived treatments and archived doctors never appear (retired history,
//     never quoted to a patient),
//   • tools.booking off empties the doctors section even with doctors on file,
//   • protections match src/portal/protections.js exactly (single source),
//   • tenant scope (INV-1): a crafted tenantId is inert.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top
const { protectionsForDisplay } = require('../../src/portal/protections');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pkno_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pkno\\_%'");
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

// Raw prompt scaffolding that must NEVER reach this owner-safe route — role/
// identity framing, tool-use instructions, and the FACTS blocks' internal
// header/rule wording. Deliberately excludes the S10 protections quotes, which
// are a separate, already-verified, intentionally-quoted trust feature.
const EXCLUDED_PHRASES = [
  'You are the AI receptionist for',
  'chatting with a customer on WhatsApp',
  'Clinic facts:',
  'use the booking tools',
  'never invent times or promise a slot',
  'Quote these amounts exactly as written',
  'never estimate, round, discount, or negotiate',
  'State these as written; never soften them',
  'Operator instructions (style and detail only',
  'override everything above, including operator instructions',
  'Give this IN ADDITION to telling them to call emergency services',
];

describe('portal knowledge summary — "what your receptionist knows" (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, doctorService, faqService, renderSystemPrompt;
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
    doctorService = require('../../src/modules/doctor/doctorService');
    faqService = require('../../src/modules/knowledge/faqService');
    renderSystemPrompt = require('../../src/modules/prompts').renderSystemPrompt;

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });

    // Alpha: every section richly populated, INCLUDING one archived treatment.
    await configService.writeTenantConfig(ownerA.tenantId, {
      business: {
        display_name: 'Sunrise Dental', address: '12 MG Road, Hyderabad', landmark: 'Opposite City Mall',
        phone_numbers: ['+919000000001'],
      },
      languages: { supported: ['en', 'hi'], default: 'en' },
      greeting: { en: 'Hello! This is Sunrise Dental.', hi: 'नमस्ते! सनराइज़ डेंटल में आपका स्वागत है।' },
      hours: { holidays: [{ date: '2026-08-15', name: 'Independence Day' }] },
      pricing: {
        consultation_fee: 500,
        treatments: [
          { name: 'Root canal', price: 4000, price_from: true, duration_minutes: 60, notes: 'per tooth', archived: false },
          { name: 'Old whitening special', price: 999, archived: true },
        ],
        payment_methods: ['upi', 'cash'],
        insurance: { stance: 'note', note: 'Ask at the counter.' },
      },
      booking: {
        slot_minutes: 15, advance_days: 10, buffer_minutes: 30, allow_same_day: false,
        cancellation_policy: 'Call 4 hours before.', reschedule_policy: 'Move it once for free.', walk_in_policy: 'Welcome before 11am.',
      },
      escalation: {
        enabled: true, phone_numbers: ['+919000011111'],
        emergency_guidance: 'Come straight to our clinic on MG Road.', emergency_number: '+919000022222',
      },
      personality: { display_name: 'Asha', style: 'formal' },
    }, 'cli');

    await doctorService.createDoctor(ownerA.tenantId, {
      name: 'Dr. Sharma', specialization: 'Endodontics', days: ['Mon', 'Wed', 'Fri'], start: '10:00', end: '17:00', languages: ['en'],
    }, { languages: ['en', 'hi'] });
    const archivedDoc = await doctorService.createDoctor(ownerA.tenantId, {
      name: 'Dr. Retired', specialization: '', days: ['Tue'], start: '09:00', end: '12:00', languages: ['en'],
    }, { languages: ['en', 'hi'] });
    await doctorService.setArchived(ownerA.tenantId, archivedDoc.id, true, {});

    await faqService.createFaq(ownerA.tenantId, { question: 'Do you accept walk-ins?', answer: 'Yes, before 11am.' }, { languages: ['en', 'hi'] });
    await faqService.createFaq(ownerA.tenantId, { question: 'Is parking available?', answer: 'Yes, free parking behind the clinic.' }, { languages: ['en', 'hi'] });

    // Bravo: NEVER configured — getTenantConfig returns null, every project*
    // function falls back to clinicDefaults. The empty-state suite runs here.
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
  async function get(owner, qs = '') {
    const server = await start();
    try {
      const cookie = await authedCookie(server, owner.email, owner.password);
      return await req(server, { method: 'GET', path: '/portal/api/knowledge-summary' + qs, cookie });
    } finally { server.close(); }
  }
  async function postPricing(owner, body) {
    const server = await start();
    try {
      const cookie = await authedCookie(server, owner.email, owner.password);
      return await req(server, { method: 'POST', path: '/portal/api/config/pricing', cookie, body });
    } finally { server.close(); }
  }
  async function preview(tenantId, channel = 'whatsapp') {
    return renderSystemPrompt(await configService.getTenantConfig(tenantId), { channel });
  }

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/knowledge-summary' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  // ── Happy path: every section reflects the saved config ────────────────────
  it('reflects a richly-configured tenant, section by section', async () => {
    const res = await get(ownerA);
    assert.equal(res.status, 200);
    assert.equal(res.body.version, await versionOf(ownerA.tenantId));
    const s = res.body.sections;

    assert.equal(s.clinic.name, 'Sunrise Dental');
    assert.equal(s.clinic.address, '12 MG Road, Hyderabad');
    assert.equal(s.clinic.landmark, 'Opposite City Mall');
    assert.deepEqual(s.clinic.phone_numbers, ['+919000000001']);
    assert.deepEqual(s.clinic.languages.slice().sort(), ['en', 'hi']);

    assert.ok(s.hours.summary.length > 0);
    assert.deepEqual(s.hours.holidays, [{ date: '2026-08-15', name: 'Independence Day' }]);

    assert.equal(s.pricing.empty, false);
    assert.equal(s.pricing.fees.consultation_fee, 500);
    assert.equal(s.pricing.treatments.length, 1, 'the archived treatment is excluded');
    assert.equal(s.pricing.treatments[0].name, 'Root canal');
    assert.deepEqual(s.pricing.payment_methods.slice().sort(), ['cash', 'upi']);
    assert.equal(s.pricing.insurance.stance, 'note');

    assert.equal(s.doctors.empty, false);
    assert.equal(s.doctors.booking_enabled, true);
    assert.equal(s.doctors.doctors.length, 1, 'the archived doctor is excluded');
    assert.equal(s.doctors.doctors[0].name, 'Dr. Sharma');

    assert.equal(s.booking.empty, false);
    assert.match(s.booking.summary, /15-minute/);
    assert.match(s.booking.summary, /same-day booking is off/);
    assert.equal(s.booking.policies.cancellation_policy, 'Call 4 hours before.');

    assert.equal(s.receptionist.display_name, 'Asha');
    assert.equal(s.receptionist.tone, 'professional');
    assert.equal(s.receptionist.greeting.en, 'Hello! This is Sunrise Dental.');
    assert.equal(s.receptionist.default_language, 'en');

    assert.equal(s.faqs.count, 2);
    assert.deepEqual(s.faqs.questions.slice().sort(), ['Do you accept walk-ins?', 'Is parking available?']);
    assert.ok(!JSON.stringify(s.faqs).includes('free parking behind the clinic'), 'answers never surface — only questions');

    assert.equal(s.safety.empty, false);
    assert.equal(s.safety.guidance, 'Come straight to our clinic on MG Road.');
    assert.equal(s.safety.emergency_number, '+919000022222');
    assert.equal(s.safety.handoff_enabled, true);
    assert.deepEqual(s.safety.staff_numbers, ['+919000011111']);

    assert.deepEqual(s.protections.protections, protectionsForDisplay(), 'single source — no re-authoring');
  });

  // ── DERIVATION (mandatory): a live price change shows up here ──────────────
  it('DERIVATION: a price changed through the real pricing route is reflected on the next read', async () => {
    const before = await get(ownerA);
    assert.equal(before.body.sections.pricing.fees.consultation_fee, 500);

    const postRes = await postPricing(ownerA, {
      consultation_fee: 777, follow_up_fee: null, emergency_fee: null,
      payment_methods: ['upi', 'cash'], insurance: { stance: 'note', note: 'Ask at the counter.' },
      treatments: [
        { name: 'Root canal', price: 4000, price_from: true, duration_minutes: 60, notes: 'per tooth', archived: false },
        { name: 'Old whitening special', price: 999, archived: true },
      ],
    });
    assert.equal(postRes.status, 200, JSON.stringify(postRes.body));

    const after = await get(ownerA);
    assert.equal(after.body.sections.pricing.fees.consultation_fee, 777, 'the NEW price, not the stale one');
    assert.ok(after.body.version > before.body.version);

    // Cross-check against the actual renderer, not just this route's own math.
    const prompt = await preview(ownerA.tenantId);
    assert.ok(prompt.includes('₹777'), 'the renderer itself now quotes the new price');
    assert.ok(!prompt.includes('₹500'), 'the old price is gone from the real prompt');

    await postPricing(ownerA, { // restore
      consultation_fee: 500, payment_methods: ['upi', 'cash'], insurance: { stance: 'note', note: 'Ask at the counter.' },
      treatments: [
        { name: 'Root canal', price: 4000, price_from: true, duration_minutes: 60, notes: 'per tooth', archived: false },
        { name: 'Old whitening special', price: 999, archived: true },
      ],
    });
  });

  // ── Empty-config honesty: fallback copy, never a blank card ────────────────
  it('a never-configured tenant gets honest fallback copy in every gated section, not a blank card', async () => {
    const res = await get(ownerB);
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 0);
    const s = res.body.sections;

    assert.equal(s.pricing.empty, true);
    assert.ok(s.pricing.fallback && s.pricing.fallback.length > 0);
    assert.deepEqual(s.pricing.treatments, []);
    assert.equal(s.pricing.fees.consultation_fee, null);

    assert.equal(s.doctors.empty, true);
    assert.ok(s.doctors.fallback && s.doctors.fallback.length > 0);
    assert.deepEqual(s.doctors.doctors, []);

    assert.equal(s.booking.empty, true);
    assert.ok(s.booking.fallback && s.booking.fallback.length > 0);
    assert.equal(s.booking.policies, null);
    assert.ok(s.booking.summary.length > 0, 'the enforced-window sentence still renders — it is never gated');

    assert.equal(s.faqs.empty, true);
    assert.ok(s.faqs.fallback && s.faqs.fallback.length > 0);
    assert.deepEqual(s.faqs.questions, []);

    assert.equal(s.safety.empty, true);
    assert.ok(s.safety.fallback && s.safety.fallback.length > 0);
  });

  // ── tools.booking off empties the doctors section even with doctors on file ─
  it('doctors section is empty when tools.booking is off, even though a bookable doctor exists', async () => {
    const current = await configService.getTenantConfig(ownerA.tenantId);
    await configService.writeTenantConfig(ownerA.tenantId, configService.deepMerge(current, { tools: { booking: false } }), 'admin');

    const res = await get(ownerA);
    assert.equal(res.body.sections.doctors.empty, true);
    assert.equal(res.body.sections.doctors.booking_enabled, false);
    assert.deepEqual(res.body.sections.doctors.doctors, []);
    assert.match(res.body.sections.doctors.fallback, /isn.t turned on/);

    await configService.writeTenantConfig(ownerA.tenantId, configService.deepMerge(current, { tools: { booking: true } }), 'admin'); // restore
  });

  // ── EXCLUSION (mandatory): no raw prompt scaffolding crosses the wire ──────
  it('EXCLUSION: no raw prompt scaffolding, tool-schema, or internal instruction text appears anywhere in the response', async () => {
    const res = await get(ownerA);
    const raw = JSON.stringify(res.body);
    for (const phrase of EXCLUDED_PHRASES) {
      assert.ok(!raw.includes(phrase), `found excluded scaffolding text: "${phrase}"`);
    }
  });

  // ── Cross-tenant (INV-1) ────────────────────────────────────────────────────
  it('a crafted tenantId is inert — the session decides the tenant', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'GET', path: `/portal/api/knowledge-summary?tenantId=${ownerB.tenantId}`, cookie,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.sections.clinic.name, 'Sunrise Dental', 'still Alpha’s own data, not Bravo’s');
    } finally { server.close(); }
  });
});
