#!/usr/bin/env node
'use strict';

// seed-turn-traces — put FABRICATED turn_traces rows on a LOCAL DEV tenant so
// the Issue 27 trace viewer can be looked at before there is any real traffic.
//
// Usage:
//   node scripts/seed-turn-traces.js [--tenant <uuid>] [--bulk <n>] [--allow-remote-host]
//   node scripts/seed-turn-traces.js --clear            remove only its own rows
//
// Exit codes: 0 success · 1 refused (guard tripped, bad input, or tenant missing).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// turn_traces has ZERO ROWS and will until the first production deploy
// (Issue 20). The page is therefore built and reviewed against seeded rows.
// The rows are fabricated and that is fine HERE — fixtures belong in tests and
// in a seed script. What must never happen is the PAGE fabricating: it renders
// what the API returns and nothing else, so seeing it populated requires
// putting real rows in a real table, which is this script's whole job.
//
// ── CHANNEL: 'whatsapp' AND 'voice' ONLY. NEVER 'test'. ─────────────────────
// testTurnService.countTestTurnsToday counts `turn_traces WHERE channel='test'
// AND created_at >= today` as the OWNER-FACING daily budget for the portal's
// "Test your receptionist" page. A seed row on that channel would silently
// spend a clinic owner's allowance. The fixtures below use the two live
// channels; the third value exists and the page renders it, but nothing may
// manufacture one.
//
// `assertNoForbiddenChannel` enforces that BEFORE the first INSERT, over the
// whole row set — fixtures and `--bulk` together. It is deliberately not a
// query run afterwards: a check that reads the table once the rows are in is a
// DETECTOR, and the allowance it protects has already been spent by the time it
// speaks. A guard refuses; a detector reports.
//
// ── THE GUARDS ARE seed-portal-owner.js's, COPIED IN SHAPE ──────────────────
// That script is the one seed in this repo that refuses to run somewhere it
// should not, and it is the shape to copy rather than reinvent. Both of its
// guards are here: NODE_ENV=production with no override, and a host check on
// the PARSED connection target. The other two seed scripts in scripts/ have
// neither and write to whatever DATABASE_URL names — filed, not fixed here.

require('dotenv').config();

// pg's OWN connection-string parser, for the same reason seed-portal-owner.js
// gives: the guard must assert on the target pg would really dial, not on a
// substring of the env var. A string match would pass
// `…?options=host%3Dlocalhost` and would fail a unix socket path.
const { parse: parseConnectionString } = require('pg-connection-string');

// ⚠ LAZY, and this is the PORTAL-P1-S1 lesson restated: src/db/db.js builds its
// pg Pool at IMPORT time and captures DATABASE_URL right there. A top-level
// require here would pin the pool to whatever DATABASE_URL said when something
// merely READ this file's exports — which is exactly what happened the first
// time tests/admin/tracePageContract.integration.test.js imported the fixtures
// below: the router then queried the developer's database while the test seeded
// a scratch one, and every row count came back zero. Nothing but main() needs
// the pool, so nothing but main() takes it.
const getDb = () => require('../src/db/db');

// Smile Dental (Voice Dev) — the long-lived local dev tenant.
const DEFAULT_TENANT = '11111111-1111-1111-1111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every row this script writes carries this correlation-id prefix, so `--clear`
// can find exactly its own rows and nothing else. It satisfies the route's
// correlation-id shape (`^[a-z]{2,12}_[0-9a-f]{16}$`), so the page's own filter
// works on them.
const SEED_PREFIX = 'seed_';

// The one channel value this script may never write. See the header.
const FORBIDDEN_CHANNEL = 'test';

const USAGE = `Usage:
  node scripts/seed-turn-traces.js
    [--tenant <uuid>]           default ${DEFAULT_TENANT} (Smile Dental (Voice Dev))
    [--bulk <n>]                n EXTRA incident rows on top of the shape
                                fixtures, for volume (default 0). 200 is what
                                the incidents page's truncation notice needs.
    [--allow-remote-host]       permit a non-local database host
    [--clear]                   delete only the rows this script wrote, then exit`;

function die(msg, { usage = false } = {}) {
  console.error(`✗ ${msg}`);
  if (usage) console.error(`\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { tenant: DEFAULT_TENANT, allowRemoteHost: false, clear: false, bulk: 0 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--allow-remote-host') out.allowRemoteHost = true;
    else if (a === '--clear') out.clear = true;
    else if (a === '--tenant') out.tenant = args[++i];
    else if (a === '--bulk') {
      const raw = args[++i];
      const n = Number(raw);
      // Rejected here rather than coerced: `--bulk abc` silently becoming 0
      // would print "Seeded: 8" and leave the operator wondering why the
      // truncation notice never appeared.
      if (!Number.isInteger(n) || n < 0) die(`--bulk must be a non-negative integer, got: ${raw}`, { usage: true });
      out.bulk = n;
    } else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else die(`Unknown argument: ${a}`, { usage: true });
  }
  return out;
}

// ── Guard 1: never production ────────────────────────────────────────────────
// No flag overrides this one. Every other guard here has an escape hatch; this
// one is the reason the escape hatches are safe to offer.
function assertNotProduction() {
  if (process.env.NODE_ENV === 'production') {
    die('NODE_ENV=production. This script writes fabricated trace rows and will not run against production.');
  }
}

// ── Guard 2: the database host ───────────────────────────────────────────────
// Asserts on the PARSED connection target, never on the env var's text. pg
// defaults an absent host to 'localhost' and treats a leading '/' as a unix
// domain socket; both are local, and both are reproduced here so the guard
// agrees with the driver rather than with an assumption about it.
function resolveDbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) die('DATABASE_URL is not set.');

  let parsed;
  try {
    parsed = parseConnectionString(url);
  } catch (err) {
    die(`DATABASE_URL could not be parsed by pg's own parser: ${err.message}`);
  }

  const host = parsed.host || 'localhost';
  const isSocket = host.startsWith('/');
  const isLocal = isSocket || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
  return { host, database: parsed.database || '(default)', isLocal };
}

function assertLocalHost(target, allowRemoteHost) {
  if (target.isLocal) return;
  if (!allowRemoteHost) {
    die(`database host '${target.host}' is not local.\n` +
        "  This tenant's data may not be yours to write to. If this really is your dev\n" +
        '  database, re-run with --allow-remote-host.');
  }
  console.warn(`⚠ Host '${target.host}' is NOT local — proceeding only because --allow-remote-host was passed.`);
}

// ── The fixtures: THE SHAPE CATALOGUE ────────────────────────────────────────
//
// One row per branch the two pages can render, so every branch is reachable by
// LOOKING at a page rather than by reading its code:
//
//   1 clean WhatsApp turn — retrieval, prompt, model, no tools, no error
//   2 WhatsApp turn with tool calls, one ok and one carrying the tool's own
//     error string (the CONTENT-CLASS:FREE-TEXT path, site 1). `error` is NULL:
//     the turn COMPLETED and the patient did not get their booking, so the
//     trace viewer ranks it `ok` and Incidents ranks it `tool_error`. Both
//     answers are correct — they are answers to different questions (F-A054).
//   3 voice turn ABORTED (the second error envelope)
//   4 voice turn FAILED with a long message (free-text site 2, over the
//     renderer's 240-character cap, so truncation is visible)
//   5 a turn that never reached the model — null retrieval, null prompt,
//     null llm, null tool_calls
//   6 a turn with tool_calls = [] — the EMPTY LIST the live writer never
//     produces (it maps "no tools" to null), so this is the only way to see
//     that the page tells the two apart
//   7 voice turn aborted AFTER THE POINT OF NO RETURN — `client_gone` with
//     `aborted_after_commit: true`, the internalVoice.js:300 shape. The
//     mutating tool that justifies "after commit" is on the row.
//   8 THE OVERLAP: an error envelope AND a failed tool on the SAME row. Both
//     arms of incidentsQuery.js's `OR` select it, and it is ONE row that ranks
//     by its envelope (`failed`), never `tool_error` — turn-status.js:118 says
//     so and, until this fixture, nothing in the tree had ever drawn it. The
//     real production shape is whatsapp/routes.js:228: the booking failed and
//     then the apology never sent.
//
// ⚠ NOT A DIAL. Volume belongs to `--bulk` and never here — see BULK_SHAPES.
//
// Every shape below is one the WRITER can produce. A fixture that cannot occur
// in production makes a page look right about something that will never happen.
const hex16 = () => require('crypto').randomBytes(8).toString('hex');

function fixtures(conversationId) {
  return [
    {
      channel: 'whatsapp',
      conversation_id: conversationId,
      stage_timings: { persist_inbound: 18.4, fetch_parallel: 212.7, fetch_parallel_rag: 190.2, gemini_call_1: 1340.9, dispatch: 305.1, persist_outbound: 22.8, total_ms: 1904.2 },
      retrieval: [
        { chunk_id: '9f2c1d44-0000-4000-8000-000000000001', score: 0.8121 },
        { chunk_id: '9f2c1d44-0000-4000-8000-000000000002', score: 0.7440 },
        { chunk_id: '9f2c1d44-0000-4000-8000-000000000003', score: 0.2013, below_floor: true },
      ],
      prompt: { hash: 'b3a1c7de92f04a1188c6de2f7a4be05517b9a2c1d0e8f3a6b5c4d3e2f1a09876', config_version: 12, mode: 'rendered' },
      llm: { model: 'gemini-2.5-flash', input_tokens: 2411, output_tokens: 143, latency_ms: 1340.9, finish_reason: 'STOP', calls: [{ n: 1, latency_ms: 1340.9, input_tokens: 2411, output_tokens: 143, thinking_tokens: 0, total_tokens: 2554, streamed: false, model: 'gemini-2.5-flash', finish_reason: 'STOP' }] },
      tool_calls: null,
      error: null,
    },
    {
      channel: 'whatsapp',
      conversation_id: conversationId,
      stage_timings: { persist_inbound: 15.1, fetch_parallel: 180.4, gemini_call_1: 980.2, tool_exec_1_check_availability: 62.8, tool_exec_2_book_appointment: 118.3, gemini_call_2: 720.5, dispatch: 288.0, total_ms: 2365.3 },
      retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-000000000004', score: 0.6612 }],
      prompt: { hash: '77de1a0c5b3e49f2a8114c6b9d0e2f3a5c7b8d9e0f1a2b3c4d5e6f7a8b9c0d1e', config_version: 12, mode: 'rendered' },
      llm: { model: 'gemini-2.5-flash', input_tokens: 3140, output_tokens: 212, latency_ms: 1700.7, finish_reason: 'STOP', calls: [{ n: 1, latency_ms: 980.2, input_tokens: 2402, output_tokens: 88, thinking_tokens: 0, total_tokens: 2490, streamed: false, model: 'gemini-2.5-flash', finish_reason: 'STOP' }, { n: 2, latency_ms: 720.5, input_tokens: 738, output_tokens: 124, thinking_tokens: 0, total_tokens: 862, streamed: false, model: 'gemini-2.5-flash', finish_reason: 'STOP' }] },
      tool_calls: [
        { n: 1, name: 'check_availability', latency_ms: 62.8, outcome: { status: 'ok' } },
        // The tool's own error string, verbatim, exactly as appointmentService
        // builds it — INCLUDING the model-supplied `doctor` argument. This is
        // what the free-text disclosure exists for.
        { n: 2, name: 'book_appointment', latency_ms: 118.3, outcome: { status: 'error', error: 'Doctor "Dr. Bandaru" not found. Available: Dr. Sharma, Dr. Reddy' } },
      ],
      error: null,
    },
    {
      channel: 'voice',
      conversation_id: conversationId,
      stage_timings: { hydrate: 41.2, fetch_parallel: 160.9, gemini_call_1: 7810.4, total_ms: 8022.6 },
      retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-000000000005', score: 0.7015 }],
      prompt: { hash: '1c9b0d7e5a4f3821b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3', config_version: 12, mode: 'rendered' },
      llm: { model: 'gemini-2.5-flash', input_tokens: 1880, output_tokens: 0, latency_ms: 7810.4, finish_reason: null, calls: [{ n: 1, latency_ms: 7810.4, input_tokens: 1880, output_tokens: 0, thinking_tokens: 0, total_tokens: 1880, streamed: true, model: 'gemini-2.5-flash', finish_reason: null }] },
      tool_calls: null,
      error: { outcome: 'aborted', abort_reason: 'deadline', aborted_after_commit: false, stage: 'generate_reply', message: 'voice turn aborted' },
    },
    {
      channel: 'voice',
      conversation_id: null,
      stage_timings: { hydrate: 38.7, fetch_parallel: 143.2, total_ms: 402.5 },
      retrieval: null,
      prompt: null,
      llm: null,
      tool_calls: null,
      // Deliberately over the renderer's 240-character cap, so the truncation
      // indicator is visible in a review rather than only in a test.
      error: { stage: 'fetch_parallel', status: 500, message: 'upstream failure while assembling context: ' + 'the underlying driver reported a transient condition and the turn was abandoned; '.repeat(4) },
    },
    {
      channel: 'whatsapp',
      conversation_id: conversationId,
      stage_timings: { persist_inbound: 14.9, total_ms: 31.2 },
      retrieval: null,
      prompt: null,
      llm: null,
      tool_calls: null,
      error: null,
    },
    {
      channel: 'whatsapp',
      conversation_id: conversationId,
      stage_timings: { persist_inbound: 16.0, fetch_parallel: 171.5, gemini_call_1: 1104.3, dispatch: 262.9, total_ms: 1560.1 },
      retrieval: [],
      prompt: { hash: 'aa01bb23cc45dd67ee89ff01aa23bb45cc67dd89ee01ff23aa45bb67cc89dd01', config_version: null, mode: 'legacy' },
      llm: { model: 'gemini-2.5-flash', input_tokens: 1204, output_tokens: 96, latency_ms: 1104.3, finish_reason: 'STOP', calls: [{ n: 1, latency_ms: 1104.3, input_tokens: 1204, output_tokens: 96, thinking_tokens: 0, total_tokens: 1300, streamed: false, model: 'gemini-2.5-flash', finish_reason: 'STOP' }] },
      tool_calls: [],
      error: null,
    },
    {
      // 7 · The abort that crossed the point of no return.
      //
      // `stage: null`, and that is the shape rather than a gap: collector.js's
      // setAbort writes `t.currentStage() ?? null`, and at the internalVoice.js
      // :300 site persist_outbound's closure has already run, so no stage is
      // open. `aborted_after_commit: true` means a mutating tool had executed —
      // the ok `book_appointment` below is that tool, present so the claim the
      // envelope makes is visible on the row that makes it.
      channel: 'voice',
      conversation_id: conversationId,
      stage_timings: { hydrate_validate: 44.1, persist_inbound: 19.7, fetch_parallel: 168.3, gemini_call_1: 1210.6, tool_exec_1_book_appointment: 132.4, gemini_call_2: 690.2, persist_outbound: 26.5, total_ms: 8291.4 },
      retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-000000000006', score: 0.7731 }],
      prompt: { hash: '4e0d2f8a6b1c93d5e7f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3', config_version: 12, mode: 'rendered' },
      llm: { model: 'gemini-2.5-flash', input_tokens: 3005, output_tokens: 174, latency_ms: 1901.1, finish_reason: 'STOP', calls: [{ n: 1, latency_ms: 1210.6, input_tokens: 2288, output_tokens: 71, thinking_tokens: 0, total_tokens: 2359, streamed: true, model: 'gemini-2.5-flash', finish_reason: 'STOP' }, { n: 2, latency_ms: 690.5, input_tokens: 717, output_tokens: 103, thinking_tokens: 0, total_tokens: 820, streamed: true, model: 'gemini-2.5-flash', finish_reason: 'STOP' }] },
      tool_calls: [{ n: 1, name: 'book_appointment', latency_ms: 132.4, outcome: { status: 'ok' } }],
      error: { outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: true, stage: null, message: 'voice turn aborted' },
    },
    {
      // 8 · THE OVERLAP — an error envelope AND a failed tool, one row.
      //
      // The worst single row this system can produce: the patient asked for a
      // slot, the slot was gone, the model composed an apology, and the send
      // failed too — so nothing reached them at all. It matches BOTH arms of
      // incidentsQuery.js:148-149 and ranks `failed`, by its envelope, because
      // the envelope is the stronger statement. Nothing had ever rendered this
      // precedence before; it was written down in two files and drawn in none.
      channel: 'whatsapp',
      conversation_id: conversationId,
      stage_timings: { fetch_parallel: 194.6, gemini_call_1: 1021.8, tool_exec_1_book_appointment: 104.7, gemini_call_2: 733.4, dispatch: 4180.3, total_ms: 6259.1 },
      retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-000000000007', score: 0.6903 }],
      prompt: { hash: 'c2b4a68e0d1f35792a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d80', config_version: 12, mode: 'rendered' },
      llm: { model: 'gemini-2.5-flash', input_tokens: 3218, output_tokens: 187, latency_ms: 1755.2, finish_reason: 'STOP', calls: [{ n: 1, latency_ms: 1021.8, input_tokens: 2461, output_tokens: 74, thinking_tokens: 0, total_tokens: 2535, streamed: false, model: 'gemini-2.5-flash', finish_reason: 'STOP' }, { n: 2, latency_ms: 733.4, input_tokens: 757, output_tokens: 113, thinking_tokens: 0, total_tokens: 870, streamed: false, model: 'gemini-2.5-flash', finish_reason: 'STOP' }] },
      tool_calls: [{ n: 1, name: 'book_appointment', latency_ms: 104.7, outcome: { status: 'error', error: 'Slot 2026-09-08 15:30 is no longer available.' } }],
      error: { stage: 'dispatch', message: 'Request failed with status code 502', status: 502 },
    },
  ];
}

// ── The bulk shapes: VOLUME, and why it is a second path ────────────────────
//
// ⚠ VOLUME LIVES HERE AND NEVER IN `fixtures()`. THIS IS NOT A STYLE CHOICE,
//   AND MERGING THE TWO PATHS BREAKS AN EXISTING TEST.
//   tests/admin/tracePageContract.integration.test.js:146 asks the route for
//   `limit: 50` and then asserts, at :148, that the response length equals
//   `seed.fixtures(null).length`. The moment `fixtures()` returns more than
//   fifty rows that compares a CAPPED response against an UNCAPPED array and
//   reddens. So the two arrays answer two different questions and stay apart:
//   `fixtures()` is the shape catalogue — one row per renderable branch, small
//   enough to read in one sitting — and this is volume.
//
// WHY VOLUME IS NEEDED AT ALL. public/admin/incidents.js:97 sets LIMIT = 200
// and :217 asks for exactly that (the route's hard cap, adminRoutes.js:1071).
// Its truncation notice fires when the response FILLS the page it asked for
// (:308-317), so seeing that notice needs 200 rows matching the route's
// predicate. Only incidents count: the shape catalogue contributes five, so the
// rest has to come from somewhere, and this is it.
//
// EVERY SHAPE BELOW IS AN INCIDENT, and every one is a shape the writer can
// produce. Note in particular that all four aborts are `voice`: setAbort is
// only ever called from src/routes/internalVoice.js, so an aborted WhatsApp
// turn is not a thing, and manufacturing one would put a row on this page that
// production can never put there.
const PROMPT_OK = { hash: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2', config_version: 12, mode: 'rendered' };
const llmOnce = (ms, inTok, outTok, streamed) => ({
  model: 'gemini-2.5-flash', input_tokens: inTok, output_tokens: outTok,
  latency_ms: ms, finish_reason: 'STOP',
  calls: [{ n: 1, latency_ms: ms, input_tokens: inTok, output_tokens: outTok, thinking_tokens: 0, total_tokens: inTok + outTok, streamed: !!streamed, model: 'gemini-2.5-flash', finish_reason: 'STOP' }],
});

const BULK_SHAPES = [
  // ── failed, at each stage a real turn can fail in ──────────────────────────
  // The stage names are the ones turnMetrics' `start()` is actually called
  // with, per channel: hydrate_validate and persist_inbound are voice-only
  // (internalVoice.js:155/196), fetch_parallel/dispatch/persist_outbound are
  // shared, and 'generate_reply' is the explicit arg + the setErrorFromException
  // fallback (collector.js:73).
  { channel: 'voice', error: { stage: 'hydrate_validate', message: 'tenant for call session not found', status: 404 },
    stage_timings: { hydrate_validate: 61.4, total_ms: 74.9 }, retrieval: null, prompt: null, llm: null, tool_calls: null },
  { channel: 'voice', error: { stage: 'persist_inbound', message: 'duplicate key value violates unique constraint "uniq_msg_external"', status: null },
    stage_timings: { hydrate_validate: 38.2, persist_inbound: 26.8, total_ms: 79.5 }, retrieval: null, prompt: null, llm: null, tool_calls: null },
  { channel: 'whatsapp', error: { stage: 'fetch_parallel', message: 'embedding request timed out after 3000ms', status: 500 },
    stage_timings: { fetch_parallel: 3012.7, fetch_parallel_knowledge: 3001.4, total_ms: 3044.1 }, retrieval: null, prompt: null, llm: null, tool_calls: null },
  { channel: 'whatsapp', error: { stage: 'generate_reply', message: 'Resource has been exhausted (e.g. check quota).', status: 429 },
    stage_timings: { fetch_parallel: 176.3, total_ms: 1402.8 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b1', score: 0.7412 }], prompt: PROMPT_OK, llm: null, tool_calls: null },
  { channel: 'whatsapp', error: { stage: 'dispatch', message: 'Request failed with status code 502', status: 502 },
    stage_timings: { fetch_parallel: 181.9, gemini_call_1: 1188.4, dispatch: 4210.6, total_ms: 5589.3 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b2', score: 0.6844 }], prompt: PROMPT_OK, llm: llmOnce(1188.4, 2380, 118, false), tool_calls: null },
  { channel: 'voice', error: { stage: 'persist_outbound', message: 'connection terminated unexpectedly', status: null },
    stage_timings: { hydrate_validate: 40.6, persist_inbound: 18.1, fetch_parallel: 159.7, gemini_call_1: 1042.2, persist_outbound: 2011.5, total_ms: 3279.4 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b3', score: 0.7108 }], prompt: PROMPT_OK, llm: llmOnce(1042.2, 1904, 96, true), tool_calls: null },

  // ── aborted, all four combinations of reason x after-commit ────────────────
  // client_gone/false is internalVoice.js:536 (the SSE branch, whose only abort
  // source is the socket) and :311; client_gone/true and deadline/true are
  // :300, where the budget or the socket fired past the point of no return;
  // deadline/false is :311 with the budget timer. `stage` is whatever was open
  // at the time, which past persist_outbound is nothing at all.
  { channel: 'voice', error: { outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: false, stage: null, message: 'voice turn aborted' },
    stage_timings: { hydrate_validate: 42.8, persist_inbound: 17.4, fetch_parallel: 164.2, gemini_call_1: 2903.7, total_ms: 3141.6 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b4', score: 0.7629 }], prompt: PROMPT_OK, llm: llmOnce(2903.7, 1962, 44, true), tool_calls: null },
  { channel: 'voice', error: { outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: true, stage: null, message: 'voice turn aborted' },
    stage_timings: { hydrate_validate: 45.9, persist_inbound: 20.2, fetch_parallel: 171.8, gemini_call_1: 1174.5, tool_exec_1_book_appointment: 128.9, gemini_call_2: 702.3, persist_outbound: 25.1, total_ms: 8104.7 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b5', score: 0.7385 }], prompt: PROMPT_OK, llm: llmOnce(1876.8, 2994, 168, true), tool_calls: [{ n: 1, name: 'book_appointment', latency_ms: 128.9, outcome: { status: 'ok' } }] },
  { channel: 'voice', error: { outcome: 'aborted', abort_reason: 'deadline', aborted_after_commit: false, stage: 'fetch_parallel', message: 'voice turn aborted' },
    stage_timings: { hydrate_validate: 39.4, persist_inbound: 16.9, fetch_parallel: 7801.2, total_ms: 8021.3 }, retrieval: null, prompt: null, llm: null, tool_calls: null },
  { channel: 'voice', error: { outcome: 'aborted', abort_reason: 'deadline', aborted_after_commit: true, stage: null, message: 'voice turn aborted' },
    stage_timings: { hydrate_validate: 43.1, persist_inbound: 19.0, fetch_parallel: 166.4, gemini_call_1: 1319.7, tool_exec_1_reschedule_appointment: 149.6, gemini_call_2: 6104.8, persist_outbound: 27.7, total_ms: 8033.9 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b6', score: 0.7042 }], prompt: PROMPT_OK, llm: llmOnce(7424.5, 3110, 152, true), tool_calls: [{ n: 1, name: 'reschedule_appointment', latency_ms: 149.6, outcome: { status: 'ok' } }] },

  // ── tool error on a turn that otherwise completed (F-A054) ─────────────────
  // `error` is NULL on both. The trace viewer calls these `ok` and is right;
  // Incidents calls them `tool_error` and is also right.
  { channel: 'whatsapp', error: null,
    tool_calls: [{ n: 1, name: 'check_availability', latency_ms: 58.3, outcome: { status: 'ok' } }, { n: 2, name: 'book_appointment', latency_ms: 111.2, outcome: { status: 'error', error: 'Slot 2026-09-09 11:00 is no longer available.' } }],
    stage_timings: { fetch_parallel: 174.5, gemini_call_1: 996.1, tool_exec_1_check_availability: 58.3, tool_exec_2_book_appointment: 111.2, gemini_call_2: 711.9, dispatch: 291.4, total_ms: 2352.8 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b7', score: 0.6971 }], prompt: PROMPT_OK, llm: llmOnce(1708.0, 3096, 202, false) },
  { channel: 'voice', error: null,
    tool_calls: [{ n: 1, name: 'cancel_appointment', latency_ms: 96.4, outcome: { status: 'error', error: 'No upcoming appointment found for this patient.' } }],
    stage_timings: { hydrate_validate: 41.7, persist_inbound: 18.6, fetch_parallel: 158.3, gemini_call_1: 1063.8, tool_exec_1_cancel_appointment: 96.4, gemini_call_2: 688.1, persist_outbound: 24.9, total_ms: 2113.5 }, retrieval: [{ chunk_id: '9f2c1d44-0000-4000-8000-0000000000b8', score: 0.7256 }], prompt: PROMPT_OK, llm: llmOnce(1751.9, 2871, 164, true) },
];

/** The first bulk row sits behind the last shape fixture, so volume never
 * displaces the catalogue at the top of a newest-first page. */
const BULK_BASE_MINUTES = 60;
const BULK_STEP_MINUTES = 3;

/**
 * `n` extra incident rows, cycling BULK_SHAPES. Pure — no clock, no randomness,
 * no database — so a test can ask what it would write without writing it.
 *
 * @param {number} n                the row count
 * @param {?string} conversationId  the thread to hang them on, or null
 */
function bulkFixtures(n, conversationId) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ ...BULK_SHAPES[i % BULK_SHAPES.length], conversation_id: conversationId });
  }
  return out;
}

/**
 * THE CHANNEL GUARD. Refuses BEFORE the first INSERT, over the whole row set.
 *
 * See the channel note in this file's header for what a `channel:'test'` row
 * costs. This is a guard and not a detector on purpose: a query run after the
 * inserts would name the damage rather than prevent it, and the budget it
 * protects is a real clinic owner's.
 *
 * @param {Array<{channel: string}>} rows  fixtures AND bulk, together
 * @returns {number} the row count, so the caller can say what it checked
 */
function assertNoForbiddenChannel(rows) {
  const bad = [];
  rows.forEach((r, i) => { if (r.channel === FORBIDDEN_CHANNEL) bad.push(i); });
  if (bad.length) {
    die(`${bad.length} of ${rows.length} row(s) carry channel '${FORBIDDEN_CHANNEL}' `
      + `(index ${bad.join(', ')}). NOTHING WAS WRITTEN.\n`
      + "  testTurnService.countTestTurnsToday counts today's `channel='test'` rows as a\n"
      + '  clinic owner\'s daily "Test your receptionist" allowance, so a seeded row there\n'
      + '  silently spends it. Use \'whatsapp\' or \'voice\'.');
  }
  return rows.length;
}

async function main() {
  const args = parseArgs(process.argv);

  assertNotProduction();
  const target = resolveDbTarget();
  assertLocalHost(target, args.allowRemoteHost);

  if (!UUID_RE.test(args.tenant)) die(`--tenant must be a UUID, got: ${args.tenant}`, { usage: true });

  console.log(`Database : ${target.host}/${target.database}`);

  // Taken HERE, after the guards have passed — see the note at the top.
  const db = getDb();

  if (args.clear) {
    const { rowCount } = await db.query(
      `DELETE FROM turn_traces WHERE tenant_id = $1 AND correlation_id LIKE $2`,
      [args.tenant, SEED_PREFIX + '%']
    );
    console.log(`Cleared  : ${rowCount} seeded trace row(s) on tenant ${args.tenant}.`);
    return;
  }

  const { rows: [tenant] } = await db.query(
    'SELECT id, business_name FROM tenants WHERE id = $1', [args.tenant]);
  if (!tenant) die(`No tenant with id ${args.tenant}. Pass --tenant, or seed one first.`);
  console.log(`Tenant   : ${tenant.business_name} (${tenant.id})`);

  // An EXISTING conversation, never a manufactured one. conversation_id is
  // nullable and SET NULL on delete, so a trace without one is an ordinary row
  // — and inventing a conversation to make the column look full would be
  // fabricating a second thing to decorate the first.
  const { rows: [conv] } = await db.query(
    `SELECT id FROM conversations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [args.tenant]);
  const conversationId = conv ? conv.id : null;
  console.log(conversationId
    ? `Thread   : reusing conversation ${conversationId}`
    : 'Thread   : none exists for this tenant — conversation_id will be NULL on every row.');

  // Shape catalogue first, volume behind it. Their `created_at` offsets do not
  // overlap (BULK_BASE_MINUTES is past the last fixture), so on a newest-first
  // page the catalogue is what a reader sees at the top however large n is.
  const shapes = fixtures(conversationId);
  const bulk = bulkFixtures(args.bulk, conversationId);
  const rows = shapes.concat(bulk);

  // THE GUARD, BEFORE THE FIRST INSERT, OVER BOTH ARRAYS.
  assertNoForbiddenChannel(rows);
  console.log(`Channels : ${[...new Set(rows.map((r) => r.channel))].sort().join(' + ')} — `
    + `${rows.length} row(s) checked for '${FORBIDDEN_CHANNEL}' before writing any.`);

  const j = (v) => (v == null ? null : JSON.stringify(v));
  const minutesFor = (i) => (i < shapes.length
    ? i * 7
    : BULK_BASE_MINUTES + (i - shapes.length) * BULK_STEP_MINUTES);

  let n = 0;
  for (const r of rows) {
    await db.query(
      `INSERT INTO turn_traces
         (tenant_id, conversation_id, channel, correlation_id,
          stage_timings, retrieval, prompt, llm, tool_calls, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() - ($11 || ' minutes')::interval)`,
      [
        tenant.id, r.conversation_id, r.channel, SEED_PREFIX + hex16(),
        j(r.stage_timings), j(r.retrieval), j(r.prompt), j(r.llm), j(r.tool_calls), j(r.error),
        String(minutesFor(n)),
      ]
    );
    n++;
  }

  console.log(`Seeded   : ${n} trace row(s) — ${shapes.length} shape fixture(s) + ${bulk.length} bulk.`);
  console.log('\nOpen     : http://localhost:3000/admin/traces.html');
  console.log('         : http://localhost:3000/admin/incidents.html');
  console.log(`Undo     : node scripts/seed-turn-traces.js --tenant ${tenant.id} --clear`);
}

// Requireable, so the fixtures have exactly ONE home (scripts/admin/
// trace-capture.js drives the same rows) and so the guards above can be tested
// directly rather than by assertion. Running the file still seeds.
if (require.main === module) {
  main()
    .then(() => getDb().close())
    .catch((err) => { console.error(`✗ ${err.message}`); getDb().close(); process.exit(1); });
}

module.exports = {
  fixtures, bulkFixtures, BULK_SHAPES,
  SEED_PREFIX, DEFAULT_TENANT, FORBIDDEN_CHANNEL,
  assertNotProduction, resolveDbTarget, assertLocalHost, assertNoForbiddenChannel, parseArgs,
};
