'use strict';

// Trace retention (Issue 22) — daily cron deleting turn_traces older than each
// tenant's `retention_days` (tenant config, default 365 for tenants with no
// config document). Same advisory-lock idiom as reminderCron/collectionsCron:
// pg_try_advisory_lock guards against a double-run, the lock is released in a
// finally, and a tick failure only logs. Probe traces (probe_ correlation
// prefix) are NOT special-cased — they age out like everything else.

const cron = require('node-cron');
const logger = require('../../infra/logging/logger');
const db = require('../../db/db');
const { clinicDefaults } = require('../config/defaults');

const LOCK_KEY = 770_203; // reminder=770_202, collections=770_201

// The canonical default lives in the config layer — a config-less tenant must
// age out on the same window a defaulted config document would produce.
const DEFAULT_RETENTION_DAYS = clinicDefaults.retention_days;

// The ONE definition of a tenant's retention window and of "expired" —
// DELETE_SQL and PREVIEW_SQL are built from it so the dry-run twin can never
// drift from what the tick actually deletes.
const WINDOW_DAYS_SQL = `COALESCE((tc.config->>'retention_days')::int, ${DEFAULT_RETENTION_DAYS})`;
const EXPIRED_SQL = `tt.created_at < NOW() - make_interval(days => ${WINDOW_DAYS_SQL})`;

// One statement, per-tenant cutoff: every trace joins its tenant's config
// (LEFT — tenants without a config doc use the default) and dies when older
// than that tenant's window.
const DELETE_SQL = `
  DELETE FROM turn_traces tt
  USING tenants t
  LEFT JOIN tenant_configs tc ON tc.tenant_id = t.id
  WHERE tt.tenant_id = t.id
    AND ${EXPIRED_SQL}`;

// Dry-run twin: counts what a tick WOULD delete, per tenant. Read-only —
// used for operator evidence, takes no lock.
const PREVIEW_SQL = `
  SELECT tt.tenant_id,
         ${WINDOW_DAYS_SQL} AS retention_days,
         count(*)::int AS expired
  FROM turn_traces tt
  JOIN tenants t ON t.id = tt.tenant_id
  LEFT JOIN tenant_configs tc ON tc.tenant_id = t.id
  WHERE ${EXPIRED_SQL}
  GROUP BY tt.tenant_id, retention_days
  ORDER BY expired DESC`;

async function tick() {
  let client;
  let lockAcquired = false;

  try {
    client = await db.getClient();

    const { rows: [{ acquired }] } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`, [LOCK_KEY]
    );
    if (!acquired) {
      logger.info('trace retention advisory lock held — skipping');
      return { skipped: true, deleted: 0 };
    }
    lockAcquired = true;

    const { rowCount } = await client.query(DELETE_SQL);
    if (rowCount > 0) {
      logger.info({ count: rowCount }, 'trace retention deleted expired turn traces');
    }
    return { skipped: false, deleted: rowCount };
  } catch (err) {
    logger.error({ err: err.message }, 'trace retention tick failed');
    return { skipped: false, deleted: 0, error: err.message };
  } finally {
    if (lockAcquired && client) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
        .catch(err => logger.error({ err: err.message }, 'trace retention advisory unlock failed'));
    }
    if (client) client.release();
  }
}

/** What the next tick would delete, per tenant. No lock, no writes. */
async function preview() {
  const { rows } = await db.query(PREVIEW_SQL);
  return rows;
}

function start() {
  const task = cron.schedule('15 3 * * *', () => {
    tick().catch(err => logger.error({ err: err.message }, 'trace retention unhandled tick error'));
  });
  logger.info('trace retention cron started — runs daily at 03:15');
  return task;
}

module.exports = { start, tick, preview, LOCK_KEY };
