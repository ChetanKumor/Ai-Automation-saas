'use strict';

// Issue 29 (V-003): the app pool carries a Postgres statement_timeout;
// the migration runner's own client is exempt. Env must be set BEFORE db.js
// is required (the pool reads it at module load) — node --test runs each file
// in its own process, so this shrunk timeout never leaks into other suites.

require('dotenv').config();
process.env.DB_STATEMENT_TIMEOUT_MS = '500';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../src/db/db');
const { makeClient } = require('../../src/db/migrate');

describe('app-pool statement_timeout (Issue 29)', () => {
  after(async () => { await db.close(); });

  it('the pool session carries the configured statement_timeout', async () => {
    const { rows: [{ statement_timeout }] } = await db.query('SHOW statement_timeout');
    assert.equal(statement_timeout, '500ms');
  });

  it('a slow statement through the app pool errors at the limit (57014), quickly', async () => {
    const t0 = Date.now();
    await assert.rejects(db.query('SELECT pg_sleep(5)'), (err) => {
      assert.equal(err.code, '57014'); // query_canceled: statement timeout
      return true;
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4000, `cancelled at ~500ms, not after the sleep (elapsed ${elapsed}ms)`);
  });

  it('the migration runner client is exempt: no statement_timeout, slow DDL survives', async () => {
    const client = makeClient();
    await client.connect();
    try {
      const { rows: [{ statement_timeout }] } = await client.query('SHOW statement_timeout');
      assert.equal(statement_timeout, '0', 'runner sessions have no statement timeout');
      // Longer than the app pool limit — would be killed there, survives here.
      await client.query('SELECT pg_sleep(1)');
    } finally {
      await client.end();
    }
  });
});
