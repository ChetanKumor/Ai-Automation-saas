'use strict';

// Lockstep guard for migration 029 (conversation_events).
//
// Same machinery and the same two-path shape as conversationsOriginChannel.test.js
// and controlPlane.test.js: real runner, throwaway scratch DATABASES on the
// DATABASE_URL server, dropped in a finally, suite skipped when DATABASE_URL is
// unset.
//
// ── What this guards ─────────────────────────────────────────────────────────
// The drift a CREATE TABLE migration produces is as invisible as a rename's.
// Genesis trusts schema.sql and never replays migrations
// (src/db/migrate.js:122-126), so a table added to schema.sql alone leaves every
// scratch-DB suite green while every long-lived database has no such table —
// and a table added to the MIGRATION alone leaves the first production database
// (Issue 20 runs db:genesis, which executes schema.sql and stamps 002-029
// unread) missing it forever. Either half of the lockstep, broken silently.
//
// So: build the shape from schema.sql, fabricate the pre-029 state by DROPping
// the table, run the REAL 029 file through the runner, and assert the two
// shapes are identical.
//
// ── Why this asserts INDEXES and CONSTRAINTS, not only columns ───────────────
// conversationsOriginChannel.test.js compares columns alone, which is complete
// for a RENAME COLUMN — 028's header notes there was "no CHECK, no enum and no
// index on it to move". A CREATE TABLE is different: the two indexes, the four
// foreign keys with three distinct ON DELETE rules, and the actor CHECK are all
// part of what the migration must reproduce, and every one of them is invisible
// to information_schema.columns. An FK whose ON DELETE said CASCADE in one file
// and SET NULL in the other would pass a columns-only comparison and diverge
// the two databases for good.

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const REAL_MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
const MIG_029 = '029_conversation_events.sql';

const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

// Scratch-DB prefix — MUST be disjoint from every other file's prefix AND from
// every other file's sweep PATTERN. node --test runs files concurrently and a
// sweep that matched this prefix could drop this suite's database mid-genesis.
// Note the sweeps use LIKE with unescaped '_', which is a single-char wildcard:
// 'zyon_ce_' is not reachable by any of them (they all require 'test' or a
// different literal at offset 5).
const SCRATCH_PREFIX = 'zyon_ce_';

async function dropDb(name) {
  const c = admin();
  await c.connect();
  try {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    await c.query('DROP DATABASE IF EXISTS ' + name);
  } finally { await c.end(); }
}

async function withScratch(fn) {
  const name = SCRATCH_PREFIX + crypto.randomBytes(6).toString('hex');
  const c = admin();
  await c.connect();
  await c.query('CREATE DATABASE ' + name);
  await c.end();
  try {
    return await fn({ name, cs: swapDb(ADMIN, name) });
  } finally {
    await dropDb(name);
  }
}

async function exec(cs, sql, params) {
  const c = new Client({ connectionString: cs, ssl: SSL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

// Full shape of a table: name, type, nullability, default — ordinal-independent
// so a column moving position is not read as drift.
async function shapeOf(cs, table) {
  const r = await exec(cs, `
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY column_name`, [table]);
  return r.rows;
}

// Index shape: the full pg-rendered definition, which carries the column list,
// their order, DESC, uniqueness and any partial predicate. Name-only would miss
// an index built on the wrong columns.
async function indexesOf(cs, table) {
  const r = await exec(cs, `
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = $1 ORDER BY indexname`, [table]);
  return r.rows;
}

// Foreign keys with their ON DELETE rule — the half of this table's design that
// differs deliberately per column (CASCADE on the thread, SET NULL on the call).
async function fksOf(cs, table) {
  const r = await exec(cs, `
    SELECT kcu.column_name, ccu.table_name AS refs, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
     WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY kcu.column_name`, [table]);
  return r.rows;
}

// CHECK constraints, rendered. `actor` has one; `type` and `channel` must not.
async function checksOf(cs, table) {
  const r = await exec(cs, `
    SELECT pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = $1 AND con.contype = 'c'
     ORDER BY pg_get_constraintdef(con.oid)`, [table]);
  return r.rows;
}

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\_ce\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

describe('conversation_events (migration 029)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  before(sweep);
  after(sweep);

  it('schema.sql and the real 029 file converge on the same table, indexes, FKs and checks', async () => {
    await withScratch(async ({ cs }) => {
      // ── Path A: genesis from schema.sql ──────────────────────────────
      const g = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(g.ok, true, 'genesis succeeded');

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'zero pending after genesis');
      const row = s.applied.find((a) => a.filename === MIG_029);
      assert.ok(row, '029 recorded');
      assert.equal(row.stamped, true, '029 stamped, not executed (genesis trusts schema.sql)');
      assert.equal(s.mismatches.length, 0, 'no checksum mismatches');

      const colsFromSchema = await shapeOf(cs, 'conversation_events');
      assert.ok(colsFromSchema.length > 0, 'schema.sql builds conversation_events');

      // The vocabulary decision, asserted rather than assumed: `type` and
      // `channel` are unconstrained TEXT, and only `actor` is CHECKed. A future
      // session that "tidies up" by adding a CHECK to `type` has to delete this
      // line to do it, which is the point.
      const checksFromSchema = await checksOf(cs, 'conversation_events');
      assert.equal(checksFromSchema.length, 1, 'exactly one CHECK on the table');
      assert.match(checksFromSchema[0].def, /actor/, 'the one CHECK is on actor');
      assert.ok(!checksFromSchema.some((c) => /\btype\b/.test(c.def)),
        '`type` must stay unconstrained — the vocabulary is settled from real rows');
      assert.ok(!checksFromSchema.some((c) => /\bchannel\b/.test(c.def)),
        '`channel` must stay unconstrained, as turn_traces.channel is');

      const idxFromSchema = await indexesOf(cs, 'conversation_events');
      assert.deepEqual(
        idxFromSchema.map((i) => i.indexname),
        ['conversation_events_pkey',
         'idx_conversation_events_conversation',
         'idx_conversation_events_tenant_type_created'],
        'schema.sql builds the PK and both §8/P-2 indexes'
      );

      const fksFromSchema = await fksOf(cs, 'conversation_events');
      const deleteRules = Object.fromEntries(fksFromSchema.map((f) => [f.column_name, f.delete_rule]));
      assert.equal(deleteRules.conversation_id, 'CASCADE',
        'events are evidence about a thread and go with it (unlike turn_traces)');
      assert.equal(deleteRules.call_session_id, 'SET NULL',
        'a WhatsApp event has no call; a deleted call must not delete the event');
      assert.equal(deleteRules.tenant_id, 'CASCADE');
      assert.equal(deleteRules.customer_id, 'CASCADE');

      // ── Path B: fabricate pre-029, then run the REAL migration file ──
      await exec(cs, 'DROP TABLE conversation_events');
      const gone = await shapeOf(cs, 'conversation_events');
      assert.equal(gone.length, 0, 'pre-029 state fabricated');

      const sql = fs.readFileSync(path.join(REAL_MIGRATIONS, MIG_029), 'utf8');
      await exec(cs, sql);

      // ── The lockstep assertions: all four shapes, both paths ─────────
      assert.deepEqual(await shapeOf(cs, 'conversation_events'), colsFromSchema,
        'the real 029 file reproduces schema.sql\'s COLUMNS — lockstep');
      assert.deepEqual(await indexesOf(cs, 'conversation_events'), idxFromSchema,
        'the real 029 file reproduces schema.sql\'s INDEXES — lockstep');
      assert.deepEqual(await fksOf(cs, 'conversation_events'), fksFromSchema,
        'the real 029 file reproduces schema.sql\'s FOREIGN KEYS and ON DELETE rules — lockstep');
      assert.deepEqual(await checksOf(cs, 'conversation_events'), checksFromSchema,
        'the real 029 file reproduces schema.sql\'s CHECK constraints — lockstep');
    });
  });
});
