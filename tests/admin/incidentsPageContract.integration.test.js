'use strict';

// ── The incidents page against seeded rows (INCIDENTS-C) ────────────────────
//
// Over HTTP, against a scratch DB bootstrapped by GENESIS from schema.sql, with
// the REAL admin router on a bare express app — the tracePageContract.
// integration.test.js idiom. Disjoint scratch prefix: zyon_test_ip_. Skips
// without DATABASE_URL.
//
// WHAT MAKES THIS DIFFERENT FROM tests/traces/incidents.test.js, which already
// covers the route: every request below is built by THE PAGE, and every
// response is put through THE PAGE'S OWN RENDERERS. The URL comes from
// `public/admin/incidents.js`'s listUrl(), not from a string written here, and
// the clinic names come from the same /admin/api/tenants call the page makes.
// A route proven correct in isolation and a page proven to read it correctly
// are two different claims, and only the second one is about this session.
//
// THE FAILURE THIS FILE EXISTS FOR is silent by construction: rename a column
// in incidentsQuery.js's projection and the page reads `undefined`, which is
// falsy, which flattens to {hasError:false} and ranks a FAILED turn `ok`. There
// is no exception, no log line and no visible symptom — the badge simply says
// the wrong thing. `levelOf` refuses such a row by name, and block one below is
// what proves the refusal fires on the REAL response rather than on a fixture
// shaped to agree with it.
//
// ⚠ THIS SUITE SKIPS WITHOUT A DATABASE. The always-running half of the same
// contract is tests/admin/incidentsPage.unit.test.js block three, which reads
// incidentsQuery.js off disk and needs nothing.
//
// THREE test() blocks, following the rule tokenDrift.test.js, adminNav.test.js
// and adminShell.test.js all state. They are three concerns — the render path,
// the truncation boundary, and the free-text guard — not three assertions.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const PAGE = require('../../public/admin/incidents.js');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_test_ip_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_ip\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

function req(server, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) { /* not json */ }
          // `raw` is kept deliberately: the free-text guard asserts on the
          // bytes that actually crossed the wire, not on a re-serialised object.
          resolve({ status: res.statusCode, raw: data, body: json });
        });
      });
    r.on('error', reject);
    r.end();
  });
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

// The real shapes, verbatim from tests/traces/incidents.test.js. TOOL_ERROR_TEXT
// is exactly what appointmentService builds for doctor_not_found, INCLUDING the
// model-supplied `doctor` argument, which the model took from the patient's
// utterance. MSG_NEEDLE stands in for err.message, which is unbounded.
const TOOL_ERROR_TEXT = 'Doctor "Dr. Bandaru" not found. Available: Dr. Sharma, Dr. Reddy';
const TOOL_NEEDLE = 'Dr. Bandaru';
const ERROR_MESSAGE_TEXT = 'upstream failure while assembling context ZZFREETEXTNEEDLEZZ';
const MSG_NEEDLE = 'ZZFREETEXTNEEDLEZZ';

// SIX failures and THREE clean turns, across two clinics. The clean rows exist
// so "the page never draws an ok row" is a measured exclusion and not an empty
// fixture, and the six give the truncation boundary a pair to sit on.
const FIXTURE = [
  { name: 'ok_recent', t: 'A', mins: 1, channel: 'whatsapp', tool_calls: null, error: null },
  {
    name: 'b_failed', t: 'B', mins: 20, channel: 'whatsapp', tool_calls: null,
    error: { stage: 'dispatch', message: 'WhatsApp send failed', status: 502 },
  },
  {
    name: 'a_abort_commit', t: 'A', mins: 30, channel: 'voice', tool_calls: null,
    error: {
      outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: true,
      stage: 'gemini_call_1', message: 'voice turn aborted',
    },
  },
  {
    name: 'a_abort_stopped', t: 'A', mins: 40, channel: 'voice', tool_calls: null,
    error: {
      outcome: 'aborted', abort_reason: 'deadline', aborted_after_commit: false,
      stage: 'generate_reply', message: 'voice turn aborted',
    },
  },
  // The turn COMPLETED and the patient did not get their booking. `error` is
  // NULL, the trace viewer calls it ok, and it is an incident (F-A054).
  {
    name: 'a_tool_error', t: 'A', mins: 50, channel: 'whatsapp',
    tool_calls: [
      { n: 1, name: 'check_availability', latency_ms: 62.8, outcome: { status: 'ok' } },
      { n: 2, name: 'book_appointment', latency_ms: 118.3, outcome: { status: 'error', error: TOOL_ERROR_TEXT } },
    ],
    error: null,
  },
  {
    name: 'a_failed', t: 'A', mins: 60, channel: 'voice', tool_calls: null,
    error: { stage: 'fetch_parallel', message: ERROR_MESSAGE_TEXT, status: 500 },
  },
  {
    name: 'b_tool_error', t: 'B', mins: 70, channel: 'test',
    tool_calls: [{ n: 1, name: 'book_appointment', latency_ms: 91.0, outcome: { status: 'error', error: 'slot taken' } }],
    error: null,
  },
  // Non-vacuity for the containment probe: tools ran, all reported ok.
  {
    name: 'ok_tools_ok', t: 'A', mins: 80, channel: 'whatsapp',
    tool_calls: [{ n: 1, name: 'check_availability', latency_ms: 44.2, outcome: { status: 'ok', success: true } }],
    error: null,
  },
  { name: 'ok_tools_empty', t: 'A', mins: 90, channel: 'whatsapp', tool_calls: [], error: null },
];

const FAILURES = 6;

describe('incidents page contract, over seeded rows (INCIDENTS-C)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, server;
  let clinicA, clinicB;
  const id = {};
  const OLD_URL = process.env.DATABASE_URL;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const url = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: url, logger: SILENT });

    // The app pool reads DATABASE_URL at import time, so it is repointed before
    // the router is required — the PORTAL-P1-S1 lazy-require lesson.
    process.env.DATABASE_URL = url;
    db = new Client({ connectionString: url, ssl: SSL });
    await db.connect();

    const mk = async (name, pnid) => (await db.query(
      `INSERT INTO tenants (business_name, phone_number_id, wa_token, ai_enabled, active)
       VALUES ($1, $2, 'x', true, true) RETURNING id`, [name, pnid])).rows[0].id;
    clinicA = await mk('Incidents Clinic A', 'pnid_ip_1');
    clinicB = await mk('Incidents Clinic B', 'pnid_ip_2');

    const mkConv = async (tenantId, phone) => {
      const { rows: [cust] } = await db.query(
        `INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING id`, [tenantId, phone]);
      const { rows: [conv] } = await db.query(
        `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`, [tenantId, cust.id]);
      return conv.id;
    };
    const convA = await mkConv(clinicA, '+919000004101');
    const convB = await mkConv(clinicB, '+919000004102');

    const j = (v) => (v == null ? null : JSON.stringify(v));
    for (const f of FIXTURE) {
      const turnId = crypto.randomUUID();
      id[f.name] = turnId;
      await db.query(
        `INSERT INTO turn_traces
           (turn_id, tenant_id, conversation_id, channel, correlation_id,
            stage_timings, tool_calls, error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() - make_interval(mins => $9))`,
        [
          turnId,
          f.t === 'A' ? clinicA : clinicB,
          f.t === 'A' ? convA : convB,
          f.channel,
          (f.channel === 'voice' ? 'probe_' : 'wa_') + crypto.randomBytes(8).toString('hex'),
          JSON.stringify({ total_ms: 100 + f.mins }),
          j(f.tool_calls),
          j(f.error),
          f.mins,
        ]
      );
    }

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use(session({ secret: 'ip-test', resave: false, saveUninitialized: false }));
    app.use((rq, _rs, next) => { rq.session.admin = true; next(); });
    app.use('/admin', require('../../src/admin/adminRoutes'));
    server = await listen(app);
  });

  after(async () => {
    if (server) server.close();
    try { await require('../../src/db/db').close(); } catch (_) { /* already closed */ }
    if (db) await db.end();
    process.env.DATABASE_URL = OLD_URL;
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  /** The clinic map exactly as the page builds it: one call, mapped by id. */
  async function clinicNames() {
    const res = await req(server, '/admin/api/tenants');
    assert.equal(res.status, 200);
    const names = {};
    for (const t of res.body) names[t.id] = t.business_name;
    return names;
  }

  it('renders every reachable level from the real response, through the page\'s own call path', async () => {
    // THE URL COMES FROM THE PAGE. A page that asks for something the route
    // refuses would render its 400 as nothing, which is the untrue answer.
    assert.equal(PAGE.listUrl(), '/admin/api/incidents?limit=200');
    const res = await req(server, PAGE.listUrl());
    assert.equal(res.status, 200);
    assert.equal(res.body.length, FAILURES,
      'the route returns the six failures and none of the three clean turns');

    // Newest first, which is what the page's Time column claims.
    const times = res.body.map((r) => new Date(r.created_at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));

    // EVERY FIELD THE PAGE DECLARED IS ON THE PAYLOAD. This is the rename guard
    // over HTTP: `levelOf` throws by name on a missing one, so a green here is
    // a statement about the real projection.
    const first = res.body[0];
    for (const f of PAGE.REQUIRED_FIELDS) {
      assert.ok(f in first, `the payload has no ${f}, and the page reads it off every row`);
    }

    // All three reachable levels, off the real rows, and no fourth.
    const levels = res.body.map((r) => PAGE.levelOf(r));
    assert.deepEqual([...new Set(levels)].sort(), ['aborted', 'failed', 'tool_error']);
    assert.equal(levels.filter((l) => l === 'aborted').length, 2, 'both abort rows');
    assert.equal(levels.filter((l) => l === 'tool_error').length, 2, 'both tool-error rows');
    assert.ok(!levels.includes('ok'), 'the route cannot return an ok row and the page cannot draw one');
    assert.equal(PAGE.levelOf(res.body.find((r) => r.turn_id === id.a_tool_error)), 'tool_error',
      'the turn COMPLETED and the patient did not get their booking (F-A054)');

    // And the renderers survive the real payload end to end.
    const names = await clinicNames();
    const html = PAGE.rowsHtml(res.body, names);
    assert.equal((html.match(/class="incident-row"/g) || []).length, FAILURES);
    assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
    assert.doesNotMatch(html, /class="contract-fail"/,
      'the real response must not trip the page\'s own shape guard');

    // The clinic map is the page's, and both real names reach the table.
    assert.match(html, /Incidents Clinic A/);
    assert.match(html, /Incidents Clinic B/);
    // A tenant absent from the map degrades to the id, never to a blank.
    const stripped = PAGE.rowsHtml(res.body, {});
    assert.doesNotMatch(stripped, /Incidents Clinic/);
    assert.match(stripped, new RegExp('title="' + clinicA + '"'));

    // F-A058, as a presentation fact rather than a filter: a probe turn sits
    // beside a patient failure and the channel and correlation id are what
    // separate them. Both are on the row, and the page draws both.
    assert.match(html, /class="chip chip-voice">voice</);
    assert.match(html, /class="chip chip-test">test</);
    assert.match(html, /probe_/);

    // Not the empty state, and the trace link carries the row's OWN tenant.
    assert.doesNotMatch(html, /No failed turn has been recorded/);
    assert.match(html, new RegExp('href="/admin/traces\\.html\\?tenant_id=' + clinicB + '"'));
  });

  it('discloses truncation exactly when the response fills the page it asked for', async () => {
    // THE BOUNDARY, on real responses rather than on constructed arrays. Six
    // failures exist, so limit=6 is a full page and limit=7 is not, and the
    // same six rows produce a different answer for the reader.
    const atCap = await req(server, '/admin/api/incidents?limit=' + FAILURES);
    assert.equal(atCap.status, 200);
    assert.equal(atCap.body.length, FAILURES);
    const disclosed = PAGE.truncationHtml(atCap.body, FAILURES);
    assert.match(disclosed, /window, not the whole list/i,
      'a response that exactly fills the requested page is a WINDOW, and '
      + 'presenting it as the set is rank-then-truncate one layer up');
    assert.match(disclosed, /no next page/);

    const underCap = await req(server, '/admin/api/incidents?limit=' + (FAILURES + 1));
    assert.equal(underCap.status, 200);
    assert.equal(underCap.body.length, FAILURES, 'the same six rows');
    assert.equal(PAGE.truncationHtml(underCap.body, FAILURES + 1), '',
      'one row short of the page it asked for, the list IS the set — without '
      + 'this the disclosure could fire always and disclose nothing');

    // And in production the page asks for the ceiling, which the route accepts.
    // Nine rows exist and six are failures, so today's real answer is silent —
    // the disclosure is reachable, not permanent.
    const real = await req(server, PAGE.listUrl());
    assert.equal(real.status, 200);
    assert.equal(PAGE.truncationHtml(real.body, PAGE.LIMIT), '');
  });

  it('carries no free-text field on the wire, and the page renders none', async () => {
    const res = await req(server, PAGE.listUrl());
    const names = await clinicNames();

    // Not rendering free text is not the same as not fetching it. The strong
    // form: assert on the BYTES that actually crossed the wire.
    assert.ok(!res.raw.includes(MSG_NEEDLE),
      'error.message must not cross the wire — it is unbounded and can carry an '
      + 'upstream response body');
    assert.ok(!res.raw.includes(TOOL_NEEDLE),
      'tool_calls[].outcome.error must not cross the wire — appointmentService '
      + "interpolates the model's own doctor argument into it, taken from the "
      + "patient's utterance verbatim");
    for (const row of res.body) {
      assert.ok(!('error' in row), 'the raw error envelope is not projected');
      assert.ok(!('tool_calls' in row), 'the raw tool_calls array is not projected');
    }

    // Nor does the rendered page carry either.
    const html = PAGE.rowsHtml(res.body, names);
    assert.ok(!html.includes(MSG_NEEDLE));
    assert.ok(!html.includes(TOOL_NEEDLE));

    // Non-vacuity: both needles really are in the table, so the assertions
    // above are testing a projection and not an empty fixture.
    const { rows: [t] } = await db.query(
      `SELECT count(*)::int AS n FROM turn_traces WHERE error->>'message' LIKE $1`, ['%' + MSG_NEEDLE + '%']);
    assert.equal(t.n, 1, 'the error.message needle is genuinely stored');
    const { rows: [u] } = await db.query(
      `SELECT count(*)::int AS n FROM turn_traces WHERE tool_calls::text LIKE $1`, ['%' + TOOL_NEEDLE + '%']);
    assert.equal(u.n, 1, 'the tool-error needle is genuinely stored');

    // The closed-set fields the page DOES draw are all present, so this is a
    // projection boundary and not a page that renders nothing.
    assert.match(html, /dispatch/);
    assert.match(html, /client_gone/);
    assert.match(html, /after commit/);
    assert.match(html, /deadline/);
    assert.match(html, /before commit/);
    assert.match(html, /a tool call reported an error/);
  });
});
