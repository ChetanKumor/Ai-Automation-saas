'use strict';

// Route-level tests for /portal/api/faqs (PORTAL-P4-S11) — the first portal
// surface that writes knowledge_chunks rather than a tenant_configs section.
// Exercises the real /portal router over HTTP against a throwaway scratch DB
// (same genesis pattern as the other portal suites). Skips when DATABASE_URL
// is unset.
//
// Disjoint DB-name prefix (zyon_pfaq_) so it can run in parallel with the
// auth / readiness / identity / hours / pricing / booking / doctors / safety
// suites without dropping their scratch DBs.
//
// EMBEDDING COST: knowledgeService.embed reaches Google. WHETHER IT DOES SO
// FOR REAL IS DECIDED IN ONE PLACE — tests/_support/embedTransport.js, loaded
// as a `--require` preload by the `test` script:
//
//   npm test                 default arm — offline transport, ZERO live calls
//   LIVE_GEMINI=1 npm test   live arm    — the real SDK call (docs/testing/live-arm.md)
//
// This header used to claim real calls were "reserved for ONE test". That was
// false, and measurably so: a census over `npm test` at 051ed7b
// (scripts/net-census.js) recorded FIVE live embedContent requests from this
// file, and twelve across three files. The claim was wrong by 2.4x and every
// quota estimate built on it was wrong by the same factor. The count is now a
// property of the transport rather than of a comment: in the default arm it is
// zero, and `scripts/net-census.js` is how that is checked rather than asserted.
//
// Two stub layers therefore coexist, and they are not redundant:
//   • `mock.method(knowledgeService, 'embed', fakeEmbed)` — the SERVICE seam,
//     used by every test that only needs CRUD shape, validation, the cap or
//     cross-tenant isolation. It skips `embed()` entirely, which is the point:
//     those tests assert on call COUNTS (see :293's re-embed test).
//   • the transport preload — the WIRE seam, underneath all of them. It is what
//     makes the retrieval test below, which cannot use the service seam
//     (knowledgeService.js:111-118), run offline by default.
//
// The contract under test:
//   • POST/PATCH/DELETE go through knowledgeService (no raw SQL from the
//     route) and content collapses to a single line so Q/A round-trips exactly,
//   • PATCH only re-embeds when the question/answer text actually changed —
//     a language-only edit reuses the existing vector,
//   • the 100-FAQ cap rejects a 101st with NO write,
//   • empty question/answer → 400, no write,
//   • kb.populated / kb.retrieval flip fail→pass as FAQs cross the threshold,
//   • REAL retrieval: a created FAQ is found by a semantically related query,
//     an edit changes what's found, and a delete removes it from results,
//   • tenant scope (INV-1): a crafted id / tenantId is inert on read AND write.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
// The arm switch + the per-call recorder. Same module instance the `--require`
// preload installed (require resolves to the same absolute path), so `calls()`
// here reads the transport that actually served this process — AND it installs
// the transport when this file is run directly (`node --test <file>`), which
// bypasses the preload entirely. Requiring it IS the install. Without this line
// the repeated single-file runs an attribution session lives on would silently
// go live again, which is how the 12 calls got there in the first place.
const embedTransport = require('../_support/embedTransport');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_pfaq_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_pfaq\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// Deterministic, always non-zero unit vector (safe for pgvector's cosine
// index — an all-zero vector has no defined cosine distance). Different text
// → (almost always) a different index set to 1, so "did the vector change"
// is provable without a live embedding call.
function fakeEmbedding(text) {
  const s = String(text == null ? '' : text);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const vec = new Array(768).fill(0);
  vec[h % 768] = 1;
  return vec;
}
async function fakeEmbed(text) { return fakeEmbedding(text); }

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

describe('portal faqs — knowledge_chunks Q/A editor (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, knowledgeService, validationService;
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

    // Required only AFTER the env swap so the shared pool binds to the
    // scratch DB (the S1 lesson: an eager import binds to the wrong database).
    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    knowledgeService = require('../../src/modules/knowledge/knowledgeService');
    validationService = require('../../src/modules/validation/validationService');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    // C is used ONLY by the real-embedding retrieval test, so no fake chunk
    // ever pollutes the ranking a live Gemini query is scored against.
    ownerC = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });
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

  afterEach(() => mock.restoreAll());

  async function seedOwner({ tenantName, email, password }) {
    const t = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [tenantName]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    return { tenantId, userId: u.rows[0].id, email, password };
  }

  // Read the storage DIRECTLY — proves the route writes real knowledge_chunks
  // rows, not a parallel table.
  async function rawFaqRows(tenantId) {
    const { rows } = await db.query(
      `SELECT id, content, source, embedding::text AS embedding, created_at
       FROM knowledge_chunks WHERE tenant_id=$1 ORDER BY created_at`, [tenantId]);
    return rows;
  }
  async function clearFaqs(tenantId) {
    await db.query('DELETE FROM knowledge_chunks WHERE tenant_id=$1', [tenantId]);
  }

  // Bulk-seed N cap-eligible rows directly (bypassing embed entirely) — the
  // cap test needs 100 EXISTING rows, not 100 real or fake embed round-trips.
  async function seedFaqRows(tenantId, n) {
    const vec = '[' + new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(',') + ']';
    await db.query(
      `INSERT INTO knowledge_chunks (tenant_id, content, source, embedding)
       SELECT $1, 'Q: seed ' || i || E'\nA: seed answer ' || i, 'faq', $2::vector
       FROM generate_series(1, $3) AS i`,
      [tenantId, vec, n]);
  }

  const kbCheck = async (tenantId, name) => {
    const run = await validationService.validateTenant(tenantId, {
      skip: ['turn.scripted', 'whatsapp.live'],
      deps: {
        pingNumber: async () => 'stub',
        // Proxies the REAL storage (proving the check tracks real chunk
        // count/presence) without a live embedding call for the canned query.
        getRelevantChunks: async (tid) => {
          const rows = await knowledgeService.listChunks(tid);
          return rows.length ? [rows[0]] : [];
        },
      },
    });
    return run.checks.find((c) => c.name === name);
  };

  const VALID = { question: 'Do you accept insurance?', answer: 'Yes, we accept most major insurance plans.' };

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/faqs' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', body: VALID });
      assert.equal(res.status, 401);
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns an empty list, the tenant’s languages, and a readiness snapshot', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'GET', path: '/portal/api/faqs', cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.faqs, []);
      assert.deepEqual(res.body.languages, ['te', 'hi', 'en']);
      assert.ok('readiness' in res.body);
    } finally { server.close(); }
  });

  // ── Create → the storage retrieval reads ────────────────────────────────────
  it('POST creates a knowledge_chunks row: content encodes Q/A, source is "faq"', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: VALID });

      assert.equal(res.status, 200);
      const created = res.body.faqs.find((f) => f.question === VALID.question);
      assert.ok(created, 'the new FAQ is in the returned list');
      assert.equal(created.answer, VALID.answer);
      assert.equal(created.language, null);

      const rows = await rawFaqRows(ownerA.tenantId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'faq');
      assert.equal(rows[0].content, `Q: ${VALID.question}\nA: ${VALID.answer}`,
        'content is exactly what aiService renders verbatim into the prompt');

      await clearFaqs(ownerA.tenantId);
    } finally { server.close(); }
  });

  it('a language tag is stored on `source` as "faq:<lang>" and round-trips on read', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/faqs', cookie, body: { ...VALID, language: 'te' },
      });
      assert.equal(res.status, 200);
      const created = res.body.faqs[0];
      assert.equal(created.language, 'te');

      const rows = await rawFaqRows(ownerA.tenantId);
      assert.equal(rows[0].source, 'faq:te');

      await clearFaqs(ownerA.tenantId);
    } finally { server.close(); }
  });

  // ── Edit: re-embeds only when the text actually changed ─────────────────────
  it('PATCH re-embeds when the question/answer text changes, but NOT for a language-only edit', async () => {
    const embedMock = mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const created = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: VALID });
      const id = created.body.faqs[0].id;
      const callsAfterCreate = embedMock.mock.calls.length;
      const vecAfterCreate = (await rawFaqRows(ownerA.tenantId))[0].embedding;

      // Same question/answer, only the language tag changes.
      const langOnly = await req(server, {
        method: 'PATCH', path: `/portal/api/faqs/${id}`, cookie, body: { ...VALID, language: 'hi' },
      });
      assert.equal(langOnly.status, 200);
      assert.equal(langOnly.body.faqs[0].language, 'hi');
      assert.equal(embedMock.mock.calls.length, callsAfterCreate,
        'no re-embed call for a language-only edit — the text did not change');
      const vecAfterLangEdit = (await rawFaqRows(ownerA.tenantId))[0].embedding;
      assert.equal(vecAfterLangEdit, vecAfterCreate, 'the stored vector is untouched');

      // Now the answer actually changes.
      const contentEdit = await req(server, {
        method: 'PATCH', path: `/portal/api/faqs/${id}`, cookie,
        body: { ...VALID, answer: 'No, we do not accept insurance at this time.', language: 'hi' },
      });
      assert.equal(contentEdit.status, 200);
      assert.equal(embedMock.mock.calls.length, callsAfterCreate + 1, 're-embedded exactly once for the content change');
      const rows = await rawFaqRows(ownerA.tenantId);
      assert.equal(rows[0].content, `Q: ${VALID.question}\nA: No, we do not accept insurance at this time.`);
      assert.notEqual(rows[0].embedding, vecAfterCreate, 'the stale vector was replaced');

      await clearFaqs(ownerA.tenantId);
    } finally { server.close(); }
  });

  // ── Delete ───────────────────────────────────────────────────────────────────
  it('DELETE removes the row outright (no archive concept for FAQs)', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const created = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: VALID });
      const id = created.body.faqs[0].id;

      const res = await req(server, { method: 'DELETE', path: `/portal/api/faqs/${id}`, cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.faqs, []);
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0);
    } finally { server.close(); }
  });

  // ── Validation → 4xx, no write ──────────────────────────────────────────────
  it('an empty question → 400 with no write', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: { ...VALID, question: '   ' } });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'question'));
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0);
    } finally { server.close(); }
  });

  it('an empty answer → 400 with no write', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: { ...VALID, answer: '' } });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'answer'));
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0);
    } finally { server.close(); }
  });

  it('a question over 200 characters → 400 with no write', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/faqs', cookie, body: { ...VALID, question: 'x'.repeat(201) },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'question'));
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0);
    } finally { server.close(); }
  });

  it('an answer over 800 characters → 400 with no write', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/faqs', cookie, body: { ...VALID, answer: 'x'.repeat(801) },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'answer'));
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0);
    } finally { server.close(); }
  });

  it('an unknown language → 400 with no write', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'POST', path: '/portal/api/faqs', cookie, body: { ...VALID, language: 'fr' },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.fields.some((f) => f.field === 'language'));
      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0);
    } finally { server.close(); }
  });

  it('PATCH of an unknown id → 404', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'PATCH', path: `/portal/api/faqs/${crypto.randomUUID()}`, cookie, body: VALID });
      assert.equal(res.status, 404);
    } finally { server.close(); }
  });

  it('a malformed id is treated as unknown, not a 500', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, { method: 'DELETE', path: '/portal/api/faqs/not-a-uuid', cookie });
      assert.equal(res.status, 404);
    } finally { server.close(); }
  });

  // ── Cap: 100 FAQs ────────────────────────────────────────────────────────────
  it('the 101st FAQ is rejected with no write; the tenant stays at 100', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    await seedFaqRows(ownerB.tenantId, 100);
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerB.email, ownerB.password);
      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: VALID });
      assert.equal(res.status, 400);
      assert.equal((await rawFaqRows(ownerB.tenantId)).length, 100, 'the cap held — no 101st row');
    } finally {
      server.close();
      await clearFaqs(ownerB.tenantId);
    }
  });

  // ── Readiness ───────────────────────────────────────────────────────────────
  it('kb.populated and kb.retrieval flip fail→pass as FAQs cross the 5-chunk threshold', async () => {
    // A bare tenant: both checks fail.
    let populated = await kbCheck(ownerB.tenantId, 'kb.populated');
    let retrieval = await kbCheck(ownerB.tenantId, 'kb.retrieval');
    assert.equal(populated.severity, 'fail');
    assert.equal(retrieval.severity, 'fail');

    await seedFaqRows(ownerB.tenantId, 5);

    populated = await kbCheck(ownerB.tenantId, 'kb.populated');
    retrieval = await kbCheck(ownerB.tenantId, 'kb.retrieval');
    assert.equal(populated.severity, 'pass', '5 chunks meets the default kbMin');
    assert.equal(retrieval.severity, 'pass', 'retrieval now returns a chunk for the canned query');

    await clearFaqs(ownerB.tenantId);
  });

  // ── Why this ONE test carries its own telemetry ─────────────────────────────
  //
  // The assertion below has failed three times — RAG Session 3, HERO-1 phase 3,
  // HERO-1 phase 5 — and only the first was ever attributed. The other two
  // recorded `500 !== 200` and NOTHING ELSE, because both places that know why
  // are closed on this path: routes.js:1988 collapses every failure into the one
  // string `Failed to add this FAQ`, and this file's `LOG_LEVEL = 'silent'`
  // (:35) suppresses routes.js:1987, the only line that carries the cause. The
  // test was therefore incapable of reporting its own failure, which is a defect
  // in the test before it is a defect in anything it exercises.
  //
  // LATENCY is the field that discriminates, and it is the one field a bare
  // status assertion never records. Measured this session, all at this test, the
  // arms are metres apart in time and identical in every other recorded field —
  // same location, same `500 !== 200`, same response body:
  //
  //   Google ANSWERS with a rejection (quota / tier / auth)   1925.6 ms
  //   the fetch never reaches Google (DNS / connect / socket)  1104.7 ms   (20-way parallelism)
  //   ------------------------------------------------------------------
  //   a POST that does no network work at all                  548-690 ms (uncontended)
  //   the phase-5 red, unexplained                               607 ms
  //
  // A live embedding call that Google answers costs 424-1903 ms — p50 482, p99
  // 1571, n=333 measured this session — whether it succeeds or is rejected. No
  // arm in which Google replied can produce a 607 ms test, which is why the next
  // sighting needs the per-call timings and not just a status.
  //
  // ── AND IT CAUGHT ONE, on run 20 of 50 ──────────────────────────────────────
  // A natural firing, at :548 (the PATCH, not the POST): the third live call
  // reported `{"ok":false,"ms":10085.7,"err":"…Request aborted…"}` — the 10,000 ms
  // `interactive` deadline (knowledgeService.js:66) expiring on a call that
  // STALLED rather than one that ran long: 1 of 334 calls, and against a p99 of
  // 1571 ms and a next-slowest of 1903 ms it is not in the tail of the
  // distribution above but in a separate mode whose latency is unbounded — the
  // deadline is the only reason a number was recorded for it at all. So no finite
  // bound escapes it and raising this one would only lengthen the red. That is a
  // live defect against D-011's derivation and it is recorded in state.md — and
  // it is NOT the phase-5 607 ms red, which remains unattributed.
  //
  // THE INSTRUMENTATION MOVED, IT DID NOT GO AWAY. The per-call recorder this
  // block describes now lives in tests/_support/embedTransport.js and runs in
  // BOTH arms, so the record shape an assertion message carries is the same
  // whether the call went to Google or not. What changed is only that the
  // default arm answers offline; under `LIVE_GEMINI=1` the call below is the
  // identical real request, timed the identical way, and a stall would be
  // recorded exactly as the 10,085.7 ms one was.
  //
  // It still sits at the SDK transport rather than on `knowledgeService.embed`,
  // for the reason that has not changed: :551’s `getRelevantChunks` reaches
  // `embed` through the module-local binding, which a `mock.method` on the
  // export cannot see (knowledgeService.js:111-118). The transport is below that
  // split, so it sees every call this test makes.
  function embedProbe() {
    embedTransport.reset();
    return {
      // Everything the next sighting needs, in the assertion message itself:
      // which request, what came back, what every embedding call cost, and
      // which arm produced it.
      why(what, res) {
        return `${what} → HTTP ${res.status}, expected 200. body=${JSON.stringify(res.body)} ` +
          `arm=${embedTransport.live ? 'LIVE' : 'offline'} ` +
          `embedCalls=${JSON.stringify(embedTransport.calls())}`;
      },
    };
  }

  // ── REAL semantic retrieval (the ONE test the live arm exists for) ────────
  it('real semantic retrieval: create → found by a related query → edit re-embeds → delete removes it', async () => {
    const server = await start();
    const probe = embedProbe();
    try {
      const cookie = await authedCookie(server, ownerC.email, ownerC.password);

      const created = await req(server, {
        method: 'POST', path: '/portal/api/faqs', cookie,
        body: { question: 'Do you accept insurance?', answer: 'No, we currently do not accept any health insurance plans.' },
      });
      assert.equal(created.status, 200, probe.why('POST /portal/api/faqs', created));
      const id = created.body.faqs[0].id;

      const found = await knowledgeService.getRelevantChunks(ownerC.tenantId, 'does the clinic take insurance', 3);
      assert.ok(found.length > 0, 'retrieval returns something for a semantically related query');
      assert.ok(found.some((c) => c.content.includes('do not accept')),
        'the receptionist would retrieve exactly what was just saved');

      const edited = await req(server, {
        method: 'PATCH', path: `/portal/api/faqs/${id}`, cookie,
        body: { question: 'Do you accept insurance?', answer: 'Yes, we now accept Star Health and HDFC Ergo insurance plans.' },
      });
      assert.equal(edited.status, 200, probe.why(`PATCH /portal/api/faqs/${id}`, edited));

      const foundAfterEdit = await knowledgeService.getRelevantChunks(ownerC.tenantId, 'does the clinic take insurance', 3);
      assert.ok(foundAfterEdit.some((c) => c.content.includes('Star Health')),
        'the edit re-embedded — retrieval now surfaces the NEW answer');
      assert.ok(!foundAfterEdit.some((c) => c.content.includes('do not accept')),
        'the stale answer is gone, not just superseded');

      const del = await req(server, { method: 'DELETE', path: `/portal/api/faqs/${id}`, cookie });
      assert.equal(del.status, 200, probe.why(`DELETE /portal/api/faqs/${id}`, del));

      const foundAfterDelete = await knowledgeService.getRelevantChunks(ownerC.tenantId, 'does the clinic take insurance', 3);
      assert.ok(!foundAfterDelete.some((c) => c.id === id), 'deleting the FAQ removes it from retrieval');
    } finally { server.close(); }
  });

  // ── The offline transport can FAIL, and the route's 500 branch proves it ────
  //
  // A stub that only ever returns success is not a stub of the call, it is a
  // deletion of the call's failure mode. routes.js:1986-1990 turns any throw
  // out of the embedding into a 500 with the body `Failed to add this FAQ`, and
  // nothing else in the suite reaches that line — which is why the three
  // historical `500 !== 200` sightings on the retrieval test above had no
  // companion test showing what a real 500 there looks like.
  //
  // These two use the WIRE seam deliberately. `mock.method(knowledgeService,
  // 'embed', …)` cannot express them: it replaces `embed()` whole, so the
  // AbortController, the deadline timer and the budget-class lookup — everything
  // the second test is actually about — never run.
  it('an embedding transport failure is a 500, not a partial write', async () => {
    const server = await start();
    embedTransport.reset();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      embedTransport.failNext('fetch failed');

      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: VALID });
      assert.equal(res.status, 500, `expected the embed failure to surface as a 500, got ${res.status}`);
      assert.deepEqual(res.body, { error: 'Failed to add this FAQ' });

      const calls = embedTransport.calls();
      assert.equal(calls.length, 1, `exactly one embedding call was attempted: ${JSON.stringify(calls)}`);
      assert.equal(calls[0].ok, false, 'and it is recorded as a failure, with its latency');

      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0,
        'a failed embedding leaves NO row — the FAQ is not written unembedded');
    } finally {
      // Defensive, and it earned its place: when this assertion was deliberately
      // broken during a mutation check, the row it did not expect to exist leaked
      // into the NEXT test and reddened that one too. A cascade hides which
      // assertion actually caught the mutant.
      await clearFaqs(ownerA.tenantId);
      embedTransport.reset();
      server.close();
    }
  });

  // Fault A's shape, on demand. The stall recorded live on 2026-08-18 (10,085.7 ms,
  // 1 of 334 calls) is a call that never answers, so the ONLY thing that ends it
  // is `embed()`'s deadline — which is exactly what this asserts, at a deadline
  // small enough to be a test. `EMBED_TIMEOUT_INTERACTIVE_MS` is read at call
  // time (knowledgeService.js:84-87), so no sleeping and no clock control.
  it('an embedding that never answers is ended by the interactive deadline, and 500s', async () => {
    const server = await start();
    const DEADLINE_MS = 150;
    const prior = process.env.EMBED_TIMEOUT_INTERACTIVE_MS;
    process.env.EMBED_TIMEOUT_INTERACTIVE_MS = String(DEADLINE_MS);
    embedTransport.reset();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      embedTransport.stallNext();

      const res = await req(server, { method: 'POST', path: '/portal/api/faqs', cookie, body: VALID });

      assert.equal(res.status, 500, 'a stalled embedding ends as a 500, the same shape the owner sees');
      const calls = embedTransport.calls();
      assert.equal(calls.length, 1, JSON.stringify(calls));
      assert.equal(calls[0].ok, false);
      assert.match(calls[0].err, /abort/i,
        'the deadline aborts the in-flight call — the record carries the reason, not just a status');
      // A FRACTION of the deadline, not the deadline itself — the bound is
      // asymmetric by construction and an earlier `>= DEADLINE_MS` went red 1 run
      // in 20 at 149.6 ms. `embed()` arms the timer BEFORE it calls
      // `embedContent` (knowledgeService.js:147-155), so the span recorded here
      // starts strictly later than the deadline's clock and is always a little
      // shorter than it. What the assertion is actually for is separating "waited
      // out the deadline" from "answered instantly", and an instant path records
      // well under a millisecond — so 80% discriminates by two orders of
      // magnitude while leaving the arming gap all the room it needs.
      assert.ok(calls[0].ms >= DEADLINE_MS * 0.8,
        `the recorded latency is the deadline, not the response time: ${JSON.stringify(calls)}`);

      // NO WALL-CLOCK CEILING HERE, deliberately. An earlier revision asserted
      // `Date.now()` elapsed < 5000 ms and it went red once in 20 runs — the host
      // suspended for 2h25m mid-run, and the assertion measured the suspension.
      // It was also redundant: `stallNext()` settles ONLY when the signal aborts,
      // and on this path the sole aborter is `embed()`'s own deadline timer (no
      // caller signal is passed from the FAQ save), so a 500 carrying an abort
      // error IS the deadline having fired. A deadline that never fired would
      // hang the request instead, which node:test reports as a CANCELLED test —
      // and os-check.js:196-206 refuses a run with any cancellation. The failure
      // mode is caught either way, by something a sleeping laptop cannot forge.

      assert.equal((await rawFaqRows(ownerA.tenantId)).length, 0, 'nothing written');
    } finally {
      if (prior === undefined) delete process.env.EMBED_TIMEOUT_INTERACTIVE_MS;
      else process.env.EMBED_TIMEOUT_INTERACTIVE_MS = prior;
      await clearFaqs(ownerA.tenantId);   // see the sibling above
      embedTransport.reset();
      server.close();
    }
  });

  // ── INV-1: cross-tenant (mandatory) ─────────────────────────────────────────
  it('READ is scoped to the session tenant; a crafted tenantId is inert (INV-1)', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
      await req(server, { method: 'POST', path: '/portal/api/faqs', cookie: cookieB,
        body: { question: 'Bravo-only question?', answer: 'Bravo-only answer.' } });

      const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
      const res = await req(server, {
        method: 'GET', path: `/portal/api/faqs?tenantId=${ownerB.tenantId}`, cookie: cookieA });
      assert.equal(res.status, 200);
      assert.ok(!res.body.faqs.some((f) => f.question === 'Bravo-only question?'),
        'A sees only its own FAQs, never B’s');

      await clearFaqs(ownerB.tenantId);
    } finally { server.close(); }
  });

  it('owner A cannot read, edit, or delete tenant B’s FAQ by id (INV-1)', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookieB = await authedCookie(server, ownerB.email, ownerB.password);
      await req(server, { method: 'POST', path: '/portal/api/faqs', cookie: cookieB, body: VALID });
      const bFaq = (await rawFaqRows(ownerB.tenantId))[0];

      const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
      const patch = await req(server, {
        method: 'PATCH', path: `/portal/api/faqs/${bFaq.id}`, cookie: cookieA,
        body: { question: 'Hijacked?', answer: 'Hijacked.' } });
      assert.equal(patch.status, 404, 'another tenant’s FAQ simply does not exist');

      const del = await req(server, { method: 'DELETE', path: `/portal/api/faqs/${bFaq.id}`, cookie: cookieA });
      assert.equal(del.status, 404);

      const after = (await rawFaqRows(ownerB.tenantId))[0];
      assert.equal(after.content, bFaq.content, 'B’s FAQ is completely untouched');

      await clearFaqs(ownerB.tenantId);
    } finally { server.close(); }
  });

  it('a crafted tenantId in the body cannot redirect a write (INV-1)', async () => {
    mock.method(knowledgeService, 'embed', fakeEmbed);
    const server = await start();
    try {
      const cookieA = await authedCookie(server, ownerA.email, ownerA.password);
      const bBefore = await rawFaqRows(ownerB.tenantId);

      const res = await req(server, {
        method: 'POST', path: '/portal/api/faqs', cookie: cookieA,
        body: { ...VALID, tenantId: ownerB.tenantId, tenant_id: ownerB.tenantId },
      });
      assert.equal(res.status, 200);

      const aRows = await rawFaqRows(ownerA.tenantId);
      assert.ok(aRows.length > 0, 'written to the SESSION tenant');
      const bAfter = await rawFaqRows(ownerB.tenantId);
      assert.equal(bAfter.length, bBefore.length, 'B gained nothing');

      await clearFaqs(ownerA.tenantId);
    } finally { server.close(); }
  });
});
