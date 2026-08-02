'use strict';

// Tenant lifecycle (Issue 17) — the guarded path from a provisioned draft to a
// live tenant, and back.
//
//   draft ──validate(pass)──▶ validated ──activate──▶ live ──pause──▶ paused
//     ▲                          │                                      │
//     └──────── (validate fails: status untouched) ───────────────┘     │
//                                                                       │
//   resume is NOT a transition: a paused tenant goes back through       │
//   validate → activate. Re-validation is mandatory. ◀──────────────────┘
//
// ── The single writer ────────────────────────────────────────────────────────
// `writeStatus` below is the ONLY code path in this repo that writes
// `tenants.status` or the `tenants.active` boolean. Both columns move in ONE
// statement, so they can never disagree:
//
//     status === 'live'  ⇔  active = true
//
// This is the deferred Issue-9 reconciliation. `status` is operator intent;
// `active` remains the runtime gate — tenantService.getByPhoneNumberId() selects
// `WHERE phone_number_id = $1 AND active = true`, so a non-live tenant simply
// does not resolve and no AI reply is ever produced on either channel. Keeping
// them lock-step in one UPDATE is what makes "paused" actually mean silent.
// (`ai_enabled` is the owner's orthogonal AI toggle and is never touched here.)
//
// ── The freshness invariant ──────────────────────────────────────────────────
// Activation requires the tenant's LATEST validation run to have passed AND to
// be newer than every input the catalog measures — see validationInputsChangedAt
// below. Editing those inputs after validating does not mutate status; it simply
// makes the next activate reject with STALE_VALIDATION. They are the things
// validation made claims about — once they move, those claims expire.
//
// Race (documented, not locked): two concurrent validate runs both INSERT into
// validation_runs; activate reads the newest by created_at. Latest-wins. There is
// no lock — an operator racing themselves gets the later verdict, which is the
// intuitive outcome, and both runs remain in the audit history.

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');
const tenantService = require('./tenantService');
const configService = require('../config/configService');
const validationService = require('../validation/validationService');

const ACTIONS = ['validate', 'activate', 'pause'];

// Structured failure. `code` is the machine-readable reason the routes/CLI render
// verbatim; VALIDATION_FAILED carries the first failing check name as
// `VALIDATION_FAILED:<check>` so an operator sees WHAT blocked them.
class LifecycleError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ── THE SINGLE WRITER ────────────────────────────────────────────────────────
// Do not add another `UPDATE tenants SET status` / `SET active` anywhere. A
// structure test greps for exactly that.
async function writeStatus(tenantId, status) {
  const active = status === 'live'; // live ⇒ active; anything else ⇒ inactive
  const { rows } = await db.query(
    `UPDATE tenants SET status = $2, active = $3 WHERE id = $1
     RETURNING id, status, active`,
    [tenantId, status, active]
  );
  if (!rows[0]) throw new LifecycleError('NOT_FOUND', `tenant not found: ${tenantId}`);
  return rows[0];
}

// Evict both per-tenant caches so a status flip takes effect on the next inbound
// rather than up to 5 minutes later. On pause this is load-bearing: the tenant
// cache holds a decrypted-credential row keyed by phone_number_id, and a stale
// entry would keep the AI answering for a paused tenant.
//
// Observed, and honest about the seam: these caches are per-PROCESS (see
// tenantService — single-instance semantics, no cross-instance fan-out).
//   • Panel pause runs INSIDE the server process → the warm entry is evicted
//     immediately (logged as `evicted: 1`) and the very next WhatsApp inbound
//     fails to resolve the tenant. Gate is instant.
//   • CLI pause runs in its OWN process → it evicts nothing in the server. The
//     VOICE path is unaffected (internalVoice re-reads `active = true` straight
//     from the DB on every turn/call-start, so it gates immediately), but the
//     WhatsApp path reads through this 5-minute cache and can keep answering
//     until the entry expires. Prefer the panel button — or accept the lag — for
//     an urgent pause on a running instance.
// Pause during an in-flight conversation: the current turn completes (it already
// holds its tenant row); the NEXT inbound hits the gate.
function invalidateCaches(tenantId) {
  const tenant = tenantService.invalidateTenantCache(tenantId);
  const config = configService.invalidateConfigCache(tenantId);
  return { tenant, config };
}

async function loadTenant(tenantId) {
  const { rows } = await db.query('SELECT id, slug, business_name, status, active FROM tenants WHERE id = $1', [tenantId]);
  if (!rows[0]) throw new LifecycleError('NOT_FOUND', `tenant not found: ${tenantId}`);
  return rows[0];
}

// ── "When did anything validation measures last move?" (F1) ──────────────────
// THE staleness source. One query, read by the activation guard below AND by the
// portal's readiness snapshot (`src/portal/routes.js`), so the button an owner
// sees and the refusal the server issues are computed from the same number and
// cannot drift.
//
// This used to read `tenant_configs.updated_at` alone, and that was wrong in a
// way nothing caught for six sessions: the catalog does not measure only config.
//   • kb.populated / kb.retrieval   → knowledge_chunks  (FAQs, and Documents in v1.1)
//   • doctor.schedule / turn.scripted → tenant_entities (doctor schedules)
// A FAQ write therefore moved the thing kb.populated counts without moving the
// measurement, so a run reported itself CURRENT while its knowledge verdict was
// already out of date. That is F1.
//
// ⚠️ INSERTS ONLY, and this is a schema limitation, not a choice.
// `knowledge_chunks` and `tenant_entities` carry `created_at` and no `updated_at`
// (schema.sql: no `set_updated_at` trigger on either). So a FAQ or doctor EDIT
// (`UPDATE ... SET data/content`) and a DELETE are invisible here — max(created_at)
// cannot rise on an edit and can only fall on a delete. The fix is one migration
// adding `updated_at` + the existing trigger to both tables; until then the
// residual is bounded by the portal always re-validating before it activates
// (see routes.js runGoLiveChain), so a deletion below a threshold is still
// refused at the press. Recorded as F1-R1 in docs/os/state.md.
//
// ⚠️ `tenants.updated_at` is deliberately NOT in this union even though
// whatsapp.config/live and tenant.legacy_prompt read that row. `writeStatus`
// above UPDATEs `tenants`, and the table has a BEFORE UPDATE trigger — so
// including it would bump the timestamp past the very run that just succeeded
// and mark every validated tenant permanently stale. Those columns are operator-
// written anyway; no portal surface can move them.
//
// Cost: three tenant-scoped lookups in ONE round trip. `tenant_configs` is a PK
// hit; the two max() aggregates ride `idx_knowledge_chunks_tenant` and
// `idx_tenant_entities_tenant_type` over a single clinic's rows (tens, not
// thousands) — not index-only, but bounded by the tenant. It REPLACES the single
// query it grew out of, so the readiness read is still three queries total.
//
// Returns { configAt, inputsAt }. `configAt` is kept separate because "no config
// row at all" is a different refusal from "your config moved", and collapsing
// them would let a configless tenant with one FAQ past the wrong guard.
// GREATEST ignores NULLs in Postgres, so a tenant with no FAQs and no doctors
// still yields its config timestamp.
async function validationInputsChangedAt(tenantId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT updated_at FROM tenant_configs WHERE tenant_id = $1) AS config_at,
       GREATEST(
         (SELECT updated_at      FROM tenant_configs   WHERE tenant_id = $1),
         (SELECT max(created_at) FROM knowledge_chunks WHERE tenant_id = $1),
         (SELECT max(created_at) FROM tenant_entities  WHERE tenant_id = $1)
       ) AS inputs_at`,
    [tenantId]);
  const r = rows[0] || {};
  return { configAt: r.config_at || null, inputsAt: r.inputs_at || null };
}

// ── Actions ──────────────────────────────────────────────────────────────────

// Run the full catalog. On pass: status → validated. On fail: status UNTOUCHED
// and a structured throw naming the first failing check.
//
// Refused on a live tenant: a pass would demote live → validated, which flips
// active=false and silently takes a serving tenant offline. Pause it first.
async function doValidate(tenant, opts) {
  if (tenant.status === 'live') {
    throw new LifecycleError('INVALID_TRANSITION',
      'cannot validate a live tenant — pause it first (a passing run would demote it to validated and take it offline)',
      { from: tenant.status });
  }

  const run = await validationService.validateTenant(tenant.id, opts.validate || {});

  if (!run.passed) {
    const firstFail = run.checks.find((c) => c.severity === 'fail');
    const name = firstFail ? firstFail.name : 'unknown';
    throw new LifecycleError(`VALIDATION_FAILED:${name}`,
      `validation failed on ${name}: ${firstFail ? firstFail.detail : 'no detail'}`,
      { from: tenant.status, run });
  }

  const updated = await writeStatus(tenant.id, 'validated');
  logger.info({ scope: 'lifecycle', tenantId: tenant.id, from: tenant.status, to: 'validated' },
    'tenant lifecycle transition');
  return { from: tenant.status, to: updated.status, active: updated.active, run };
}

// validated + fresh ⇒ live (active=true). Everything else is refused, loudly.
async function doActivate(tenant) {
  if (tenant.status === 'live') {
    throw new LifecycleError('INVALID_TRANSITION', 'tenant is already live', { from: tenant.status });
  }
  if (tenant.status !== 'validated') {
    throw new LifecycleError('NOT_VALIDATED',
      `tenant is '${tenant.status}' — run validate first (a passing run is required to activate)`,
      { from: tenant.status });
  }

  const latest = await validationService.getLatestValidation(tenant.id);
  if (!latest || !latest.passed) {
    throw new LifecycleError('NOT_VALIDATED',
      'no passing validation run on record — run validate first', { from: tenant.status });
  }

  const { configAt, inputsAt } = await validationInputsChangedAt(tenant.id);
  if (!configAt) {
    throw new LifecycleError('NOT_VALIDATED',
      'tenant has no config — run validate first', { from: tenant.status });
  }
  if (new Date(latest.created_at) <= new Date(inputsAt)) {
    throw new LifecycleError('STALE_VALIDATION',
      'settings changed since validation — re-validate',
      { from: tenant.status, validated_at: latest.created_at, config_updated_at: inputsAt });
  }

  const updated = await writeStatus(tenant.id, 'live');
  const evicted = invalidateCaches(tenant.id);
  logger.info(
    { scope: 'lifecycle', tenantId: tenant.id, from: tenant.status, to: 'live', active: updated.active, evicted },
    'tenant lifecycle transition');
  return { from: tenant.status, to: updated.status, active: updated.active, validation_run_id: latest.id };
}

// live ⇒ paused (active=false). Always allowed from live; nothing else.
async function doPause(tenant) {
  if (tenant.status !== 'live') {
    throw new LifecycleError('INVALID_TRANSITION',
      `cannot pause a '${tenant.status}' tenant — only a live tenant can be paused`, { from: tenant.status });
  }
  const updated = await writeStatus(tenant.id, 'paused');
  const evicted = invalidateCaches(tenant.id);
  logger.info(
    { scope: 'lifecycle', tenantId: tenant.id, from: tenant.status, to: 'paused', active: updated.active, evicted },
    'tenant lifecycle transition');
  return { from: tenant.status, to: updated.status, active: updated.active };
}

// ── Public API ───────────────────────────────────────────────────────────────
// transition(tenantId, action, opts) — the one entry point. Throws LifecycleError
// with a structured `code`; the routes and CLI render that verbatim.
//   opts.validate — passed through to validateTenant (e.g. { skip: [...] }).
async function transition(tenantId, action, opts = {}) {
  if (!tenantId) throw new LifecycleError('INVALID_TRANSITION', 'transition: tenantId is required');
  if (!ACTIONS.includes(action)) {
    throw new LifecycleError('INVALID_TRANSITION', `unknown action '${action}' (expected: ${ACTIONS.join(' | ')})`);
  }

  const tenant = await loadTenant(tenantId);

  if (action === 'validate') return doValidate(tenant, opts);
  if (action === 'activate') return doActivate(tenant);
  return doPause(tenant);
}

module.exports = { transition, validationInputsChangedAt, LifecycleError, ACTIONS };
