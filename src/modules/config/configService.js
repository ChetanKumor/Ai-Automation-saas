'use strict';

// configService (Issue 8) — the single source of per-tenant behavior.
//
//   • writeTenantConfig  — deep-merge defaults into the input, validate the
//     WHOLE document strict, then write it transactionally (revision snapshot +
//     head bump). Failed validation writes nothing.
//   • getTenantConfig    — lazy-TTL cached read; re-validates on read and WARNs
//     (never throws) on a stale-schema document, still returning it.
//   • invalidateConfigCache — evict one tenant or the whole cache.
//
// No runtime consumer reads this yet — Issue 9 repoints the brain read-sites.
// The only non-test callers are the admin cache endpoint and the backfill script.

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');
const { configSchema } = require('./schema');
const { clinicDefaults } = require('./defaults');

// ~60s lazy TTL. Freshness is a timestamp comparison on read — there is NO timer
// handle anywhere in this module. Issue 4 taught us a lingering timer is a
// shutdown hazard; a lazy check can't recreate one.
const TTL_MS = 60 * 1000;

// tenant_id -> { config, ts }. `config` is exactly what getTenantConfig returns.
const cache = new Map();

// Thrown by writeTenantConfig on validation failure. Carries Zod's path-level
// issues in a flat shape a future admin PUT can render field-by-field.
class ConfigValidationError extends Error {
  constructor(zodError) {
    super('tenant config failed validation');
    this.name = 'ConfigValidationError';
    this.issues = zodError.issues.map((i) => ({
      path: i.path.join('.'),          // dotted path, '' for a top-level issue
      message: i.message,
      code: i.code,
      ...(i.keys ? { keys: i.keys } : {}), // unrecognized_keys lists the offenders here
    }));
  }
}

// Thrown by writeTenantConfig when the caller passed an `expectedVersion` that no
// longer matches the tenant's current head (optimistic concurrency — Issue 25).
// Carries the live version so the admin PUT can return 409 { current_version }
// and the editor can offer a reload-and-rediff. Nothing is written.
class ConfigConflictError extends Error {
  constructor(currentVersion) {
    super('tenant config version conflict');
    this.name = 'ConfigConflictError';
    this.currentVersion = currentVersion;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `overlay` onto `base`. Objects merge key-by-key; **arrays REPLACE**
// wholesale (a supplied array wins outright — never element-wise merged);
// primitives and null in the overlay replace. Array-replace is deliberate:
// silently unioning a config array (e.g. escalation.phone_numbers) with stale
// defaults is a classic config foot-gun. `base` is never mutated.
function deepMerge(base, overlay) {
  if (!isPlainObject(overlay)) return overlay;            // array / primitive / null replaces
  const out = isPlainObject(base) ? { ...base } : {};
  for (const key of Object.keys(overlay)) {
    const o = overlay[key];
    out[key] = (isPlainObject(o) && isPlainObject(out[key])) ? deepMerge(out[key], o) : o;
  }
  return out;
}

// Write a tenant's config. `source` is free text for the revision log
// ('provision' | 'admin' | 'cli' | 'portal'). Returns { version, config }. Throws
// ConfigValidationError (nothing written) if the merged document is invalid.
//
// `opts.expectedVersion` (optional) enables optimistic concurrency: when set, the
// write asserts the tenant's current head version equals it (0 = no config yet)
// under the same FOR UPDATE lock that serializes writers, throwing
// ConfigConflictError (nothing written) on mismatch. Omit it for the historical
// unconditional-write behavior — existing callers (backfill/provision) are
// unaffected.
//
// `opts.actorUserId` (optional, INV-4) records WHO made the change on the revision
// row (portal owner writes pass their user id). NULL for operator/CLI writes,
// whose provenance is the `source` label. Backward-compatible: existing callers
// that omit it record NULL, exactly as before the column existed (migration 024).
async function writeTenantConfig(tenantId, input, source, opts = {}) {
  if (!tenantId) throw new Error('writeTenantConfig: tenantId is required');
  if (!source) throw new Error('writeTenantConfig: source is required');
  const { expectedVersion, actorUserId = null } = opts;

  // Write-materialize: merge defaults in, validate the whole document strict.
  const parsed = configSchema.safeParse(deepMerge(clinicDefaults, input || {}));
  if (!parsed.success) throw new ConfigValidationError(parsed.error);
  const config = parsed.data;

  const client = await db.getClient();
  let version;
  try {
    await client.query('BEGIN');

    // Serialize concurrent writers for this tenant AND assert it still exists.
    // Plain reads (the hot path) never block on this FOR UPDATE under READ
    // COMMITTED — only another writer for the same tenant does.
    const { rows: locked } = await client.query(
      'SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!locked[0]) throw new Error(`writeTenantConfig: tenant not found: ${tenantId}`);

    const { rows: current } = await client.query(
      'SELECT version FROM tenant_configs WHERE tenant_id = $1', [tenantId]);
    const currentVersion = current[0] ? current[0].version : 0;

    // Optimistic concurrency: reject a write built against a stale view. Checked
    // inside the lock so the compared version can't shift under us.
    if (expectedVersion != null && expectedVersion !== currentVersion) {
      throw new ConfigConflictError(currentVersion);
    }
    version = currentVersion + 1;

    // Append the immutable revision, then move the head. UNIQUE(tenant_id,
    // version) is the backstop should two writers ever race past the lock.
    await client.query(
      `INSERT INTO tenant_config_revisions (tenant_id, version, config, source, actor_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, version, JSON.stringify(config), source, actorUserId]);
    await client.query(
      `INSERT INTO tenant_configs (tenant_id, version, config, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id)
       DO UPDATE SET version = EXCLUDED.version, config = EXCLUDED.config, updated_at = now()`,
      [tenantId, version, JSON.stringify(config)]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  invalidateConfigCache(tenantId); // a fresh write must never be shadowed by a stale entry
  logger.info({ scope: 'config', tenantId, version, source }, 'tenant config written');
  return { version, config };
}

// Read a tenant's config, cached with a lazy ~60s TTL. Returns the config
// document, or null when the tenant has no config row (caller falls back to
// legacy columns until Issues 9/15). Never throws on a stale-schema document.
async function getTenantConfig(tenantId) {
  if (!tenantId) return null; // falsy-guard — never key the cache on '' (Issue 4 lesson)

  const hit = cache.get(tenantId);
  if (hit && (Date.now() - hit.ts) < TTL_MS) return hit.config; // fresh cache hit — no DB, no timer

  const { rows } = await db.query(
    'SELECT config, version FROM tenant_configs WHERE tenant_id = $1', [tenantId]);

  if (!rows[0]) {
    cache.delete(tenantId); // drop any now-stale entry (tenant/config deleted between fills)
    return null;
  }

  // Re-validate on read. On a stale-schema document, WARN with the offending
  // paths and still return the stored doc unchanged — evolution/repair is an
  // Issue-9+ concern; the read path must not throw.
  const stored = rows[0].config;
  const check = configSchema.safeParse(stored);
  let config;
  if (check.success) {
    config = check.data;
  } else {
    config = stored;
    logger.warn(
      { scope: 'config', tenantId, issues: check.error.issues.map((i) => i.path.join('.')) },
      'stored tenant config failed current schema — returning stored doc as-is');
  }

  cache.set(tenantId, { config, version: rows[0].version, ts: Date.now() });
  return config;
}

// The cached config's version, or null when nothing is cached for this tenant.
// Synchronous by design: the only consumer (prompt provenance, Issue 22) calls
// it immediately after an awaited getTenantConfig, so the entry is warm. A
// null here means "version unknown" and is recorded as such — provenance must
// never add a DB round-trip to the turn.
function getCachedConfigVersion(tenantId) {
  const hit = cache.get(tenantId);
  return hit ? (hit.version ?? null) : null;
}

// Evict cached config. With a tenantId → evict just that entry. No arg
// (undefined/null) → full flush. Returns the eviction count.
//
// Presence, not truthiness: an empty-string id is a *scoped* no-op (evicts
// nothing), never a full flush — a stray '' can't nuke every tenant's cache.
// Lazy cache → eviction is a plain Map delete/clear; there are no timers to clear.
function invalidateConfigCache(tenantId) {
  let evicted = 0;
  if (tenantId != null) {
    if (cache.delete(tenantId)) evicted = 1;
    logger.info({ scope: 'config', tenantId, evicted }, 'config cache invalidated');
  } else {
    evicted = cache.size;
    cache.clear();
    logger.info({ scope: 'config-all', evicted }, 'config cache invalidated');
  }
  return evicted;
}

module.exports = {
  writeTenantConfig,
  getTenantConfig,
  getCachedConfigVersion,
  invalidateConfigCache,
  ConfigValidationError,
  ConfigConflictError,
  clinicDefaults,
  configSchema,
  deepMerge, // exported for a focused array-replace/object-merge unit test
};
