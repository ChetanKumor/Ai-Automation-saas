const db = require('../../db/db');
const { decrypt } = require('../../utils/encryption');
const logger = require('../../infra/logging/logger');

// In-memory tenant credential/config cache — avoids a DB hit (and a wa_token
// decrypt) on every inbound message / voice turn on the hot path.
//
// Single-instance semantics: this cache lives inside one Node process (single
// Railway instance). invalidateTenantCache() evicts *this* process's copy only
// — there is no cross-instance fan-out. Multi-instance invalidation is
// explicitly out of scope; revisit if we ever scale horizontally.
const cache = new Map();   // phone_number_id -> tenant row (with decrypted wa_token)
const timers = new Map();  // phone_number_id -> expiry Timeout handle

const TTL_MS = 5 * 60 * 1000;

// Arm (or re-arm) the per-entry expiry timer for a cache key.
//
// handle.unref() only detaches the timer from event-loop keepalive — it does
// NOT change refresh behavior while the process runs; the entry still expires
// after TTL_MS. Without unref(), every warmed entry would hold the loop alive
// for up to 5 min (a lingering handle at shutdown). Re-arming clears the prior
// handle first, so a key never accumulates more than one live timer — the cache
// has no module-level periodic timer, so this per-key replacement is the whole
// of its "idempotent init" guarantee.
function armExpiry(phoneNumberId) {
  const existing = timers.get(phoneNumberId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    cache.delete(phoneNumberId);
    timers.delete(phoneNumberId);
  }, TTL_MS);
  handle.unref();
  timers.set(phoneNumberId, handle);
}

const getByPhoneNumberId = async (phoneNumberId) => {
  if (cache.has(phoneNumberId)) return cache.get(phoneNumberId);

  const { rows } = await db.query(
    `SELECT id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, owner_notify_phone, active_handoff_customer
     FROM tenants WHERE phone_number_id = $1 AND active = true LIMIT 1`,
    [phoneNumberId]
  );

  if (!rows[0]) return null;

  rows[0].wa_token = decrypt(rows[0].wa_token);

  // Cache for 5 minutes (caches decrypted token — avoids repeated decryption)
  cache.set(phoneNumberId, rows[0]);
  armExpiry(phoneNumberId);

  return rows[0];
};

// Evict a single key's cache entry and its expiry timer. Safe if absent.
function evictKey(phoneNumberId) {
  const handle = timers.get(phoneNumberId);
  if (handle) clearTimeout(handle);
  timers.delete(phoneNumberId);
  cache.delete(phoneNumberId);
}

// Evict cached tenant config/credentials so a change takes effect without a
// redeploy. With a tenantId, evict just that tenant — the cache is keyed by
// phone_number_id, so we scan for the entry whose row.id matches (unknown or
// malformed id → 0, never a broader flush). Omit the argument (undefined/null)
// to full-flush the cache. Returns the eviction count.
//
// Presence, not truthiness: an empty-string id is a *scoped* no-op, not a full
// flush — so a stray '' can never nuke every tenant's cache.
//
// Invalidation only evicts; the next read repopulates from the DB and re-arms
// caching. Issues 8 (configService) and 17 (activation flow) call this directly.
function invalidateTenantCache(tenantId) {
  let evicted = 0;

  if (tenantId != null) {
    for (const [phoneNumberId, row] of cache) {
      if (row.id === tenantId) {
        evictKey(phoneNumberId);
        evicted += 1;
      }
    }
    logger.info({ scope: 'tenant', tenantId, evicted }, 'tenant cache invalidated');
  } else {
    evicted = cache.size;
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
    cache.clear();
    logger.info({ scope: 'all', evicted }, 'tenant cache invalidated');
  }

  return evicted;
}

// Graceful-shutdown hook: clear every outstanding expiry timer so nothing is
// left holding the event loop during drain. Idempotent — safe to call twice.
function stop() {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

module.exports = { getByPhoneNumberId, invalidateTenantCache, stop };
