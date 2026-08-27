'use strict';

// Lockstep guard for migration 028 (conversations.channel -> origin_channel).
//
// Same machinery and the same two-path shape as controlPlane.test.js: real
// runner, throwaway scratch DATABASES on the DATABASE_URL server, dropped in a
// finally, suite skipped when DATABASE_URL is unset.
//
// ── What this guards, and why it is not the general guard ────────────────────
// The drift this class of change produces is INVISIBLE. Genesis trusts
// schema.sql and never replays migrations (src/db/migrate.js:122-126), so a
// rename applied to schema.sql alone leaves every scratch-DB suite green while
// every long-lived database still carries the old column. There is no general
// schema.sql-versus-full-replay test in this repo, and one CANNOT be written as
// things stand: migration 001 is folded into schema.sql and exists as no file,
// so "replay every migration from an empty database" has no starting point.
// controlPlane.test.js:101-127 covers migration 020's four objects and nothing
// else. That gap is real and is recorded in docs/os/state.md rather than papered
// over here.
//
// What IS constructible, and what this file does, is a convergence proof for
// this one migration: build the shape from schema.sql, fabricate the pre-028
// state from it, run the REAL 028 file through the runner, and assert the two
// shapes are identical down to type, nullability and default. If a future
// session edits one side of the lockstep and not the other, this fails.

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
const MIG_028 = '028_rename_conversations_origin_channel.sql';

const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

// Scratch-DB prefix — MUST be disjoint from every other file's prefix.
// node --test runs files concurrently and each file sweeps only its own.
const SCRATCH_PREFIX = 'zyon_test_oc_';

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

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_oc\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

describe('conversations.origin_channel (migration 028)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  before(sweep);
  after(sweep);

  it('schema.sql and the real 028 file converge on the same conversations shape', async () => {
    await withScratch(async ({ cs }) => {
      // ── Path A: genesis from schema.sql ──────────────────────────────
      const g = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(g.ok, true, 'genesis succeeded');

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'zero pending after genesis');
      const row = s.applied.find((a) => a.filename === MIG_028);
      assert.ok(row, '028 recorded');
      assert.equal(row.stamped, true, '028 stamped, not executed (genesis trusts schema.sql)');
      assert.equal(s.mismatches.length, 0, 'no checksum mismatches');

      const fromSchema = await shapeOf(cs, 'conversations');
      const names = fromSchema.map((c) => c.column_name);
      assert.ok(names.includes('origin_channel'), 'schema.sql builds origin_channel');
      assert.ok(!names.includes('channel'),
        'schema.sql must NOT still build the pre-028 `channel` column');

      const oc = fromSchema.find((c) => c.column_name === 'origin_channel');
      assert.equal(oc.is_nullable, 'NO', 'NOT NULL survives the rename');
      assert.equal(oc.data_type, 'text', 'TEXT survives the rename');
      assert.match(oc.column_default, /'whatsapp'/, "DEFAULT 'whatsapp' survives the rename");

      // ── Path B: fabricate pre-028, then run the REAL migration file ──
      // Renaming back is the only way to reach the pre-028 shape: migration 001
      // is folded into schema.sql and exists as no file, so a replay from an
      // empty database has no starting point (see the header).
      await exec(cs, 'ALTER TABLE conversations RENAME COLUMN origin_channel TO channel');
      const pre = (await shapeOf(cs, 'conversations')).map((c) => c.column_name);
      assert.ok(pre.includes('channel') && !pre.includes('origin_channel'), 'pre-028 state fabricated');

      const sql = fs.readFileSync(path.join(REAL_MIGRATIONS, MIG_028), 'utf8');
      await exec(cs, sql);

      const fromMigration = await shapeOf(cs, 'conversations');
      assert.deepEqual(fromMigration, fromSchema,
        'the real 028 file reproduces exactly what schema.sql builds — lockstep');
    });
  });
});
