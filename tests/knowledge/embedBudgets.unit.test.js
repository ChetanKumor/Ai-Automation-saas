'use strict';

// ONE DEADLINE CANNOT SERVE THREE CALLERS — RAG Session 3 §6.0, D-011.
//
// D-010 gave `knowledgeService.embed` a single 3,000 ms deadline and derived it
// from the voice turn: 8,000 ms of turn budget (internalVoice.js:65-68) less
// hydration, with generation and tool rounds still to come. The derivation was
// sound. Applying its result to every caller was not — and D-010's own recorded
// falsifier fired, in the suite rather than in production:
//
//   tests/portal/portalFaqs.integration.test.js:465 → POST /portal/api/faqs →
//   createChunk → the first, COLD embedding call of that test process. Under the
//   suite's 20-way file parallelism it exceeded 3,000 ms, EMBED_TIMEOUT
//   propagated, and the route 500'd. An owner clicking Save had been given a
//   voice turn's deadline. There is no turn budget on that request at all.
//
// So the classes are the point of this file, and each test asks a different
// question about them:
//
//   (1) does an expiry name the class that expired,
//   (2) does a class's own env var govern ONLY its own call sites,
//   (3) does a caller that fails to classify itself get the SAFE bound,
//   (4) are the three defaults the derived table, and
//   (5) is D-010's composition-with-`signal` behaviour untouched.
//
// (2) is the one that would have caught the defect. It is the unit twin of the
// two-way pair run against portalFaqs:465 this session: with the turn bound at
// 50 ms the portal save now succeeds and only retrieval fails; with the
// interactive bound at 50 ms the save fails byte-identically to the original red.
//
// ── HOW THIS FILE REACHES THE REAL CALL SITES WITHOUT POSTGRES ───────────────
// `src/db/db` is replaced in require.cache BEFORE knowledgeService is required,
// so storeChunks / getRelevantChunks / createChunk / updateChunk all execute for
// real — including which `embed` binding each one reaches, which is the property
// §6.5 forbids changing — while every SQL call returns a canned row. Asserting on
// `embed` alone would prove the parameter exists; it would not prove the call
// sites pass it, and the call sites are the change.
//
// The transport is stubbed at `GenerativeModel.prototype.embedContent`, never at
// `knowledgeService.embed`: a `mock.method` on the export is invisible to the
// LOCAL binding getRelevantChunks calls (knowledgeService.js:226-229), and half
// of what is under test here is exactly that split. No Gemini quota is spent.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { GenerativeModel } = require('@google/generative-ai');

// Canned SQL. getChunk must return a row (updateChunk bails to null otherwise)
// and its `content` must differ from what the update writes, or updateChunk takes
// the text-unchanged branch and never embeds at all.
const CANNED_ROW = { id: 'row', content: 'stored text', source: 'faq', created_at: new Date(0) };
const dbPath = require.resolve('../../src/db/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    query: async () => ({ rows: [CANNED_ROW], rowCount: 1 }),
  },
};

const knowledgeService = require('../../src/modules/knowledge/knowledgeService');

const ORIGINAL_EMBED_CONTENT = GenerativeModel.prototype.embedContent;
const ENV_KEYS = ['EMBED_TIMEOUT_MS', 'EMBED_TIMEOUT_INTERACTIVE_MS', 'EMBED_TIMEOUT_BATCH_MS'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const TENANT = '00000000-0000-0000-0000-aaaa00000031';
const CHUNK_ID = '00000000-0000-0000-0000-cccc00000031';
const FAKE_VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 7);

let calls;
const pendingTimers = new Set();

/**
 * `behaviour`:
 *   'hang'  — settles only when the caller's signal aborts. A ref'd keep-alive
 *             timer holds the loop open so an UNBOUNDED call becomes a clean
 *             assertion failure rather than a process that exits early and
 *             reports `# cancelled` (§7.4 — Session 2's lesson).
 *   'slow'  — resolves after `slowMs`, so a bound below it fires and a bound
 *             above it does not. That difference is test (2).
 */
function stubTransport(behaviour, slowMs = 200) {
  GenerativeModel.prototype.embedContent = async function embedContent(request, requestOptions) {
    calls.push(requestOptions);
    if (behaviour === 'slow') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ embedding: { values: FAKE_VECTOR } }), slowMs);
        pendingTimers.add(t);
        const sig = requestOptions && requestOptions.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            clearTimeout(t); pendingTimers.delete(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        }
      });
    }
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const keepAlive = setTimeout(() => resolve({ embedding: { values: FAKE_VECTOR } }), 30000);
      pendingTimers.add(keepAlive);
      const sig = requestOptions && requestOptions.signal;
      if (!sig) return;
      if (sig.aborted) { clearTimeout(keepAlive); pendingTimers.delete(keepAlive); return abort(); }
      sig.addEventListener('abort', () => {
        clearTimeout(keepAlive); pendingTimers.delete(keepAlive); abort();
      }, { once: true });
    });
  };
}

// Never let an unbounded call become a per-test timeout: a timed-out test is
// reported `not ok` but counted under `# cancelled`, never `# fail` — which is
// precisely the hole §6.2 closes in the gate, and no test defending a deadline
// should rely on the thing it is defending.
const UNBOUNDED = Symbol('unbounded');
const GUARD_MS = 2500;
function settleOrGiveUp(promise) {
  return Promise.race([
    promise.then((value) => ({ value }), (err) => ({ err })),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ marker: UNBOUNDED }), GUARD_MS);
      pendingTimers.add(t);
    }),
  ]);
}

// The four production call sites, each named by the class it declares.
const CALL_SITES = {
  turn: () => knowledgeService.getRelevantChunks(TENANT, 'what are your timings', 3),
  interactiveCreate: () => knowledgeService.createChunk(TENANT, { content: 'Q: parking?\nA: yes', source: 'faq' }),
  interactiveUpdate: () => knowledgeService.updateChunk(TENANT, CHUNK_ID, { content: 'new text', source: 'faq' }),
  batch: () => knowledgeService.storeChunks(TENANT, ['one chunk of a document'], 'clinic.md'),
};

async function expiryFrom(site) {
  const r = await settleOrGiveUp(CALL_SITES[site]());
  assert.notEqual(r.marker, UNBOUNDED,
    `${site} did not settle within ${GUARD_MS}ms — its deadline did not fire at all`);
  assert.ok(r.err, `${site} resolved instead of hitting its deadline`);
  return r.err;
}

describe('every embedding call site carries the deadline its own budget allows', () => {
  before(() => { calls = []; });

  afterEach(() => {
    calls = [];
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  after(() => {
    GenerativeModel.prototype.embedContent = ORIGINAL_EMBED_CONTENT;
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  // ── (1) An expiry says WHICH bound expired (§6.0(f)) ────────────────────────
  // With three deadlines, "the embedding deadline fired" identifies nothing
  // actionable: from the turn class it means Google was slow, from the batch
  // class it means a socket is wedged, and they are fixed differently.
  it('(1) each call site reports the class that expired, and its own configured value', async () => {
    process.env.EMBED_TIMEOUT_MS = '40';
    process.env.EMBED_TIMEOUT_INTERACTIVE_MS = '80';
    process.env.EMBED_TIMEOUT_BATCH_MS = '120';
    stubTransport('hang');

    const expected = {
      turn:              { budget: 'turn',        ms: '40',  env: 'EMBED_TIMEOUT_MS' },
      interactiveCreate: { budget: 'interactive', ms: '80',  env: 'EMBED_TIMEOUT_INTERACTIVE_MS' },
      interactiveUpdate: { budget: 'interactive', ms: '80',  env: 'EMBED_TIMEOUT_INTERACTIVE_MS' },
      batch:             { budget: 'batch',       ms: '120', env: 'EMBED_TIMEOUT_BATCH_MS' },
    };

    for (const [site, want] of Object.entries(expected)) {
      const err = await expiryFrom(site);
      assert.equal(err.code, 'EMBED_TIMEOUT',
        `${site}: the discriminator D-010 added must survive the split (P5-3)`);
      assert.equal(err.budget, want.budget,
        `${site}: the error must carry its budget class as a field, for grouping in logs`);
      assert.match(err.message, new RegExp(`\\b${want.ms}ms\\b`),
        `${site}: the message must name the value that fired, got: ${err.message}`);
      assert.match(err.message, new RegExp(want.env),
        `${site}: the message must name the knob that set it, got: ${err.message}`);
    }
  });

  // ── (2) THE DEFECT. A class's env var governs only its own call sites ───────
  // This is the unit twin of the two-way pair run against portalFaqs:465. Before
  // the split, EMBED_TIMEOUT_MS at 50 ms turned an owner's Save into a 500.
  it('(2) the turn deadline does not reach the portal save or CLI ingestion', async () => {
    process.env.EMBED_TIMEOUT_MS = '40';          // interactive + batch stay at their defaults
    stubTransport('slow', 200);                   // slower than 40ms, far faster than 10s/30s

    const turnErr = await expiryFrom('turn');
    assert.equal(turnErr.budget, 'turn',
      'retrieval IS governed by the turn bound — that half must not regress');

    for (const site of ['interactiveCreate', 'interactiveUpdate', 'batch']) {
      const r = await settleOrGiveUp(CALL_SITES[site]());
      assert.notEqual(r.marker, UNBOUNDED, `${site} did not settle within ${GUARD_MS}ms`);
      assert.equal(r.err, undefined,
        `${site} failed under a TURN deadline it does not belong to — this is the defect ` +
        `verbatim: ${r.err && r.err.message}`);
    }
  });

  // ── (3) The fallback is the SAFE bound, not the generous one (§6.0(b)) ──────
  it('(3) an unclassified or misspelled caller falls back to the tightest class', async () => {
    process.env.EMBED_TIMEOUT_MS = '40';
    stubTransport('slow', 200);

    for (const budget of [undefined, 'batchh', 'INTERACTIVE', '', null]) {
      const args = budget === undefined ? ['x'] : ['x', null, budget];
      const r = await settleOrGiveUp(knowledgeService.embed(...args));
      assert.notEqual(r.marker, UNBOUNDED, `budget=${String(budget)} did not settle`);
      assert.ok(r.err, `budget=${String(budget)} was not bounded at all`);
      assert.equal(r.err.budget, 'turn',
        `budget=${String(budget)} must fall back to the conservative class — a typo that ` +
        'silently buys a 30s deadline on a patient-facing turn is the failure being prevented');
    }
  });

  // ── (4) The table itself ────────────────────────────────────────────────────
  it('(4) the three defaults are the derived table, and turn is the tightest', () => {
    const b = knowledgeService.EMBED_BUDGETS;
    assert.equal(b.turn.ms, 3000,
      'the turn bound is D-010\'s derived value and this session does not revisit it — ' +
      'it scopes it to the voice path it was derived for');
    assert.equal(b.interactive.ms, 10000);
    assert.equal(b.batch.ms, 30000);
    assert.deepEqual(
      Object.keys(b).map((k) => k),
      ['turn', 'interactive', 'batch'],
      'three classes, no more: a fourth would need its own derivation in D-011');
    assert.equal(knowledgeService.DEFAULT_EMBED_BUDGET, 'turn',
      'the default must be the TIGHTEST class');
    assert.ok(b.turn.ms < b.interactive.ms && b.interactive.ms < b.batch.ms,
      'the ordering is the argument: the cheaper a spurious expiry is, the tighter the bound');
  });

  // ── (5) D-010's composition behaviour is unchanged ──────────────────────────
  it('(5) a caller signal still wins, and an already-aborted signal never dispatches', async () => {
    process.env.EMBED_TIMEOUT_BATCH_MS = '30000';
    stubTransport('hang');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);
    const t0 = Date.now();
    const err = await knowledgeService.embed('rescheduling', ac.signal, 'batch')
      .then(() => { throw new Error('expected a rejection'); }, (e) => e);
    assert.ok(Date.now() - t0 < 2000, 'the caller abort must not be swallowed by a 30s batch bound');
    assert.notEqual(err.code, 'EMBED_TIMEOUT', 'a caller abort is not a deadline expiry');

    calls = [];
    const pre = new AbortController();
    pre.abort();
    const preErr = await knowledgeService.embed('already gone', pre.signal, 'interactive')
      .then(() => { throw new Error('expected a rejection'); }, (e) => e);
    assert.equal(preErr.name, 'AbortError');
    assert.equal(calls.length, 0,
      'an already-aborted signal must throw BEFORE dispatch — the SDK wires signals with ' +
      'addEventListener, which never fires for one that aborted first');
  });
});
