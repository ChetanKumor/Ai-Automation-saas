'use strict';

// Q4-1 (01-map.md §7, §6.2's absence table) — R1 takes top-K with NO similarity
// threshold. `similarity` is computed at `knowledgeService.js:191` and every
// consumer discards it. At the envelope's 150–250 chunks per tenant and topK=3,
// R1 ALWAYS returns three rows, and `aiService.js:575` renders all three under
//
//     Business knowledge (use ONLY this to answer questions — do not invent information):
//
// so the third row — whatever it is — is handed to the model as the authoritative
// answer to the question that was asked.
//
// This file is the floor's regression net. It exercises the REAL R1 against a
// REAL Postgres (§7.3: a unit test on a filter function in isolation would not
// show the floor working on scores that came out of the SQL), through the REAL
// production path — `assembleConversationContext`, the single retrieval path both
// channels use — and it follows Session 1's two-tenant idiom
// (`retrievalIsolation.integration.test.js`) deliberately, because one of the
// things that has to stay true is that the floor did not become a substitute for
// the tenant predicate.
//
// ── WHY THE FIXTURE CAN NAME ITS OWN SIMILARITIES ───────────────────────────
// Session 1 seeded random unit-Gaussian vectors and got whatever similarities
// they happened to produce (0.026–0.060). A threshold test cannot be built on
// "whatever happened": it has to seed a row that is a KNOWN distance from the
// query. So this fixture builds one unit query vector `q` and one unit vector `u`
// orthogonal to it (Gram-Schmidt), and then
//
//     v(s) = s·q + sqrt(1 - s²)·u        has cosine similarity EXACTLY s with q.
//
// Measured after float4 storage (pgvector's element type), the round trip lands
// within 1e-9 of the target — so a chunk seeded "at 0.62" really does come back
// from R1 at 0.62, and an assertion about the floor is an assertion about the
// floor rather than about fixture luck.
//
// A third vector `far`, orthogonal to both, is the query for which EVERY chunk
// scores exactly 0 — that is how the zero-surviving-chunks case (§7.4, D-010's
// Q4-3 interaction) is reached without deleting any data.
//
// ── THE EMBEDDING IS STUBBED, R1 IS NOT ─────────────────────────────────────
// Same rule and same reason as Session 1: the stub sits at
// `GenerativeModel.prototype.embedContent`, never on `knowledgeService.embed`,
// because `getRelevantChunks:187` calls the module-local binding and a
// `mock.method` on the export is invisible to it (knowledgeService.js:110-118).
// No Gemini quota is spent; R1's own `embed()` body still executes.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_rfloor_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_rfloor\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── Deterministic geometry ───────────────────────────────────────────────────
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
function gaussian(rand, dim = 768) {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(rand(), Number.MIN_VALUE);
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
  }
  return v;
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (a) => { const n = Math.sqrt(dot(a, a)); return a.map((x) => x / n); };
/** Gram-Schmidt `v` against every vector in `basis`, then normalise. */
function orthonormalise(v, basis) {
  let w = v.slice();
  for (const b of basis) {
    const p = dot(w, b);
    w = w.map((x, i) => x - p * b[i]);
  }
  return unit(w);
}

const VECTORS = new Map();
function stubEmbeddingTransport() {
  const { GenerativeModel } = require('@google/generative-ai');
  GenerativeModel.prototype.embedContent = async function embedContent(request) {
    const text = (request && request.content && Array.isArray(request.content.parts))
      ? request.content.parts.map((p) => p.text).join('')
      : String(request);
    if (!VECTORS.has(text)) {
      throw new Error(
        `relevanceFloor: unregistered embedding query ${JSON.stringify(text)} — ` +
        'refusing to make a live Gemini call');
    }
    return { embedding: { values: VECTORS.get(text) } };
  };
}

describe('Q4-1 — a relevance floor stands between R1 and the prompt',
  { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {

  let scratchName, scratchCs, db, knowledgeService, contextAssembler, traces, requestContext, aiService;
  let A, B;
  let chunkAt;             // (similarity) -> vector
  const ids = {};          // label -> chunk id

  // The query every seeded chunk has a KNOWN similarity to.
  const QUERY = 'the query whose vector is the fixture basis';
  // Orthogonal to every seeded chunk: similarity exactly 0 for all of them.
  const QUERY_FAR = 'a query orthogonal to every chunk in the fixture';

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
    stubEmbeddingTransport();
    db               = require('../../src/db/db');
    knowledgeService = require('../../src/modules/knowledge/knowledgeService');
    contextAssembler = require('../../src/modules/conversation/contextAssembler');
    traces           = require('../../src/modules/traces/collector');
    requestContext   = require('../../src/core/requestContext');
    aiService        = require('../../src/modules/ai/aiService');

    const rand = mulberry32(0x5EED0F10);
    const q   = unit(gaussian(rand));
    const u   = orthonormalise(gaussian(rand), [q]);
    const far = orthonormalise(gaussian(rand), [q, u]);
    chunkAt = (s) => q.map((x, i) => s * x + Math.sqrt(1 - s * s) * u[i]);

    VECTORS.set(QUERY, q);
    VECTORS.set(QUERY_FAR, far);

    // Tenant A: one chunk comfortably above the floor, two comfortably below.
    A = await seedTenant('Alpha Clinic', [
      ['above', 0.62, 'Q: Do you do root canals?\nA: Yes, root canal treatment starts at 6,000 rupees.'],
      ['below', 0.12, 'Q: Where can I park?\nA: Free parking is available behind the building.'],
      ['floor_adjacent', 0.05, 'Q: Do you sell toothbrushes?\nA: We stock a few brands at reception.'],
    ]);
    // Tenant B: a chunk that would clear the floor easily. It must still never
    // reach tenant A — the floor is applied AFTER the tenant predicate (6.1c),
    // it is not a substitute for it.
    B = await seedTenant('Bravo Clinic', [
      ['b_high', 0.99, 'Q: Bravo only.\nA: This row belongs to another clinic entirely.'],
    ]);
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

  afterEach(() => {
    delete process.env.RAG_MIN_SIMILARITY;
    aiService._setModelProvider(null);
  });

  async function seedTenant(businessName, rows) {
    const t = await db.query(
      'INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [businessName]);
    const tenantId = t.rows[0].id;

    for (const [label, sim, content] of rows) {
      const r = await db.query(
        `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
         VALUES ($1, $2, $3::vector, 'faq') RETURNING id`,
        [tenantId, content, `[${chunkAt(sim).join(',')}]`]);
      ids[label] = r.rows[0].id;
    }

    // assembleConversationContext excludes the current inbound row by id (V-009),
    // so the turn needs a real customer / conversation / message.
    const cust = await db.query(
      `INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING id`,
      [tenantId, '+9190000' + Math.floor(Math.random() * 100000)]);
    const conv = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id, status, mode)
       VALUES ($1, $2, 'open', 'ai') RETURNING id`,
      [tenantId, cust.rows[0].id]);
    const msg = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel)
       VALUES ($1, $2, $3, 'inbound', 'customer', $4, 'whatsapp') RETURNING id`,
      [tenantId, conv.rows[0].id, cust.rows[0].id, 'the inbound turn']);

    return { tenantId, customerId: cust.rows[0].id, conversationId: conv.rows[0].id, messageId: msg.rows[0].id };
  }

  /** One turn's context assembly, inside a traced request context. */
  async function assemble(tenant, text) {
    return requestContext.runWith({ correlationId: 'ts_0000000000000000' }, async () => {
      const trace = traces.open({ channel: 'whatsapp', tenantId: tenant.tenantId });
      const ctx = await contextAssembler.assembleConversationContext({
        tenantId: tenant.tenantId,
        conversationId: tenant.conversationId,
        customerId: tenant.customerId,
        currentMessageId: tenant.messageId,
        text,
      });
      return { ctx, trace };
    });
  }

  const contents = (chunks) => chunks.map((c) => c.content);

  // ── 6.1, BOTH DIRECTIONS (§7.2) ─────────────────────────────────────────────
  // A one-directional test passes when the floor is 1.0 and everything is cut.
  it('(1) a chunk below the floor is excluded and a chunk above it is retained — on scores that came out of R1', async () => {
    const { ctx } = await assemble(A, QUERY);

    // RETAINED. Seeded at 0.62, far above the 0.25 default.
    assert.ok(contents(ctx.knowledgeChunks).some((c) => c.includes('root canal treatment starts')),
      'the chunk seeded at similarity 0.62 must still reach the prompt — a floor that ' +
      'removes real answers is worse than no floor at all');

    // EXCLUDED. Seeded at 0.12 and 0.05, both below the 0.25 default. At HEAD
    // R1 returns all three rows and every one of them is rendered under the
    // "use ONLY this to answer questions" header.
    assert.ok(!contents(ctx.knowledgeChunks).some((c) => c.includes('Free parking')),
      'the chunk seeded at similarity 0.12 is not an answer to this question and must ' +
      'not be presented to the model as one (Q4-1)');
    assert.ok(!contents(ctx.knowledgeChunks).some((c) => c.includes('toothbrushes')),
      'the chunk seeded at similarity 0.05 must not reach the prompt either');

    assert.equal(ctx.knowledgeChunks.length, 1,
      'exactly one of A\'s three chunks clears the floor');
  });

  // ── 6.1(c) — the floor did NOT replace the tenant predicate ─────────────────
  it('(2) the floor is applied AFTER the tenant predicate, never instead of it', async () => {
    const { ctx } = await assemble(A, QUERY);

    assert.ok(!contents(ctx.knowledgeChunks).some((c) => c.includes('another clinic entirely')),
      "tenant B's chunk sits at similarity 0.99 — it clears any floor. It must be absent " +
      'for tenant A because of INV-R1\'s predicate, and the floor must not have become ' +
      'the thing standing in for it (D-009)');

    // And the same row IS retrievable by its owner, so the negative above is
    // evidence rather than an artefact of the row being unreachable.
    const { ctx: forB } = await assemble(B, QUERY);
    assert.ok(contents(forB.knowledgeChunks).some((c) => c.includes('another clinic entirely')),
      "B's own high-similarity row must reach B — otherwise test (2) proves nothing");
  });

  // ── 6.1(b) — configurable, EMBED_TIMEOUT_* precedent, read at call time ─────
  it('(3) RAG_MIN_SIMILARITY moves the floor, and is read per call', async () => {
    process.env.RAG_MIN_SIMILARITY = '0.7';
    const { ctx: strict } = await assemble(A, QUERY);
    assert.equal(strict.knowledgeChunks.length, 0,
      'a floor of 0.7 is above the 0.62 chunk, so nothing survives');

    process.env.RAG_MIN_SIMILARITY = '0.1';
    const { ctx: loose } = await assemble(A, QUERY);
    assert.equal(loose.knowledgeChunks.length, 2,
      'a floor of 0.1 admits the 0.62 and 0.12 chunks but still not the 0.05 one — ' +
      'and the change took effect without a restart, like EMBED_TIMEOUT_MS (D-011)');
  });

  // ── 7.4 — the interaction that makes the floor safe to ship ─────────────────
  // A floor RAISES the rate at which the zero-chunk branch fires. D-010's change 4
  // (Q4-3) put the anti-invention instruction on that branch. This asserts the two
  // still compose, on the assembled prompt rather than on a helper's return value.
  it('(4) when the floor removes every chunk the prompt still carries the instruction not to invent', async () => {
    const { ctx } = await assemble(A, QUERY_FAR);
    assert.equal(ctx.knowledgeChunks.length, 0,
      'every chunk is orthogonal to this query (similarity 0), so none survives the floor');

    let systemInstruction = null;
    aiService._setModelProvider((config) => {
      systemInstruction = config.systemInstruction;
      return {
        startChat: () => ({
          sendMessage: async () => ({
            response: { functionCalls: () => undefined, text: () => 'ok', usageMetadata: {} },
          }),
        }),
      };
    });

    await aiService.generateReply(
      { id: A.tenantId, business_name: 'Alpha Clinic', ai_prompt: 'You are the receptionist.' },
      { id: A.customerId, phone: '+919000000001', name: null },
      { id: A.conversationId, mode: 'ai', summary: null },
      'do you do root canals?', [], ctx.knowledgeChunks, [], { channel: 'whatsapp' });

    assert.ok(systemInstruction.includes('do not invent information'),
      'a turn whose chunks were ALL removed by the floor is exactly the turn with the ' +
      'least to ground an answer in — the Q4-3 guard must survive it (D-010 change 4)');
  });

  // ── 6.3 — the discarded scores are recorded, distinguishably ────────────────
  // Without this the trace shows only what survived, and the distribution needed
  // to tune the floor is precisely the part that was thrown away.
  it('(5) the trace records filtered-out chunks with their scores, marked apart from the kept ones', async () => {
    const { trace } = await assemble(A, QUERY);

    assert.ok(Array.isArray(trace.retrieval), 'retrieval was recorded');
    assert.equal(trace.retrieval.length, 3, 'all three rows R1 returned are recorded, not just the survivor');

    const kept = trace.retrieval.filter((r) => !r.below_floor);
    const cut  = trace.retrieval.filter((r) => r.below_floor);

    assert.equal(kept.length, 1);
    assert.equal(kept[0].chunk_id, ids.above);
    assert.deepEqual(Object.keys(kept[0]).sort(), ['chunk_id', 'score'],
      'a KEPT entry keeps the exact shape it has always had — traces.integration.test.js:276 ' +
      'deepEquals it, and nothing about this change should move it');

    assert.equal(cut.length, 2, 'both discarded chunks are recorded');
    for (const c of cut) {
      assert.ok(typeof c.score === 'number', 'with the score that got it discarded');
      assert.ok(c.score < 0.25, `a filtered chunk scored below the floor (got ${c.score})`);
    }
    assert.deepEqual(cut.map((c) => c.chunk_id).sort(), [ids.below, ids.floor_adjacent].sort());
  });

  it('(6) a turn where R1 returned nothing at all still records null, not an empty array', async () => {
    // Tenant B owns exactly one chunk and it is orthogonal to QUERY_FAR, so R1
    // returns one row and the floor cuts it: retrieval is the cut row, NOT null.
    const { trace } = await assemble(B, QUERY_FAR);
    assert.ok(Array.isArray(trace.retrieval) && trace.retrieval.length === 1,
      'rows came back and were filtered — that is not the same as no retrieval');
    assert.equal(trace.retrieval[0].below_floor, true);

    // A tenant with no knowledge base at all: R1 returns zero rows.
    const empty = await seedTenant('Charlie Clinic', []);
    const { trace: t2 } = await assemble(empty, QUERY);
    assert.equal(t2.retrieval, null,
      'no rows retrieved → null, unchanged (contextAssembler.js:88, traces.integration.test.js:323)');
  });
});
