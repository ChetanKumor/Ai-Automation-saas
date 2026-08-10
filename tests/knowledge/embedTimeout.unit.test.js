'use strict';

// The embedding call is the ONLY outbound HTTP call on the retrieval path, and
// until this file it had no bound of any kind on five of its six entry points.
//
// `knowledgeService.embed` (:10-19) calls `embeddingModel.embedContent(request)`.
// In @google/generative-ai@0.24.1, `buildFetchOptions`
// (node_modules/@google/generative-ai/dist/index.js:441-456) creates an
// AbortController ONLY when:
//
//     requestOptions?.signal !== undefined || requestOptions?.timeout >= 0
//
// With no second argument that condition is false in both halves, so
// `fetchOptions` is `{}` — a bare `fetch` with no signal and no deadline. There
// is no SDK default. (02-ingestion.md §D.3, re-verified against the installed
// SDK at HEAD this session.) The request is therefore held for as long as Google
// holds the socket: on the WhatsApp path, the portal FAQ save, the provisioning
// CLI, `validationService`'s KB probe and the portal test-turn, nothing else on
// the path is capable of ending it.
//
// The deadline goes INSIDE `embed`'s body rather than around the export. That is
// not a style choice: `getRelevantChunks:34` calls the module-LOCAL `embed`
// binding while `createChunk`/`updateChunk` call `module.exports.embed`
// deliberately (knowledgeService.js:76-79). A wrapper on the export would bound
// four callers and silently miss R1 — the one call on the patient-facing path.
// Inside the body, all six entry points inherit it regardless of binding.
//
// TWO PROPERTIES ARE ASSERTED, and the second is the one that is easy to get
// wrong:
//
//   • the internal deadline fires for a caller that passes nothing (the five
//     unbounded entry points), and
//   • it COMPOSES with a caller-supplied `signal` rather than replacing it — the
//     voice turn's 8,000 ms budget signal must still abort earlier than the
//     internal deadline, and must not be swallowed by it.
//
// The transport is stubbed at `GenerativeModel.prototype.embedContent`, never at
// `knowledgeService.embed` — same reason as retrievalIsolation.integration.test.js:
// a `mock.method` on the export is invisible to the local binding, and stubbing
// the export would remove the very function under test. No Gemini quota is spent.
//
// §7.2: the deadline is read from EMBED_TIMEOUT_MS at call time, so these tests
// configure it down to tens of milliseconds instead of sleeping for the real
// 3,000 ms.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { GenerativeModel } = require('@google/generative-ai');
const knowledgeService = require('../../src/modules/knowledge/knowledgeService');

const ORIGINAL_EMBED_CONTENT = GenerativeModel.prototype.embedContent;
const ORIGINAL_TIMEOUT_ENV = process.env.EMBED_TIMEOUT_MS;

// A 768-dim vector's stand-in — nothing here inspects its contents.
const FAKE_VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 7);

// Records what `embed` handed the SDK, so the composition claim is asserted
// against the real argument rather than inferred from timing.
let seen;

// Keep-alive timers armed by the 'hang' stub (see stubTransport).
const pendingTimers = new Set();

// "Unbounded" has to arrive as a real assertion failure, not as a node:test
// per-test timeout: a timed-out test is reported `not ok` but counted under
// `# cancelled`, NOT `# fail`, so a future regression here could slip past any
// gate that reads the fail count. This races the call against a short guard and
// hands the outcome back as data, so the assertion — and the failure — is ours.
const UNBOUNDED = Symbol('unbounded');
const GUARD_MS = 2000;

function settleOrGiveUp(promise) {
  return Promise.race([
    promise.then((value) => ({ value }), (err) => ({ err })),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ marker: UNBOUNDED }), GUARD_MS);
      pendingTimers.add(t);
    }),
  ]);
}

/**
 * Replace the transport. `behaviour` decides what the stubbed call does:
 *   'hang'  — never resolves on its own; resolves/rejects only via the signal.
 *   'fast'  — resolves immediately.
 * The stub honours `requestOptions.signal` the way a real `fetch` would, so an
 * abort that never reaches the transport shows up as a hung test rather than a
 * false pass.
 */
function stubTransport(behaviour) {
  GenerativeModel.prototype.embedContent = async function embedContent(request, requestOptions) {
    seen.calls += 1;
    seen.requestOptions = requestOptions;
    if (behaviour === 'fast') return { embedding: { values: FAKE_VECTOR } };
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      // A ref'd timer, held for far longer than any case's own `timeout`. Without
      // it an unbounded call parks with nothing keeping the loop alive, node exits,
      // and the cases report `cancelled` instead of `fail` — which would make the
      // unbounded call look like an infrastructure hiccup rather than the finding.
      // With it, an unbounded call is a clean per-test timeout failure. `afterEach`
      // clears any that survive, so a red run never lingers.
      const keepAlive = setTimeout(() => resolve({ embedding: { values: FAKE_VECTOR } }), 30000);
      pendingTimers.add(keepAlive);
      const sig = requestOptions && requestOptions.signal;
      if (!sig) return;
      if (sig.aborted) { clearTimeout(keepAlive); pendingTimers.delete(keepAlive); return abort(); }
      sig.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        pendingTimers.delete(keepAlive);
        abort();
      }, { once: true });
    });
  };
}

describe('the embedding call is bounded, and the bound composes with the caller\'s signal', () => {
  before(() => { seen = { calls: 0, requestOptions: undefined }; });

  afterEach(() => {
    seen = { calls: 0, requestOptions: undefined };
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
  });

  after(() => {
    GenerativeModel.prototype.embedContent = ORIGINAL_EMBED_CONTENT;
    if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.EMBED_TIMEOUT_MS;
    else process.env.EMBED_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
  });

  // ── The finding ─────────────────────────────────────────────────────────────
  // Five of six entry points pass no signal. At HEAD this call never returns.
  it('(1) a caller that passes no signal is still bounded by the internal deadline', { timeout: 5000 }, async () => {
    process.env.EMBED_TIMEOUT_MS = '60';
    stubTransport('hang');

    const r = await settleOrGiveUp(knowledgeService.embed('what are your timings'));

    assert.notEqual(r.marker, UNBOUNDED,
      `embed() with no caller signal did not settle within ${GUARD_MS}ms. At HEAD it never ` +
      'settles at all: five of six entry points pass no signal, and the SDK issues a bare ' +
      'fetch with no deadline (dist/index.js:443). That is the finding.');
    assert.ok(r.err, 'the deadline must reject rather than resolve with a fabricated vector');
    assert.equal(seen.calls, 1, 'the transport was reached exactly once');
  });

  // ── §6.3 — the timeout must not collapse into the P5-3 bucket ───────────────
  // contextAssembler.js:68 logs a `22P02` and a Google outage as the same line.
  // A third indistinguishable case would make this session's change undebuggable
  // in production, so the timeout carries its own discriminator.
  it('(2) a deadline failure is identifiable — it is not just another RAG error', { timeout: 5000 }, async () => {
    process.env.EMBED_TIMEOUT_MS = '60';
    stubTransport('hang');

    const r = await settleOrGiveUp(knowledgeService.embed('do you do root canal'));
    assert.notEqual(r.marker, UNBOUNDED, `embed() did not settle within ${GUARD_MS}ms`);
    const err = r.err;
    assert.ok(err, 'expected a rejection');

    assert.equal(err.code, 'EMBED_TIMEOUT',
      'the timeout path must be distinguishable from a 22P02 and from a Google outage (P5-3)');
    assert.match(err.message, /\b60ms\b/,
      'the message names the deadline that fired, so the log says which bound was hit');
  });

  // ── §6.1 — COMPOSES, not replaces ───────────────────────────────────────────
  // The voice turn's 8,000 ms budget signal must still win when it fires first.
  it('(3) a caller-supplied signal still aborts earlier than the internal deadline', { timeout: 5000 }, async () => {
    process.env.EMBED_TIMEOUT_MS = '30000'; // far beyond the caller's abort
    stubTransport('hang');

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);

    const t0 = Date.now();
    const err = await knowledgeService.embed('rescheduling my appointment', ac.signal).then(
      () => { throw new Error('expected a rejection'); },
      (e) => e
    );
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 2000,
      `the caller's abort must not be swallowed by the internal deadline (took ${elapsed}ms)`);
    assert.notEqual(err.code, 'EMBED_TIMEOUT',
      'a caller abort is not a deadline expiry — conflating them would mislabel every ' +
      'voice turn the worker hung up on');

    // The SDK builds a real fetch AbortController only when `signal !== undefined`
    // (dist/index.js:443). Asserting on the argument pins the property that makes
    // the bound reach the socket, not merely reach the SDK.
    assert.notEqual(seen.requestOptions, undefined,
      'embed must pass requestOptions — with none, buildFetchOptions returns {} and the fetch is bare');
    assert.notEqual(seen.requestOptions.signal, undefined,
      'requestOptions.signal must be defined — that is the exact condition at SDK index.js:443');
  });

  // ── Control ─────────────────────────────────────────────────────────────────
  // Green at HEAD by construction. It is here so a future deadline set absurdly
  // low, or a timer that fires regardless of outcome, cannot pass unnoticed.
  it('(4) a call that answers within the deadline returns its vector unchanged', async () => {
    process.env.EMBED_TIMEOUT_MS = '5000';
    stubTransport('fast');

    const values = await knowledgeService.embed('kitna kharcha aayega');
    assert.deepEqual(values, FAKE_VECTOR, 'the happy path is untouched by the bound');
  });
});
