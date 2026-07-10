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
// be newer than `tenant_configs.updated_at`. Editing config after validating does
// not mutate status; it simply makes the next activate reject with
// STALE_VALIDATION. Config is the thing validation made claims about — once it
// moves, those claims expire.
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

// `tenant_configs.updated_at` is bumped to now() on every write (configService),
// so it is the authoritative "config last moved" timestamp. Null ⇒ no config row.
async function configUpdatedAt(tenantId) {
  const { rows } = await db.query('SELECT updated_at FROM tenant_configs WHERE tenant_id = $1', [tenantId]);
  return rows[0] ? rows[0].updated_at : null;
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

  const cfgAt = await configUpdatedAt(tenant.id);
  if (!cfgAt) {
    throw new LifecycleError('NOT_VALIDATED',
      'tenant has no config — run validate first', { from: tenant.status });
  }
  if (new Date(latest.created_at) <= new Date(cfgAt)) {
    throw new LifecycleError('STALE_VALIDATION',
      'config changed since validation — re-validate',
      { from: tenant.status, validated_at: latest.created_at, config_updated_at: cfgAt });
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

module.exports = { transition, LifecycleError, ACTIONS };
