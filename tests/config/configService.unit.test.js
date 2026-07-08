'use strict';

// Loader (cache/TTL/invalidate/stale-WARN), deep-merge semantics, and the admin
// endpoint's both-cache eviction. DB + logger are stubbed in the require cache
// BEFORE the modules under test load, so nothing touches Postgres or emits logs.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

// ── Stubs (must land before requires) ────────────────────────────────────────
// Tenant rows for the hot-path lookup (so the admin endpoint can warm the
// tenant cache); config rows for the configService loader. Tests mutate these.
const tenantRows = {
  'pnid-A': { id: TENANT_A, business_name: 'A', phone_number_id: 'pnid-A', wa_token: 'enc-A', ai_prompt: null, ai_enabled: true, owner_notify_phone: null, active_handoff_customer: null },
};
let configRows = {};      // tenant_id -> stored config (object), or absent for "no row"
let cfgReads = 0;         // count of tenant_configs SELECTs (loader DB hits)

const dbPath = require.resolve('../../src/db/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      if (/FROM tenants WHERE phone_number_id/.test(sql)) {
        const row = tenantRows[params[0]];
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/FROM tenant_configs WHERE tenant_id/.test(sql)) {
        cfgReads += 1;
        const cfg = configRows[params[0]];
        return { rows: cfg === undefined ? [] : [{ config: cfg }] };
      }
      return { rows: [] };
    },
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    close: async () => {},
  },
};

const logs = { warn: [], info: [], error: [] };
const logPath = require.resolve('../../src/infra/logging/logger');
require.cache[logPath] = {
  id: logPath, filename: logPath, loaded: true,
  exports: {
    warn: (...a) => logs.warn.push(a),
    info: (...a) => logs.info.push(a),
    error: (...a) => logs.error.push(a),
    debug: () => {},
  },
};

const encPath = require.resolve('../../src/utils/encryption');
require.cache[encPath] = {
  id: encPath, filename: encPath, loaded: true,
  exports: { encrypt: (v) => v, decrypt: (v) => `dec:${v}` },
};

const configService = require('../../src/modules/config/configService');
const tenantService = require('../../src/modules/tenant/tenantService');
const adminRoutes = require('../../src/admin/adminRoutes');

beforeEach(() => {
  configService.invalidateConfigCache();
  tenantService.invalidateTenantCache();
  tenantService.stop();
  configRows = {};
  cfgReads = 0;
  logs.warn.length = logs.info.length = logs.error.length = 0;
});

// A minimal-but-valid stored document for the loader tests.
const storedDoc = () => JSON.parse(JSON.stringify(configService.clinicDefaults));

describe('deepMerge — arrays replace, objects merge', () => {
  it('replaces arrays wholesale and merges objects key-by-key', () => {
    const base = { a: [1, 2, 3], o: { x: 1, y: 2 }, keep: 'me' };
    const overlay = { a: [9], o: { y: 3, z: 4 } };
    assert.deepEqual(configService.deepMerge(base, overlay), {
      a: [9],                       // array REPLACED, not unioned
      o: { x: 1, y: 3, z: 4 },      // object MERGED
      keep: 'me',
    });
  });

  it('does not mutate the base', () => {
    const base = { o: { x: 1 }, a: [1] };
    const snap = JSON.stringify(base);
    configService.deepMerge(base, { o: { y: 2 }, a: [9] });
    assert.equal(JSON.stringify(base), snap);
  });
});

describe('getTenantConfig — cache + TTL', () => {
  it('DB hit on first read, cache hit on second', async () => {
    configRows[TENANT_A] = storedDoc();
    const first = await configService.getTenantConfig(TENANT_A);
    assert.ok(first);
    assert.equal(cfgReads, 1);
    const second = await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, 1, 'second read served from cache');
    assert.equal(second.retention_days, 365);
  });

  it('expires lazily after the TTL and re-reads (no sleep — injected clock)', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    configRows[TENANT_A] = storedDoc();

    await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, 1);

    now += 59_000;                    // still within the ~60s TTL
    await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, 1, 'still cached at 59s');

    now += 2_000;                     // now past the TTL
    await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, 2, 're-read after expiry');
  });

  it('invalidate → next read hits the DB again', async () => {
    configRows[TENANT_A] = storedDoc();
    await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, 1);

    assert.equal(configService.invalidateConfigCache(TENANT_A), 1, 'one entry evicted');
    await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, 2);
  });

  it('missing config row → null', async () => {
    assert.equal(await configService.getTenantConfig(TENANT_A), null);
    assert.equal(cfgReads, 1);
  });

  it('falsy tenantId → null, no DB hit', async () => {
    assert.equal(await configService.getTenantConfig(''), null);
    assert.equal(await configService.getTenantConfig(undefined), null);
    assert.equal(cfgReads, 0);
  });

  it('stale-schema document → WARN with paths, still returns the stored doc', async () => {
    const stale = { ...storedDoc(), bogus_field: 1 }; // unknown key → fails current schema
    configRows[TENANT_A] = stale;

    const out = await configService.getTenantConfig(TENANT_A);
    assert.deepEqual(out, stale, 'returns the stored doc unchanged');
    assert.equal(logs.warn.length, 1, 'one WARN emitted');
    assert.match(logs.warn[0][1], /failed current schema/);
    assert.ok(Array.isArray(logs.warn[0][0].issues), 'WARN carries issue paths');
  });

  it('tenant deleted between fill and expiry → stale entry evicted, returns null, no crash', async (t) => {
    let now = 5_000_000;
    t.mock.method(Date, 'now', () => now);
    configRows[TENANT_A] = storedDoc();

    await configService.getTenantConfig(TENANT_A);   // fill
    delete configRows[TENANT_A];                      // tenant/config deleted
    now += 61_000;                                    // expire the cached entry

    assert.equal(await configService.getTenantConfig(TENANT_A), null, 'no crash, returns null');
    // A subsequent read still misses (entry was evicted, not resurrected).
    const before = cfgReads;
    await configService.getTenantConfig(TENANT_A);
    assert.equal(cfgReads, before + 1);
  });
});

describe('invalidateConfigCache — presence semantics', () => {
  it('empty-string tenantId is a scoped no-op, not a full flush', async () => {
    configRows[TENANT_A] = storedDoc();
    configRows[TENANT_B] = storedDoc();
    await configService.getTenantConfig(TENANT_A);
    await configService.getTenantConfig(TENANT_B);

    assert.equal(configService.invalidateConfigCache(''), 0, 'empty string evicts nothing');

    cfgReads = 0;
    await configService.getTenantConfig(TENANT_A);
    await configService.getTenantConfig(TENANT_B);
    assert.equal(cfgReads, 0, 'both entries survived — no full flush');
  });

  it('no-arg full flush returns the eviction count', async () => {
    configRows[TENANT_A] = storedDoc();
    configRows[TENANT_B] = storedDoc();
    await configService.getTenantConfig(TENANT_A);
    await configService.getTenantConfig(TENANT_B);
    assert.equal(configService.invalidateConfigCache(), 2);
    assert.equal(configService.invalidateConfigCache(), 0, 'idempotent on empty cache');
  });
});

describe('POST /admin/api/cache/invalidate — evicts BOTH caches', () => {
  function startApp() {
    const app = express();
    app.use((req, _res, next) => { req.session = { admin: true }; next(); });
    app.use('/admin', adminRoutes);
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    });
  }
  // X-Zyon-Admin is the custom-header CSRF check the mutating admin APIs now
  // require (Issue 18); attach it centrally so all three cases carry it.
  const post = (url, body) => fetch(`${url}/admin/api/cache/invalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Zyon-Admin': '1' },
    body: JSON.stringify(body || {}),
  });

  it('full flush evicts tenant + config and reports both counts', async () => {
    configRows[TENANT_A] = storedDoc();
    await tenantService.getByPhoneNumberId('pnid-A'); // warm tenant cache
    await configService.getTenantConfig(TENANT_A);    // warm config cache

    const { server, url } = await startApp();
    try {
      const res = await post(url, {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { scope: 'all', evicted: 2, caches: { tenant: 1, config: 1 } });
    } finally { server.close(); }
  });

  it('tenant-scoped evicts that tenant in both caches', async () => {
    configRows[TENANT_A] = storedDoc();
    await tenantService.getByPhoneNumberId('pnid-A');
    await configService.getTenantConfig(TENANT_A);

    const { server, url } = await startApp();
    try {
      const res = await post(url, { tenant_id: TENANT_A });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { scope: 'tenant', evicted: 2, caches: { tenant: 1, config: 1 } });
    } finally { server.close(); }
  });

  it('unknown tenant_id → both counts zero', async () => {
    const { server, url } = await startApp();
    try {
      const res = await post(url, { tenant_id: 'no-such-tenant' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { scope: 'tenant', evicted: 0, caches: { tenant: 0, config: 0 } });
    } finally { server.close(); }
  });
});
