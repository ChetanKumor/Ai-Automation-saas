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
// ('provision' | 'admin' | 'cli'). Returns { version, config }. Throws
// ConfigValidationError (nothing written) if the merged document is invalid.
async function writeTenantConfig(tenantId, input, source) {
  if (!tenantId) throw new Error('writeTenantConfig: tenantId is required');
  if (!source) throw new Error('writeTenantConfig: source is required');

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
    version = current[0] ? current[0].version + 1 : 1;

    // Append the immutable revision, then move the head. UNIQUE(tenant_id,
    // version) is the backstop should two writers ever race past the lock.
    await client.query(
      `INSERT INTO tenant_config_revisions (tenant_id, version, config, source)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, version, JSON.stringify(config), source]);
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
    'SELECT config FROM tenant_configs WHERE tenant_id = $1', [tenantId]);

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

  cache.set(tenantId, { config, ts: Date.now() });
  return config;
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
  invalidateConfigCache,
  ConfigValidationError,
  clinicDefaults,
  configSchema,
  deepMerge, // exported for a focused array-replace/object-merge unit test
};
