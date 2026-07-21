'use strict';

// Tenant lifecycle + the dynamic turn.scripted check (Issue 17), against a REAL
// throwaway scratch database (same genesis pattern as the Issue 16 suite).
//
// Three concerns live here:
//   1. the transition matrix (draft → validated → live → paused, and every refusal),
//   2. turn.scripted: booking through the real tool loop with a scripted model,
//      cleanup, throw-isolation, skip accounting,
//   3. the single-writer invariant, proven structurally over the source tree.
//
// Disjoint DB-name prefix (zyon_lc_) — deliberately NOT starting with `zyon_test_`,
// because tests/admin/tenantDetail.test.js sweeps `zyon_test_%` and would drop our
// database mid-run. Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { encrypt } = require('../../src/utils/encryption');
const { clinicDefaults } = require('../../src/modules/config/defaults');

let deepMerge, db, validation, lifecycle, configService, aiService, knowledgeService, scripted;

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_lc_';

function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_lc\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

const ZERO_VEC = '[' + Array(768).fill(0).join(',') + ']';

const PASS_OVERRIDES = {
  business: { display_name: 'Sunrise Dental' },
  notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
  escalation: { enabled: true, phone_numbers: ['+919000000002'] },
};

// Network deps are always mocked here; the live Gemini path is a §10 manual command.
const DEPS = {
  getRelevantChunks: async () => [{ content: 'Our clinic hours are 9am to 6pm.', similarity: 0.9 }],
  pingNumber: async () => 'Sunrise Dental',
};

// Validate opts that keep the suite hermetic and fast: no Meta ping, no model calls.
const STATIC = { deps: DEPS, skip: ['whatsapp.live', 'turn.scripted'] };

// A scripted model driving the REAL tool loop: it reads the date/time out of the
// probe's own transcript (exactly as Gemini would), calls check_availability, then
// book_appointment for that slot, then answers. No live model, fully deterministic.
function scriptedBookingModel({ doctor = 'Dr. Rao', reply = 'Your appointment is booked.', patientName = 'Zyon Validation Probe' } = {}) {
  const resp = (fc, text) => ({
    response: { functionCalls: () => fc || undefined, text: () => text || '' },
  });
  return () => ({
    startChat: () => {
      let i = 0;
      let slot = null;
      return {
        sendMessage: async (payload) => {
          i += 1;
          if (i === 1) {
            const m = String(payload).match(/on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/);
            assert.ok(m, 'probe transcript should name an explicit date and time');
            slot = { date: m[1], time: m[2] };
            return resp([{ name: 'check_availability', args: { date: slot.date } }]);
          }
          if (i === 2) {
            return resp([{
              name: 'book_appointment',
              args: {
                doctor_name: doctor,
                appointment_time: `${slot.date}T${slot.time}:00+05:30`,
                patient_name: patientName,
              },
            }]);
          }
          return resp(null, reply);
        },
      };
    },
  });
}

describe('tenant lifecycle + turn.scripted (integration)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName;
  let seq = 0;
  let kbMock;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    const scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind the pooled db module (and everything requiring it) to the scratch DB
    // BEFORE first require.
    process.env.DATABASE_URL = scratchCs;
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    validation = require('../../src/modules/validation/validationService');
    lifecycle = require('../../src/modules/tenant/lifecycleService');
    scripted = require('../../src/modules/validation/scriptedTurnCheck');
    configService = require('../../src/modules/config/configService');
    aiService = require('../../src/modules/ai/aiService');
    knowledgeService = require('../../src/modules/knowledge/knowledgeService');
    ({ deepMerge } = configService);

    // Keep the real context assembler in play but never hit live embeddings.
    kbMock = mock.method(knowledgeService, 'getRelevantChunks', async () => []);
  });

  after(async () => {
    if (kbMock) kbMock.mock.restore();
    if (aiService) aiService._setModelProvider(null);
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  const materialize = (overrides) => structuredClone(deepMerge(clinicDefaults, overrides || PASS_OVERRIDES));

  // Tenant born the way provisioning makes them: draft + active=false.
  async function makeTenant(opts = {}) {
    const n = ++seq;
    const { rows } = await db.query(
      `INSERT INTO tenants (business_name, slug, phone_number_id, wa_token, waba_id, ai_prompt, active, status)
       VALUES ($1,$2,$3,$4,$5,$6,false,'draft') RETURNING id`,
      ['Sunrise Dental', `lc-${n}-${crypto.randomBytes(3).toString('hex')}`,
        '2000000000' + String(n).padStart(4, '0'), encrypt('meta-token-' + n), 'WABA_' + n, null]);
    const id = rows[0].id;

    if (!opts.noConfig) {
      const doc = opts.rawConfig || materialize(opts.overrides);
      await db.query('INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1,1,$2)', [id, JSON.stringify(doc)]);
      await db.query("INSERT INTO tenant_config_revisions (tenant_id, version, config, source) VALUES ($1,1,$2,'test')", [id, JSON.stringify(doc)]);
    }
    for (let i = 0; i < (opts.chunks != null ? opts.chunks : 5); i++) {
      await db.query(
        "INSERT INTO knowledge_chunks (tenant_id, content, embedding, source) VALUES ($1,$2,$3::vector,'test')",
        [id, `chunk ${i}`, ZERO_VEC]);
    }
    if (opts.schedule !== false) {
      await db.query(
        "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,'schedule',$2)",
        [id, JSON.stringify({
          doctor: 'Dr. Rao', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          start: '09:00', end: '18:00', slot_minutes: 30,
        })]);
    }
    return id;
  }

  const statusOf = async (id) => (await db.query('SELECT status, active FROM tenants WHERE id=$1', [id])).rows[0];
  const go = (id, action, opts) => lifecycle.transition(id, action, opts);
  const validatePass = (id) => go(id, 'validate', { validate: STATIC });

  async function refusal(promise) {
    try { await promise; assert.fail('expected a LifecycleError'); }
    catch (err) {
      assert.equal(err.name, 'LifecycleError', `got ${err.name}: ${err.message}`);
      return err;
    }
  }

  // ── Lifecycle matrix ────────────────────────────────────────────────────────

  it('draft → activate is rejected NOT_VALIDATED (status untouched)', async () => {
    const id = await makeTenant();
    const err = await refusal(go(id, 'activate'));
    assert.equal(err.code, 'NOT_VALIDATED');
    assert.deepEqual(await statusOf(id), { status: 'draft', active: false });
  });

  it('validate-fail leaves status untouched and names the failing check', async () => {
    const id = await makeTenant({ overrides: { ...PASS_OVERRIDES, notifications: { owner_numbers: [], on_booking: true, on_escalation: true } } });
    const err = await refusal(validatePass(id));
    assert.equal(err.code, 'VALIDATION_FAILED:numbers.e164');
    assert.equal(err.run.passed, false);
    assert.deepEqual(await statusOf(id), { status: 'draft', active: false });

    // The failed run is still persisted — a refusal is auditable history.
    const latest = await validation.getLatestValidation(id);
    assert.equal(latest.passed, false);
  });

  it('validate-pass → validated (active stays false: validated is not serving)', async () => {
    const id = await makeTenant();
    const out = await validatePass(id);
    assert.equal(out.from, 'draft');
    assert.equal(out.to, 'validated');
    assert.equal(out.run.passed, true);
    assert.deepEqual(await statusOf(id), { status: 'validated', active: false });
  });

  it('activate → live + active=true (the runtime gate opens)', async () => {
    const id = await makeTenant();
    await validatePass(id);
    const out = await go(id, 'activate');
    assert.equal(out.to, 'live');
    assert.equal(out.active, true);
    assert.deepEqual(await statusOf(id), { status: 'live', active: true });
  });

  it('config write after validation → activate rejected STALE_VALIDATION', async () => {
    const id = await makeTenant();
    await validatePass(id);
    // A real, versioned config write — bumps tenant_configs.updated_at to now().
    await configService.writeTenantConfig(id, materialize({ ...PASS_OVERRIDES, personality: { style: 'warm_professional', custom_instructions: 'Be extra gentle.' } }), 'test');

    const err = await refusal(go(id, 'activate'));
    assert.equal(err.code, 'STALE_VALIDATION');
    assert.match(err.message, /config changed since validation/);
    // Status is NOT mutated by a config edit — it simply blocks activation.
    assert.deepEqual(await statusOf(id), { status: 'validated', active: false });

    // Re-validating restores freshness and activation proceeds.
    await validatePass(id);
    assert.equal((await go(id, 'activate')).to, 'live');
  });

  it('pause → paused + active=false (the gate closes)', async () => {
    const id = await makeTenant();
    await validatePass(id);
    await go(id, 'activate');
    const out = await go(id, 'pause');
    assert.equal(out.from, 'live');
    assert.equal(out.to, 'paused');
    assert.equal(out.active, false);
    assert.deepEqual(await statusOf(id), { status: 'paused', active: false });
  });

  it('paused → activate without a fresh validation is rejected (resume = re-validate)', async () => {
    const id = await makeTenant();
    await validatePass(id);
    await go(id, 'activate');
    await go(id, 'pause');

    const err = await refusal(go(id, 'activate'));
    assert.equal(err.code, 'NOT_VALIDATED');
    assert.deepEqual(await statusOf(id), { status: 'paused', active: false });

    // The sanctioned resume path: validate → activate.
    assert.equal((await validatePass(id)).to, 'validated');
    assert.equal((await go(id, 'activate')).to, 'live');
    assert.deepEqual(await statusOf(id), { status: 'live', active: true });
  });

  it('invalid transitions are refused explicitly (never idempotent no-ops)', async () => {
    const id = await makeTenant();

    // pause a draft
    assert.equal((await refusal(go(id, 'pause'))).code, 'INVALID_TRANSITION');

    await validatePass(id);
    // pause a validated (not yet live)
    assert.equal((await refusal(go(id, 'pause'))).code, 'INVALID_TRANSITION');

    await go(id, 'activate');
    // activate an already-live tenant → explicit refusal, NOT a no-op
    const already = await refusal(go(id, 'activate'));
    assert.equal(already.code, 'INVALID_TRANSITION');
    assert.match(already.message, /already live/);

    // validating a live tenant would demote it offline → refused
    const demote = await refusal(validatePass(id));
    assert.equal(demote.code, 'INVALID_TRANSITION');
    assert.match(demote.message, /pause it first/);
    assert.deepEqual(await statusOf(id), { status: 'live', active: true });

    // unknown action / unknown tenant
    assert.equal((await refusal(go(id, 'destroy'))).code, 'INVALID_TRANSITION');
    assert.equal((await refusal(go('00000000-0000-0000-0000-000000000000', 'activate'))).code, 'NOT_FOUND');
  });

  it('two validate runs race → latest wins at activate time', async () => {
    const id = await makeTenant();
    await validatePass(id);
    await validatePass(id); // second run supersedes the first
    const { rows } = await db.query('SELECT count(*)::int n FROM validation_runs WHERE tenant_id=$1', [id]);
    assert.equal(rows[0].n, 2, 'both runs persisted; no locking');
    assert.equal((await go(id, 'activate')).to, 'live');
  });

  // ── turn.scripted ───────────────────────────────────────────────────────────

  const runTurn = (id, extra = {}) =>
    validation.validateTenant(id, { deps: DEPS, skip: ['whatsapp.live'], ...extra });
  const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));
  const skipMap = (r) => Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));

  // Nothing synthetic may survive, in ANY table the probe can touch.
  async function syntheticResidue(id) {
    const q = async (sql, params) => (await db.query(sql, params)).rows[0].n;
    return {
      customers: await q('SELECT count(*)::int n FROM customers WHERE tenant_id=$1 AND phone=$2', [id, scripted.SYNTHETIC_PHONE]),
      conversations: await q('SELECT count(*)::int n FROM conversations WHERE tenant_id=$1', [id]),
      messages: await q('SELECT count(*)::int n FROM messages WHERE tenant_id=$1', [id]),
      appointments: await q('SELECT count(*)::int n FROM appointments WHERE tenant_id=$1', [id]),
      channel_identifiers: await q('SELECT count(*)::int n FROM channel_identifiers WHERE tenant_id=$1 AND identifier=$2', [id, scripted.SYNTHETIC_PHONE]),
      notifications: await q("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND type='appointment_booked'", [id]),
    };
  }

  it('turn.scripted — happy path: tool call + appointment written + everything cleaned up', async () => {
    const id = await makeTenant();
    aiService._setModelProvider(scriptedBookingModel());

    const r = await runTurn(id);
    const c = byName(r)['turn.scripted'];

    assert.equal(c.severity, 'pass', c.detail);
    assert.match(c.detail, /book_appointment/, 'tool-call evidence present');
    assert.match(c.detail, /booked appointment [0-9a-f-]{36}/, 'appointment id in detail');
    assert.match(c.detail, /turn latency \d+ms/, 'per-turn latency recorded');
    assert.match(c.detail, /0 residual rows/);
    assert.equal(r.passed, true);

    // The probe's rows are gone — including the notification, which does NOT cascade.
    assert.deepEqual(await syntheticResidue(id), {
      customers: 0, conversations: 0, messages: 0, appointments: 0, channel_identifiers: 0, notifications: 0,
    });
  });

  it('turn.scripted — a throwing turn fails the check, the run still completes and still cleans up', async () => {
    const id = await makeTenant();
    const r = await runTurn(id, {
      deps: { ...DEPS, generateReply: async () => { throw new Error('gemini boom'); } },
    });
    const c = byName(r)['turn.scripted'];

    assert.equal(c.severity, 'fail');
    assert.match(c.detail, /internal_error.*boom/);
    assert.equal(r.passed, false);

    // The run was not aborted — the earlier checks all recorded their verdicts.
    assert.equal(byName(r)['config.exists'].severity, 'pass');
    assert.equal(byName(r)['hours.sane'].severity, 'pass');
    // And the synthetic customer did not survive the throw.
    assert.equal((await syntheticResidue(id)).customers, 0);
  });

  it('turn.scripted — an empty reply is a fail (and books nothing)', async () => {
    const id = await makeTenant();
    const r = await runTurn(id, { deps: { ...DEPS, generateReply: async () => '   ' } });
    const c = byName(r)['turn.scripted'];
    assert.equal(c.severity, 'fail');
    assert.match(c.detail, /empty reply/);
    assert.equal((await syntheticResidue(id)).customers, 0);
  });

  it('turn.scripted — aborts (fail) rather than adopt a pre-existing customer on the reserved number', async () => {
    const id = await makeTenant();
    // A real customer squatting the reserved number — the probe must NOT touch it.
    const { rows: [real] } = await db.query(
      'INSERT INTO customers (tenant_id, phone, name) VALUES ($1,$2,$3) RETURNING id',
      [id, scripted.SYNTHETIC_PHONE, 'A Real Human']);

    const r = await runTurn(id);
    const c = byName(r)['turn.scripted'];
    assert.equal(c.severity, 'fail');
    assert.match(c.detail, /already has rows/);
    assert.match(c.detail, /aborting rather than adopting/);

    // Untouched.
    const { rows } = await db.query('SELECT name FROM customers WHERE id=$1', [real.id]);
    assert.equal(rows[0].name, 'A Real Human');
  });

  // Regression: the probe must emit NO domain events. workflowEngine subscribes to
  // '*', so a CUSTOMER_CREATED emit would run a real operator automation for the
  // fake patient and write a workflow_executions row that has no customer FK and
  // therefore never cascades away.
  it('turn.scripted — emits no domain events (no workflow rule fires, no non-cascading rows)', async () => {
    const id = await makeTenant();
    aiService._setModelProvider(scriptedBookingModel());

    // A rule that would fire on customer.created if the probe emitted it.
    await db.query(
      `INSERT INTO workflow_rules (tenant_id, name, trigger_event, conditions, action, action_params, enabled)
       VALUES ($1,'probe-canary','customer.created','{}','add_tag','{"tag":"leaked"}',true)`, [id]);

    const seen = [];
    const bus = require('../../core/events');
    const unsubscribe = bus.on('*', (e) => seen.push(e.type)); // on() returns its own unsubscribe
    // emit() dispatches on setImmediate; drain the loop before asserting silence.
    const drain = () => new Promise((r) => setImmediate(() => setImmediate(r)));
    try {
      const r = await runTurn(id);
      assert.equal(byName(r)['turn.scripted'].severity, 'pass', byName(r)['turn.scripted'].detail);
      await drain();
      assert.deepEqual(seen, [], `probe emitted events: ${seen.join(', ')}`);

      // Positive control: the canary CAN see an emit — otherwise the assertion above
      // would pass vacuously if the wildcard subscription ever silently broke.
      bus.emit('probe.canary', { tenant_id: id });
      await drain();
      assert.deepEqual(seen, ['probe.canary'], 'wildcard listener is live');
    } finally {
      unsubscribe();
    }

    const { rows } = await db.query('SELECT count(*)::int n FROM workflow_executions WHERE tenant_id=$1', [id]);
    assert.equal(rows[0].n, 0, 'no workflow_executions row (it would never cascade away)');
  });

  // Regression: cleanup used to match notifications.content on the synthetic
  // patient name, which the MODEL chooses. A paraphrasing model left a real row
  // behind while the residue check — using the same match — reported zero.
  it('turn.scripted — cleans the booking notification even when the model renames the patient', async () => {
    const id = await makeTenant();
    // A pre-existing notification belonging to someone else — must survive.
    const { rows: [keep] } = await db.query(
      `INSERT INTO notifications (tenant_id, type, content, sent_status)
       VALUES ($1,'appointment_booked','New appointment: Real Person with Dr. Rao at 9am','sent') RETURNING id`, [id]);

    aiService._setModelProvider(scriptedBookingModel({ patientName: 'Zeeon Probe (renamed by the model)' }));
    const r = await runTurn(id);
    assert.equal(byName(r)['turn.scripted'].severity, 'pass', byName(r)['turn.scripted'].detail);

    const { rows } = await db.query(
      "SELECT id FROM notifications WHERE tenant_id=$1 AND type='appointment_booked'", [id]);
    assert.deepEqual(rows.map((x) => x.id), [keep.id],
      'the probe removed exactly its own notification and left the pre-existing one');
  });

  it('turn.scripted — no schedules configured → fail (a clinic that cannot book is not go-live ready)', async () => {
    const id = await makeTenant({ schedule: false });
    const r = await runTurn(id);
    assert.equal(byName(r)['turn.scripted'].severity, 'fail');
    assert.match(byName(r)['turn.scripted'].detail, /no doctor schedules/);
  });

  it('turn.scripted — skip accounting: explicit --skip and the tools.booking gate', async () => {
    const id = await makeTenant();
    const explicit = await runTurn(id, { skip: ['whatsapp.live', 'turn.scripted'] });
    assert.equal(skipMap(explicit)['turn.scripted'], 'explicitly skipped (--skip)');
    assert.ok(!byName(explicit)['turn.scripted'], 'a skipped check never appears in checks[]');
    assert.equal(explicit.passed, true, 'skips never block a pass');

    const gated = await makeTenant({ overrides: { ...PASS_OVERRIDES, tools: { booking: false } } });
    const r = await runTurn(gated);
    assert.equal(skipMap(r)['turn.scripted'], 'tools.booking is false');
  });

  it('turn.scripted — a skipped dynamic check does not block activation', async () => {
    const id = await makeTenant();
    await validatePass(id); // STATIC skips turn.scripted
    const out = await go(id, 'activate');
    assert.equal(out.to, 'live');

    // …and the skip is visible in the recorded run (operator judgment, recorded).
    const latest = await validation.getLatestValidation(id);
    assert.ok(latest.result.skipped.find((s) => s.name === 'turn.scripted'));
  });

  it('turn.scripted is appended to the catalog; the frozen names are unchanged', () => {
    // doctor.schedule (PORTAL-P3-S8) was appended after tenant.legacy_prompt via
    // the same extension path; every name that existed before is still here, in
    // its original position.
    assert.deepEqual(validation.CHECK_NAMES, [
      'config.exists', 'config.schema', 'prompt.renders', 'hours.sane', 'numbers.e164',
      'consent.lines', 'kb.populated', 'kb.retrieval', 'whatsapp.config', 'whatsapp.live',
      'voice.config', 'tenant.legacy_prompt', 'doctor.schedule', 'turn.scripted',
    ]);
  });

  // ── Single writer (structural) ──────────────────────────────────────────────
  // The lifecycle service must be the ONLY place that writes tenants.status or the
  // tenants.active boolean, and it must write them TOGETHER in one statement.
  // Anything else can desync intent (status) from the runtime gate (active).

  it('single-writer: only lifecycleService updates tenants.status / tenants.active', () => {
    const files = [];
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    }
    walk(path.join(__dirname, '../../src'));
    walk(path.join(__dirname, '../../scripts'));

    // `active_handoff_customer =` must NOT count as an `active =` write.
    const STMT = /UPDATE\s+tenants\s+SET([\s\S]*?)WHERE/gi;
    const SETS_STATUS = /\bstatus\s*=/i;
    const SETS_ACTIVE = /(?:^|[^_a-zA-Z])active\s*=/;

    const offenders = [];
    let lifecycleStatements = 0;

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(STMT)) {
        const body = m[1];
        const touchesStatus = SETS_STATUS.test(body);
        const touchesActive = SETS_ACTIVE.test(body);
        if (!touchesStatus && !touchesActive) continue;

        if (path.basename(file) !== 'lifecycleService.js') {
          offenders.push(`${path.relative(process.cwd(), file)}: ${m[0].replace(/\s+/g, ' ').trim()}`);
          continue;
        }
        lifecycleStatements += 1;
        // The atomic requirement: this one statement moves BOTH columns.
        assert.ok(touchesStatus && touchesActive,
          'lifecycleService writes status and active in the SAME statement');
      }
    }

    assert.deepEqual(offenders, [], 'no other code path may write tenants.status / tenants.active');
    assert.equal(lifecycleStatements, 1, 'exactly one status+active writer exists');
  });

  it('single-writer: status and active never diverge across a full arc', async () => {
    const id = await makeTenant();
    const seen = [];
    const snap = async () => seen.push(await statusOf(id));

    await snap();
    await validatePass(id); await snap();
    await go(id, 'activate'); await snap();
    await go(id, 'pause'); await snap();

    for (const s of seen) {
      assert.equal(s.active, s.status === 'live',
        `invariant live⇔active violated at status=${s.status} active=${s.active}`);
    }
    assert.deepEqual(seen.map((s) => s.status), ['draft', 'validated', 'live', 'paused']);
  });
});
