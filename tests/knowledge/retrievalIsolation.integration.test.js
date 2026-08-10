'use strict';

// R1 — `knowledgeService.getRelevantChunks` (src/modules/knowledge/knowledgeService.js:33-46)
// — is the only vector query in the repository and the only read whose rows reach a
// patient-facing prompt (aiService.js:567-569). Its entire tenant boundary is one line:
// `WHERE tenant_id = $1` at :40. R1 does not select `tenant_id`, so nothing downstream
// can revalidate ownership — the predicate is not one check among several, it is the
// only one (05-isolation.md §B.R1).
//
// Phase 5 of the RAG audit measured that boundary's regression cover and found it to be
// zero. An external shim deleted the predicate and the suite still reported 989 pass /
// 0 fail, byte-identical to baseline (05-isolation.md §F.3, red-checked by execution at
// §F.5). Of the 30 references to `getRelevantChunks` under tests/, 29 are stubs that
// never reach the SQL, and the one that does — portalFaqs.integration.test.js:465 — is
// single-tenant and makes no cross-tenant claim (§F.2).
//
// This file is that missing net: §F.4's T-1 and T-2, and nothing else. T-3 (provisioning
// `--kb-dir` dedup), T-4 (the three out-of-module readers), T-5 (`getTrace` reachability)
// and T-6 (foreign-vs-fabricated id equality) defend different hops and belong to later
// sessions.
//
// TWO RULES GOVERN THIS FILE, and they pull in opposite directions on purpose:
//
//   • `getRelevantChunks` is NEVER stubbed here. It is the subject under test. A
//     `mock.method(knowledgeService, 'getRelevantChunks', …)` anywhere in this file
//     would reproduce precisely the hole the file exists to close.
//
//   • The EMBEDDING is stubbed, so no Gemini call is made and no quota is spent. The
//     stub sits at the SDK boundary — `GenerativeModel.prototype.embedContent` — and
//     NOT on `knowledgeService.embed`, because `getRelevantChunks:34` calls the
//     module-local `embed` binding rather than `module.exports.embed`; a
//     `mock.method()` on the export is invisible to it. (Contrast createChunk /
//     updateChunk, which call through the export deliberately — knowledgeService.js:76-79
//     — and note that this asymmetry is why portalFaqs.integration.test.js:465 has to
//     spend real Gemini quota to reach R1.) Patching the transport is also the stronger
//     choice: R1's real `embed()` body at :10-19 still executes.
//
// The query vector is not generated, it is read back byte-for-byte from a row OWNED BY
// TENANT B — cosine distance 0 to a row tenant A must never see, which is the strongest
// possible cross-tenant pull. That is §H.2's executed prototype, made permanent.
//
// The fixture is 17 rows. §H.6 measured that Postgres does not choose the HNSW index for
// a single tenant below ~400 rows in a 1,500-row table, so both queries here run exact
// and an approximate-recall flake is not available to this test.
//
// Disjoint scratch-DB prefix (zyon_riso_) so this suite can run in parallel with the
// other scratch-minting suites without dropping their databases.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_riso_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_riso\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── Deterministic fixture vectors ────────────────────────────────────────────
// mulberry32: the fixture — and therefore the ranking it produces — is
// byte-identical on every run. A random fixture would make a failure here
// impossible to reproduce.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Unit-normalised Gaussian, 768-dim — the shape a real embedding has, and the
// shape §H.1 seeded. All-zero vectors have no defined cosine distance; uniform
// [0,1) noise would push every row into one orthant and float every similarity
// near 1, hiding the very contrast T-1 measures.
function unitGaussian(rand, dim = 768) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(rand(), Number.MIN_VALUE);
    const u2 = rand();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

// ── The embedding stub (see the header) ──────────────────────────────────────
// An exact-match registry of query text → the vector `embed` must return. A
// query this file did not register throws, so an accidental live Gemini call is
// loud rather than silent.
const VECTORS = new Map();

function stubEmbeddingTransport() {
  const { GenerativeModel } = require('@google/generative-ai');
  GenerativeModel.prototype.embedContent = async function embedContent(request) {
    const text = (request && request.content && Array.isArray(request.content.parts))
      ? request.content.parts.map((p) => p.text).join('')
      : String(request);
    if (!VECTORS.has(text)) {
      throw new Error(
        `retrievalIsolation: unregistered embedding query ${JSON.stringify(text)} — ` +
        'refusing to make a live Gemini call');
    }
    return { embedding: { values: VECTORS.get(text) } };
  };
}

// faqService.encode's convention: content is `Q: …\nA: …` on a single newline,
// source is 'faq' (02-ingestion.md §B.2 conventions 1 and 2). R1 neither selects
// nor filters `source`, so it is inert here — but a seed that violated the
// convention would leave rows no product surface could have written.
function faqContent(label, i) { return `Q: ${label} question ${i}?\nA: ${label} answer ${i}.`; }

describe('R1 retrieval isolation — getRelevantChunks is tenant-scoped (INV-R1)',
  { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {

  let scratchName, scratchCs, db, knowledgeService;
  let A, B;                 // { tenantId, ids: [...] }
  let sourceRowId;          // the row in B whose own vector becomes the query

  // The query whose registered vector IS tenant B's row 0, byte-for-byte.
  const PULL = 'pull tenant B chunk 0 by its own vector';
  // validationService.js:220's real canned retrieval probe — the text a
  // production tenant-resolution bug would actually arrive with.
  const CANNED = 'what are your timings';

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Only AFTER the env swap: src/db/db.js builds its Pool from DATABASE_URL at
    // import time, so an eager require would bind the wrong database.
    process.env.DATABASE_URL = scratchCs;
    stubEmbeddingTransport();
    db = require('../../src/db/db');
    knowledgeService = require('../../src/modules/knowledge/knowledgeService');

    const rand = mulberry32(0x5150A709);
    A = await seedTenant('Alpha Clinic', Array.from({ length: 12 }, () => unitGaussian(rand)));
    B = await seedTenant('Bravo Clinic', Array.from({ length: 5 }, () => unitGaussian(rand)));

    // Read B's row 0 vector back out of the table and register it as the answer
    // `embed` gives for PULL. The pull is therefore maximal: distance 0.
    sourceRowId = B.ids[0];
    const { rows } = await db.query(
      'SELECT embedding::text AS embedding FROM knowledge_chunks WHERE id = $1', [sourceRowId]);
    VECTORS.set(PULL, JSON.parse(rows[0].embedding));
    VECTORS.set(CANNED, unitGaussian(rand));
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

  async function seedTenant(businessName, vectors) {
    const t = await db.query(
      'INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [businessName]);
    const tenantId = t.rows[0].id;
    const label = businessName.split(' ')[0];
    const ids = [];
    for (let i = 0; i < vectors.length; i++) {
      const r = await db.query(
        `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
         VALUES ($1, $2, $3::vector, $4) RETURNING id`,
        [tenantId, faqContent(label, i), `[${vectors[i].join(',')}]`, 'faq']);
      ids.push(r.rows[0].id);
    }
    return { tenantId, ids };
  }

  // T-1 (05-isolation.md §F.4). Fails at knowledgeService.js:40 — `WHERE
  // tenant_id = $1` — and at nothing else: the fixture is exact-plan, the
  // vector is deterministic, and the control below proves retrieval itself works.
  it("R1 is tenant-scoped: a query vector drawn from tenant B's own corpus returns zero of B's rows for tenant A", async () => {
    const aIds = new Set(A.ids);
    const bIds = new Set(B.ids);

    // ── NEGATIVE: the attack. Tenant A asks with tenant B's own vector. ──
    const forA = await knowledgeService.getRelevantChunks(A.tenantId, PULL, 3);

    assert.equal(forA.length, 3, 'A owns 12 chunks, so a topK of 3 is satisfiable from A alone');
    for (const row of forA) {
      assert.ok(aIds.has(row.id),
        `cross-tenant row returned to A: ${row.id} — ${JSON.stringify(row.content)}`);
      assert.ok(!bIds.has(row.id),
        `row ${row.id} belongs to tenant B and was served to tenant A`);
    }
    assert.ok(!forA.some((r) => r.id === sourceRowId),
      "B's source row is at cosine distance 0 from the query vector and must still be absent for A");
    assert.ok(forA[0].similarity < 0.5,
      `A's best hit should be an unrelated neighbour, not the pulled row (got ${forA[0].similarity})`);

    // ── POSITIVE CONTROL: the same vector, its own tenant. ──
    // Without this, the negative above would also pass if retrieval were simply
    // broken. §H.2 measured the same contrast: 0.095 for A, 1.000000 for B.
    const forB = await knowledgeService.getRelevantChunks(B.tenantId, PULL, 3);

    assert.equal(forB.length, 3, 'B owns 5 chunks, so a topK of 3 is satisfiable from B alone');
    assert.equal(forB[0].id, sourceRowId,
      'the identical vector must return B its own source row as the top hit — otherwise the pull was not real');
    assert.ok(forB[0].similarity >= 0.999999,
      `the source row is its own nearest neighbour at similarity 1.0 (got ${forB[0].similarity})`);
    for (const row of forB) {
      assert.ok(bIds.has(row.id), `cross-tenant row returned to B: ${row.id}`);
    }
  });

  // T-2 (05-isolation.md §F.4). Pins the fail-closed behaviour §H.2's attacks 2,
  // 2b and 4 measured, so a future "convenience" coercion cannot silently turn a
  // tenant-resolution bug into a full-corpus read. The first two assertions fail
  // at knowledgeService.js:40 (SQL NULL is never equal to anything); the third
  // fails at :40 together with :43's parameterised `$1`, which is what forces the
  // uuid cast that raises 22P02.
  it('R1 denies rather than defaults when the tenant cannot be resolved', async () => {
    assert.deepEqual(await knowledgeService.getRelevantChunks(undefined, CANNED, 3), [],
      'undefined tenant: node-pg sends SQL NULL and `tenant_id = NULL` is never true — 0 rows, not the whole corpus');

    assert.deepEqual(await knowledgeService.getRelevantChunks(null, CANNED, 3), [],
      'explicit null tenant denies identically');

    await assert.rejects(
      () => knowledgeService.getRelevantChunks("' OR 1=1 --", CANNED, 3),
      (err) => {
        assert.equal(err.code, '22P02',
          `a non-UUID tenant must be rejected by the uuid cast, not silently widened (got ${err.code}: ${err.message})`);
        return true;
      },
      'a non-UUID tenantId must throw rather than return rows');
  });
});
