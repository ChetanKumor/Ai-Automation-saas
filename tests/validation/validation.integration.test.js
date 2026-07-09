'use strict';

// validationService (Issue 16) against a REAL throwaway scratch database (same
// pattern as configService / provisioning integration tests). Genesis a scratch
// DB from schema.sql, bind the db.js pool at it, then drive validateTenant
// end-to-end over a broken-fixture matrix — one fixture per check, each built to
// trip exactly that check (the two checks that duplicate a schema guarantee —
// prompt.renders and consent.lines — necessarily co-trip config.schema on a
// stale doc; those assert INCLUSION, noted inline). Network checks are always
// mocked here (deps injection); the one LIVE embedding retrieval is a manual
// §10 command, not part of this suite.
//
// Disjoint DB-name prefix (zyon_test_val_) so a concurrent sweep in another file
// can't drop our DB mid-run. Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { encrypt } = require('../../src/utils/encryption');
const { clinicDefaults } = require('../../src/modules/config/defaults'); // pure, no db import

// deepMerge lives in configService, which requires db.js — importing it at the
// top would bind the pg Pool to the REAL DATABASE_URL before before() swaps it.
// It's loaded inside before(), after the swap, like db/validation below.
let deepMerge;

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_test_val_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_test\\_val\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// A 768-dim vector literal (matches knowledge_chunks.embedding). Content is
// irrelevant — kb.populated only counts rows; kb.retrieval is mocked.
const ZERO_VEC = '[' + Array(768).fill(0).join(',') + ']';

// Overrides that make a materialized clinic config pass EVERY local check:
// an owner number (numbers.e164 needs ≥1) and a non-empty escalation list
// (escalation.enabled defaults true, so an empty list would fail numbers).
const PASS_OVERRIDES = {
  business: { display_name: 'Sunrise Dental' },
  notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
  escalation: { enabled: true, phone_numbers: ['+919000000002'] },
};

// Mocked network deps — the run never touches Gemini or Meta in this suite.
const DEPS = {
  getRelevantChunks: async () => [{ content: 'Our clinic hours are 9am to 6pm.', similarity: 0.9 }],
  pingNumber: async () => 'Sunrise Dental',
};

describe('validationService (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, db, validation;
  let phoneSeq = 0;

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
    validation = require('../../src/modules/validation/validationService');
    ({ deepMerge } = require('../../src/modules/config/configService'));
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

  // Create a tenant + (optionally) a config + N knowledge chunks.
  //   opts.overrides  — config overrides merged onto clinicDefaults (valid write).
  //   opts.rawConfig  — a full config doc inserted DIRECTLY (bypasses the writer,
  //                     for stale/schema-invalid fixtures). Mutually exclusive
  //                     with overrides.
  //   opts.noConfig   — create no config row at all.
  //   opts.columns    — tenants column overrides (waba_id, ai_prompt, …).
  //   opts.chunks     — how many knowledge_chunks to seed (default 5).
  async function makeTenant(opts = {}) {
    const n = ++phoneSeq;
    const slug = `t-${n}-${crypto.randomBytes(3).toString('hex')}`;
    const cols = {
      waba_id: 'WABA_' + n,
      wa_token: encrypt('meta-token-' + n),
      ai_prompt: null,
      phone_number_id: '1000000000' + String(n).padStart(4, '0'),
      ...opts.columns,
    };
    const { rows } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, wa_token, waba_id, ai_prompt, active, status)
       VALUES ($1, $2, $3, $4, $5, $6, false, 'draft') RETURNING id`,
      ['Sunrise Dental', slug, cols.phone_number_id, cols.wa_token, cols.waba_id, cols.ai_prompt]);
    const id = rows[0].id;

    if (!opts.noConfig) {
      const doc = opts.rawConfig || materialize(opts.overrides);
      await db.query(
        `INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1, 1, $2)`,
        [id, JSON.stringify(doc)]);
      await db.query(
        `INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1, 1, $2, 'test')`,
        [id, JSON.stringify(doc)]);
    }

    const nChunks = opts.chunks != null ? opts.chunks : 5;
    for (let i = 0; i < nChunks; i++) {
      await db.query(
        `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
         VALUES ($1, $2, $3::vector, 'test')`,
        [id, `chunk ${i}`, ZERO_VEC]);
    }
    return id;
  }

  // A FRESH, fully-materialized config each call. structuredClone is essential:
  // deepMerge shares sub-trees absent from the overlay (e.g. `hours`) by
  // reference, so mutating raw.hours would poison clinicDefaults for later tests.
  const materialize = (overrides) => structuredClone(deepMerge(clinicDefaults, overrides || PASS_OVERRIDES));

  const run = (id, extra = {}) => validation.validateTenant(id, { deps: DEPS, ...extra });
  const failNames = (r) => r.checks.filter((c) => c.severity === 'fail').map((c) => c.name);
  const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));
  const skipMap = (r) => Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));

  // ── Broken-fixture matrix — one violation per check ──────────────────────────

  it('config.exists — no config row → sole fail; dependent checks skip (prerequisite_failed)', async () => {
    const id = await makeTenant({ noConfig: true });
    const r = await run(id);
    assert.equal(r.passed, false);
    assert.deepEqual(failNames(r), ['config.exists']);
    const sk = skipMap(r);
    for (const dep of ['config.schema', 'prompt.renders', 'hours.sane', 'numbers.e164', 'consent.lines', 'whatsapp.config', 'voice.config']) {
      assert.match(sk[dep], /prerequisite_failed/, `${dep} skipped for prerequisite`);
    }
  });

  it('config.schema — unknown top-level key → sole fail (renderer ignores it)', async () => {
    const raw = materialize();
    raw.bogus_field = 'nope';
    const id = await makeTenant({ rawConfig: raw });
    const r = await run(id);
    assert.deepEqual(failNames(r), ['config.schema']);
    assert.match(byName(r)['config.schema'].detail, /bogus_field|\(root\)|schema/);
  });

  it('prompt.renders — malformed hours make the render throw (co-trips config.schema/hours.sane)', async () => {
    const raw = materialize();
    raw.hours.mon = { open: '18:00', close: '09:00' }; // open >= close — stale pre-refine doc
    const id = await makeTenant({ rawConfig: raw });
    const r = await run(id);
    assert.equal(r.passed, false);
    assert.ok(failNames(r).includes('prompt.renders'), 'prompt.renders failed');
    assert.match(byName(r)['prompt.renders'].detail, /internal_error/);
  });

  it('hours.sane — every day closed → sole fail (schema-valid, renders fine)', async () => {
    const raw = materialize();
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) raw.hours[d] = { closed: true };
    const id = await makeTenant({ rawConfig: raw });
    const r = await run(id);
    assert.deepEqual(failNames(r), ['hours.sane']);
    assert.match(byName(r)['hours.sane'].detail, /no open days/);
  });

  it('numbers.e164 — no owner number → sole fail', async () => {
    const id = await makeTenant({ overrides: { ...PASS_OVERRIDES, notifications: { owner_numbers: [], on_booking: true, on_escalation: true } } });
    const r = await run(id);
    assert.deepEqual(failNames(r), ['numbers.e164']);
    assert.match(byName(r)['numbers.e164'].detail, /owner/);
  });

  it('consent.lines — enabled but a supported lang missing (co-trips config.schema)', async () => {
    const raw = materialize();
    raw.languages = { supported: ['en', 'hi'], default: 'en' };
    raw.greeting = { en: 'Hi', hi: 'नमस्ते' };
    raw.recording_consent = { enabled: true, line: { en: 'This call may be recorded.' } }; // missing hi
    const id = await makeTenant({ rawConfig: raw });
    const r = await run(id);
    assert.ok(failNames(r).includes('consent.lines'), 'consent.lines failed');
    assert.match(byName(r)['consent.lines'].detail, /hi/);
  });

  it('kb.populated — too few chunks → sole fail', async () => {
    const id = await makeTenant({ chunks: 2 });
    const r = await run(id);
    assert.deepEqual(failNames(r), ['kb.populated']);
    assert.match(byName(r)['kb.populated'].detail, /2 knowledge chunk/);
  });

  it('kb.retrieval — retrieval returns nothing → sole fail', async () => {
    const id = await makeTenant();
    const r = await run(id, { deps: { ...DEPS, getRelevantChunks: async () => [] } });
    assert.deepEqual(failNames(r), ['kb.retrieval']);
    assert.match(byName(r)['kb.retrieval'].detail, /no chunks/);
  });

  it('whatsapp.config — enabled but waba_id missing → sole fail', async () => {
    const id = await makeTenant({ columns: { waba_id: null } });
    const r = await run(id);
    assert.deepEqual(failNames(r), ['whatsapp.config']);
    assert.match(byName(r)['whatsapp.config'].detail, /waba_id/);
  });

  it('whatsapp.live — Meta ping rejects → sole fail (isolated internal_error)', async () => {
    const id = await makeTenant();
    const r = await run(id, { deps: { ...DEPS, pingNumber: async () => { throw new Error('401 invalid token'); } } });
    assert.deepEqual(failNames(r), ['whatsapp.live']);
    assert.match(byName(r)['whatsapp.live'].detail, /internal_error.*401/);
  });

  it('voice.config — voice enabled but no DID → sole fail', async () => {
    const id = await makeTenant({ overrides: { ...PASS_OVERRIDES, voice: { enabled: true, did: null, provider: 'plivo', sarvam_speaker: 'anushka', sarvam_voice_id: 'bulbul:v2' } } });
    const r = await run(id);
    assert.deepEqual(failNames(r), ['voice.config']);
    assert.match(byName(r)['voice.config'].detail, /DID/);
  });

  it('tenant.legacy_prompt — ai_prompt set → WARN, run still passes', async () => {
    const id = await makeTenant({ columns: { ai_prompt: 'You are a legacy assistant.' } });
    const r = await run(id);
    assert.equal(r.passed, true, 'warn never blocks');
    assert.equal(byName(r)['tenant.legacy_prompt'].severity, 'warn');
    assert.equal(byName(r)['tenant.legacy_prompt'].passed, true);
  });

  // ── Severity semantics ───────────────────────────────────────────────────────

  it('token-budget overrun → WARN on prompt.renders, run still passes', async () => {
    const id = await makeTenant();
    const r = await run(id, { tokenBudget: { whatsapp: 10, voice: 10 } }); // absurdly low → every render over budget
    assert.equal(r.passed, true, 'over-budget is a warn, not a fail');
    assert.equal(byName(r)['prompt.renders'].severity, 'warn');
    assert.match(byName(r)['prompt.renders'].detail, /token budget/);
  });

  // ── Skip accounting ──────────────────────────────────────────────────────────

  it('skip accounting: explicit + enabled-driven skips both recorded with reasons', async () => {
    const id = await makeTenant(); // voice disabled by default → enabled-driven skip
    const r = await run(id, { skip: ['kb.populated'] });
    const sk = skipMap(r);
    assert.equal(sk['kb.populated'], 'explicitly skipped (--skip)');
    assert.equal(sk['kb.retrieval'], 'kb.populated was skipped', 'retrieval auto-skips when populated skipped');
    assert.equal(sk['voice.config'], 'voice.enabled is false');
    assert.equal(r.passed, true);
    // A skipped check never appears in checks[].
    assert.ok(!byName(r)['kb.populated'], 'skipped check absent from checks[]');
  });

  it('a fully-configured tenant passes with WhatsApp live skipped', async () => {
    const id = await makeTenant();
    const r = await run(id, { skip: ['whatsapp.live'] });
    assert.equal(r.passed, true);
    assert.equal(failNames(r).length, 0);
    assert.equal(skipMap(r)['whatsapp.live'], 'explicitly skipped (--skip)');
  });

  // ── Throw isolation ──────────────────────────────────────────────────────────

  it('a check that THROWS records fail + internal_error and the run continues', async () => {
    const id = await makeTenant();
    const r = await run(id, { deps: { ...DEPS, getRelevantChunks: async () => { throw new Error('embedding boom'); } } });
    assert.equal(byName(r)['kb.retrieval'].severity, 'fail');
    assert.match(byName(r)['kb.retrieval'].detail, /internal_error.*boom/);
    // The run didn't abort — later checks still ran.
    assert.ok(byName(r)['tenant.legacy_prompt'], 'checks after the throwing one still ran');
    assert.equal(byName(r)['config.exists'].severity, 'pass');
  });

  // ── Persistence + latest-wins ────────────────────────────────────────────────

  it('every run is persisted verbatim; getLatestValidation returns the newest', async () => {
    const id = await makeTenant();
    const first = await run(id, { skip: ['whatsapp.live'] });
    const second = await run(id); // full run

    const { rows } = await db.query('SELECT count(*)::int AS n FROM validation_runs WHERE tenant_id=$1', [id]);
    assert.equal(rows[0].n, 2, 'both runs persisted (no latest-wins locking here)');

    const latest = await validation.getLatestValidation(id);
    assert.equal(latest.passed, second.passed);
    // Stored result is the returned shape minus the top-level `passed`.
    assert.deepEqual(latest.result.checks, second.checks);
    assert.deepEqual(latest.result.skipped, second.skipped);
    assert.equal(latest.result.service_version, validation.SERVICE_VERSION);
    assert.notEqual(second.skipped.length, first.skipped.length, 'the two runs differ (skip set changed)');
  });

  it('getLatestValidation returns null for a tenant that never ran', async () => {
    const id = await makeTenant();
    assert.equal(await validation.getLatestValidation(id), null);
  });

  it('validateTenant throws for a non-existent tenant (no FK to persist against)', async () => {
    await assert.rejects(
      () => validation.validateTenant('00000000-0000-0000-0000-000000000000', { deps: DEPS }),
      /tenant not found/);
  });
});
