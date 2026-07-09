'use strict';

// provisioningService + migration 021 tests against a REAL throwaway scratch
// database (same pattern as controlPlane / configService integration tests).
// Genesis a scratch DB from schema.sql, bind the db.js pool at it, exercise
// provisionTenant end-to-end. Disjoint DB-name prefix (zyon_test_prov_) so a
// concurrent sweep in another file can't drop our database mid-run.
// Skips entirely when DATABASE_URL is unset; scratch DB dropped in after().

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_test_prov_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_prov\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// tenants.phone_number_id is globally UNIQUE, so every fictional clinic needs
// its own number. Derive it deterministically from the slug: run-twice (same
// slug) yields the SAME number, while distinct slugs never collide.
function phoneForSlug(slug) {
  const hex = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 15);
  return '1' + BigInt('0x' + hex).toString().slice(0, 14).padEnd(14, '0');
}

function baseDef(slug = 'sunrise-dental') {
  return {
    slug,
    business_name: 'Sunrise Dental Care',
    whatsapp: { phone_number_id: phoneForSlug(slug), waba_id: '200000000000002' },
    config: {
      business: { display_name: 'Sunrise Dental Care' },
      greeting: { en: 'Welcome to Sunrise Dental Care!' },
    },
  };
}

describe('provisioningService + migration 021 (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, provisioning, configService, tenantService;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    provisioning = require('../../src/modules/provisioning/provisioningService');
    configService = require('../../src/modules/config/configService');
    tenantService = require('../../src/modules/tenant/tenantService');
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

  const oneTenant = async (slug) =>
    (await db.query('SELECT * FROM tenants WHERE slug=$1', [slug])).rows[0];
  const tableCount = async (tbl) =>
    (await db.query(`SELECT count(*)::int AS n FROM ${tbl}`)).rows[0].n;

  // ── Migration 021: objects + unique constraint + index (EXPLAIN) ──
  describe('migration 021', () => {
    it('tenants.slug column exists and is UNIQUE', async () => {
      const col = await db.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name='tenants' AND column_name='slug'`);
      assert.equal(col.rows[0].data_type, 'text');

      // Two rows with the same slug must be rejected by the unique constraint.
      await db.query(`INSERT INTO tenants (business_name, slug) VALUES ('A', 'dup-slug')`);
      await assert.rejects(
        db.query(`INSERT INTO tenants (business_name, slug) VALUES ('B', 'dup-slug')`),
        /tenants_slug_key|unique/i);
      await db.query(`DELETE FROM tenants WHERE slug='dup-slug'`);
    });

    it('idx_conversations_tenant_updated exists and serves the list query without a Sort', async () => {
      const idx = await db.query(
        `SELECT indexname FROM pg_indexes WHERE tablename='conversations' AND indexname='idx_conversations_tenant_updated'`);
      assert.equal(idx.rows.length, 1, 'index present');

      // EXPLAIN the Issue 26 list query. Force seqscan off so a tiny scratch
      // table still exercises the index path; assert the composite index is
      // chosen AND no Sort node is needed (order comes from the index).
      await db.query('SET enable_seqscan=off');
      const plan = (await db.query(
        `EXPLAIN SELECT c.id FROM conversations c
         WHERE c.tenant_id = '00000000-0000-0000-0000-000000000000'
           AND (c.updated_at, c.id) < (now(), '00000000-0000-0000-0000-000000000000'::uuid)
         ORDER BY c.updated_at DESC, c.id DESC LIMIT 26`)).rows.map(r => r['QUERY PLAN']).join('\n');
      await db.query('SET enable_seqscan=on');
      assert.match(plan, /idx_conversations_tenant_updated/, 'uses the new index');
      assert.doesNotMatch(plan, /\bSort\b/, 'no Sort node — order served by the index');
    });
  });

  // ── Happy path ──
  it('happy path: creates tenant (draft/inactive/ai_prompt NULL) + config v1 (source provision)', async () => {
    const report = await provisioning.provisionTenant(baseDef('happy-clinic'));

    assert.deepEqual(report.created, ['tenant', 'config@v1']);
    assert.equal(report.config_version, 1);

    const t = await oneTenant('happy-clinic');
    assert.equal(t.status, 'draft');
    assert.equal(t.active, false);
    assert.equal(t.ai_prompt, null);
    assert.equal(t.phone_number_id, phoneForSlug('happy-clinic'));

    const head = await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [t.id]);
    assert.equal(head.rows[0].version, 1);
    const rev = await db.query('SELECT version, source FROM tenant_config_revisions WHERE tenant_id=$1', [t.id]);
    assert.equal(rev.rows.length, 1);
    assert.equal(rev.rows[0].source, 'provision');

    // Config is materialized over defaults: the override wins, defaults fill the rest.
    const cfg = await configService.getTenantConfig(t.id);
    assert.equal(cfg.greeting.en, 'Welcome to Sunrise Dental Care!');
    assert.equal(cfg.business.vertical, 'clinic'); // from defaults
  });

  // ── Run-twice idempotency + --force-config ──
  it('run-twice: zero duplicates, every component skipped; --force-config bumps to v2 only', async () => {
    await provisioning.provisionTenant(baseDef('rerun-clinic'));
    const t = await oneTenant('rerun-clinic');

    const before = {
      tenants: (await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['rerun-clinic'])).rows[0].n,
      revs: (await db.query('SELECT count(*)::int n FROM tenant_config_revisions WHERE tenant_id=$1', [t.id])).rows[0].n,
    };

    const second = await provisioning.provisionTenant(baseDef('rerun-clinic'));
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.skipped, ['tenant', 'config@v1']);

    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['rerun-clinic'])).rows[0].n, before.tenants);
    assert.equal((await db.query('SELECT count(*)::int n FROM tenant_config_revisions WHERE tenant_id=$1', [t.id])).rows[0].n, before.revs);

    const forced = await provisioning.provisionTenant(baseDef('rerun-clinic'), { forceConfig: true });
    assert.deepEqual(forced.created, ['config@v2']);
    assert.deepEqual(forced.skipped, ['tenant']);
    assert.equal(forced.config_version, 2);

    // Exactly one new revision, no new tenant.
    assert.equal((await db.query('SELECT count(*)::int n FROM tenant_config_revisions WHERE tenant_id=$1', [t.id])).rows[0].n, before.revs + 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['rerun-clinic'])).rows[0].n, before.tenants);
  });

  // ── Dry-run writes nothing ──
  it('dry-run: row counts identical before/after, plan returned', async () => {
    const before = { t: await tableCount('tenants'), c: await tableCount('tenant_configs') };
    const report = await provisioning.provisionTenant(baseDef('dry-clinic'), { dryRun: true });
    assert.equal(report.dry_run, true);
    assert.equal(report.plan.tenant.slug, 'dry-clinic');
    assert.equal(report.plan.tenant.active, false);
    assert.equal(report.config_valid, true);
    assert.equal(await tableCount('tenants'), before.t);
    assert.equal(await tableCount('tenant_configs'), before.c);
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['dry-clinic'])).rows[0].n, 0);
  });

  // ── Invalid config / definition → throws, nothing written ──
  it('invalid config in definition → ConfigValidationError with path issues, nothing written', async () => {
    const bad = baseDef('bad-clinic');
    bad.config.booking = { slot_minutes: 'thirty' }; // wrong type
    await assert.rejects(
      provisioning.provisionTenant(bad),
      (err) => {
        assert.equal(err.name, 'ConfigValidationError');
        assert.ok(err.issues.some(i => i.path.includes('booking')));
        return true;
      });
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['bad-clinic'])).rows[0].n, 0);
  });

  it('unknown top-level key in definition → DefinitionValidationError (strict), path shown', async () => {
    const bad = baseDef('strict-clinic');
    bad.wa_token = 'SECRET'; // secret-bearing / unknown key — must be rejected
    await assert.rejects(
      provisioning.provisionTenant(bad),
      (err) => {
        assert.equal(err.name, 'DefinitionValidationError');
        return true;
      });
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['strict-clinic'])).rows[0].n, 0);
  });

  // ── Transaction: induced failure mid-create rolls back tenant + config ──
  it('induced failure during config write rolls back the tenant entirely', async () => {
    const orig = db.getClient;
    db.getClient = async () => {
      const c = await orig();
      const q = c.query.bind(c);
      const origRelease = c.release.bind(c);
      c.query = (text, params) => {
        if (typeof text === 'string' && /tenant_config_revisions/.test(text)) {
          return Promise.reject(new Error('induced failure'));
        }
        return q(text, params);
      };
      // Un-patch on release so the pooled connection goes back pristine —
      // otherwise the next pool.query reuses a wrapped client and can hang.
      c.release = (...args) => { c.query = q; return origRelease(...args); };
      return c;
    };
    try {
      await assert.rejects(provisioning.provisionTenant(baseDef('rollback-clinic')), /induced failure/);
    } finally {
      db.getClient = orig;
    }
    // Neither the tenant nor any config survived the rolled-back transaction.
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['rollback-clinic'])).rows[0].n, 0);
  });

  // ── Slug collision surfaces as a clean error, not a stack trace ──
  it('slug collision surfaces as a clean PROVISION_CONFLICT error', async () => {
    await provisioning.provisionTenant(baseDef('collide-clinic'));
    // Force the create path against an already-taken slug by faking "not found".
    const origQuery = db.query;
    let firstSelect = true;
    db.query = (text, params) => {
      if (firstSelect && typeof text === 'string' && /SELECT id FROM tenants WHERE slug/.test(text)) {
        firstSelect = false;
        return Promise.resolve({ rows: [] }); // pretend it doesn't exist → create path
      }
      return origQuery(text, params);
    };
    try {
      await assert.rejects(
        provisioning.provisionTenant(baseDef('collide-clinic')),
        (err) => { assert.equal(err.code, 'PROVISION_CONFLICT'); return true; });
    } finally {
      db.query = origQuery;
    }
  });

  // ── phone_number_id collision (distinct slug, shared WhatsApp number) is
  //    reported accurately, not mislabeled as a slug conflict ──
  it('phone_number_id collision surfaces a phone-specific PROVISION_CONFLICT', async () => {
    const first = baseDef('phone-owner');
    await provisioning.provisionTenant(first);
    // A different slug that (mistakenly) reuses the same WhatsApp number.
    const clash = baseDef('phone-thief');
    clash.whatsapp.phone_number_id = first.whatsapp.phone_number_id;
    await assert.rejects(
      provisioning.provisionTenant(clash),
      (err) => {
        assert.equal(err.code, 'PROVISION_CONFLICT');
        assert.match(err.message, /phone_number_id .* already attached/);
        return true;
      });
    // The clashing slug was rolled back — no partial tenant left behind.
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE slug=$1', ['phone-thief'])).rows[0].n, 0);
  });

  // ── KB ingest failure: tenant survives, failure reported ──
  it('KB ingest against a missing dir: tenant intact, kb.failed reported (exit-2 semantics)', async () => {
    const report = await provisioning.provisionTenant(baseDef('kb-clinic'), { kbDir: '/no/such/dir/exists' });
    assert.ok(await oneTenant('kb-clinic'), 'tenant created despite KB failure');
    assert.ok(report.kb.failed, 'kb failure reported');
    assert.match(report.kb.failed.error, /cannot read --kb-dir/);
  });

  it('KB ingest skips an already-ingested source (resumable)', async () => {
    const t = await oneTenant('kb-clinic') || await oneTenant('happy-clinic');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbtest-'));
    fs.writeFileSync(path.join(dir, 'faq.md'), 'Q: hours? A: 9-6.');
    // Pre-seed a chunk for source 'faq.md' so ingest treats it as already done.
    await db.query(
      `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
       VALUES ($1, 'seed', $2::vector, 'faq.md')`,
      [t.id, `[${new Array(768).fill(0).join(',')}]`]);
    const res = await provisioning.ingestKnowledge(t.id, dir);
    assert.deepEqual(res.ingested, []);
    assert.deepEqual(res.skipped, ['faq.md']);
    assert.equal(res.failed, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Shared insertTenant: panel-equivalent defaults preserved ──
  it('insertTenant defaults match the panel (active true, status draft, slug null)', async () => {
    const row = await tenantService.insertTenant(db, { business_name: 'Panel Co', phone_number_id: 'pnid_panel' });
    const full = (await db.query('SELECT active, status, slug FROM tenants WHERE id=$1', [row.id])).rows[0];
    assert.equal(full.active, true);
    assert.equal(full.status, 'draft');
    assert.equal(full.slug, null);
    assert.ok(row.id && row.business_name === 'Panel Co' && row.created_at);
  });
});
