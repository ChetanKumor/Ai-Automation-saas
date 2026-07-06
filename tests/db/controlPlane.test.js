'use strict';

// Control-plane schema tests (Issue 7 / migration 020). Like migrate.test.js,
// these run the REAL runner against throwaway scratch DATABASES on the same
// server as DATABASE_URL, so dev data is never touched. Every scratch DB is
// dropped in a finally; the suite skips entirely when DATABASE_URL is unset.
//
// Two convergence paths are proven:
//   • Path A (genesis): a fresh DB built from schema.sql has 020 STAMPED (never
//     executed) and zero pending — schema.sql is in lockstep with the migration.
//   • Path B (migrate): a fabricated pre-020 DB runs the REAL 020 file through
//     the runner, exercising the ALTER + backfill end-to-end.
// Plus the constraint behaviours: status CHECK, UNIQUE(tenant_id, version),
// ON DELETE CASCADE, and the validation_runs insert/ordered-read.

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
const MIG_020 = '020_control_plane.sql';

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

async function withScratch(fn) {
  const name = 'zyon_test_' + crypto.randomBytes(6).toString('hex');
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
  const r = await exec(cs, `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column]);
  return r.rowCount > 0;
}
async function newTenant(cs, active = true) {
  const r = await exec(cs, `INSERT INTO tenants (business_name, active) VALUES ('T', $1) RETURNING id`, [active]);
  return r.rows[0].id;
}

// Sweep any scratch DBs left by a crashed run (shared with migrate.test.js).
async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon_test_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

describe('control-plane schema (migration 020)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  before(sweep);
  after(sweep);

  // ── Path A: genesis convergence (lockstep proof) ──────────────
  it('Path A — genesis from schema.sql: 020 stamped (never executed), zero pending, four objects present', async () => {
    await withScratch(async ({ cs }) => {
      const g = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(g.ok, true, 'genesis succeeded');

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'zero pending after genesis');
      const row = s.applied.find((a) => a.filename === MIG_020);
      assert.ok(row, '020 recorded');
      assert.equal(row.stamped, true, '020 stamped, not executed (genesis trusts schema.sql)');
      assert.equal(s.mismatches.length, 0, 'no checksum mismatches');

      // The four objects exist purely from schema.sql (lockstep).
      assert.ok(await tableExists(cs, 'tenant_configs'), 'tenant_configs');
      assert.ok(await tableExists(cs, 'tenant_config_revisions'), 'tenant_config_revisions');
      assert.ok(await tableExists(cs, 'validation_runs'), 'validation_runs');
      assert.ok(await columnExists(cs, 'tenants', 'status'), 'tenants.status');

      // tenant_configs is one-row-per-tenant (tenant_id is the PK).
      const pk = await exec(cs, `
        SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'tenant_configs'::regclass AND i.indisprimary`);
      assert.deepEqual(pk.rows.map((r) => r.attname), ['tenant_id'], 'tenant_configs PK is tenant_id');
    });
  });

  // ── Path B: migrate path runs the REAL 020 file (ALTER + backfill) ──
  it('Path B — migrate applies the real 020 file: creates objects and backfills status from active', async () => {
    await withScratch(async ({ cs }) => {
      // Fabricate a pre-020 database: apply the real schema, then strip exactly
      // the objects 020 introduces so 020 has real work to do.
      await exec(cs, fs.readFileSync(REAL_SCHEMA, 'utf8'));
      await exec(cs, `
        DROP TABLE validation_runs;
        DROP TABLE tenant_config_revisions;
        DROP TABLE tenant_configs;
        ALTER TABLE tenants DROP COLUMN status;`);

      // Stamp every migration EXCEPT 020, so 020 is the lone pending file and the
      // runner actually executes it (rather than adopting the whole DB).
      await exec(cs, runner.CREATE_TRACKING);
      for (const m of runner.listMigrations(REAL_MIGRATIONS)) {
        if (m.filename === MIG_020) continue;
        await exec(cs, `INSERT INTO schema_migrations (filename, checksum, stamped) VALUES ($1,$2,true)`, [m.filename, m.checksum]);
      }

      // Pre-existing tenants with mixed active flags to exercise the backfill.
      await exec(cs, `INSERT INTO tenants (business_name, active) VALUES ('Alpha', true), ('Beta', false), ('Gamma', true)`);

      const m = await runner.migrate({ connectionString: cs, logger: SILENT });
      assert.equal(m.ok, true, 'migrate succeeded');
      assert.deepEqual(m.applied, [MIG_020], 'only 020 was applied');

      // Objects now exist, and 020 is recorded as run (not stamped).
      assert.ok(await tableExists(cs, 'tenant_configs'));
      assert.ok(await tableExists(cs, 'tenant_config_revisions'));
      assert.ok(await tableExists(cs, 'validation_runs'));
      assert.ok(await columnExists(cs, 'tenants', 'status'));
      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'clean after migrate');
      assert.equal(s.applied.find((a) => a.filename === MIG_020).stamped, false, '020 recorded as run');

      // Backfill: active → 'live', inactive → 'paused'; no 'draft' left behind.
      const dist = await exec(cs, `SELECT business_name, active, status FROM tenants ORDER BY business_name`);
      const byName = Object.fromEntries(dist.rows.map((r) => [r.business_name, r]));
      assert.equal(byName.Alpha.status, 'live', 'active tenant → live');
      assert.equal(byName.Beta.status, 'paused', 'inactive tenant → paused');
      assert.equal(byName.Gamma.status, 'live', 'active tenant → live');
      const drafts = await exec(cs, `SELECT count(*)::int AS n FROM tenants WHERE status = 'draft'`);
      assert.equal(drafts.rows[0].n, 0, 'no draft rows after backfill');
    });
  });

  // ── Constraint behaviours (on a genesis'd scratch DB) ──────────
  it('status CHECK rejects an invalid value; the four lifecycle values are accepted', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });

      await assert.rejects(
        exec(cs, `INSERT INTO tenants (business_name, status) VALUES ('Bad', 'archived')`),
        /tenants_status_check|check constraint/i,
        'invalid status rejected',
      );
      for (const v of ['draft', 'validated', 'live', 'paused']) {
        await exec(cs, `INSERT INTO tenants (business_name, status) VALUES ($1, $2)`, ['ok', v]);
      }
      const n = await exec(cs, `SELECT count(*)::int AS n FROM tenants WHERE status IN ('draft','validated','live','paused')`);
      assert.equal(n.rows[0].n, 4, 'all four lifecycle values accepted');
    });
  });

  it('UNIQUE (tenant_id, version) rejects a duplicate revision', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      const t = await newTenant(cs);

      await exec(cs, `INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1, 1, '{}', 'provision')`, [t]);
      await assert.rejects(
        exec(cs, `INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1, 1, '{}', 'admin')`, [t]),
        /unique|duplicate key/i,
        'duplicate (tenant_id, version) rejected',
      );
      // A different version for the same tenant is fine (append-only history).
      await exec(cs, `INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1, 2, '{}', 'cli')`, [t]);
      const n = await exec(cs, `SELECT count(*)::int AS n FROM tenant_config_revisions WHERE tenant_id=$1`, [t]);
      assert.equal(n.rows[0].n, 2);
    });
  });

  it('ON DELETE CASCADE removes config, revisions, and validation runs with the tenant', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      const t = await newTenant(cs);

      await exec(cs, `INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1, 1, '{"k":1}')`, [t]);
      await exec(cs, `INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1, 1, '{}', 'provision'), ($1, 2, '{}', 'admin')`, [t]);
      await exec(cs, `INSERT INTO validation_runs (tenant_id, passed, result) VALUES ($1, true, '{}'), ($1, false, '{}')`, [t]);

      await exec(cs, `DELETE FROM tenants WHERE id=$1`, [t]);

      for (const tbl of ['tenant_configs', 'tenant_config_revisions', 'validation_runs']) {
        const r = await exec(cs, `SELECT count(*)::int AS n FROM ${tbl} WHERE tenant_id=$1`, [t]);
        assert.equal(r.rows[0].n, 0, `${tbl} rows cascaded away`);
      }
    });
  });

  it('validation_runs: insert + ordered read (newest first)', async () => {
    await withScratch(async ({ cs }) => {
      await runner.genesis({ connectionString: cs, logger: SILENT });
      const t = await newTenant(cs);

      // Explicit, distinct created_at so the DESC ordering is deterministic.
      await exec(cs, `INSERT INTO validation_runs (tenant_id, passed, result, created_at)
                        VALUES ($1, false, '{"check":"old"}',  now() - interval '1 hour'),
                               ($1, true,  '{"check":"new"}',  now())`, [t]);

      const r = await exec(cs, `SELECT passed, result->>'check' AS which FROM validation_runs
                                 WHERE tenant_id=$1 ORDER BY created_at DESC`, [t]);
      assert.deepEqual(r.rows.map((x) => x.which), ['new', 'old'], 'newest first');
      assert.equal(r.rows[0].passed, true, 'latest run carried its passed flag');
    });
  });
});
