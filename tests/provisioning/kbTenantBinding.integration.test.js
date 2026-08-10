'use strict';

// T-3 (05-isolation.md §F.4) — `ingestKnowledge` writes only to the tenant it
// was given, and a re-run into a DIFFERENT tenant does not dedup against the
// first.
//
// R7 — the resume check at provisioningService.js:136-139 — is
// `SELECT 1 FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2 LIMIT 1`.
// Its key has two halves and only one of them is defended anywhere: the
// existing suite asserts the `source` half (provisioning.integration.test.js:298
// pre-seeds a source and asserts the skip), and nothing asserts the `tenant_id`
// half at all. That half rests on one uncommented `$1`. If it were dropped, the
// same document ingested for clinic A would be SKIPPED for clinic B — clinic B
// silently going live with an empty knowledge base while the CLI reports
// `skipped 1 already-ingested`, which reads as success (§A.6, D2-01).
//
// So: ingest the same directory into A, then into B, and assert BOTH hold full
// copies with A's rows untouched.
//
// THE WRITE PATH IS NOT STUBBED. `ingestKnowledge` → `chunkText` → `storeChunks`
// → the real INSERT all execute; a stub anywhere in there would reproduce
// exactly the hole §F.2 measured, where 29 of 30 test references to retrieval
// never reached the SQL. What IS stubbed is the SDK TRANSPORT —
// `GenerativeModel.prototype.embedContent` — following
// retrievalIsolation.integration.test.js: `storeChunks` calls the module-local
// `embed` binding (knowledgeService.js:174), so `mock.method` on the export is
// invisible to it, and patching the transport leaves embed()'s own body,
// deadline and budget class executing. No Gemini call is possible and no quota
// is spent.
//
// Disjoint scratch-DB prefix (zyon_kbt_).

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_kbt_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_kbt\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// A deterministic unit vector per text: the same chunk always embeds to the
// same 768 floats, so a failure here is reproducible. Values are irrelevant to
// what this file asserts — nothing retrieves — but a NOT NULL-shaped, correctly
// dimensioned vector keeps the INSERT identical to production's.
function vectorFor(text) {
  const seed = crypto.createHash('sha256').update(text).digest();
  const v = new Array(768);
  for (let i = 0; i < 768; i++) v[i] = ((seed[i % seed.length] / 255) - 0.5) / 16;
  return v;
}

let embedCalls = 0;
function stubEmbeddingTransport() {
  const { GenerativeModel } = require('@google/generative-ai');
  GenerativeModel.prototype.embedContent = async function embedContent(request) {
    embedCalls += 1;
    const text = (request && request.content && Array.isArray(request.content.parts))
      ? request.content.parts.map((p) => p.text).join('')
      : String(request);
    return { embedding: { values: vectorFor(text) } };
  };
}

// Long enough that chunkText's 500-char window actually splits it: "full copy"
// has to mean several rows, or a dedup bug could survive by writing one.
const para = (label, n) => `${label} paragraph ${n}. ` + `${label} `.repeat(30) + 'end.';
const DOC_A = [para('alpha', 1), para('alpha', 2), para('alpha', 3)].join('\n\n');
const DOC_B = [para('bravo', 1), para('bravo', 2)].join('\n\n');

describe('T-3 — ingestKnowledge is bound to the tenant it was given',
  { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {

  let scratchName, db, provisioning, kbDir, A, B, expectedChunks;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Only AFTER the env swap: src/db/db.js builds its Pool from DATABASE_URL
    // at import time.
    process.env.DATABASE_URL = scratchCs;
    stubEmbeddingTransport();
    db = require('../../src/db/db');
    provisioning = require('../../src/modules/provisioning/provisioningService');
    const { chunkText } = require('../../src/modules/knowledge/knowledgeService');

    const mk = async (name, phone) => (await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id) VALUES ($1, $2, $3) RETURNING id`,
      [name, name.toLowerCase().replace(/\W+/g, '-'), phone])).rows[0].id;
    A = await mk('Alpha Clinic', '910000000000031');
    B = await mk('Bravo Clinic', '910000000000032');

    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbt-'));
    fs.writeFileSync(path.join(kbDir, 'services.md'), DOC_A);
    fs.writeFileSync(path.join(kbDir, 'policies.txt'), DOC_B);

    // The expected row count is derived from the repo's own chunker, not
    // hardcoded — a chunkText change must not quietly weaken this test.
    expectedChunks = {
      'services.md': chunkText(DOC_A).length,
      'policies.txt': chunkText(DOC_B).length,
    };
    assert.ok(expectedChunks['services.md'] > 1, 'the fixture must span multiple chunks');
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    if (kbDir) fs.rmSync(kbDir, { recursive: true, force: true });
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  const rowsOf = async (tenantId) => (await db.query(
    `SELECT id, content, source FROM knowledge_chunks WHERE tenant_id = $1
      ORDER BY source, content`, [tenantId])).rows;

  it('the same --kb-dir ingested into A then B leaves BOTH holding full copies, A untouched', async () => {
    const total = expectedChunks['services.md'] + expectedChunks['policies.txt'];

    const intoA = await provisioning.ingestKnowledge(A, kbDir);
    assert.deepEqual(intoA.skipped, [], 'a first ingest skips nothing');
    assert.equal(intoA.failed, null);
    assert.deepEqual([...intoA.ingested].sort(), ['policies.txt', 'services.md']);

    const aBefore = await rowsOf(A);
    assert.equal(aBefore.length, total, 'A holds every chunk of both documents');

    // ── The assertion this file exists for. R7's dedup is (tenant_id, source);
    // with the tenant half gone, A's rows would match B's lookup and BOTH
    // documents would come back as `skipped` with nothing written for B.
    const intoB = await provisioning.ingestKnowledge(B, kbDir);
    assert.deepEqual(intoB.skipped, [],
      "B must not dedup against A's rows — the dedup key is (tenant_id, source)");
    assert.equal(intoB.failed, null);
    assert.deepEqual([...intoB.ingested].sort(), ['policies.txt', 'services.md']);

    const bRows = await rowsOf(B);
    assert.equal(bRows.length, total, 'B holds a full copy, not a partial one');
    for (const [source, n] of Object.entries(expectedChunks)) {
      assert.equal(bRows.filter((r) => r.source === source).length, n,
        `B holds every chunk of ${source}`);
    }

    // Same documents, same chunking, different rows.
    const aAfter = await rowsOf(A);
    assert.deepEqual(bRows.map((r) => [r.source, r.content]), aAfter.map((r) => [r.source, r.content]),
      'the two tenants hold identical text');
    assert.equal(new Set([...aAfter, ...bRows].map((r) => r.id)).size, total * 2,
      'and hold it in disjoint rows');

    // A is untouched: same ids, same contents, same count.
    assert.deepEqual(aAfter, aBefore, "ingesting for B must not modify a single one of A's rows");

    // Every chunk was embedded exactly once per tenant, through the real
    // storeChunks loop — proof the write path ran rather than being short-
    // circuited by a stub.
    assert.equal(embedCalls, total * 2);
  });

  it("a re-run into A skips (the source half of the key), and B keeps its own rows", async () => {
    const aBefore = await rowsOf(A);
    const bBefore = await rowsOf(B);
    const callsBefore = embedCalls;

    const again = await provisioning.ingestKnowledge(A, kbDir);
    assert.deepEqual(again.ingested, []);
    assert.deepEqual([...again.skipped].sort(), ['policies.txt', 'services.md']);
    assert.equal(again.failed, null);

    assert.deepEqual(await rowsOf(A), aBefore, 'a resume must not duplicate rows');
    assert.deepEqual(await rowsOf(B), bBefore, "and must not touch the other tenant's");
    assert.equal(embedCalls, callsBefore, 'a skipped source costs no embedding call');
  });
});
