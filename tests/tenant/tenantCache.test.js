const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ── Stubs must land in the require cache BEFORE the modules under test are
// required, so tenantService/adminRoutes never touch a real DB or read a real
// ENCRYPTION_KEY. ───────────────────────────────────────────────────────────
const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

const rowsByPnid = {
  'pnid-A': { id: TENANT_A, business_name: 'A', phone_number_id: 'pnid-A', wa_token: 'enc-A', ai_prompt: null, ai_enabled: true, owner_notify_phone: null, active_handoff_customer: null },
  'pnid-B': { id: TENANT_B, business_name: 'B', phone_number_id: 'pnid-B', wa_token: 'enc-B', ai_prompt: null, ai_enabled: true, owner_notify_phone: null, active_handoff_customer: null },
};

let dbQueryCalls = 0;
const dbPath = require.resolve('../../src/db/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (_sql, params) => {
      dbQueryCalls += 1;
      const row = rowsByPnid[params[0]];
      return { rows: row ? [{ ...row }] : [] };
    },
    close: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  },
};

const encPath = require.resolve('../../src/utils/encryption');
require.cache[encPath] = {
  id: encPath, filename: encPath, loaded: true,
  exports: { encrypt: (v) => v, decrypt: (v) => `dec:${v}` },
};

const tenantService = require('../../src/modules/tenant/tenantService');
const adminRoutes = require('../../src/admin/adminRoutes');

// Deterministic starting state for every test (cache is a module singleton).
beforeEach(() => {
  tenantService.invalidateTenantCache(); // full flush + clear real timers
  dbQueryCalls = 0;
});
afterEach(() => {
  tenantService.stop();
  tenantService.invalidateTenantCache();
});

// A fake timer factory so timer hygiene is asserted deterministically without
// waiting on real 5-min timeouts.
function installFakeTimers(t) {
  const created = [];
  t.mock.method(global, 'setTimeout', (fn, ms) => {
    const h = { fn, ms, cleared: false, unref: t.mock.fn(function () { return h; }) };
    created.push(h);
    return h;
  });
  t.mock.method(global, 'clearTimeout', (h) => { if (h && typeof h === 'object') h.cleared = true; });
  return created;
}

describe('tenant cache — timer hygiene', () => {
  it('arms exactly one unref\'d expiry timer when a key is first cached', async (t) => {
    const timers = installFakeTimers(t);

    const first = await tenantService.getByPhoneNumberId('pnid-A');
    assert.ok(first, 'tenant resolved');
    assert.equal(timers.length, 1, 'one expiry timer armed on first cache');
    assert.equal(timers[0].ms, 5 * 60 * 1000, 'TTL is 5 minutes');
    assert.equal(timers[0].unref.mock.callCount(), 1, 'unref() called on creation');

    // Cache hit: no new DB query, no second timer for the same key.
    const second = await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(second, first);
    assert.equal(dbQueryCalls, 1, 'second read served from cache');
    assert.equal(timers.length, 1, 'one timer per key — no double registration');
  });

  it('re-warming a key clears the previous timer (no leak)', async (t) => {
    const timers = installFakeTimers(t);

    await tenantService.getByPhoneNumberId('pnid-A');          // timer #0
    assert.equal(timers.length, 1);

    tenantService.invalidateTenantCache(TENANT_A);            // evict + clear #0
    assert.equal(timers[0].cleared, true, 'invalidate cleared the timer');

    await tenantService.getByPhoneNumberId('pnid-A');          // timer #1
    assert.equal(timers.length, 2, 'a fresh timer after re-warm');
  });

  it('stop() clears every outstanding timer and is idempotent', async (t) => {
    const timers = installFakeTimers(t);

    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-B');
    assert.equal(timers.length, 2);

    tenantService.stop();
    assert.ok(timers.every((h) => h.cleared), 'all timers cleared on stop()');
    assert.doesNotThrow(() => tenantService.stop(), 'second stop() is a no-op');
  });
});

describe('tenant cache — invalidation', () => {
  it('second read is served from cache (no DB hit)', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(dbQueryCalls, 1, 'second read served from cache');
  });

  it('invalidateTenantCache(tenantId) evicts that tenant, then it repopulates', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(dbQueryCalls, 1);

    const evicted = tenantService.invalidateTenantCache(TENANT_A);
    assert.equal(evicted, 1, 'one entry evicted');

    await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(dbQueryCalls, 2, 'read after invalidation hits DB again');

    // Repopulated: subsequent reads are cached again (hot path stays warm).
    await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(dbQueryCalls, 2, 'repopulated cache serves later reads');
  });

  it('full flush evicts every entry', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-B');
    assert.equal(dbQueryCalls, 2);

    const evicted = tenantService.invalidateTenantCache();
    assert.equal(evicted, 2, 'both entries flushed');

    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-B');
    assert.equal(dbQueryCalls, 4, 'both re-read from DB after flush');
  });

  it('unknown tenant_id → evicted 0, cache untouched', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(dbQueryCalls, 1);

    assert.equal(tenantService.invalidateTenantCache('no-such-tenant'), 0);

    await tenantService.getByPhoneNumberId('pnid-A');
    assert.equal(dbQueryCalls, 1, 'existing entry still cached');
  });

  it('full flush on an empty cache → 0', () => {
    assert.equal(tenantService.invalidateTenantCache(), 0);
  });

  it('empty-string tenantId is a scoped no-op, not a full flush', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-B');
    assert.equal(dbQueryCalls, 2);

    assert.equal(tenantService.invalidateTenantCache(''), 0, 'no match → evicts nothing');

    // Both entries survive — a stray '' must not nuke the whole cache.
    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-B');
    assert.equal(dbQueryCalls, 2, 'empty-string did not flush the cache');
  });
});

describe('POST /admin/api/cache/invalidate', () => {
  function startApp({ authed }) {
    const app = express();
    app.use((req, _res, next) => { req.session = authed ? { admin: true } : {}; next(); });
    app.use('/admin', adminRoutes);
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
      });
    });
  }

  function post(url, body) {
    return fetch(`${url}/admin/api/cache/invalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  it('401 without a session', async () => {
    const { server, url } = await startApp({ authed: false });
    try {
      const res = await post(url, {});
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('200 full flush with a session', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    const { server, url } = await startApp({ authed: true });
    try {
      const res = await post(url, {});
      assert.equal(res.status, 200);
      // Issue 8: endpoint now evicts both caches. Config cache is empty here.
      assert.deepEqual(await res.json(), { scope: 'all', evicted: 1, caches: { tenant: 1, config: 0 } });
    } finally { server.close(); }
  });

  it('200 tenant-scoped with a session', async () => {
    await tenantService.getByPhoneNumberId('pnid-A');
    await tenantService.getByPhoneNumberId('pnid-B');
    const { server, url } = await startApp({ authed: true });
    try {
      const res = await post(url, { tenant_id: TENANT_A });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { scope: 'tenant', evicted: 1, caches: { tenant: 1, config: 0 } });
    } finally { server.close(); }
  });

  it('200 unknown tenant_id → evicted 0', async () => {
    const { server, url } = await startApp({ authed: true });
    try {
      const res = await post(url, { tenant_id: 'no-such-tenant' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { scope: 'tenant', evicted: 0, caches: { tenant: 0, config: 0 } });
    } finally { server.close(); }
  });
});
