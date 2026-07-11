const { Pool } = require('pg');
const logger = require('../infra/logging/logger');

// App-pool statement timeout (Issue 29 / V-003): a session-level setting on
// EVERY pooled connection, so every statement on the app pool is bounded —
// the turn path and the crons alike (retention/reminder/collections measured
// well under it at current scale; at-scale batching is a deferred ledger
// item). Sent via the libpq `options` startup field, NOT pg's
// `statement_timeout` config: managed proxies drop the latter as an unknown
// startup parameter (verified live: Neon accepts the packet, session stays 0)
// but pass `options` through (verified live: SHOW returns the value). A
// SET-on-connect would also work but queues behind the first checkout query —
// deprecated client behavior slated for removal in pg@9.
// The migration runner (src/db/migrate.js) builds its own pg.Client without
// this and is deliberately exempt — long DDL must not be killed mid-migration.
const statementTimeoutMs = () => {
  const v = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c statement_timeout=${statementTimeoutMs()}`,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'DB pool error');
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  close: () => pool.end(),
};