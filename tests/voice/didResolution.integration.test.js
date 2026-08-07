'use strict';

// Issue 11 — DID → tenant resolution (tenantService.getByDid).
//
// The dialled number lives at `config.voice.did` in tenant_configs.config
// (JSONB); there is no column and no index. Unlike tenants.phone_number_id,
// which is UNIQUE, nothing in the schema stops two tenants claiming one DID —
// so the ambiguity guard is the point of this suite, not a formality.
//
// Runs against a REAL throwaway scratch database built by the migration runner
// from schema.sql, then repoints DATABASE_URL and lazy-requires the pooled db
// module (the lifecycle/validation suite pattern — the pg Pool captures
// DATABASE_URL at import time, so the require must come after the repoint).
//
// Disjoint DB-name prefix (zyon_did_): `node --test` runs files concurrently and
// each file sweeps by LIKE prefix, so a prefix that is a prefix of another
// file's lets one sweep DROP the other's live database mid-run. `zyon_did_` is
// a prefix of nothing in use and nothing in use is a prefix of it.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

let db, tenantService, configService;

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_did_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_did\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// Fixture tenants. Fixed UUIDs so a failure names a row you can find by eye.
const T = {
  A:        '00000000-0000-0011-0000-00000000000a', // active, DID +914012345678
  B:        '00000000-0000-0011-0000-00000000000b', // active, DID +914099999999 — cross-tenant target
  NOCONFIG: '00000000-0000-0011-0000-00000000000c', // active, NO tenant_configs row
  NULLDID:  '00000000-0000-0011-0000-00000000000d', // active, config present, voice.did null
  INACTIVE: '00000000-0000-0011-0000-00000000000e', // INACTIVE, DID +914055555555
  SHARED_A: '00000000-0000-0011-0000-00000000000f', // active,   DID +914088888888
  SHARED_I: '00000000-0000-0011-0000-000000000010', // INACTIVE, DID +914088888888 (same as SHARED_A)
  DUP_1:    '00000000-0000-0011-0000-000000000011', // active,   DID +914077777777
  DUP_2:    '00000000-0000-0011-0000-000000000012', // active,   DID +914077777777 (same as DUP_1)
};

const DID_A        = '+914012345678';
const DID_B        = '+914099999999';
const DID_INACTIVE = '+914055555555';
const DID_SHARED   = '+914088888888';
const DID_DUP      = '+914077777777';
const DID_UNUSED   = '+914011111111';

// The resolver's own FROM/JOIN/active shape with the DID predicate removed.
// Used to prove the negative tests are not vacuous: whatever this returns is
// exactly what a resolver that forgot its WHERE clause would have to choose
// between.
const CANDIDATES_SQL = `
  SELECT t.id
    FROM tenants t
    JOIN tenant_configs tc ON tc.tenant_id = t.id
   WHERE t.active = true`;

describe('DID → tenant resolution (Issue 11)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind the pooled db module — and everything requiring it — to the scratch
    // DB BEFORE first require.
    process.env.DATABASE_URL = scratchCs;
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    tenantService = require('../../src/modules/tenant/tenantService');
    configService = require('../../src/modules/config/configService');

    async function makeTenant(id, name, active) {
      await db.query(
        `INSERT INTO tenants (id, business_name, active, status)
         VALUES ($1, $2, $3, 'live')`,
        [id, name, active]
      );
    }

    // Configs are written through the REAL writer, so what the resolver reads is
    // what the only production write path produces — schema-validated, defaults
    // merged, E.164 enforced on voice.did by configSchema.
    const writeDid = (id, did) =>
      configService.writeTenantConfig(id, { voice: { enabled: true, did } }, 'cli');

    await makeTenant(T.A, 'Clinic A', true);
    await makeTenant(T.B, 'Clinic B', true);
    await makeTenant(T.NOCONFIG, 'Clinic No-Config', true);
    await makeTenant(T.NULLDID, 'Clinic Null-DID', true);
    await makeTenant(T.INACTIVE, 'Clinic Inactive', false);
    await makeTenant(T.SHARED_A, 'Clinic Shared (active)', true);
    await makeTenant(T.SHARED_I, 'Clinic Shared (inactive)', false);
    await makeTenant(T.DUP_1, 'Clinic Dup 1', true);
    await makeTenant(T.DUP_2, 'Clinic Dup 2', true);

    await writeDid(T.A, DID_A);
    await writeDid(T.B, DID_B);
    await writeDid(T.NULLDID, null);
    await writeDid(T.INACTIVE, DID_INACTIVE);
    await writeDid(T.SHARED_A, DID_SHARED);
    await writeDid(T.SHARED_I, DID_SHARED);
    await writeDid(T.DUP_1, DID_DUP);
    await writeDid(T.DUP_2, DID_DUP);
    // T.NOCONFIG deliberately gets no tenant_configs row.

    tenantService.invalidateTenantCache();
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (tenantService) tenantService.stop();
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  // ── 1. the happy path ──────────────────────────────────────────────────────

  it('(1) an exact DID resolves the tenant that owns it', async () => {
    const t = await tenantService.getByDid(DID_A);
    assert.ok(t, 'a tenant resolved');
    assert.equal(t.id, T.A);
    assert.equal(t.business_name, 'Clinic A', 'the row is hydrated, not just an id');
  });

  it('(2) whitespace, dashes and parentheses resolve the same tenant', async () => {
    for (const variant of [' +91 4012 345 678 ', '(+91) 40-1234-5678', '+91-40-1234-5678']) {
      const t = await tenantService.getByDid(variant);
      assert.ok(t, `"${variant}" resolved`);
      assert.equal(t.id, T.A, `"${variant}" is the same tenant as ${DID_A}`);
    }
  });

  // ── 2. the normalisation boundary, pinned in both directions ───────────────

  it('(3) a number with no country code returns null; one missing only the "+" resolves', async () => {
    // F-003b: "4012345678" is one digit short of E164_RE's 11-digit floor, so
    // normalizePhone refuses rather than reinterpreting it as a real +40
    // (Romania) number. A silently-wrong tenant is the failure being bought out
    // of, so the resolver must answer null.
    assert.equal(await tenantService.getByDid('4012345678'), null,
      'a bare local number is not silently promoted to a plausible foreign one');

    // The other side of the same boundary: a number that carries its country
    // code and is missing only the leading "+" is unambiguous, normalises to
    // DID_A, and MUST resolve — this is the case the issue's §1 requires.
    const t = await tenantService.getByDid('914012345678');
    assert.ok(t, '"914012345678" resolved');
    assert.equal(t.id, T.A, 'a stored +914012345678 and a dialled 914012345678 are one tenant');
  });

  it('(4) malformed input returns null and does not throw', async () => {
    for (const bad of ['not-a-number', '', '   ', '+', 'abc', '+++', null, undefined, 12345]) {
      const t = await tenantService.getByDid(bad);
      assert.equal(t, null, `${JSON.stringify(bad)} resolved to null`);
    }
  });

  // ── 3. the negatives ───────────────────────────────────────────────────────

  it('(5) an unknown number returns null', async () => {
    assert.equal(await tenantService.getByDid(DID_UNUSED), null);
  });

  it('(6) a tenant with no config document is invisible to the lookup (inner join)', async () => {
    // Precondition: it really is active and really has no config row — without
    // both, this test proves nothing.
    const { rows: [t] } = await db.query('SELECT active FROM tenants WHERE id = $1', [T.NOCONFIG]);
    assert.equal(t.active, true, 'the config-less tenant is active');
    const { rowCount } = await db.query('SELECT 1 FROM tenant_configs WHERE tenant_id = $1', [T.NOCONFIG]);
    assert.equal(rowCount, 0, 'and it genuinely has no config document');

    // The join excludes it outright, so no DID value can ever reach it.
    const { rows: candidates } = await db.query(CANDIDATES_SQL);
    assert.ok(!candidates.some((r) => r.id === T.NOCONFIG),
      'a config-less tenant contributes no candidate row at all');

    // And its presence does not perturb a resolution that should succeed.
    const a = await tenantService.getByDid(DID_A);
    assert.equal(a.id, T.A);
  });

  it('(7) a tenant whose voice.did is null is unaddressable', async () => {
    // It DOES have a config document — so it is in the join, unlike (6) — but
    // its DID expression is SQL NULL and therefore equal to nothing.
    const { rows: [cfg] } = await db.query(
      `SELECT config->'voice'->>'did' AS did FROM tenant_configs WHERE tenant_id = $1`, [T.NULLDID]);
    assert.equal(cfg.did, null, 'voice.did is stored as null');
    const { rows: candidates } = await db.query(CANDIDATES_SQL);
    assert.ok(candidates.some((r) => r.id === T.NULLDID),
      'it IS a candidate row — the exclusion below is the predicate, not the join');

    // Nothing names it: not a real number, and not any flavour of empty. The
    // last three would match it under an `IS NOT DISTINCT FROM` comparison.
    for (const probe of [DID_UNUSED, null, '', undefined]) {
      const t = await tenantService.getByDid(probe);
      assert.equal(t, null, `${JSON.stringify(probe)} did not reach the null-DID tenant`);
    }
  });

  it('(8) an INACTIVE tenant with a matching DID returns null', async () => {
    const { rows: [t] } = await db.query('SELECT active FROM tenants WHERE id = $1', [T.INACTIVE]);
    assert.equal(t.active, false, 'the tenant really is inactive');
    const { rows: [cfg] } = await db.query(
      `SELECT config->'voice'->>'did' AS did FROM tenant_configs WHERE tenant_id = $1`, [T.INACTIVE]);
    assert.equal(cfg.did, DID_INACTIVE, 'and it really does carry the DID being dialled');

    assert.equal(await tenantService.getByDid(DID_INACTIVE), null);
  });

  // ── 4. the three that matter ───────────────────────────────────────────────

  it('(9) an active tenant sharing a DID with an INACTIVE one still resolves', async () => {
    // The regression this pins: filtering `active` only during hydration, and
    // not in the DID query, would return two rows here, trip the ambiguity
    // guard, and answer null for a clinic that is legitimately the only active
    // owner of its number.
    const { rows } = await db.query(
      `SELECT t.id, t.active
         FROM tenants t JOIN tenant_configs tc ON tc.tenant_id = t.id
        WHERE tc.config->'voice'->>'did' = $1`, [DID_SHARED]);
    assert.equal(rows.length, 2, 'two tenants carry this DID');
    assert.equal(rows.filter((r) => r.active).length, 1, 'exactly one of them is active');

    const t = await tenantService.getByDid(DID_SHARED);
    assert.ok(t, 'the active owner resolved rather than being lost to ambiguity');
    assert.equal(t.id, T.SHARED_A);
  });

  it('(10) two ACTIVE tenants sharing a DID resolve to null — the ambiguity guard', async () => {
    const { rows } = await db.query(
      `SELECT t.id FROM tenants t JOIN tenant_configs tc ON tc.tenant_id = t.id
        WHERE tc.config->'voice'->>'did' = $1 AND t.active = true`, [DID_DUP]);
    assert.equal(rows.length, 2, 'two ACTIVE tenants genuinely claim this DID');

    // Never the first row. A silent wrong-tenant match is a cross-tenant leak.
    assert.equal(await tenantService.getByDid(DID_DUP), null);
  });

  it('(11) cross-tenant: tenant A\'s DID never resolves to tenant B', async () => {
    // Non-vacuity FIRST: a resolver that dropped its DID predicate would have a
    // real choice to make here, and B would be one of the options.
    const { rows: candidates } = await db.query(CANDIDATES_SQL);
    assert.ok(candidates.length > 1,
      `more than one active tenant has a config document (got ${candidates.length})`);
    assert.ok(candidates.some((r) => r.id === T.B),
      'tenant B is among the rows a WHERE-less query would return');
    const { rows: [b] } = await db.query(
      `SELECT config->'voice'->>'did' AS did FROM tenant_configs WHERE tenant_id = $1`, [T.B]);
    assert.equal(b.did, DID_B, 'and B carries a real DID of its own, not a null');
    assert.notEqual(DID_A, DID_B, 'the two DIDs are genuinely different');

    // Now the claim.
    const a = await tenantService.getByDid(DID_A);
    assert.equal(a.id, T.A, "A's DID resolves to A");
    assert.notEqual(a.id, T.B, "A's DID does not resolve to B");

    const bResolved = await tenantService.getByDid(DID_B);
    assert.equal(bResolved.id, T.B, "and B's DID resolves to B, not A");
  });
});
