'use strict';

// Cross-tenant incidents read (INCIDENTS-B) — GET /admin/api/incidents.
//
// Runs over HTTP against a scratch DB bootstrapped by GENESIS from schema.sql,
// same idiom as tracesRoutes.test.js. Skips without DATABASE_URL. Disjoint
// scratch prefix: zyon_inc_.
//
// ── WHAT THIS FILE IS ACTUALLY FOR ──────────────────────────────────────────
// One test here matters more than the rest put together: the `limit + 1`
// fixture. The defect it exists to catch is rank-then-truncate — taking the
// newest N rows and filtering them afterwards, which can only ever mean "the
// failures inside the newest N turns" and reports ZERO incidents for a tenant
// that has many. At genesis N=1, so a wrong implementation is indistinguishable
// from a correct one until there is traffic, and then it stops being right with
// no symptom. A fixture that fits inside one page of results returns the same
// answer under both implementations and its green result is worthless. Hence
// six clean turns NEWER than every failure, and a page of five.
//
// ── THE TABLE-STATE PRECONDITION, AND WHY IT IS NOT OPTIONAL ────────────────
// This is the first test in the repository whose correctness depends on the
// contents of the ENTIRE table, because the route under test has no tenant
// predicate. Every other traces test is isolated by tenant_id; this one is
// isolated only by the scratch database. That is adequate today and silently
// stops being adequate the moment anyone points it elsewhere.
//
// "No ok row is returned" is the exposed assertion: against a polluted or
// shared database it does not become WRONG, it becomes a DIFFERENT assertion,
// and it can go green while proving nothing. So every request is preceded by
// assertTableState(), which fails loudly and by name on a row the fixture did
// not put there — rather than letting the main assertion redden and
// misattribute the cause.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_inc_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_inc\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirrors tracesRoutes.test.js) ──────────────────────────────
function req(server, { method = 'GET', path = '/', headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const h = Object.assign({}, headers);
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = null; }
        // `raw` is kept deliberately: the free-text guard asserts on the bytes
        // that actually crossed the wire, not on a re-serialised object.
        resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: json, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

// ── Free-text needles ────────────────────────────────────────────────────────
// Both are the real shapes. TOOL_NEEDLE is exactly what appointmentService
// builds for doctor_not_found, INCLUDING the model-supplied `doctor` argument,
// which the model took from the patient's utterance verbatim — this is
// patient-derived text sitting in a column. MSG_NEEDLE stands in for
// err.message, which is unbounded and can carry an entire upstream response
// body. Neither may cross the wire on a cross-tenant read.
const TOOL_ERROR_TEXT = 'Doctor "Dr. Bandaru" not found. Available: Dr. Sharma, Dr. Reddy';
const TOOL_NEEDLE = 'Dr. Bandaru';
const ERROR_MESSAGE_TEXT = 'upstream failure while assembling context ZZFREETEXTNEEDLEZZ';
const MSG_NEEDLE = 'ZZFREETEXTNEEDLEZZ';

// The projection's exact shape. Declared here, from intent, so a column added
// to the route without a decision fails this file rather than sliding through.
const EXPECTED_KEYS = [
  'abort_reason',
  'aborted_after_commit',
  'call_session_id',
  'channel',
  'conversation_id',
  'correlation_id',
  'created_at',
  'error_outcome',
  'error_stage',
  'has_error',
  'has_tool_error',
  'tenant_id',
  'turn_id',
].sort();

describe('cross-tenant incidents read (INCIDENTS-B)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, server, cookie;
  let tenantA, tenantB, convA, convB;
  const OLD_PW = process.env.ADMIN_PASSWORD;

  // turn_id by fixture name, so assertions name rows rather than indexes.
  const id = {};

  // ── The fixture ────────────────────────────────────────────────────────────
  // Laid out on one timeline, newest first. The six `ok_recent_*` rows sit
  // ABOVE every failure on purpose: they are the page that a rank-then-truncate
  // implementation would return, and they contain no failure at all.
  //
  //   minutes  name              tenant  level        why it is here
  //   ------------------------------------------------------------------------
  //    1..6    ok_recent_1..6    A       ok           limit+1 clean rows, all
  //                                                   newer than every failure
  //      20    b_failed          B       failed       newest failure; the row
  //                                                   the limit+1 red-check
  //                                                   asserts on by name
  //      30    a_abort_commit    A       aborted      aborted_after_commit true
  //      40    a_abort_stopped   A       aborted      aborted_after_commit false
  //      50    a_tool_error      A       tool error   error NULL, booking tool
  //                                                   returned status:'error'
  //      60    a_failed          A       failed       carries MSG_NEEDLE
  //      70    b_tool_error      B       tool error   second tenant, second arm
  //      80    ok_tools_ok       A       ok           tools present, all ok —
  //                                                   the containment probe
  //                                                   must NOT match this
  //      90    ok_tools_empty    A       ok           tool_calls = [] , the
  //                                                   empty list the live
  //                                                   writer never produces
  //
  // 14 rows. 6 are failures, 8 are not.
  const FIXTURE = [
    { name: 'ok_recent_1', t: 'A', mins: 1, conv: true, channel: 'whatsapp', tool_calls: null, error: null },
    { name: 'ok_recent_2', t: 'A', mins: 2, conv: true, channel: 'whatsapp', tool_calls: null, error: null },
    { name: 'ok_recent_3', t: 'A', mins: 3, conv: true, channel: 'voice', tool_calls: null, error: null },
    { name: 'ok_recent_4', t: 'A', mins: 4, conv: true, channel: 'whatsapp', tool_calls: null, error: null },
    { name: 'ok_recent_5', t: 'A', mins: 5, conv: true, channel: 'voice', tool_calls: null, error: null },
    { name: 'ok_recent_6', t: 'A', mins: 6, conv: true, channel: 'whatsapp', tool_calls: null, error: null },

    {
      name: 'b_failed', t: 'B', mins: 20, conv: true, channel: 'whatsapp', tool_calls: null,
      error: { stage: 'dispatch', message: 'WhatsApp send failed', status: 502 },
    },
    {
      name: 'a_abort_commit', t: 'A', mins: 30, conv: true, channel: 'voice', tool_calls: null,
      error: {
        outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: true,
        stage: 'gemini_call_1', message: 'voice turn aborted',
      },
    },
    {
      name: 'a_abort_stopped', t: 'A', mins: 40, conv: true, channel: 'voice', tool_calls: null,
      error: {
        outcome: 'aborted', abort_reason: 'deadline', aborted_after_commit: false,
        stage: 'generate_reply', message: 'voice turn aborted',
      },
    },
    // THE ONE THE LADDER'S THIRD ARM EXISTS FOR. The turn completed. The
    // patient did not get their booking. `error` is NULL and the trace viewer's
    // statusOf therefore renders it `ok` — correctly, because it answers a
    // different question (F-A054). It is an incident all the same.
    {
      name: 'a_tool_error', t: 'A', mins: 50, conv: true, channel: 'whatsapp',
      tool_calls: [
        { n: 1, name: 'check_availability', latency_ms: 62.8, outcome: { status: 'ok' } },
        { n: 2, name: 'book_appointment', latency_ms: 118.3, outcome: { status: 'error', error: TOOL_ERROR_TEXT } },
      ],
      error: null,
    },
    // conv:false — a voice failure with no conversation, mirroring the
    // canonical fixture row. Proves the projection carries a null through.
    {
      name: 'a_failed', t: 'A', mins: 60, conv: false, channel: 'voice', tool_calls: null,
      error: { stage: 'fetch_parallel', message: ERROR_MESSAGE_TEXT, status: 500 },
    },
    {
      name: 'b_tool_error', t: 'B', mins: 70, conv: true, channel: 'voice',
      tool_calls: [{ n: 1, name: 'book_appointment', latency_ms: 91.0, outcome: { status: 'error', error: 'slot taken' } }],
      error: null,
    },
    // Non-vacuity for the containment probe: tools ran, all reported ok. If
    // `@>` matched on the presence of an outcome rather than its status, this
    // row would be returned and the ok-exclusion assertion would catch it.
    {
      name: 'ok_tools_ok', t: 'A', mins: 80, conv: true, channel: 'whatsapp',
      tool_calls: [{ n: 1, name: 'check_availability', latency_ms: 44.2, outcome: { status: 'ok', success: true } }],
      error: null,
    },
    { name: 'ok_tools_empty', t: 'A', mins: 90, conv: true, channel: 'whatsapp', tool_calls: [], error: null },
  ];

  const FAILURES = ['b_failed', 'a_abort_commit', 'a_abort_stopped', 'a_tool_error', 'a_failed', 'b_tool_error'];
  const NOT_FAILURES = ['ok_recent_1', 'ok_recent_2', 'ok_recent_3', 'ok_recent_4', 'ok_recent_5',
    'ok_recent_6', 'ok_tools_ok', 'ok_tools_empty'];
  const SEEDED_ROWS = FIXTURE.length;

  /**
   * A4 — the table-state precondition.
   *
   * The route has no tenant predicate, so every row in the table is in scope
   * for every request. A row this fixture did not write changes what the
   * assertions below MEAN. Assert the whole-table count before each request and
   * fail here, by name, rather than letting a main assertion redden and point
   * at the wrong thing.
   */
  async function assertTableState() {
    const { rows: [c] } = await db.query('SELECT count(*)::int AS n FROM turn_traces');
    assert.equal(
      c.n, SEEDED_ROWS,
      `PRECONDITION FAILED: turn_traces holds ${c.n} rows, fixture seeded ${SEEDED_ROWS}. ` +
      'This route has NO tenant predicate, so an unseeded row is in scope for every ' +
      'assertion in this file and silently changes what they mean. Fix the table state; ' +
      'do not weaken the assertions.'
    );
  }

  const get = (path) => req(server, { path, cookie });
  const names = (rows) => rows.map((r) => Object.keys(id).find((k) => id[k] === r.turn_id));

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use(session({
      secret: 'test-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict' },
    }));
    app.use('/admin', require('../../src/admin/adminRoutes'));
    server = await listen(app);

    const login = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    assert.equal(login.status, 200);
    cookie = sid(login.setCookie);

    // Two tenants, one conversation each. Cross-tenant is proven on rows that
    // belong to genuinely different tenants, not on one tenant seen twice.
    const { rows: [a] } = await db.query(
      `INSERT INTO tenants (business_name) VALUES ('Incidents Clinic A') RETURNING id`);
    tenantA = a.id;
    const { rows: [b] } = await db.query(
      `INSERT INTO tenants (business_name) VALUES ('Incidents Clinic B') RETURNING id`);
    tenantB = b.id;

    const mkConv = async (tenantId, phone) => {
      const { rows: [cust] } = await db.query(
        `INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING id`, [tenantId, phone]);
      const { rows: [conv] } = await db.query(
        `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`, [tenantId, cust.id]);
      return conv.id;
    };
    convA = await mkConv(tenantA, '+919000003101');
    convB = await mkConv(tenantB, '+919000003102');

    const j = (v) => (v == null ? null : JSON.stringify(v));
    for (const f of FIXTURE) {
      const turnId = crypto.randomUUID();
      id[f.name] = turnId;
      await db.query(
        `INSERT INTO turn_traces
           (turn_id, tenant_id, conversation_id, channel, correlation_id,
            stage_timings, tool_calls, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - make_interval(mins => $9))`,
        [
          turnId,
          f.t === 'A' ? tenantA : tenantB,
          f.conv ? (f.t === 'A' ? convA : convB) : null,
          f.channel,
          'wa_' + crypto.randomBytes(8).toString('hex'),
          JSON.stringify({ total_ms: 100 + f.mins }),
          j(f.tool_calls),
          j(f.error),
          f.mins,
        ]
      );
    }
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    process.env.ADMIN_PASSWORD = OLD_PW;
    if (server) await new Promise((r) => server.close(r));
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  it('requires auth', async () => {
    await assertTableState();
    assert.equal((await req(server, { path: '/admin/api/incidents' })).status, 401);

    // Non-vacuity: with a session the route answers, so the 401 above is auth
    // and not a route that never worked.
    const authed = await get('/admin/api/incidents');
    assert.equal(authed.status, 200);
    assert.ok(Array.isArray(authed.body));
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  THE ONE THAT MATTERS.
  //
  //  Six clean turns sit NEWER than every failure. Ask for a page of five.
  //
  //    predicate inside the WHERE  → the clean rows never enter the result
  //                                  set; five failures come back and
  //                                  `b_failed` is the newest of them.
  //    predicate after the LIMIT   → the newest five rows are all clean, every
  //                                  failure is outside the window, and the
  //                                  post-filter yields ZERO rows.
  //
  //  The assertion that must redden in the wrong direction is the PRESENCE of
  //  b_failed — not a count, not a shape, either of which would also move for
  //  unrelated reasons.
  // ══════════════════════════════════════════════════════════════════════════
  it('applies the failure predicate inside the WHERE: a failure older than a full page of clean turns is still returned', async () => {
    await assertTableState();

    const PAGE = 5;
    const newerCleanRows = FIXTURE.filter((f) => f.error == null && !f.tool_calls?.some((t) => t.outcome.status === 'error') && f.mins <= 6);
    assert.equal(newerCleanRows.length, PAGE + 1,
      'fixture precondition: there must be limit+1 clean turns newer than every failure, ' +
      'or this test fits inside one page and cannot catch rank-then-truncate');

    const r = await get(`/admin/api/incidents?limit=${PAGE}`);
    assert.equal(r.status, 200);

    // ── THE ASSERTION. Under rank-then-truncate the body is []. ──
    assert.ok(
      r.body.some((row) => row.turn_id === id.b_failed),
      'the newest failure is returned even though six clean turns are newer than it — ' +
      'i.e. the predicate ran BEFORE the LIMIT, not after it'
    );

    // Corroborating, deliberately secondary to the assertion above.
    assert.equal(r.body.length, PAGE, 'a full page of failures, not a page of whatever was newest');
    assert.deepEqual(
      names(r.body),
      ['b_failed', 'a_abort_commit', 'a_abort_stopped', 'a_tool_error', 'a_failed'],
      'the five NEWEST FAILURES, in recency order — b_tool_error is the one the limit cuts'
    );
    for (const n of NOT_FAILURES) {
      assert.ok(!r.body.some((row) => row.turn_id === id[n]), `${n} is not a failure and must not appear`);
    }
  });

  it('returns every failure level, and no ok row', async () => {
    await assertTableState();
    const r = await get('/admin/api/incidents?limit=200');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, FAILURES.length);
    assert.deepEqual(names(r.body).sort(), [...FAILURES].sort());

    const by = (n) => r.body.find((row) => row.turn_id === id[n]);

    // failed — an error envelope that is not an abort.
    for (const n of ['b_failed', 'a_failed']) {
      assert.equal(by(n).has_error, true, `${n}: has_error`);
      assert.equal(by(n).error_outcome, null, `${n}: not an abort`);
    }
    assert.equal(by('b_failed').error_stage, 'dispatch');
    assert.equal(by('a_failed').error_stage, 'fetch_parallel');

    // aborted — BOTH values of aborted_after_commit, because the two mean
    // materially different things and neither is ranked against the other.
    assert.equal(by('a_abort_commit').error_outcome, 'aborted');
    assert.equal(by('a_abort_commit').abort_reason, 'client_gone');
    assert.equal(by('a_abort_commit').aborted_after_commit, true);
    assert.equal(by('a_abort_stopped').error_outcome, 'aborted');
    assert.equal(by('a_abort_stopped').abort_reason, 'deadline');
    assert.equal(by('a_abort_stopped').aborted_after_commit, false);

    // tool error — error NULL, and a tool reported one.
    for (const n of ['a_tool_error', 'b_tool_error']) {
      assert.equal(by(n).has_error, false, `${n}: the error column is NULL`);
      assert.equal(by(n).has_tool_error, true, `${n}: a tool reported an error`);
    }

    // No returned row is an ok row: every one carries at least one of the two
    // signals. A predicate of TRUE would break exactly here.
    for (const row of r.body) {
      assert.ok(row.has_error || row.has_tool_error,
        'every returned row is a failure by one of the two arms');
    }
    for (const n of NOT_FAILURES) {
      assert.ok(!r.body.some((row) => row.turn_id === id[n]), `${n} must not be returned`);
    }
  });

  // The class that is invisible without the JSONB arm: the turn SUCCEEDED and
  // the patient did not get their booking. It earns its place on this fixture,
  // not on an argument.
  it('returns a turn whose error column is NULL but whose booking tool failed', async () => {
    await assertTableState();
    const r = await get('/admin/api/incidents?limit=200');
    const row = r.body.find((x) => x.turn_id === id.a_tool_error);

    assert.ok(row, 'the tool-error turn is an incident even though error IS NULL');
    assert.equal(row.has_error, false);
    assert.equal(row.has_tool_error, true);
    assert.equal(row.error_outcome, null);
    assert.equal(row.error_stage, null);

    // Non-vacuity for the containment probe: a turn whose tools ALL reported ok
    // is not swept in by it.
    assert.ok(!r.body.some((x) => x.turn_id === id.ok_tools_ok),
      'a turn whose tools all succeeded is not a tool error');
    assert.ok(!r.body.some((x) => x.turn_id === id.ok_tools_empty),
      'a turn with an empty tool list is not a tool error');
  });

  // Asserted deliberately, not satisfied incidentally: the fixture puts
  // failures on BOTH tenants and the assertion names both.
  it('reads across tenants: one response carries rows from two different tenants', async () => {
    await assertTableState();
    const r = await get('/admin/api/incidents?limit=200');

    const tenants = new Set(r.body.map((row) => row.tenant_id));
    assert.equal(tenants.size, 2, 'rows from exactly the two seeded tenants');
    assert.ok(tenants.has(tenantA), 'tenant A is represented');
    assert.ok(tenantB !== tenantA && tenants.has(tenantB), 'tenant B is represented, and is a different tenant');

    // And both tenants' rows arrive in ONE response, interleaved by recency —
    // not grouped, which would hint at a per-tenant fan-out behind the route.
    assert.deepEqual(
      names(r.body),
      ['b_failed', 'a_abort_commit', 'a_abort_stopped', 'a_tool_error', 'a_failed', 'b_tool_error']
    );
  });

  it('orders by recency, newest first, after the predicate', async () => {
    await assertTableState();
    const r = await get('/admin/api/incidents?limit=200');
    const times = r.body.map((row) => new Date(row.created_at).getTime());
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], `row ${i} is not newer-or-equal to row ${i + 1}`);
    }
    assert.equal(r.body[0].turn_id, id.b_failed, 'the newest FAILURE leads — not the newest turn');
  });

  // The limit contract is the traces list's, read off it rather than chosen:
  // default 50, cap 200, and out-of-range is REFUSED rather than clamped, in
  // the identical 400 shape.
  it('honours the limit contract and refuses malformed values in the existing 400 shape', async () => {
    await assertTableState();

    const dflt = await get('/admin/api/incidents');
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.length, FAILURES.length, 'the default of 50 is above the fixture, so all failures return');

    const one = await get('/admin/api/incidents?limit=1');
    assert.equal(one.body.length, 1);
    assert.equal(one.body[0].turn_id, id.b_failed, 'the newest failure');

    // Refused, not clamped — matching adminRoutes' traces list exactly.
    for (const bad of ['0', '999', 'abc', '-1', '1.5', '']) {
      const r = await get(`/admin/api/incidents?limit=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `limit=${JSON.stringify(bad)} is refused`);
      assert.deepEqual(r.body, { error: 'limit must be an integer between 1 and 200' },
        `limit=${JSON.stringify(bad)} refuses in the existing shape`);
    }

    // The cap is a boundary, not a fence: 200 itself is accepted.
    assert.equal((await get('/admin/api/incidents?limit=200')).status, 200);
  });

  // Not rendering free text is not the same as not fetching it. A cross-tenant
  // read multiplies both free-text fields by tenant count in one response, and
  // one of them provably carries patient-derived text.
  it('projects the closed sets only: neither free-text field crosses the wire', async () => {
    await assertTableState();
    const r = await get('/admin/api/incidents?limit=200');

    assert.deepEqual(Object.keys(r.body[0]).sort(), EXPECTED_KEYS,
      'the projection is exactly the declared columns — a new column needs a decision, not a default');
    for (const row of r.body) {
      assert.ok(!('error' in row), 'the raw error envelope is not projected');
      assert.ok(!('tool_calls' in row), 'the raw tool_calls array is not projected');
    }

    // The strong form: assert on the BYTES that actually crossed the wire.
    assert.ok(!r.raw.includes(MSG_NEEDLE),
      'error.message must not cross the wire — it is unbounded and can carry an upstream response body');
    assert.ok(!r.raw.includes(TOOL_NEEDLE),
      'tool_calls[].outcome.error must not cross the wire — appointmentService interpolates the ' +
      "model's own doctor argument into it, taken from the patient's utterance verbatim");

    // Non-vacuity: both needles really are in the table, so the two assertions
    // above are testing a projection and not an empty fixture.
    const { rows: [t] } = await db.query(
      `SELECT count(*)::int AS n FROM turn_traces WHERE error->>'message' LIKE $1`, ['%' + MSG_NEEDLE + '%']);
    assert.equal(t.n, 1, 'the error.message needle is genuinely stored');
    const { rows: [u] } = await db.query(
      `SELECT count(*)::int AS n FROM turn_traces WHERE tool_calls::text LIKE $1`, ['%' + TOOL_NEEDLE + '%']);
    assert.equal(u.n, 1, 'the tool-error needle is genuinely stored');
  });
});
