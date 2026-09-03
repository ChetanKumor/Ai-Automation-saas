'use strict';

// Platform actor storage (ADMIN-S3b / migration 031, D-022). Same shape as
// controlPlane.test.js: the REAL runner against throwaway scratch DATABASES on
// the same server as DATABASE_URL, so dev data is never touched. Every scratch
// DB is dropped in a finally; the suite skips entirely when DATABASE_URL is unset.
//
// Two convergence paths, because the lockstep rule has two directions:
//   • Path A (genesis): a fresh DB built from schema.sql alone has 031 STAMPED
//     (never executed) and zero pending — schema.sql already contains everything
//     the migration would have added.
//   • Path B (migrate): a fabricated pre-031 DB runs the REAL 031 file through
//     the runner, exercising CREATE TABLE + both ALTERs end to end.
//
// Plus the constraint behaviours that carry the design: the role CHECK that
// reserves 'support' without anything reading it, the at-most-one-actor CHECK on
// both audit tables, and — the one that is an INVARIANT rather than a detail —
// that platform_users has NO tenant_id. D-022 chose a separate table precisely so
// "platform actor" is unrepresentable inside tenant scope by construction; a
// tenant_id appearing here later would silently undo that, and this file is where
// that would be caught.

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const REAL_SCHEMA = path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
const REAL_MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
const MIG_031 = '031_platform_actors.sql';

const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function dropDb(name) {
  const c = admin();
  await c.connect();
  try {
    await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    await c.query('DROP DATABASE IF EXISTS ' + name);
  } finally { await c.end(); }
}

// Scratch-DB prefix — MUST be disjoint from every other suite's prefix.
// node --test runs files concurrently; a shared prefix lets one file's sweep
// DROP another file's live scratch DB mid-test. Each file sweeps ONLY its own.
const SCRATCH_PREFIX = 'zyon_test_pa_';

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

async function tableExists(cs, table) {
  const r = await exec(cs, `SELECT to_regclass($1) AS reg`, [table]);
  return r.rows[0].reg !== null;
}
async function columnExists(cs, table, column) {
  const r = await exec(cs,
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column]);
  return r.rowCount > 0;
}
async function rejects(cs, sql, params) {
  try {
    await exec(cs, sql, params);
    return null;                       // no error — the caller asserts on this
  } catch (e) {
    return e.code || e.message;
  }
}

// A tenant + an owner user, for the actor columns that reference users(id).
async function seedTenantUser(cs) {
  const t = await exec(cs, `INSERT INTO tenants (business_name) VALUES ('T') RETURNING id`);
  const tenantId = t.rows[0].id;
  const u = await exec(cs,
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,'o@x.test','h','owner') RETURNING id`,
    [tenantId]);
  return { tenantId, userId: u.rows[0].id };
}
async function seedOperator(cs, email = 'ops@veprio.test') {
  const r = await exec(cs, `INSERT INTO platform_users (email) VALUES ($1) RETURNING id, role`, [email]);
  return r.rows[0];
}

// Strip exactly what 031 introduces, so the migration has real work to do.
const STRIP_031 = `
  ALTER TABLE tenant_config_revisions DROP CONSTRAINT tenant_config_revisions_one_actor;
  ALTER TABLE tenant_config_revisions DROP COLUMN actor_platform_user_id;
  ALTER TABLE validation_runs DROP CONSTRAINT validation_runs_one_actor;
  ALTER TABLE validation_runs DROP COLUMN actor_user_id;
  ALTER TABLE validation_runs DROP COLUMN actor_platform_user_id;
  DROP TABLE platform_users;
`;

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_pa\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

describe('platform actor storage (migration 031)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  before(sweep);
  after(sweep);

  // ── Path A: genesis convergence (lockstep proof) ──────────────
  it('Path A — genesis from schema.sql: 031 stamped (never executed), zero pending, all three objects present', async () => {
    await withScratch(async ({ cs }) => {
      const g = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(g.ok, true, 'genesis succeeded');

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'zero pending after genesis');
      const row = s.applied.find((a) => a.filename === MIG_031);
      assert.ok(row, '031 recorded');
      assert.equal(row.stamped, true, '031 stamped, not executed (genesis trusts schema.sql)');
      assert.equal(s.mismatches.length, 0, 'no checksum mismatches');

      // All three exist purely from schema.sql — that IS the lockstep claim.
      assert.ok(await tableExists(cs, 'platform_users'), 'platform_users');
      assert.ok(await columnExists(cs, 'tenant_config_revisions', 'actor_platform_user_id'),
        'tenant_config_revisions.actor_platform_user_id');
      assert.ok(await columnExists(cs, 'validation_runs', 'actor_user_id'),
        'validation_runs.actor_user_id');
      assert.ok(await columnExists(cs, 'validation_runs', 'actor_platform_user_id'),
        'validation_runs.actor_platform_user_id');
    });
  });

  // ── Path B: migrate path runs the REAL 031 file ──────────────
  it('Path B — migrate applies the real 031 file: creates the table and both actor pairs', async () => {
    await withScratch(async ({ cs }) => {
      // Fabricate a pre-031 database: apply the real schema, then strip exactly
      // the objects 031 introduces.
      await exec(cs, fs.readFileSync(REAL_SCHEMA, 'utf8'));
      await exec(cs, STRIP_031);
      assert.equal(await tableExists(cs, 'platform_users'), false, 'stripped: no platform_users');
      assert.equal(await columnExists(cs, 'validation_runs', 'actor_user_id'), false, 'stripped');

      // Adopt into tracking, then un-record 031 so it is the ONLY pending file.
      await runner.migrate({ connectionString: cs, migrationsDir: REAL_MIGRATIONS, logger: SILENT });
      await exec(cs, `DELETE FROM schema_migrations WHERE filename = $1`, [MIG_031]);

      const m = await runner.migrate({ connectionString: cs, migrationsDir: REAL_MIGRATIONS, logger: SILENT });
      assert.equal(m.ok, true, 'migrate succeeded');
      assert.deepEqual(m.applied, [MIG_031], 'applied exactly 031, executed not stamped');

      assert.ok(await tableExists(cs, 'platform_users'), 'platform_users created by the migration');
      assert.ok(await columnExists(cs, 'tenant_config_revisions', 'actor_platform_user_id'));
      assert.ok(await columnExists(cs, 'validation_runs', 'actor_user_id'));
      assert.ok(await columnExists(cs, 'validation_runs', 'actor_platform_user_id'));

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'zero pending afterwards');
    });
  });

  // ── INV-1 / I2: the property the separate table exists to provide ──
  it('platform_users has NO tenant_id — a platform actor is unrepresentable inside tenant scope', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });

      // EXISTENCE FIRST, and this line is load-bearing. Without it the whole
      // test passes vacuously against a database that has no platform_users at
      // all: columnExists() is false for a missing table exactly as it is for a
      // table without the column, and the FK query returns zero rows for both.
      // Caught by the red-check — this was the one test of the eight that stayed
      // green against the reverted schema, and it is the test guarding the
      // session's central invariant. An assertion that cannot fail is not one.
      assert.ok(await tableExists(cs, 'platform_users'), 'platform_users exists');

      assert.equal(await columnExists(cs, 'platform_users', 'tenant_id'), false,
        'platform_users must never acquire a tenant_id (D-022 / INV-1)');

      // Nothing on this table may reference tenants, by any column name — a
      // differently-named FK would reintroduce tenant scope just as effectively.
      const fks = await exec(cs, `
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'platform_users' AND con.contype = 'f'`);
      assert.deepEqual(fks.rows, [], 'platform_users has no foreign keys at all');
    });
  });

  // ── the role column that nothing reads ──
  it("role defaults to 'operator' and the CHECK reserves 'support', rejecting anything else", async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });

      const op = await seedOperator(cs, 'a@veprio.test');
      assert.equal(op.role, 'operator', "DEFAULT 'operator' — the bootstrap row needs no role argument");

      const sup = await exec(cs,
        `INSERT INTO platform_users (email, role) VALUES ('b@veprio.test','support') RETURNING role`);
      assert.equal(sup.rows[0].role, 'support', "'support' is accepted storage-side, though nothing reads it");

      const code = await rejects(cs,
        `INSERT INTO platform_users (email, role) VALUES ('c@veprio.test','admin')`);
      assert.equal(code, '23514', "an unreserved role is a CHECK violation, not a silent insert");
    });
  });

  it('email is UNIQUE — two operator rows cannot share an address', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      await seedOperator(cs, 'dup@veprio.test');
      const code = await rejects(cs, `INSERT INTO platform_users (email) VALUES ('dup@veprio.test')`);
      assert.equal(code, '23505', 'duplicate email rejected by the UNIQUE constraint');
    });
  });

  // ── at-most-one-actor, on both audit tables ──
  it('tenant_config_revisions: at most one actor — both set is rejected, each alone and neither are accepted', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      const { tenantId, userId } = await seedTenantUser(cs);
      const op = await seedOperator(cs);

      const ins = (v, u, p) => exec(cs,
        `INSERT INTO tenant_config_revisions (tenant_id, version, config, source, actor_user_id, actor_platform_user_id)
         VALUES ($1, $2, '{}', 'test', $3, $4)`, [tenantId, v, u, p]);

      // NEITHER — this is the provisioning case (source='provision' has no human
      // actor) and it must be accepted deliberately, not by accident.
      await ins(1, null, null);
      // Each alone.
      await ins(2, userId, null);
      await ins(3, null, op.id);

      const code = await rejects(cs,
        `INSERT INTO tenant_config_revisions (tenant_id, version, config, source, actor_user_id, actor_platform_user_id)
         VALUES ($1, 4, '{}', 'test', $2, $3)`, [tenantId, userId, op.id]);
      assert.equal(code, '23514', 'both actors set violates tenant_config_revisions_one_actor');

      const n = await exec(cs, `SELECT count(*)::int n FROM tenant_config_revisions WHERE tenant_id=$1`, [tenantId]);
      assert.equal(n.rows[0].n, 3, 'exactly the three accepted rows landed');
    });
  });

  it('validation_runs: the same at-most-one-actor rule on the pair it gained', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      const { tenantId, userId } = await seedTenantUser(cs);
      const op = await seedOperator(cs);

      const ins = (u, p) => exec(cs,
        `INSERT INTO validation_runs (tenant_id, passed, result, actor_user_id, actor_platform_user_id)
         VALUES ($1, true, '{}', $2, $3)`, [tenantId, u, p]);

      await ins(null, null);            // CLI/lifecycle run — no human actor
      await ins(userId, null);          // portal-triggered
      await ins(null, op.id);           // admin-triggered

      const code = await rejects(cs,
        `INSERT INTO validation_runs (tenant_id, passed, result, actor_user_id, actor_platform_user_id)
         VALUES ($1, true, '{}', $2, $3)`, [tenantId, userId, op.id]);
      assert.equal(code, '23514', 'both actors set violates validation_runs_one_actor');

      const n = await exec(cs, `SELECT count(*)::int n FROM validation_runs WHERE tenant_id=$1`, [tenantId]);
      assert.equal(n.rows[0].n, 3);
    });
  });

  // ── referential integrity: the whole reason the FK was kept (D-022) ──
  it('actor_platform_user_id is a real FK: an unknown id is refused, and deleting the operator SETs NULL', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      const { tenantId } = await seedTenantUser(cs);
      const op = await seedOperator(cs);

      // A wrong id is unverifiable at write time under the rejected bare-UUID
      // shape; under the FK it is a 23503 at the moment of the write.
      const code = await rejects(cs,
        `INSERT INTO tenant_config_revisions (tenant_id, version, config, source, actor_platform_user_id)
         VALUES ($1, 1, '{}', 'test', gen_random_uuid())`, [tenantId]);
      assert.equal(code, '23503', 'unknown platform actor rejected by the foreign key');

      await exec(cs,
        `INSERT INTO tenant_config_revisions (tenant_id, version, config, source, actor_platform_user_id)
         VALUES ($1, 1, '{}', 'test', $2)`, [tenantId, op.id]);
      await exec(cs,
        `INSERT INTO validation_runs (tenant_id, passed, result, actor_platform_user_id)
         VALUES ($1, true, '{}', $2)`, [tenantId, op.id]);

      // ON DELETE SET NULL: removing an operator must never cascade away the
      // immutable audit rows they are the actor of.
      await exec(cs, `DELETE FROM platform_users WHERE id = $1`, [op.id]);
      const rev = await exec(cs,
        `SELECT actor_platform_user_id FROM tenant_config_revisions WHERE tenant_id=$1`, [tenantId]);
      const run = await exec(cs,
        `SELECT actor_platform_user_id FROM validation_runs WHERE tenant_id=$1`, [tenantId]);
      assert.equal(rev.rows.length, 1, 'the revision survives the actor');
      assert.equal(rev.rows[0].actor_platform_user_id, null, 'revision actor SET NULL');
      assert.equal(run.rows.length, 1, 'the validation run survives the actor');
      assert.equal(run.rows[0].actor_platform_user_id, null, 'run actor SET NULL');
    });
  });
});
