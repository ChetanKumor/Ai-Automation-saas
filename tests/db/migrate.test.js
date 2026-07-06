'use strict';

// Migration-runner tests. These exercise the real runner against throwaway
// scratch DATABASES created on the same server as DATABASE_URL (postgres is a
// superuser with CREATEDB here), so dev data is never touched. Each scratch DB
// is dropped in a finally. The whole suite skips when DATABASE_URL is unset.

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const REAL_SCHEMA = path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
const REAL_MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
const REAL_COUNT = ADMIN ? runner.listMigrations(REAL_MIGRATIONS).length : 0;

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

// Run fn with a fresh, empty scratch database; always drop it afterwards.
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

// Convenience: run a SQL statement against a connection string.
async function exec(cs, sql, params) {
  const c = new Client({ connectionString: cs, ssl: SSL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

// A self-contained fixture: trivial base schema + a controllable migrations dir.
function makeFixture(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyon-mig-'));
  const schemaFile = path.join(dir, 'schema.sql');
  fs.writeFileSync(schemaFile, 'CREATE TABLE fixture_base (id SERIAL PRIMARY KEY, note TEXT);\n');
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  for (const [name, sql] of Object.entries(initial)) fs.writeFileSync(path.join(migDir, name), sql);
  return {
    schemaFile,
    migDir,
    write: (n, s) => fs.writeFileSync(path.join(migDir, n), s),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function columnExists(cs, table, column) {
  const r = await exec(cs, `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column]);
  return r.rowCount > 0;
}
async function tableExists(cs, table) {
  const r = await exec(cs, `SELECT to_regclass($1) AS reg`, [table]);
  return r.rows[0].reg !== null;
}

describe('migration runner', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  // Sweep any scratch DBs left by a previously crashed run.
  before(async () => {
    const c = admin();
    await c.connect();
    try {
      const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon_test_%'");
      for (const r of rows) {
        await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
        await c.query('DROP DATABASE IF EXISTS ' + r.datname);
      }
    } finally { await c.end(); }
  });

  it('lists only .sql files, ordered numeric-aware (002 before 19)', () => {
    const fx = makeFixture({
      'README.md': 'not a migration',
      '002_a.sql': '-- a',
      '19_c.sql': '-- c',
      '003_b.sql': '-- b',
    });
    try {
      const names = runner.listMigrations(fx.migDir).map((m) => m.filename);
      assert.deepEqual(names, ['002_a.sql', '003_b.sql', '19_c.sql'], 'numeric order, README ignored');
    } finally { fx.cleanup(); }
  });

  it('genesis bootstraps an empty DB from schema.sql, stamps all migrations, then refuses a re-run', async () => {
    await withScratch(async ({ cs }) => {
      const g = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(g.ok, true, 'genesis succeeded');
      assert.equal(g.stamped.length, REAL_COUNT, 'stamped every migration file');

      // schema.sql actually ran (incl. the §4 call_sessions repair) and Issue 5
      // is honoured (messages has no wamid).
      assert.ok(await tableExists(cs, 'call_sessions'), 'call_sessions table created');
      assert.equal(await columnExists(cs, 'messages', 'wamid'), false, 'messages.wamid is gone');

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'nothing pending after genesis');
      assert.equal(s.pending.length, 0);
      assert.equal(s.applied.length, REAL_COUNT);
      assert.ok(s.applied.every((a) => a.stamped === true), 'all applied rows are stamped');
      assert.equal(s.mismatches.length, 0, 'no checksum mismatches');

      const again = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(again.ok, false, 'genesis refuses a second run');
      assert.equal(again.reason, 'non-empty');
    });
  });

  it('genesis refuses a non-empty database (any user table present) and creates no tracking', async () => {
    await withScratch(async ({ cs }) => {
      await exec(cs, 'CREATE TABLE stray (id INT)');
      const g = await runner.genesis({ connectionString: cs, logger: SILENT });
      assert.equal(g.ok, false);
      assert.equal(g.reason, 'non-empty');
      assert.equal(await tableExists(cs, 'schema_migrations'), false, 'no tracking table left behind');
    });
  });

  it('migrate adopts an existing DB in place: stamps every migration, executes none', async () => {
    await withScratch(async ({ cs }) => {
      // Simulate a pre-existing dev DB: full schema, but no tracking table.
      await exec(cs, fs.readFileSync(REAL_SCHEMA, 'utf8'));
      // Sentinel row that a re-execution of the backfill migrations would disturb.
      await exec(cs, `INSERT INTO tenants (id, business_name) VALUES ('11111111-1111-1111-1111-111111111111', 'Adopt Co')`);

      const m = await runner.migrate({ connectionString: cs, logger: SILENT });
      assert.equal(m.ok, true);
      assert.equal(m.adopted, true, 'adoption path taken');
      assert.equal(m.applied.length, 0, 'nothing executed');
      assert.equal(m.stamped.length, REAL_COUNT, 'every migration stamped');

      const sentinel = await exec(cs, `SELECT business_name FROM tenants WHERE id='11111111-1111-1111-1111-111111111111'`);
      assert.equal(sentinel.rows[0].business_name, 'Adopt Co', 'existing data untouched');

      const s = await runner.status({ connectionString: cs, logger: SILENT });
      assert.equal(s.hasPending, false, 'clean after adoption');
      assert.ok(s.applied.every((a) => a.stamped === true));

      const noop = await runner.migrate({ connectionString: cs, logger: SILENT });
      assert.equal(noop.adopted, false);
      assert.equal(noop.applied.length, 0, 're-migrate is a no-op');
    });
  });

  it('a new migration: pending → migrate applies it → clean → re-migrate is a no-op', async () => {
    const fx = makeFixture({ '001_base.sql': 'ALTER TABLE fixture_base ADD COLUMN col1 TEXT;\n' });
    try {
      await withScratch(async ({ cs }) => {
        await runner.genesis({ connectionString: cs, migrationsDir: fx.migDir, schemaFile: fx.schemaFile, logger: SILENT });

        fx.write('002_addcol.sql', 'ALTER TABLE fixture_base ADD COLUMN col2 TEXT;\n');

        let s = await runner.status({ connectionString: cs, migrationsDir: fx.migDir, logger: SILENT });
        assert.deepEqual(s.pending, ['002_addcol.sql'], 'the new file is pending');
        assert.equal(s.hasPending, true);

        const m = await runner.migrate({ connectionString: cs, migrationsDir: fx.migDir, logger: SILENT });
        assert.deepEqual(m.applied, ['002_addcol.sql'], 'applied the pending file');
        assert.equal(await columnExists(cs, 'fixture_base', 'col2'), true, 'migration actually ran');

        s = await runner.status({ connectionString: cs, migrationsDir: fx.migDir, logger: SILENT });
        assert.equal(s.hasPending, false, 'clean after apply');
        // The run migration is recorded as run (not stamped).
        assert.equal(s.applied.find((a) => a.filename === '002_addcol.sql').stamped, false);

        const noop = await runner.migrate({ connectionString: cs, migrationsDir: fx.migDir, logger: SILENT });
        assert.equal(noop.applied.length, 0, 're-migrate is a no-op');
      });
    } finally { fx.cleanup(); }
  });

  it('a failing migration rolls back its transaction and records nothing', async () => {
    const fx = makeFixture({ '001_base.sql': 'ALTER TABLE fixture_base ADD COLUMN col1 TEXT;\n' });
    try {
      await withScratch(async ({ cs }) => {
        await runner.genesis({ connectionString: cs, migrationsDir: fx.migDir, schemaFile: fx.schemaFile, logger: SILENT });

        // Valid statement first, then a syntax error — proves the whole file is
        // one atomic transaction (the good CREATE must not survive).
        fx.write('050_bad.sql', 'CREATE TABLE should_not_exist (id INT);\nTHIS IS NOT VALID SQL;\n');

        const m = await runner.migrate({ connectionString: cs, migrationsDir: fx.migDir, logger: SILENT });
        assert.equal(m.ok, false, 'migrate reports failure');
        assert.equal(m.failed, '050_bad.sql', 'names the failing file');
        assert.ok(m.error && m.error.length, 'names the SQL error');

        assert.equal(await tableExists(cs, 'should_not_exist'), false, 'rolled back — no partial effect');
        const rec = await exec(cs, `SELECT 1 FROM schema_migrations WHERE filename='050_bad.sql'`);
        assert.equal(rec.rowCount, 0, 'nothing recorded for the failed file');
      });
    } finally { fx.cleanup(); }
  });

  it('status WARNs on a checksum mismatch (edited after apply)', async () => {
    const fx = makeFixture({ '001_base.sql': 'ALTER TABLE fixture_base ADD COLUMN col1 TEXT;\n' });
    try {
      await withScratch(async ({ cs }) => {
        await runner.genesis({ connectionString: cs, migrationsDir: fx.migDir, schemaFile: fx.schemaFile, logger: SILENT });

        // Edit the already-applied file on disk.
        fx.write('001_base.sql', 'ALTER TABLE fixture_base ADD COLUMN col1 TEXT; -- edited after apply\n');

        const errs = [];
        const capture = { log() {}, error: (...a) => errs.push(a.join(' ')) };
        const s = await runner.status({ connectionString: cs, migrationsDir: fx.migDir, logger: capture });

        assert.deepEqual(s.mismatches, ['001_base.sql'], 'mismatch detected');
        assert.ok(errs.some((l) => /checksum mismatch/i.test(l)), 'WARN surfaced');
      });
    } finally { fx.cleanup(); }
  });

  it('CLI exit codes via main(): clean → 0, pending → nonzero, migrate → 0', async () => {
    await withScratch(async ({ cs }) => {
      // main() reads DATABASE_URL and drives the real process.exitCode wiring.
      const savedUrl = process.env.DATABASE_URL;
      const savedExit = process.exitCode;
      process.env.DATABASE_URL = cs;
      try {
        await runner.genesis({ connectionString: cs, logger: SILENT });

        process.exitCode = undefined;
        await runner.main(['node', 'migrate.js', 'status']);
        assert.equal(process.exitCode, 0, 'clean status exits 0');

        // Simulate a pending migration by forgetting the last one. 019 is
        // idempotent (DROP COLUMN IF EXISTS wamid), so re-applying it is safe.
        await exec(cs, `DELETE FROM schema_migrations WHERE filename='019_drop_wamid.sql'`);

        process.exitCode = undefined;
        await runner.main(['node', 'migrate.js', 'status']);
        assert.equal(process.exitCode, 1, 'pending status exits nonzero');

        process.exitCode = undefined;
        await runner.main(['node', 'migrate.js', 'migrate']);
        assert.equal(process.exitCode, 0, 'migrate applied the pending file, exits 0');

        process.exitCode = undefined;
        await runner.main(['node', 'migrate.js', 'status']);
        assert.equal(process.exitCode, 0, 'clean again after migrate');
      } finally {
        process.env.DATABASE_URL = savedUrl;
        process.exitCode = savedExit;
      }
    });
  });

  after(async () => {
    // Final safety sweep.
    const c = admin();
    await c.connect();
    try {
      const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon_test_%'");
      for (const r of rows) {
        await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
        await c.query('DROP DATABASE IF EXISTS ' + r.datname);
      }
    } finally { await c.end(); }
  });
});
