'use strict';

// Unit tests for F-001: voice turn hydration must not require WhatsApp credentials.
//
// RED (before fix): getById(voiceOnlyId) returned null (two-step path bailed on
// phone_number_id NULL); getByPhoneNumberId with wa_token NULL threw TypeError
// from decrypt(null). GREEN (after fix): direct full-row fetch by id + lazy
// decrypt.
//
// Stubs must land in require.cache BEFORE tenantService is required.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TENANT_WA    = '00000000-0000-0000-0000-f001000000a1'; // WA tenant, wa_token set
const TENANT_VOICE = '00000000-0000-0000-0000-f001000000a2'; // voice-only, phone_number_id NULL
const TENANT_WANULL = '00000000-0000-0000-0000-f001000000a3'; // phone_number_id set, wa_token NULL

const rowsById = {
  [TENANT_WA]: {
    id: TENANT_WA,
    business_name: 'WA Clinic',
    phone_number_id: 'pnid-wa-f001',
    wa_token: 'enc-token',
    ai_prompt: null,
    ai_enabled: true,
    owner_notify_phone: null,
    active_handoff_customer: null,
  },
  [TENANT_VOICE]: {
    id: TENANT_VOICE,
    business_name: 'Voice-Only Clinic',
    phone_number_id: null,
    wa_token: null,
    ai_prompt: null,
    ai_enabled: true,
    owner_notify_phone: null,
    active_handoff_customer: null,
  },
  [TENANT_WANULL]: {
    id: TENANT_WANULL,
    business_name: 'WA-No-Token Clinic',
    phone_number_id: 'pnid-wanull-f001',
    wa_token: null,
    ai_prompt: null,
    ai_enabled: true,
    owner_notify_phone: null,
    active_handoff_customer: null,
  },
};

// Also index by phone_number_id for getByPhoneNumberId calls.
const rowsByPnid = {};
for (const row of Object.values(rowsById)) {
  if (row.phone_number_id) rowsByPnid[row.phone_number_id] = row;
}

let decryptCalls = 0;

const dbPath = require.resolve('../../src/db/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (_sql, params) => {
      const key = params[0];
      const row = rowsById[key] || rowsByPnid[key];
      return { rows: row ? [{ ...row }] : [] };
    },
    close: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  },
};

const encPath = require.resolve('../../src/utils/encryption');
require.cache[encPath] = {
  id: encPath, filename: encPath, loaded: true,
  exports: {
    encrypt: (v) => v,
    decrypt: (v) => { decryptCalls++; return `dec:${v}`; },
  },
};

const tenantService = require('../../src/modules/tenant/tenantService');

beforeEach(() => {
  tenantService.invalidateTenantCache();
  decryptCalls = 0;
});
afterEach(() => {
  tenantService.stop();
  tenantService.invalidateTenantCache();
});

// ── getById — voice-only tenant (F-001 red cases) ───────────────────────────

describe('tenantService.getById — voice-only tenant (F-001)', () => {
  it('returns the tenant when phone_number_id is NULL (was null before fix)', async () => {
    const t = await tenantService.getById(TENANT_VOICE);
    assert.ok(t, 'tenant resolved');
    assert.equal(t.id, TENANT_VOICE);
    assert.equal(t.business_name, 'Voice-Only Clinic');
    assert.equal(t.phone_number_id, null);
  });

  it('does NOT call decrypt when wa_token is NULL', async () => {
    await tenantService.getById(TENANT_VOICE);
    assert.equal(decryptCalls, 0, 'decrypt must not be called for null wa_token');
  });

  it('voice-only tenant is cached after the first call', async () => {
    await tenantService.getById(TENANT_VOICE);
    // Second call should return the same object reference (cache hit).
    const first = await tenantService.getById(TENANT_VOICE);
    const second = await tenantService.getById(TENANT_VOICE);
    assert.equal(first, second, 'cache returned same reference on warm hit');
  });

  it('invalidateTenantCache(tenantId) evicts the voice-only entry', async () => {
    await tenantService.getById(TENANT_VOICE);
    const evicted = tenantService.invalidateTenantCache(TENANT_VOICE);
    assert.equal(evicted, 1, 'one entry evicted for voice-only tenant');
  });
});

// ── getById — wa_token NULL with phone_number_id set (F-001 red case 2) ─────

describe('tenantService.getById — wa_token NULL tenant (F-001)', () => {
  it('returns the tenant when phone_number_id is set but wa_token is NULL', async () => {
    const t = await tenantService.getById(TENANT_WANULL);
    assert.ok(t, 'tenant resolved');
    assert.equal(t.id, TENANT_WANULL);
    assert.equal(t.wa_token, null, 'wa_token stays null — no decrypt attempted');
  });

  it('does NOT call decrypt when wa_token is NULL', async () => {
    await tenantService.getById(TENANT_WANULL);
    assert.equal(decryptCalls, 0, 'decrypt must not be called for null wa_token');
  });
});

// ── getByPhoneNumberId — lazy decrypt regression guard ───────────────────────

describe('tenantService.getByPhoneNumberId — lazy decrypt (F-001 regression)', () => {
  it('decrypts wa_token when it is non-null (WA path unaffected)', async () => {
    const t = await tenantService.getByPhoneNumberId('pnid-wa-f001');
    assert.ok(t);
    assert.equal(t.wa_token, 'dec:enc-token', 'wa_token decrypted correctly');
    assert.equal(decryptCalls, 1, 'decrypt called exactly once');
  });

  it('returns tenant without throwing when wa_token is NULL', async () => {
    const t = await tenantService.getByPhoneNumberId('pnid-wanull-f001');
    assert.ok(t, 'tenant resolved');
    assert.equal(t.wa_token, null, 'wa_token stays null');
    assert.equal(decryptCalls, 0, 'decrypt not called');
  });
});

// ── getById — null / missing tenant ─────────────────────────────────────────

describe('tenantService.getById — null / missing (F-001)', () => {
  it('getById(null) returns null', async () => {
    assert.equal(await tenantService.getById(null), null);
  });

  it('getById(undefined) returns null', async () => {
    assert.equal(await tenantService.getById(undefined), null);
  });

  it('getById for non-existent id returns null', async () => {
    const result = await tenantService.getById('00000000-0000-0000-0000-000000000099');
    assert.equal(result, null);
  });
});

// ── WA tenant via getById — cross-cache regression ──────────────────────────

describe('tenantService.getById — WA tenant regression (F-001)', () => {
  it('WA tenant: wa_token decrypted when present', async () => {
    const t = await tenantService.getById(TENANT_WA);
    assert.ok(t);
    assert.equal(t.wa_token, 'dec:enc-token');
    assert.equal(decryptCalls, 1);
  });

  it('WA tenant cached by phone_number_id (getByPhoneNumberId also hits cache)', async () => {
    await tenantService.getById(TENANT_WA);
    // Cache is now warm under phone_number_id; a getByPhoneNumberId call
    // should return the same object (cache hit, no second DB query).
    const t2 = await tenantService.getByPhoneNumberId('pnid-wa-f001');
    assert.equal(t2.id, TENANT_WA, 'same tenant returned via pnid lookup');
    assert.equal(decryptCalls, 1, 'decrypt called only once — cache hit');
  });
});
