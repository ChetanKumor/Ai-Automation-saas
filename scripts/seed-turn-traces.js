#!/usr/bin/env node
'use strict';

// seed-turn-traces — put FABRICATED turn_traces rows on a LOCAL DEV tenant so
// the Issue 27 trace viewer can be looked at before there is any real traffic.
//
// Usage:
//   node scripts/seed-turn-traces.js [--tenant <uuid>] [--allow-remote-host]
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

const USAGE = `Usage:
  node scripts/seed-turn-traces.js
    [--tenant <uuid>]           default ${DEFAULT_TENANT} (Smile Dental (Voice Dev))
    [--allow-remote-host]       permit a non-local database host
    [--clear]                   delete only the rows this script wrote, then exit`;

function die(msg, { usage = false } = {}) {
  console.error(`✗ ${msg}`);
  if (usage) console.error(`\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { tenant: DEFAULT_TENANT, allowRemoteHost: false, clear: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--allow-remote-host') out.allowRemoteHost = true;
    else if (a === '--clear') out.clear = true;
    else if (a === '--tenant') out.tenant = args[++i];
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
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

// ── The fixtures ─────────────────────────────────────────────────────────────
//
// Six rows, chosen so every branch the page can render is reachable by looking
// at it rather than by reading the code:
//
//   1 clean WhatsApp turn — retrieval, prompt, model, no tools, no error
//   2 WhatsApp turn with tool calls, one ok and one carrying the tool's own
//     error string (the CONTENT-CLASS:FREE-TEXT path, site 1)
//   3 voice turn ABORTED (the second error envelope)
//   4 voice turn FAILED with a long message (free-text site 2, over the
//     renderer's 240-character cap, so truncation is visible)
//   5 a turn that never reached the model — null retrieval, null prompt,
//     null llm, null tool_calls
//   6 a turn with tool_calls = [] — the EMPTY LIST the live writer never
//     produces (it maps "no tools" to null), so this is the only way to see
//     that the page tells the two apart
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
  ];
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

  const rows = fixtures(conversationId);
  let n = 0;
  for (const r of rows) {
    const j = (v) => (v == null ? null : JSON.stringify(v));
    await db.query(
      `INSERT INTO turn_traces
         (tenant_id, conversation_id, channel, correlation_id,
          stage_timings, retrieval, prompt, llm, tool_calls, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() - ($11 || ' minutes')::interval)`,
      [
        tenant.id, r.conversation_id, r.channel, SEED_PREFIX + hex16(),
        j(r.stage_timings), j(r.retrieval), j(r.prompt), j(r.llm), j(r.tool_calls), j(r.error),
        String(n * 7),
      ]
    );
    n++;
  }

  console.log(`Seeded   : ${n} trace row(s), channels ${[...new Set(rows.map((r) => r.channel))].join(' + ')}.`);
  console.log('\nOpen     : http://localhost:3000/admin/traces.html');
  console.log(`Undo     : node scripts/seed-turn-traces.js --tenant ${tenant.id} --clear`);
}

// Requireable, so the fixtures have exactly ONE home (scripts/admin/
// trace-capture.js drives the same six rows) and so the guards above can be
// tested directly rather than by assertion. Running the file still seeds.
if (require.main === module) {
  main()
    .then(() => getDb().close())
    .catch((err) => { console.error(`✗ ${err.message}`); getDb().close(); process.exit(1); });
}

module.exports = {
  fixtures, SEED_PREFIX, DEFAULT_TENANT,
  assertNotProduction, resolveDbTarget, assertLocalHost, parseArgs,
};
