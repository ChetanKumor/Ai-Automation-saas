'use strict';

// ── The trace page against seeded rows (Issue 27) ───────────────────────────
//
// Over HTTP, against a scratch DB bootstrapped by GENESIS from schema.sql, with
// the REAL admin router on a bare express app — the tracesRoutes.test.js idiom.
// Disjoint scratch prefix: zyon_test_tp_. Skips without DATABASE_URL.
//
// WHAT MAKES THIS DIFFERENT FROM tracesRoutes.test.js, which already covers the
// routes: every request below is built by THE PAGE. The URLs come from
// `public/admin/traces.js`'s own listUrl()/detailUrl(), not from strings written
// here, so the test cannot pass while the page asks for something else. That is
// the point of I1's "through the page's own call path": a route proven isolated
// and a page proven to use it correctly are two different claims, and only the
// second one is about this session.
//
// The fixtures are the SEED SCRIPT's, imported rather than restated, so the rows
// a developer sees locally and the rows this test asserts on cannot diverge.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const PAGE = require('../../public/admin/traces.js');
const seed = require('../../scripts/seed-turn-traces.js');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_test_tp_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_tp\\_%'");
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
          resolve({ status: res.statusCode, raw: data, body: json });
        });
      });
    r.on('error', reject);
    r.end();
  });
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

describe('trace page contract, over seeded rows (Issue 27)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, server;
  let tenantId, otherTenantId, conversationId;
  const turnIds = [];
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
    tenantId = await mk('Seeded Clinic', 'pnid_tp_1');
    otherTenantId = await mk('Other Clinic', 'pnid_tp_2');

    const { rows: [cust] } = await db.query(
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1, '+919000000777', 'Seed Patient') RETURNING id`,
      [tenantId]);
    const { rows: [conv] } = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id, status, mode) VALUES ($1, $2, 'open', 'ai') RETURNING id`,
      [tenantId, cust.id]);
    conversationId = conv.id;

    let n = 0;
    for (const r of seed.fixtures(conversationId)) {
      const j = (v) => (v == null ? null : JSON.stringify(v));
      const { rows: [row] } = await db.query(
        `INSERT INTO turn_traces
           (tenant_id, conversation_id, channel, correlation_id,
            stage_timings, retrieval, prompt, llm, tool_calls, error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() - ($11 || ' minutes')::interval)
         RETURNING turn_id`,
        [tenantId, r.conversation_id, r.channel, seed.SEED_PREFIX + crypto.randomBytes(8).toString('hex'),
          j(r.stage_timings), j(r.retrieval), j(r.prompt), j(r.llm), j(r.tool_calls), j(r.error),
          String(n * 7)]);
      turnIds.push(row.turn_id);
      n++;
    }

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use(session({ secret: 'tp-test', resave: false, saveUninitialized: false }));
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

  it('lists the seeded rows through the page\'s own call path, newest first', async () => {
    const res = await req(server, PAGE.listUrl({ tenantId, limit: 50 }));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, seed.fixtures(null).length);

    // Newest first, which is what the page's Time column claims.
    const times = res.body.map((r) => new Date(r.created_at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));

    // Every column the page draws is actually present on the payload, so the
    // table is reading the row rather than hoping.
    const first = res.body[0];
    for (const col of ['created_at', 'correlation_id', 'conversation_id', 'channel', 'stage_timings', 'error', 'turn_id', 'tenant_id']) {
      assert.ok(col in first, `the list payload has no ${col}, but the page renders it`);
    }
    // And the renderers survive the real payload end to end.
    const html = PAGE.rowsHtml(res.body);
    assert.equal((html.match(/class="trace-row"/g) || []).length, res.body.length);
    assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
  });

  it('narrows by the two filters the route accepts, still scoped to the tenant', async () => {
    const byConv = await req(server, PAGE.listUrl({ tenantId, conversationId, limit: 50 }));
    assert.equal(byConv.status, 200);
    // Five of the six fixtures carry the conversation; one is deliberately null.
    assert.equal(byConv.body.length, seed.fixtures(conversationId).filter((f) => f.conversation_id).length);

    const corr = byConv.body[0].correlation_id;
    const byCorr = await req(server, PAGE.listUrl({ tenantId, correlationId: corr, limit: 50 }));
    assert.equal(byCorr.status, 200);
    assert.equal(byCorr.body.length, 1);
    assert.equal(byCorr.body[0].correlation_id, corr);
  });

  // ── I1 ────────────────────────────────────────────────────────────────────
  it('cannot read another tenant\'s trace through the page\'s own call path', async () => {
    // The LIST: the other tenant sees an empty list, not an error and not rows.
    const foreignList = await req(server, PAGE.listUrl({ tenantId: otherTenantId, limit: 50 }));
    assert.equal(foreignList.status, 200);
    assert.deepEqual(foreignList.body, []);
    // And the page renders that as its empty state, not as a blank table.
    assert.match(PAGE.rowsHtml(foreignList.body), /No traces for this clinic yet\./);

    // The DETAIL: a trace belonging to tenant 1, asked for as tenant 2.
    const foreign = await req(server, PAGE.detailUrl(turnIds[0], otherTenantId));
    const absent = await req(server, PAGE.detailUrl(crypto.randomUUID(), otherTenantId));
    assert.equal(foreign.status, 404);
    assert.equal(foreign.status, absent.status);
    assert.equal(foreign.raw, absent.raw, 'the deny must be byte-identical to the absent answer');
    assert.equal(Buffer.byteLength(foreign.raw), 27, 'the 27-byte deny body recorded at ADMIN-S3a');

    // Non-vacuity: the owning tenant still reads it, so the 404 above is
    // scoping and not a page that stopped working.
    const own = await req(server, PAGE.detailUrl(turnIds[0], tenantId));
    assert.equal(own.status, 200);
    assert.equal(own.body.turn_id, turnIds[0]);
  });

  it('sends no request at all without a tenant, and the route refuses one sent anyway', async () => {
    assert.equal(PAGE.listUrl({ tenantId: '' }), null, 'the page must not build a tenant-less url');
    assert.equal(PAGE.detailUrl(turnIds[0], ''), null);

    // What the page declines to send, asked for directly, is a 400 — which is
    // why declining matters: rendered as an empty list it would read as "no
    // traces for this clinic".
    const raw = await req(server, '/admin/api/traces?limit=50');
    assert.equal(raw.status, 400);
    assert.match(raw.body.error, /tenant_id is required/);
  });

  it('renders every seeded shape without inventing a value', async () => {
    const res = await req(server, PAGE.listUrl({ tenantId, limit: 50 }));
    const details = await Promise.all(res.body.map((r) => req(server, PAGE.detailUrl(r.turn_id, tenantId))));

    let sawNullTools = false, sawEmptyTools = false, sawAborted = false, sawFailed = false, sawTruncated = false;
    for (const d of details) {
      assert.equal(d.status, 200);
      const t = d.body;
      const blocks = [
        PAGE.metaHtml(t), PAGE.stagesHtml(t.stage_timings), PAGE.retrievalHtml(t.retrieval),
        PAGE.promptHtml(t.prompt), PAGE.llmHtml(t.llm), PAGE.toolCallsHtml(t.tool_calls),
        PAGE.errorHtml(t.error),
      ].join('');
      assert.doesNotMatch(blocks, /undefined|NaN|\[object Object\]/,
        `a renderer leaked a placeholder for turn ${t.turn_id}`);

      if (t.tool_calls === null) sawNullTools = true;
      if (Array.isArray(t.tool_calls) && t.tool_calls.length === 0) sawEmptyTools = true;
      if (t.error && t.error.outcome === 'aborted') sawAborted = true;
      if (t.error && t.error.outcome !== 'aborted') sawFailed = true;
      if (/truncated at/.test(blocks)) sawTruncated = true;
    }

    // Non-vacuity: the fixtures really do reach every branch this page has, so
    // a green run means the branches were exercised, not skipped.
    assert.ok(sawNullTools, 'no fixture exercised tool_calls = null');
    assert.ok(sawEmptyTools, 'no fixture exercised tool_calls = []');
    assert.ok(sawAborted, 'no fixture exercised the abort envelope');
    assert.ok(sawFailed, 'no fixture exercised the failure envelope');
    assert.ok(sawTruncated, 'no fixture exercised free-text truncation');
  });
});

// ── The seed script's guards ────────────────────────────────────────────────
// Any seed this session adds MUST carry the production refusal, and a refusal
// that has never been shown to refuse is not a refusal.
describe('seed-turn-traces guards', () => {
  it('refuses production outright, and a non-local host without the flag', () => {
    const realExit = process.exit;
    const realErr = console.error;
    const realEnv = process.env.NODE_ENV;
    const calls = [];
    process.exit = (code) => { throw new Error('EXIT:' + code); };
    console.error = (m) => calls.push(String(m));
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => seed.assertNotProduction(), /EXIT:1/,
        'NODE_ENV=production must refuse, and no flag may override it');
      assert.ok(calls.some((c) => /NODE_ENV=production/.test(c)));

      process.env.NODE_ENV = 'test';
      assert.doesNotThrow(() => seed.assertNotProduction());

      // The host guard asserts on the PARSED target, so a socket path and a
      // bare host both read as local, and a remote host refuses.
      calls.length = 0;
      assert.throws(() => seed.assertLocalHost({ host: 'db.example.com', isLocal: false }, false), /EXIT:1/);
      assert.ok(calls.some((c) => /is not local/.test(c)));
      assert.doesNotThrow(() => seed.assertLocalHost({ host: 'localhost', isLocal: true }, false));
    } finally {
      process.exit = realExit;
      console.error = realErr;
      process.env.NODE_ENV = realEnv;
    }
  });

  it('never manufactures a trace on the channel that spends an owner\'s budget', () => {
    // testTurnService counts channel='test' rows created today as the portal's
    // daily "Test your receptionist" allowance. A seeded row there would spend
    // a real clinic owner's quota.
    const channels = new Set(seed.fixtures(null).map((f) => f.channel));
    assert.deepEqual([...channels].sort(), ['voice', 'whatsapp']);
    assert.ok(!channels.has('test'));
  });
});
