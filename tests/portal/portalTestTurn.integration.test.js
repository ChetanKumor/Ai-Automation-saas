'use strict';

// Route-level tests for POST /portal/api/test/turn (PORTAL-P5-S14) — "Test your
// receptionist". Exercises the real /portal router + the real aiService turn
// core over HTTP against a throwaway scratch DB (same genesis pattern as the
// other portal suites). Skips when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_ptst_) so it can run in parallel with the other
// portal suites without dropping their scratch DBs.
//
// ZERO real Gemini calls: aiService._setModelProvider is scripted for every
// test (including the config→answer proof, which asserts against the RENDERED
// PROMPT rather than trusting model output) — this suite must not touch the
// shared dev key's daily quota at all.
//
// What we assert is the route's contract:
//   • ISOLATION (mandatory): a test turn writes NO customer/conversation/message
//     row, ever — counted before/after, tenant-scoped,
//   • a turn_traces row (channel 'test') is written for every real attempt —
//     both the honest record and the rate-limit ledger,
//   • RATE LIMIT: the 21st attempt in a day → 429, with the model provider
//     never invoked (no LLM call made),
//   • QUOTA PATH: an upstream 429 from the model → 503 { quotaExceeded: true },
//     never a raw 500, never a fabricated reply — and still traces,
//   • CONFIG → ANSWER (the acceptance test): a saved price reaches the
//     rendered system prompt verbatim,
//   • CROSS-TENANT (INV-1): tenant comes from the session only; a crafted
//     tenantId in the body is inert,
//   • book_appointment is hard-gated for channel 'test' — no appointment row,
//     however the model behaves.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_ptst_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_ptst\\_%'");
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

// ── Scripted model factories (zero live Gemini calls) ────────────────────────
function textModel(text, captured) {
  return (config) => {
    if (captured) { captured.calls = (captured.calls || 0) + 1; captured.systemInstruction = config.systemInstruction; }
    return {
      startChat: () => ({
        sendMessage: async () => ({
          response: {
            functionCalls: () => undefined,
            text: () => text,
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            candidates: [{ finishReason: 'STOP' }],
          },
        }),
      }),
    };
  };
}

// check_availability → book_appointment → text, so the test-mode gate is
// exercised through the real tool loop (not asserted in isolation).
function bookingAttemptModel(date, appointmentTime) {
  const script = [
    { functionCalls: [{ name: 'check_availability', args: { date } }] },
    { functionCalls: [{ name: 'book_appointment', args: { doctor_name: 'Dr. Rao', appointment_time: appointmentTime, patient_name: 'Test Patient' } }] },
    { functionCalls: null, text: 'Noted.' },
  ];
  return () => {
    let i = 0;
    return {
      startChat: () => ({
        sendMessage: async () => {
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          return {
            response: {
              functionCalls: () => step.functionCalls || undefined,
              text: () => step.text || '',
              usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
              candidates: [{ finishReason: 'STOP' }],
            },
          };
        },
      }),
    };
  };
}

// The real SDK shape (GoogleGenerativeAIFetchError: `.status` set directly).
function quotaModel(captured) {
  return (config) => {
    if (captured) captured.calls = (captured.calls || 0) + 1;
    return {
      startChat: () => ({
        sendMessage: async () => {
          const err = new Error('[GoogleGenerativeAI Error]: got status: 429 Too Many Requests');
          err.status = 429;
          throw err;
        },
      }),
    };
  };
}

describe('portal test turn — POST /portal/api/test/turn (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, aiService, knowledgeService, testTurnService;
  let ownerA, ownerB;
  let knowledgeMock;

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
    aiService = require('../../src/modules/ai/aiService');
    knowledgeService = require('../../src/modules/knowledge/knowledgeService');
    testTurnService = require('../../src/modules/ai/testTurnService');

    // No knowledge chunks exist in this scratch DB, but getRelevantChunks still
    // does a live embedding call otherwise — stub it for every test (this
    // suite must not touch Gemini's embedding quota either).
    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks', async () => []);

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });

    await configService.writeTenantConfig(ownerA.tenantId, { pricing: { consultation_fee: 500 } }, 'cli');
    await configService.writeTenantConfig(ownerB.tenantId, { pricing: { consultation_fee: 999 } }, 'cli');
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

  afterEach(() => { aiService._setModelProvider(null); });

  async function seedOwner({ tenantName, email, password }) {
    const t = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [tenantName]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    return { tenantId, userId: u.rows[0].id, email, password };
  }

  async function rowCounts(tenantId) {
    const tables = ['customers', 'conversations', 'messages', 'appointments'];
    const out = {};
    for (const t of tables) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [tenantId]);
      out[t] = rows[0].n;
    }
    return out;
  }

  async function testTraceCount(tenantId) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM turn_traces WHERE tenant_id = $1 AND channel = 'test'`, [tenantId]);
    return rows[0].n;
  }

  async function latestTestTrace(tenantId) {
    const { rows } = await db.query(
      `SELECT * FROM turn_traces WHERE tenant_id = $1 AND channel = 'test' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
    return rows[0];
  }

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated → 401, no trace written', async () => {
    const server = await start();
    try {
      const before = await testTraceCount(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', body: { question: 'What are your timings?' } });
      assert.equal(res.status, 401);
      assert.equal(await testTraceCount(ownerA.tenantId), before);
    } finally { server.close(); }
  });

  // ── Input validation ─────────────────────────────────────────────────────────
  it('empty question → 400, no trace written', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = await testTraceCount(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: '   ' } });
      assert.equal(res.status, 400);
      assert.equal(await testTraceCount(ownerA.tenantId), before);
    } finally { server.close(); }
  });

  it('a question over 500 characters → 400, no trace written', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const before = await testTraceCount(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: 'x'.repeat(501) } });
      assert.equal(res.status, 400);
      assert.equal(await testTraceCount(ownerA.tenantId), before);
    } finally { server.close(); }
  });

  // ── ISOLATION (mandatory) ───────────────────────────────────────────────────
  it('a real test turn writes NO customer/conversation/message/appointment row, and leaves a turn_traces row', async () => {
    const server = await start();
    try {
      aiService._setModelProvider(textModel('We are open 9am to 6pm.'));
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);

      const before = await rowCounts(ownerA.tenantId);
      const traceBefore = await testTraceCount(ownerA.tenantId);

      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: 'What are your timings?' } });

      assert.equal(res.status, 200);
      assert.equal(res.body.reply, 'We are open 9am to 6pm.');
      assert.ok(res.body.provenance, 'provenance returned');
      assert.equal(typeof res.body.provenance.latency_ms, 'number');
      assert.equal(res.body.provenance.knowledge_used, false);
      assert.deepEqual(res.body.provenance.tool_calls, []);
      assert.equal(typeof res.body.remaining, 'number');

      const after = await rowCounts(ownerA.tenantId);
      assert.deepEqual(after, before, 'no customer/conversation/message/appointment row written');

      assert.equal(await testTraceCount(ownerA.tenantId), traceBefore + 1, 'exactly one turn_traces row for this attempt');
    } finally { server.close(); }
  });

  it('book_appointment is hard-gated for a test turn — no appointment row, however the model behaves', async () => {
    const server = await start();
    try {
      await db.query(
        "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, 'schedule', $2)",
        [ownerA.tenantId, JSON.stringify({ doctor: 'Dr. Rao', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], start: '09:00', end: '18:00', slot_minutes: 30 })]
      );
      const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      aiService._setModelProvider(bookingAttemptModel(tomorrow, `${tomorrow}T10:30:00+05:30`));
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);

      const apptBefore = (await rowCounts(ownerA.tenantId)).appointments;
      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: 'Book me with Dr. Rao tomorrow at 10:30, confirmed, my name is Test Patient.' } });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.provenance.tool_calls, ['check_availability', 'book_appointment']);
      const apptAfter = (await rowCounts(ownerA.tenantId)).appointments;
      assert.equal(apptAfter, apptBefore, 'no appointment row was created, even though the model attempted to book');

      await db.query("DELETE FROM tenant_entities WHERE tenant_id = $1 AND type = 'schedule'", [ownerA.tenantId]);
    } finally { server.close(); }
  });

  // ── CONFIG → ANSWER (the acceptance test) ───────────────────────────────────
  it('a saved consultation fee reaches the rendered system prompt verbatim — proven without trusting model output', async () => {
    const server = await start();
    try {
      const captured = {};
      aiService._setModelProvider(textModel('It is five hundred rupees.', captured));
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);

      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: 'What is the consultation fee?' } });

      assert.equal(res.status, 200);
      assert.ok(captured.systemInstruction, 'the model was invoked with a system instruction');
      assert.ok(captured.systemInstruction.includes('₹500'), 'the saved fee appears verbatim in the rendered prompt');
      assert.equal(res.body.provenance.config_version, configService.getCachedConfigVersion(ownerA.tenantId));
    } finally { server.close(); }
  });

  // ── CROSS-TENANT (INV-1) ─────────────────────────────────────────────────────
  it("tenant comes from the session only — a crafted tenantId in the body is inert", async () => {
    const server = await start();
    try {
      const captured = {};
      aiService._setModelProvider(textModel('It is five hundred rupees.', captured));
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);

      const res = await req(server, {
        method: 'POST', path: '/portal/api/test/turn', cookie,
        body: { question: 'What is the consultation fee?', tenantId: ownerB.tenantId },
      });

      assert.equal(res.status, 200);
      assert.ok(captured.systemInstruction.includes('₹500'), "A's own fee is used");
      assert.ok(!captured.systemInstruction.includes('₹999'), "B's fee never leaks in, despite the crafted tenantId");
    } finally { server.close(); }
  });

  // ── RATE LIMIT ───────────────────────────────────────────────────────────────
  it('the 21st test turn in a day → 429, and the model provider is never invoked', async () => {
    const server = await start();
    try {
      // Seed 20 prior attempts directly — cheaper than 20 scripted round-trips,
      // and the service only ever counts rows, not how they got there.
      for (let i = 0; i < 20; i++) {
        await db.query(`INSERT INTO turn_traces (tenant_id, channel) VALUES ($1, 'test')`, [ownerB.tenantId]);
      }
      const captured = {};
      aiService._setModelProvider(textModel('should never be reached', captured));
      const cookie = await authedCookie(server, ownerB.email, ownerB.password);

      const traceBefore = await testTraceCount(ownerB.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: 'What is the consultation fee?' } });

      assert.equal(res.status, 429);
      assert.equal(res.body.remaining, 0);
      assert.equal(captured.calls, undefined, 'the model was never invoked for the rejected attempt');
      assert.equal(await testTraceCount(ownerB.tenantId), traceBefore, 'the rejected attempt itself writes no trace');
    } finally { server.close(); }
  });

  // ── QUOTA PATH ───────────────────────────────────────────────────────────────
  it('an upstream 429 (quota) → 503 { quotaExceeded: true }, never a 500, never a fabricated reply — and still traces', async () => {
    const server = await start();
    try {
      const owner = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });
      aiService._setModelProvider(quotaModel());
      const cookie = await authedCookie(server, owner.email, owner.password);

      const res = await req(server, { method: 'POST', path: '/portal/api/test/turn', cookie, body: { question: 'What is the consultation fee?' } });

      assert.equal(res.status, 503);
      assert.equal(res.body.quotaExceeded, true);
      assert.ok(!res.body.reply, 'no fabricated reply field on the quota path');
      assert.match(res.body.error, /temporarily unavailable/i);

      const trace = await latestTestTrace(owner.tenantId);
      assert.ok(trace, 'the failed attempt still traces');
      assert.equal(trace.error.stage, 'generate_reply');
      assert.match(trace.error.message, /429/);
    } finally { server.close(); }
  });
});
