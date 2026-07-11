'use strict';

// ============================================================
//  Minimal, forward-only migration runner (node/pg, no deps).
//
//  Three commands, wired as npm scripts:
//    db:genesis  — bootstrap a FRESH database from schema.sql and stamp
//                  every file in migrations/ as already-applied. Refuses to
//                  run on a non-empty database.
//    db:migrate  — apply pending migrations in order, each in its own
//                  transaction. On a pre-existing database that has no
//                  tracking table yet, ADOPTS it in place (stamps the
//                  current migrations without executing them).
//    db:status   — print applied (stamped vs run) + pending, and WARN on any
//                  applied file whose checksum no longer matches disk.
//                  Exit 0 when nothing is pending, nonzero otherwise.
//
//  Design notes:
//   • Forward-only. No down-migrations — recovery is a restore from backup.
//     This matches the greenfield, no-prod-yet posture.
//   • schema.sql is the maintained fresh-install DDL and MUST stay in lockstep
//     with migrations/ (every migration PR updates schema.sql). Genesis trusts
//     schema.sql; it never replays 001–019 on a fresh DB.
//   • Never auto-runs on server boot — explicit invocation only. (A future
//     Railway release-command `npm run db:migrate` is the intended prod hook,
//     but it is deliberately NOT wired here.)
//   • Migrations must be plain DDL: no BEGIN/COMMIT of their own (the runner
//     wraps each file in one transaction) and no CREATE INDEX CONCURRENTLY.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

const CREATE_TRACKING = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stamped     BOOLEAN NOT NULL DEFAULT FALSE
  )`;

// Idempotent stamp — used by genesis and dev-DB adoption, where a filename may
// already be recorded (re-run safety).
const STAMP_SQL =
  `INSERT INTO schema_migrations (filename, checksum, stamped) VALUES ($1, $2, $3)
   ON CONFLICT (filename) DO NOTHING`;

// A genuine apply records a fresh row and must not silently swallow a conflict
// (pending excludes anything already recorded, so a conflict here is a real bug).
const RECORD_SQL =
  `INSERT INTO schema_migrations (filename, checksum, stamped) VALUES ($1, $2, FALSE)`;

// sha256 of the file, with CRLF normalised to LF so checksums are stable
// across OSes / git autocrlf (edited-after-apply detection, not tamper-proofing).
function checksum(text) {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

// List *.sql migrations, numeric-aware by the leading integer so mixed padding
// (002 vs 19) still orders correctly; non-.sql files (README, etc.) are ignored.
function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return { filename: f, sql, checksum: checksum(sql), n: parseInt(f, 10) };
    })
    .sort((a, b) => {
      if (Number.isNaN(a.n) || Number.isNaN(b.n)) return a.filename.localeCompare(b.filename);
      return (a.n - b.n) || a.filename.localeCompare(b.filename);
    });
}

function makeClient(connectionString) {
  return new Client({
    connectionString: connectionString || process.env.DATABASE_URL,
    // Mirror src/db/db.js: SSL only in production.
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

// True if ANY base table other than our own tracking table exists, in any
// non-system schema. Deliberately broad: the "empty database" guard must catch
// any user table, not just the ones this schema happens to know about.
async function hasUserTables(client) {
  const { rows } = await client.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
      AND table_name <> 'schema_migrations'
    LIMIT 1`);
  return rows.length > 0;
}

async function trackingExists(client) {
  const { rows } = await client.query(`SELECT to_regclass('schema_migrations') AS reg`);
  return rows[0].reg !== null;
}

// ── db:genesis ──────────────────────────────────────────────
// Fresh DB only: apply schema.sql, create tracking, stamp every migration.
// Whole thing is one transaction, so a failure leaves the DB untouched.
async function genesis(opts = {}) {
  const { connectionString, migrationsDir = MIGRATIONS_DIR, schemaFile = SCHEMA_FILE, logger = console } = opts;
  const client = makeClient(connectionString);
  await client.connect();
  try {
    if (await hasUserTables(client)) {
      logger.error('✗ genesis refused: database is not empty (user tables present).');
      logger.error('  Genesis only bootstraps a fresh database. Use `db:migrate` to advance an existing one.');
      return { ok: false, reason: 'non-empty' };
    }
    const migrations = listMigrations(migrationsDir);
    const schemaSql = fs.readFileSync(schemaFile, 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(schemaSql);
      await client.query(CREATE_TRACKING);
      for (const m of migrations) {
        await client.query(STAMP_SQL, [m.filename, m.checksum, true]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
    logger.log(`✓ genesis complete: applied schema.sql and stamped ${migrations.length} migration(s) as applied.`);
    return { ok: true, stamped: migrations.map((m) => m.filename) };
  } finally {
    await client.end();
  }
}

// ── db:migrate ──────────────────────────────────────────────
async function migrate(opts = {}) {
  const { connectionString, migrationsDir = MIGRATIONS_DIR, logger = console } = opts;
  const client = makeClient(connectionString);
  await client.connect();
  try {
    await client.query(CREATE_TRACKING); // idempotent — safe after a killed run
    const migrations = listMigrations(migrationsDir);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const recorded = new Set(rows.map((r) => r.filename));

    // No tracking rows yet → either adopt an existing DB, or refuse an empty one.
    if (recorded.size === 0) {
      if (await hasUserTables(client)) {
        // Existing dev/prod DB adopting tracking in place: the objects already
        // exist, so STAMP every current migration, never execute them.
        for (const m of migrations) {
          await client.query(STAMP_SQL, [m.filename, m.checksum, true]);
        }
        logger.log(`✓ adopted existing database into tracking: stamped ${migrations.length} migration(s) (none executed).`);
        return { ok: true, adopted: true, applied: [], stamped: migrations.map((m) => m.filename) };
      }
      logger.error('✗ migrate refused: empty database with no migration tracking.');
      logger.error('  Run `npm run db:genesis` to bootstrap a fresh database from schema.sql.');
      return { ok: false, reason: 'empty-no-genesis' };
    }

    // Normal path: apply pending in filename order, each in its own transaction.
    const pending = migrations.filter((m) => !recorded.has(m.filename));
    if (pending.length === 0) {
      logger.log('✓ no pending migrations.');
      return { ok: true, adopted: false, applied: [] };
    }
    const applied = [];
    for (const m of pending) {
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(RECORD_SQL, [m.filename, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.filename);
        logger.log(`  ✓ applied ${m.filename}`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(`✗ migration failed: ${m.filename}`);
        logger.error(`  ${e.message}`);
        return { ok: false, adopted: false, applied, failed: m.filename, error: e.message };
      }
    }
    logger.log(`✓ applied ${applied.length} migration(s).`);
    return { ok: true, adopted: false, applied };
  } finally {
    await client.end();
  }
}

// ── db:status ───────────────────────────────────────────────
async function status(opts = {}) {
  const { connectionString, migrationsDir = MIGRATIONS_DIR, logger = console } = opts;
  const client = makeClient(connectionString);
  await client.connect();
  try {
    const migrations = listMigrations(migrationsDir);
    const byName = new Map(migrations.map((m) => [m.filename, m]));

    let recorded = [];
    if (await trackingExists(client)) {
      const { rows } = await client.query(
        'SELECT filename, checksum, applied_at, stamped FROM schema_migrations');
      recorded = rows;
    }
    const recordedNames = new Set(recorded.map((r) => r.filename));

    // Order the applied rows the same numeric-aware way as the files.
    const order = new Map(migrations.map((m, i) => [m.filename, i]));
    recorded.sort((a, b) => {
      const ai = order.has(a.filename) ? order.get(a.filename) : Number.MAX_SAFE_INTEGER;
      const bi = order.has(b.filename) ? order.get(b.filename) : Number.MAX_SAFE_INTEGER;
      return (ai - bi) || a.filename.localeCompare(b.filename);
    });

    const pending = migrations.filter((m) => !recordedNames.has(m.filename));
    const mismatches = recorded.filter((r) => byName.has(r.filename) && byName.get(r.filename).checksum !== r.checksum)
      .map((r) => r.filename);
    const missingOnDisk = recorded.filter((r) => !byName.has(r.filename)).map((r) => r.filename);

    // ── render ──
    logger.log(`Applied (${recorded.length}):`);
    for (const r of recorded) {
      const tag = r.stamped ? 'stamped' : 'run    ';
      const when = (r.applied_at instanceof Date) ? r.applied_at.toISOString() : String(r.applied_at);
      logger.log(`  [${tag}] ${r.filename.padEnd(40)} ${when}`);
    }
    logger.log(`Pending (${pending.length}):`);
    for (const m of pending) logger.log(`  [pending] ${m.filename}`);

    if (mismatches.length) {
      logger.error(`⚠ checksum mismatch — edited after apply (${mismatches.length}):`);
      for (const f of mismatches) logger.error(`  ${f}`);
    }
    if (missingOnDisk.length) {
      logger.error(`⚠ recorded but missing on disk (${missingOnDisk.length}):`);
      for (const f of missingOnDisk) logger.error(`  ${f}`);
    }

    return {
      applied: recorded.map((r) => ({ filename: r.filename, stamped: r.stamped, checksumOk: !mismatches.includes(r.filename) })),
      pending: pending.map((m) => m.filename),
      mismatches,
      missingOnDisk,
      hasPending: pending.length > 0,
    };
  } finally {
    await client.end();
  }
}

async function main(argv) {
  const cmd = argv[2];
  try {
    if (cmd === 'genesis') {
      const r = await genesis();
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === 'migrate') {
      const r = await migrate();
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === 'status') {
      const r = await status();
      process.exitCode = r.hasPending ? 1 : 0;
    } else {
      console.error('usage: node src/db/migrate.js <genesis|migrate|status>');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('✗ ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  require('dotenv').config();
  main(process.argv);
}

module.exports = { genesis, migrate, status, main, checksum, listMigrations, hasUserTables, trackingExists, makeClient, CREATE_TRACKING };
