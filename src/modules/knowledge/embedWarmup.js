'use strict';

// Warm the embedding path once, at process boot, so no REQUEST pays the
// cold-connection cost.
//
// ── THIS IS AN OPTIMISATION. IT IS NOT THE FIX. ──────────────────────────────
// The defect this session closed was that ONE deadline served three callers with
// unrelated budgets — an owner clicking Save in the portal was given the voice
// turn's 3,000 ms. That is fixed in knowledgeService.js by giving each call site
// the bound its own budget allows (D-011), and a cold portal save now succeeds
// because the interactive bound accommodates it, not because anything was warmed.
// Nothing here is load-bearing for correctness, and nothing here runs under test.
//
// What warming buys is separate and still worth having. D-010 measured 2,555 ms
// on the first embedding call of a cold process against 459–625 ms warm, all in
// one process — so the difference is DNS + TLS + HTTP setup paid inside THIS
// process, a per-process cost. The first traffic through a freshly deployed
// process is the demo. Warming moves that one expensive call to boot, where
// nothing is waiting on it, so the first real turn runs on the warm margin.
//
// IT IS AN OPTIMISATION, AND EVERY FAILURE MODE IS A NO-OP:
//   • never awaited by the boot path — server.js calls this AFTER app.listen();
//   • the returned promise never rejects, so a fire-and-forget call at the boot
//     site cannot become an unhandled rejection or take the process down;
//   • skipped entirely under `node --test`, and by EMBED_WARMUP=false.
//
// BINDING (§6.5): this calls `knowledgeService.embed`, i.e. the EXPORTED binding
// — the only one reachable from outside the module. That is safe and changes
// nothing about the local-vs-exported split at knowledgeService.js:226-229: the
// deadline lives inside `embed`'s body, so the warm call inherits it exactly as
// the four in-module call sites do, and adding a caller cannot alter which
// binding any existing caller uses.
//
// BUDGET CLASS: 'batch', and the choice is not incidental. Nothing is waiting on
// this call, which is the batch class's definition. It also protects the
// measurement: the log line below exists to give D-010's stated residual — "the
// cold-start floor rests on a single observation" — a real distribution, one
// sample per deploy. Under the 3,000 ms turn bound a slow cold start would be
// truncated into "failed at 3,000 ms", which is the one value that tells you
// nothing. Under the batch bound the line reports the number.

const knowledgeService = require('./knowledgeService');
const defaultLogger = require('../../infra/logging/logger');

// Deliberately short and content-free. The vector is discarded; the only thing
// this call buys is the connection behind it, so the text should cost as little
// as possible and must never be tenant data.
const WARM_TEXT = 'warmup';
const WARM_BUDGET = 'batch';

// EMBED_WARMUP is tri-state on purpose:
//   unset   → warm, except under `node --test`
//   'false' → never warm. This is the local-development setting: `npm run dev` is
//             nodemon, so every file save restarts the process and would burn one
//             embedding call against a dev key documented at ~20/day (Issue 21/30).
//   'true'  → warm even under `node --test`. This exists so the suite can assert
//             the call actually FIRES; without an override that assertion is
//             unreachable, because the test-context gate is the thing being tested
//             around it.
//
// NODE_TEST_CONTEXT is set to 'child-v8' by node:test in every per-file child
// process (verified on node v22.17.1). It is the gate that holds even when a file
// is run directly, without the `--require tests/_support/testEnv.js` preload.
// ~164 suites in separate processes, one live embedding each, is the failure this
// prevents — and §6.1 is explicit that a test process must never be warmed, since
// warming a test process would be papering over a bound that is now correct.
function skipReason() {
  if (process.env.EMBED_WARMUP === 'false') return 'disabled';
  if (process.env.EMBED_WARMUP !== 'true' &&
      (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test')) return 'test';
  return null;
}

/**
 * Fire one throwaway embedding call to open the connection.
 *
 * NEVER REJECTS and never throws — callers are expected to ignore the return
 * value entirely. Resolves to `{ status, ms, reason }` so tests (and a future
 * caller that wants to know) can read the outcome.
 *
 * `status`: 'ok' | 'failed' | 'skipped'.
 *
 * The measured latency is LOGGED, not just returned, and that is load-bearing
 * rather than incidental: D-010 closed U-4 with an explicit residual — "the
 * cold-start floor rests on a single observation". Every deploy now contributes
 * one more cold-start sample under `embed_warmup`, so the number the interactive
 * and batch bounds rest on stops being a handful of measurements on one machine.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.logger] pino-shaped logger; injected by tests.
 * @param {string}  [opts.text]   the throwaway text.
 * @returns {Promise<{status: string, ms: number|null, reason: string|null}>}
 */
async function warmEmbeddings({ logger = defaultLogger, text = WARM_TEXT } = {}) {
  const reason = skipReason();
  if (reason) {
    logger.debug({ reason }, 'embed_warmup skipped');
    return { status: 'skipped', ms: null, reason };
  }

  const t0 = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - t0) / 1e6;

  try {
    const values = await knowledgeService.embed(text, null, WARM_BUDGET);
    const ms = elapsed();
    logger.info({
      ms: Math.round(ms),
      dims: Array.isArray(values) ? values.length : null,
      budget: WARM_BUDGET,
    }, 'embed_warmup ok');
    return { status: 'ok', ms, reason: null };
  } catch (err) {
    // Swallowed on purpose. A cold start that fails leaves the process exactly
    // where it was before this module existed — the first request pays the
    // connection cost, bounded by whichever class that request belongs to.
    const ms = elapsed();
    logger.warn({ ms: Math.round(ms), err: err.message, errCode: err.code ?? null },
      'embed_warmup failed (ignored — warming is an optimisation)');
    return { status: 'failed', ms, reason: null };
  }
}

module.exports = { warmEmbeddings, skipReason, WARM_TEXT, WARM_BUDGET };
