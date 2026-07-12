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

// Cached tenant lookup by tenant id. Rides the same phone_number_id-keyed
// cache: a warm entry (the webhook/voice path just resolved this tenant) is
// found by scanning row.id — zero DB queries, same scan invalidateTenantCache
// uses. A miss falls back to the existing id → phone_number_id two-step
// (adapter.send / internalVoice pattern), which warms the cache for next time.
const getById = async (tenantId) => {
  if (!tenantId) return null;

  for (const row of cache.values()) {
    if (row.id === tenantId) return row;
  }

  const { rows: [t] } = await db.query(
    'SELECT phone_number_id FROM tenants WHERE id = $1 AND active = true',
    [tenantId]
  );
  if (!t || !t.phone_number_id) return null;
  return getByPhoneNumberId(t.phone_number_id);
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

// Shared tenant-row insert (extracted for Issue 15 so the admin panel and the
// provision CLI create tenants through one place). `runner` is anything with a
// `.query(text, params)` — the db Pool for the panel, or a transaction client
// for provisioning (so tenant + config land atomically). Column set is fixed;
// every field defaults to what the DB defaults were before extraction, so the
// panel's historical insert (which omitted slug/active/status) is byte-identical
// to calling this with those left undefined. Does no encryption — the caller
// passes an already-encrypted wa_token if any.
async function insertTenant(runner, fields = {}) {
  const {
    business_name,
    slug = null,
    phone_number_id = null,
    wa_token = null,
    waba_id = null,
    ai_prompt = null,
    ai_enabled = true,
    active = true,      // DB default; provisioning passes false (born inactive)
    status = 'draft',   // DB default; provisioning is explicit about it
  } = fields;
  if (!business_name) throw new Error('insertTenant: business_name is required');
  const { rows } = await runner.query(
    `INSERT INTO tenants
       (business_name, slug, phone_number_id, wa_token, waba_id, ai_prompt, ai_enabled, active, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, business_name, created_at`,
    [business_name, slug, phone_number_id, wa_token, waba_id, ai_prompt, ai_enabled, active, status]
  );
  return rows[0];
}

module.exports = { getByPhoneNumberId, getById, invalidateTenantCache, stop, insertTenant };
