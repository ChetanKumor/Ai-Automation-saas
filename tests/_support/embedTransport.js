'use strict';

// The ONE place the test suite decides whether an embedding call goes to Google.
//
// Loaded via `--require` from the `test` npm script (the testEnv.js seam,
// for the same reason): `node --test` propagates execArgv to every per-file
// child, so this runs before any test module and before src/ imports the SDK.
// Nothing outside the test path loads it — dev/prod runtime is untouched.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// A census over `npm test` at 051ed7b (scripts/net-census.js) found 12 outbound
// requests to a host that is not loopback, all of them
// `generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`:
//
//   5  tests/portal/portalFaqs.integration.test.js            (the retrieval test)
//   5  tests/portal/portalOnboarding.integration.test.js      (5x faqService.createFaq)
//   2  tests/portal/portalKnowledgeSummary.integration.test.js (a `before` hook)
//
// Two of those three make the call from a place where a failure never reaches
// `# fail`. portalKnowledgeSummary's is in `before`, so one bad call cancels all
// seven of its tests: node reports `# fail 0 / # cancelled 7`. A suite that
// reports zero failures while seven tests were cancelled is not a gate, and
// Issue 20's genesis deploy is verified with this suite.
//
// ── WHY NOT JUST STUB THEM ──────────────────────────────────────────────────
// Because 0fdf971 caught a real defect with those calls precisely BECAUSE they
// were live: an embedding call that STALLED past the 10,000 ms `interactive`
// deadline (knowledgeService.js:66), 1 in 334 measured, in a latency mode with
// no upper bound rather than in the tail of the healthy distribution. Stubbing
// everything buys determinism by making that stall permanently unobservable.
//
// So there are two arms, and this file is the switch:
//
//   DEFAULT (LIVE_GEMINI unset)  — offline transport. Zero live external calls.
//       What `npm test` runs, what `os:check` runs, what the gates read.
//   LIVE   (LIVE_GEMINI=1)       — the real SDK call, passed through untouched.
//       Opt-in, documented in docs/testing/live-arm.md, and still instrumented.
//
// ── THE SEAM IS THE TRANSPORT, NOT THE SERVICE ──────────────────────────────
// It replaces `GenerativeModel.prototype.embedContent` — the SDK's wire call —
// and NOT `knowledgeService.embed`. Two reasons, both load-bearing:
//
//   • `getRelevantChunks` reaches `embed` through the module-local binding,
//     which a `mock.method` on the export cannot see (knowledgeService.js:111-118,
//     the RAG-S1 lesson). The transport sits below that split.
//   • Everything in `embed()` still runs in the default arm: the budget class
//     lookup, the AbortController, the deadline timer, the `signal` relay, the
//     `result.embedding.values` unwrap. Only the wire is replaced. A service-level
//     stub skips all of it.
//
// ── THE INSTRUMENTATION RUNS IN BOTH ARMS ───────────────────────────────────
// Every call is recorded as `{ ok, ms, err? }` — the same record shape that
// caught the 10,085.7 ms stall — whichever arm produced it. In the default arm
// the milliseconds are ~0 and the shape is identical, so the assertion messages
// that read it do not have two forms.

const MODE_LIVE = /^(1|true|yes)$/i.test(String(process.env.LIVE_GEMINI || ''));

// Requests recorded across the whole process, newest last. Tests read this
// through `calls()`; assertion messages embed it verbatim.
const records = [];

// Fault injection for the default arm. A stub that can only ever succeed cannot
// exercise the error path its route handles — POST /portal/api/faqs turns any
// throw from the embedding call into a 500 (routes.js:1987-1989), and that
// branch is half of what these tests are for. `failNext` makes the offline
// transport reject exactly like the SDK does on a transport error; `stallNext`
// makes it never settle, which is the shape of Fault A and the only way the
// deadline in `embed()` can be made to fire on demand.
let injected = null;

const DIMS = 768;

/**
 * Deterministic offline embedding — hashed bag-of-words, L2-normalised.
 *
 * Not a model. It has exactly the three properties the suite asserts against:
 *   • deterministic — same text, same vector, so a re-embed is provable,
 *   • distinct — different text almost always gives a different vector, which
 *     is what "the PATCH actually re-embedded" means,
 *   • overlap-ordered — texts sharing tokens sit closer under cosine than texts
 *     that share none, so `getRelevantChunks` still ranks the FAQ that mentions
 *     insurance above one that does not.
 * Never all-zero: pgvector's cosine distance is undefined for a zero vector and
 * the ORDER BY would return an arbitrary row.
 */
function offlineEmbedding(text) {
  const s = String(text == null ? '' : text);
  const vec = new Array(DIMS).fill(0);
  const tokens = s.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    vec[h % DIMS] += 1;
  }
  // Non-Latin text (the Telugu/Hindi FAQs) tokenises to nothing above. Fall back
  // to a whole-string hash so it still gets a stable, distinct, non-zero vector.
  let nonZero = tokens.length > 0;
  if (!nonZero) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    vec[h % DIMS] = 1;
    nonZero = true;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

function requestText(request) {
  try {
    if (typeof request === 'string') return request;
    const parts = (request && request.content && request.content.parts) || [];
    return parts.map((p) => (p && p.text) || '').join(' ');
  } catch (_) { return ''; }
}

// The SDK's own error shape for a transport failure, close enough that a caller
// distinguishing `AbortError` from everything else behaves the same either way.
function transportError(message) {
  return Object.assign(new Error(`[GoogleGenerativeAI Error]: ${message}`), {
    name: 'GoogleGenerativeAIFetchError',
  });
}

/**
 * Never settles until `signal` aborts, then rejects with the SDK's AbortError.
 * This is the shape of Fault A: a call with no upper latency bound, where the
 * only reason a number is ever recorded is the deadline in `embed()`.
 */
function stall(signal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;                       // no signal ⇒ genuinely never settles
    const fire = () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    if (signal.aborted) return fire();
    signal.addEventListener('abort', fire, { once: true });
  });
}

function install() {
  const { GenerativeModel } = require('@google/generative-ai');
  const original = GenerativeModel.prototype.embedContent;

  GenerativeModel.prototype.embedContent = async function (request, requestOptions) {
    const t0 = process.hrtime.bigint();
    const took = () => +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);
    const signal = requestOptions && requestOptions.signal;

    const pending = injected;
    if (pending) injected = null;

    try {
      let res;
      if (pending && pending.kind === 'fail') {
        // Yield first: an embedContent that rejects synchronously would not
        // exercise the same await/catch ordering the real one does.
        await Promise.resolve();
        throw pending.error;
      } else if (pending && pending.kind === 'stall') {
        await stall(signal);
        throw transportError('unreachable — stall() only settles by rejecting');
      } else if (MODE_LIVE) {
        res = await original.call(this, request, requestOptions);
      } else {
        if (signal && signal.aborted) {
          throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
        }
        res = { embedding: { values: offlineEmbedding(requestText(request)) } };
      }
      records.push({ ok: true, ms: took(), live: MODE_LIVE && !pending });
      return res;
    } catch (err) {
      records.push({
        ok: false,
        ms: took(),
        live: MODE_LIVE && !pending,
        err: String(err && err.message).slice(0, 300),
      });
      throw err;
    }
  };

  return original;
}

const originalEmbedContent = install();

module.exports = {
  /** true when this process will make REAL embedding calls. */
  live: MODE_LIVE,
  DIMS,
  offlineEmbedding,

  /** Every embedding call this process has made, `{ ok, ms, live, err? }`. */
  calls() { return records.slice(); },
  /** Drop the record so one test's assertion message carries only its own calls. */
  reset() { records.length = 0; injected = null; },

  /** The next embedding call rejects — the route's 500 branch. */
  failNext(message = 'fetch failed') {
    injected = { kind: 'fail', error: transportError(message) };
  },
  /** The next embedding call never answers — Fault A's shape; only the deadline ends it. */
  stallNext() { injected = { kind: 'stall' }; },

  /** Escape hatch for a test that needs the unpatched SDK back. */
  restore() {
    require('@google/generative-ai').GenerativeModel.prototype.embedContent = originalEmbedContent;
  },
};
