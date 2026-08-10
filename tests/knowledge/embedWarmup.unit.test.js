'use strict';

// THE FIRST TURN AFTER A DEPLOY SHOULD NOT PAY THE COLD-START COST — §6.1.
//
// WARMING IS AN OPTIMISATION AND NOT THIS SESSION'S FIX, and every assertion here
// is written on that footing. The defect was one deadline serving three callers
// with unrelated budgets; it is fixed in knowledgeService.js by the per-class
// bounds (D-011, defended by embedBudgets.unit.test.js). A cold portal save
// succeeds now because the interactive bound accommodates it. Warming changes no
// verdict — it moves the ~2,555 ms cold connection cost (D-010) off the first
// request after a deploy, which on the genesis deploy is the demo.
//
// The properties asserted are the ones that make warming safe to do at all, and
// most of them are about what warming must NOT do:
//   • it fires, and the boot path calls it after the listener is bound;
//   • it never blocks or crashes the boot — the promise never rejects, so the
//     bare fire-and-forget call in server.js cannot raise an unhandled rejection;
//   • it does NOT fire under `node --test`. ~164 suites in separate processes,
//     one live embedding each, against a dev key documented at ~20 calls/day
//     (Issue 21/30). Asserted POSITIVELY — zero transport calls — not inferred
//     from the absence of an error. §6.1 is explicit that warming a test process
//     would be papering over a bound that is now correct;
//   • EMBED_WARMUP=false turns it off for local development, where nodemon
//     restarts on every save;
//   • it takes the BATCH class, so a slow cold start is measured rather than
//     truncated at the turn bound into the one value that says nothing.
//
// The transport is stubbed at `GenerativeModel.prototype.embedContent`, the same
// boundary embedTimeout / embedBudgets / retrievalIsolation use: it proves no HTTP
// call was issued, which is the actual claim, and it spends no Gemini quota.
//
// The module is required inside a try/catch rather than at the top of the file on
// purpose. Session 2's lesson: a throwing `before` hook cancels its siblings, and
// a cancelled test is counted under `# cancelled`, never `# fail`. A missing
// module must arrive as a plain assertion failure so the red run is visible to any
// gate — including the one this session extended.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { GenerativeModel } = require('@google/generative-ai');

let warmup = null;
let loadError = null;
try {
  warmup = require('../../src/modules/knowledge/embedWarmup');
} catch (err) {
  loadError = err;
}

function mod() {
  assert.equal(loadError, null,
    'src/modules/knowledge/embedWarmup.js must exist and load — without it the first ' +
    'request after every deploy pays the ~2,555 ms cold connection cost on the request path.');
  return warmup;
}

const ORIGINAL_EMBED_CONTENT = GenerativeModel.prototype.embedContent;
const ENV_KEYS = ['EMBED_WARMUP', 'EMBED_TIMEOUT_MS', 'EMBED_TIMEOUT_BATCH_MS'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const FAKE_VECTOR = Array.from({ length: 768 }, (_, i) => (i % 5) / 5);

let calls;
const pendingTimers = new Set();

function stubTransport(behaviour, slowMs = 150) {
  GenerativeModel.prototype.embedContent = async function embedContent(request, requestOptions) {
    calls.push({ request, requestOptions });
    if (behaviour === 'throw') throw Object.assign(new Error('quota exhausted'), { code: 'RESOURCE_EXHAUSTED' });
    if (behaviour === 'slow') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ embedding: { values: FAKE_VECTOR } }), slowMs);
        pendingTimers.add(t);
        const sig = requestOptions && requestOptions.signal;
        if (sig) sig.addEventListener('abort', () => {
          clearTimeout(t); pendingTimers.delete(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    return { embedding: { values: FAKE_VECTOR } };
  };
}

// pino-shaped sink: records instead of printing.
function recordingLogger() {
  const lines = [];
  const at = (level) => (obj, msg) => lines.push({ level, obj, msg });
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

describe('the embedding path is warmed at boot, and never at the cost of boot', () => {
  before(() => { calls = []; });
  beforeEach(() => {
    calls = [];
    stubTransport('ok');
    for (const k of ENV_KEYS) delete process.env[k];
  });

  after(() => {
    GenerativeModel.prototype.embedContent = ORIGINAL_EMBED_CONTENT;
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  // ── The wiring ──────────────────────────────────────────────────────────────
  // Read as source rather than executed: requiring server.js binds a port, starts
  // three cron tasks and opens a pg pool. Same technique, and the same reason, as
  // channels.test.js:436 ('server.js registers adapter before routes').
  it('(1) server.js fires the warm call, AFTER app.listen, and does not await it', () => {
    const src = fs.readFileSync(require.resolve('../../server.js'), 'utf8');

    assert.match(src, /require\('\.\/src\/modules\/knowledge\/embedWarmup'\)/,
      'server.js must require the warmup module');

    const listenIdx = src.indexOf('app.listen(');
    const warmIdx = src.indexOf('warmEmbeddings()');
    assert.ok(warmIdx > 0, 'server.js must call warmEmbeddings() in its boot path');
    assert.ok(listenIdx > 0 && warmIdx > listenIdx,
      'the warm call must come AFTER app.listen — before it, a slow embedding call sits ' +
      'between process start and the port being bound');
    assert.doesNotMatch(src, /await\s+\w*\.?warmEmbeddings\(/,
      'the warm call must NOT be awaited: warming is an optimisation and the boot path ' +
      'must not wait on Google');
  });

  // ── It actually fires ───────────────────────────────────────────────────────
  it('(2) one embedding call goes out, and its latency is measured and logged', async () => {
    process.env.EMBED_WARMUP = 'true';       // override the test-context gate asserted in (3)
    const logger = recordingLogger();

    const result = await mod().warmEmbeddings({ logger });

    assert.equal(calls.length, 1, 'exactly one embedding call');
    assert.equal(result.status, 'ok');
    assert.ok(Number.isFinite(result.ms) && result.ms >= 0, `ms must be measured, got ${result.ms}`);

    // 6.1: the measurement is LOGGED, not merely returned. Every deploy then
    // contributes one cold-start sample — the exact residual D-010 left open
    // ("the cold-start floor rests on a single observation").
    const line = logger.lines.find((l) => l.level === 'info' && /embed_warmup/.test(l.msg));
    assert.ok(line, `expected an info line naming embed_warmup, got ${JSON.stringify(logger.lines)}`);
    assert.ok(Number.isFinite(line.obj.ms), 'the logged line must carry the measured ms');
  });

  // ── It must not fire under test — POSITIVE assertion (§7.5) ─────────────────
  it('(3) it does NOT fire under `node --test` — zero transport calls', async () => {
    delete process.env.EMBED_WARMUP;         // no override: the bare test environment

    // Precondition: this really is the environment being defended. node:test sets
    // NODE_TEST_CONTEXT in every per-file child process, so the gate holds even
    // when a file is run without the tests/_support/testEnv.js preload.
    assert.ok(process.env.NODE_TEST_CONTEXT,
      'NODE_TEST_CONTEXT is the signal the gate reads; without it this test proves nothing');

    const result = await mod().warmEmbeddings({ logger: recordingLogger() });

    assert.equal(calls.length, 0,
      'a warm call under `node --test` means ~164 live embeddings per suite run against a ' +
      'dev key rated at ~20 calls/day — and §6.1 forbids warming a test process outright: ' +
      'if a test needed warming, the deadline it runs under would be the thing that is wrong');
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'test');
  });

  // ── The local-development switch ────────────────────────────────────────────
  it('(4) EMBED_WARMUP=false disables it outright', async () => {
    process.env.EMBED_WARMUP = 'false';
    const result = await mod().warmEmbeddings({ logger: recordingLogger() });
    assert.equal(calls.length, 0);
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'disabled');
  });

  // ── A failed warm call is a no-op, not an incident ──────────────────────────
  it('(5) a failing warm call resolves, and fire-and-forget raises no unhandled rejection', async () => {
    process.env.EMBED_WARMUP = 'true';
    stubTransport('throw');
    const logger = recordingLogger();

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Exactly the shape server.js uses: no await, no .catch().
      const p = mod().warmEmbeddings({ logger });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 25));

      assert.equal(unhandled.length, 0,
        'server.js calls this bare — a rejection here would surface as an unhandled ' +
        'rejection at boot, which is the opposite of "warming cannot break the process"');

      const result = await p;
      assert.equal(result.status, 'failed', 'the failure is reported, not thrown');
      assert.equal(calls.length, 1);
      assert.ok(logger.lines.some((l) => l.level === 'warn' && /embed_warmup/.test(l.msg)),
        'a failed warm call must still say so');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // ── The budget class, asserted through behaviour rather than by reading an
  //    argument (§6.0's table; §6.5's binding statement) ────────────────────────
  // Two-way: the turn bound must not govern it, its own bound must. The reason is
  // measurement, not speed — this call's whole second purpose is to log a real
  // cold-start latency, and a turn-class bound would clip every slow sample to
  // "failed at 3,000 ms", which is the one number that carries no information.
  it('(6) the warm call is BATCH-classed: the turn bound does not govern it, its own does', async () => {
    process.env.EMBED_WARMUP = 'true';
    stubTransport('slow', 150);

    process.env.EMBED_TIMEOUT_MS = '20';               // absurd turn bound
    const underTurnBound = await mod().warmEmbeddings({ logger: recordingLogger() });
    assert.equal(underTurnBound.status, 'ok',
      'a warm call bounded by the TURN deadline would be truncated on exactly the slow ' +
      'cold starts the log line exists to record');

    calls = [];
    process.env.EMBED_TIMEOUT_BATCH_MS = '20';         // its own bound, absurdly low
    const logger = recordingLogger();
    const underBatchBound = await mod().warmEmbeddings({ logger });
    assert.equal(underBatchBound.status, 'failed',
      'the warm call must still be bounded — by the batch deadline it declares');
    const warn = logger.lines.find((l) => l.level === 'warn');
    assert.equal(warn && warn.obj.errCode, 'EMBED_TIMEOUT',
      'and the failure is the deadline, identifiably');
    assert.equal(mod().WARM_BUDGET, 'batch');
  });
});
