require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone } = require('../../src/utils/phone');
const db                  = require('../../src/db/db');
const identityService     = require('../../src/modules/identity/identityService');
const customerService     = require('../../src/modules/customer/customerService');

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('normalizePhone — unit', () => {
  it('normalizes WhatsApp wa_id (bare digits, CC included)', () => {
    assert.equal(normalizePhone('919999999999'), '+919999999999');
  });

  it('normalizes voice caller_id (leading +, CC included)', () => {
    assert.equal(normalizePhone('+919999999999'), '+919999999999');
  });

  it('normalizes formatted number with spaces', () => {
    assert.equal(normalizePhone('+91 99999 99999'), '+919999999999');
  });

  it('normalizes number with dashes', () => {
    assert.equal(normalizePhone('+91-99999-99999'), '+919999999999');
  });

  it('normalizes number with parentheses', () => {
    assert.equal(normalizePhone('+91(999)9999999'), '+919999999999');
  });

  it('idempotent: normalizing WA bare-digit form twice gives same result', () => {
    const once = normalizePhone('919999999999');
    assert.equal(normalizePhone(once), once);
  });

  it('idempotent: normalizing already-canonical E.164 twice gives same result', () => {
    const e164 = '+919999999999';
    assert.equal(normalizePhone(e164), e164);
  });

  it('throws on empty string', () => {
    assert.throws(() => normalizePhone(''), /invalid phone/);
  });

  it('throws on null', () => {
    assert.throws(() => normalizePhone(null), /invalid phone/);
  });

  it('throws on letters only', () => {
    assert.throws(() => normalizePhone('abcdef'), /invalid phone/);
  });

  it('throws on a number that reduces to just a country code (too short)', () => {
    // '+0' has a leading zero digit which fails [1-9] in E164_RE
    assert.throws(() => normalizePhone('+0'), /invalid phone/);
  });
});

// ── Integration: cross-channel unified-patient resolution (F-003) ─────────────
// Before this fix:
//   WhatsApp stored wa_id as "919999999999" (bare digits).
//   Voice stored caller_id as "+919999999999" (with plus).
//   Same human → two customer rows → split memory.
// After this fix:
//   Both channels normalize to "+919999999999" → one customer row.

const TENANT_1 = '00000000-0000-0000-0000-ff0300000001';
const TENANT_2 = '00000000-0000-0000-0000-ff0300000002';

async function ensureTenant(id, name) {
  await db.query(
    `INSERT INTO tenants (id, business_name, phone_number_id, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (id) DO NOTHING`,
    [id, name, `pnid_f003_${id.slice(-4)}`]
  );
}

async function cleanupTenant(id) {
  await db.query(`DELETE FROM channel_identifiers WHERE tenant_id = $1`, [id]);
  await db.query(`DELETE FROM messages WHERE tenant_id = $1`, [id]);
  await db.query(`DELETE FROM conversations WHERE tenant_id = $1`, [id]);
  await db.query(`DELETE FROM customers WHERE tenant_id = $1`, [id]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [id]);
}

describe('Cross-channel identity resolution — F-003 (integration)', () => {
  before(async () => {
    await cleanupTenant(TENANT_1);
    await cleanupTenant(TENANT_2);
    await ensureTenant(TENANT_1, 'F003 Test Clinic A');
    await ensureTenant(TENANT_2, 'F003 Test Clinic B');
  });

  after(async () => {
    await cleanupTenant(TENANT_1);
    await cleanupTenant(TENANT_2);
    await db.close();
  });

  it('WA (bare digits) then voice (+CC) resolve to the SAME customer row', async () => {
    // WhatsApp delivers wa_id without leading +
    const waCustomer = await identityService.resolveCustomer({
      tenantId: TENANT_1,
      channelType: 'whatsapp',
      identifier: '919999999999',
    });

    // Voice worker delivers caller_id with leading +
    const voiceCustomer = await identityService.resolveCustomer({
      tenantId: TENANT_1,
      channelType: 'voice',
      identifier: '+919999999999',
    });

    assert.equal(
      voiceCustomer.id,
      waCustomer.id,
      'WhatsApp and voice for same number must resolve to the same customer'
    );

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`, [TENANT_1]
    );
    assert.equal(rows[0].n, 1, 'exactly one customer row — no split-memory duplicate');

    // Phone persisted in canonical E.164
    assert.equal(waCustomer.phone, '+919999999999', 'stored phone must be E.164 with +');
  });

  it('voice (bare digits-no-plus) then WA (+CC) — reverse order resolves to SAME customer', async () => {
    // Some telephony stacks send without the + (treated like WA wa_id)
    const voiceFirst = await identityService.resolveCustomer({
      tenantId: TENANT_2,
      channelType: 'voice',
      identifier: '918888888888',
    });

    const waSecond = await identityService.resolveCustomer({
      tenantId: TENANT_2,
      channelType: 'whatsapp',
      identifier: '+918888888888',
    });

    assert.equal(waSecond.id, voiceFirst.id, 'voice-first then WA must resolve to same customer');
  });

  it('findOrCreate (legacy path) also normalizes: bare digits and +CC create ONE row', async () => {
    // Simulate legacy path: first call with bare digits
    const c1 = await customerService.findOrCreate(TENANT_1, '917777777777');
    // Second call with +CC — should hit the ON CONFLICT and return the same row
    const c2 = await customerService.findOrCreate(TENANT_1, '+917777777777');

    assert.equal(c1.id, c2.id, 'legacy findOrCreate must normalize to same customer');
    assert.equal(c1.phone, '+917777777777', 'stored phone should be E.164');
  });

  it('single-channel WA flow still works correctly after normalization', async () => {
    const customer = await identityService.resolveCustomer({
      tenantId: TENANT_1,
      channelType: 'whatsapp',
      identifier: '916666666666',
      profile: { name: 'Single Channel User' },
    });

    assert.ok(customer.id, 'should create customer');
    assert.equal(customer.phone, '+916666666666', 'WA-only customer phone is E.164');
    assert.equal(customer.name, 'Single Channel User');

    // Resolving again should return same customer (direct CI lookup)
    const again = await identityService.resolveCustomer({
      tenantId: TENANT_1,
      channelType: 'whatsapp',
      identifier: '916666666666',
    });
    assert.equal(again.id, customer.id, 'second WA lookup returns same customer');
  });
});
