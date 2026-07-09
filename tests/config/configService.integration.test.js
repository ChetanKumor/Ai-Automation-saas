'use strict';

// Writer tests against a REAL throwaway scratch database (same pattern as
// controlPlane.test.js): genesis a scratch DB from schema.sql, point the db.js
// pool at it, exercise writeTenantConfig end-to-end. Proves the transactional
// version+revision write, sequential version bumps, and that a failed validation
// writes nothing. Skips entirely when DATABASE_URL is unset; scratch DB dropped
// in after().

process.env.LOG_LEVEL = 'silent';        // silence configService's write/invalidate logs
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

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

describe('configService writer (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, configService;

  before(async () => {
    await sweep();
    scratchName = 'zyon_test_' + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;          // bind the db.js pool to the scratch DB
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  async function newTenant() {
    const { rows } = await db.query(`INSERT INTO tenants (business_name, active) VALUES ('T', true) RETURNING id`);
    return rows[0].id;
  }
  const count = async (tbl, t) =>
    (await db.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE tenant_id=$1`, [t])).rows[0].n;

  it('first write → version 1, head row + one matching revision (atomic)', async () => {
    const t = await newTenant();
    const { version, config } = await configService.writeTenantConfig(t, {}, 'cli');
    assert.equal(version, 1);

    const head = (await db.query('SELECT version, config FROM tenant_configs WHERE tenant_id=$1', [t])).rows[0];
    assert.equal(head.version, 1);
    assert.deepEqual(head.config, config, 'head config equals returned config');

    const revs = (await db.query(
      'SELECT version, source, config FROM tenant_config_revisions WHERE tenant_id=$1 ORDER BY version', [t])).rows;
    assert.equal(revs.length, 1, 'exactly one revision snapshot');
    assert.equal(revs[0].version, 1);
    assert.equal(revs[0].source, 'cli');
    assert.deepEqual(revs[0].config, config, 'revision snapshot equals head');
  });

  it('sequential writes bump version 1→2→3 with a revision each', async () => {
    const t = await newTenant();
    const r1 = await configService.writeTenantConfig(t, {}, 'provision');
    const r2 = await configService.writeTenantConfig(t, { whatsapp: { enabled: false } }, 'admin');
    const r3 = await configService.writeTenantConfig(t, { retention_days: 90 }, 'admin');
    assert.deepEqual([r1.version, r2.version, r3.version], [1, 2, 3]);

    const head = (await db.query('SELECT version, config FROM tenant_configs WHERE tenant_id=$1', [t])).rows[0];
    assert.equal(head.version, 3, 'head sits at the latest version');
    assert.equal(head.config.retention_days, 90, 'head holds the newest config');
    assert.equal(await count('tenant_config_revisions', t), 3, 'one revision per write');

    const versions = (await db.query(
      'SELECT version FROM tenant_config_revisions WHERE tenant_id=$1 ORDER BY version', [t])).rows.map((x) => x.version);
    assert.deepEqual(versions, [1, 2, 3], 'append-only history 1..3');
  });

  it('invalid input writes nothing and throws ConfigValidationError with paths', async () => {
    const t = await newTenant();
    assert.equal(await count('tenant_configs', t), 0);
    assert.equal(await count('tenant_config_revisions', t), 0);

    await assert.rejects(
      configService.writeTenantConfig(t, { nope: true }, 'admin'),
      (err) => {
        assert.equal(err.name, 'ConfigValidationError');
        assert.ok(Array.isArray(err.issues) && err.issues.length > 0, 'carries path-level issues');
        return true;
      });

    assert.equal(await count('tenant_configs', t), 0, 'no head row written');
    assert.equal(await count('tenant_config_revisions', t), 0, 'no revision written');
  });

  it('write-materializes: partial input + defaults → full stored document', async () => {
    const t = await newTenant();
    const { config } = await configService.writeTenantConfig(t, { business: { display_name: 'Acme Dental' } }, 'admin');
    assert.equal(config.business.display_name, 'Acme Dental', 'input applied');
    assert.equal(config.retention_days, 365, 'default materialized');
    assert.equal(config.crm.extraction.voice, 'off', 'default materialized (Issue 3)');
    assert.equal(config.voice.provider, 'plivo');

    const stored = (await db.query('SELECT config FROM tenant_configs WHERE tenant_id=$1', [t])).rows[0].config;
    assert.deepEqual(stored, config, 'the whole document was stored');
  });

  it('expectedVersion match → writes the next version (optimistic concurrency)', async () => {
    const t = await newTenant();
    const r1 = await configService.writeTenantConfig(t, {}, 'admin');            // v1, no guard
    const r2 = await configService.writeTenantConfig(
      t, { retention_days: 90 }, 'admin', { expectedVersion: 1 });               // guard matches head=1
    assert.deepEqual([r1.version, r2.version], [1, 2]);
    const head = (await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [t])).rows[0];
    assert.equal(head.version, 2);
  });

  it('expectedVersion match on a configless tenant is 0', async () => {
    const t = await newTenant();
    const { version } = await configService.writeTenantConfig(t, {}, 'admin', { expectedVersion: 0 });
    assert.equal(version, 1);
  });

  it('expectedVersion mismatch → ConfigConflictError, nothing written', async () => {
    const t = await newTenant();
    await configService.writeTenantConfig(t, {}, 'admin');                       // head = 1
    await assert.rejects(
      configService.writeTenantConfig(t, { retention_days: 90 }, 'admin', { expectedVersion: 0 }),
      (err) => {
        assert.equal(err.name, 'ConfigConflictError');
        assert.equal(err.currentVersion, 1, 'carries the live head version');
        return true;
      });
    assert.equal(await count('tenant_config_revisions', t), 1, 'no extra revision written');
    const head = (await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [t])).rows[0];
    assert.equal(head.version, 1, 'head unchanged');
  });

  it('unknown tenant → throws, nothing written', async () => {
    const fakeId = '00000000-0000-0000-0000-0000000000ff';
    await assert.rejects(configService.writeTenantConfig(fakeId, {}, 'cli'), /tenant not found/);
    assert.equal(await count('tenant_configs', fakeId), 0);
  });
});
