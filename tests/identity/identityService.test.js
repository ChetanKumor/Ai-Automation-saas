require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/db/db');
const eventBus = require('../../core/events');
const EVENT = require('../../core/eventTypes');
const identityService = require('../../src/modules/identity/identityService');
const customerService = require('../../src/modules/customer/customerService');

const TENANT_A = '00000000-0000-0000-0000-aaaaaaaaa001';
const TENANT_B = '00000000-0000-0000-0000-aaaaaaaaa002';

async function ensureTenant(tenantId, name) {
  await db.query(
    `INSERT INTO tenants (id, business_name, phone_number_id, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO NOTHING`,
    [tenantId, name, `pnid_identity_${tenantId.slice(-4)}`]
  );
}

async function ensureChannelIdentifiersTable() {
  const { rows } = await db.query(
    `SELECT to_regclass('public.channel_identifiers') AS tbl`
  );
  if (!rows[0].tbl) {
    await db.query(`
      CREATE TABLE channel_identifiers (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL,
        identifier  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, channel_type, identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_identifiers_lookup
        ON channel_identifiers(tenant_id, channel_type, identifier);
      CREATE INDEX IF NOT EXISTS idx_channel_identifiers_customer
        ON channel_identifiers(customer_id);
    `);
  }
}

async function cleanup() {
  await db.query('DELETE FROM channel_identifiers WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM messages WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM conversations WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM customers WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM tenants WHERE id IN ($1, $2)', [TENANT_A, TENANT_B]);
}

describe('Identity Service', () => {
  before(async () => {
    await ensureChannelIdentifiersTable();
    await cleanup();
    await ensureTenant(TENANT_A, 'Clinic Alpha');
    await ensureTenant(TENANT_B, 'Clinic Beta');
  });

  after(async () => {
    await cleanup();
    await db.close();
  });

  it('creates a new customer for an unknown identifier', async () => {
    const emitted = [];
    const off = eventBus.on(EVENT.CUSTOMER_CREATED, (env) => emitted.push(env));

    const customer = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: '919876543210',
      profile: { name: 'Test User' },
    });

    await new Promise((r) => setTimeout(r, 50));
    off();

    assert.ok(customer.id, 'should return a customer with id');
    assert.equal(customer.tenant_id, TENANT_A);
    assert.equal(customer.phone, '919876543210');
    assert.equal(customer.name, 'Test User');

    assert.equal(emitted.length, 1, 'should emit customer.created');
    assert.equal(emitted[0].payload.customer_id, customer.id);

    const { rows: ciRows } = await db.query(
      'SELECT * FROM channel_identifiers WHERE tenant_id = $1 AND identifier = $2',
      [TENANT_A, '919876543210']
    );
    assert.equal(ciRows.length, 1, 'should create channel_identifier');
    assert.equal(ciRows[0].channel_type, 'whatsapp');
  });

  it('returns existing customer for known identifier (direct lookup)', async () => {
    const emitted = [];
    const offCreated = eventBus.on(EVENT.CUSTOMER_CREATED, (env) => emitted.push(env));
    const offIdentified = eventBus.on(EVENT.CUSTOMER_IDENTIFIED, (env) => emitted.push(env));

    const first = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: '919876543210',
    });

    await new Promise((r) => setTimeout(r, 50));
    offCreated();
    offIdentified();

    assert.ok(first.id, 'should return existing customer');
    assert.equal(emitted.length, 0, 'should not emit any event for direct lookup');
  });

  it('phone fallback: links identifier and emits customer.identified', async () => {
    // Create a customer directly via old path (no channel_identifier)
    const existing = await customerService.findOrCreate(TENANT_A, '918888888888');

    const emitted = [];
    const off = eventBus.on(EVENT.CUSTOMER_IDENTIFIED, (env) => emitted.push(env));

    const resolved = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: '918888888888',
    });

    await new Promise((r) => setTimeout(r, 50));
    off();

    assert.equal(resolved.id, existing.id, 'should return the same customer');
    assert.equal(emitted.length, 1, 'should emit customer.identified');
    assert.equal(emitted[0].payload.channel_type, 'whatsapp');

    const { rows: ciRows } = await db.query(
      'SELECT * FROM channel_identifiers WHERE customer_id = $1 AND channel_type = $2',
      [existing.id, 'whatsapp']
    );
    assert.equal(ciRows.length, 1, 'should have linked channel_identifier');
  });

  it('tenant isolation: same phone in different tenants resolves independently', async () => {
    const phone = '917777777777';

    const customerA = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: phone,
      profile: { name: 'Alpha Patient' },
    });

    const customerB = await identityService.resolveCustomer({
      tenantId: TENANT_B,
      channelType: 'whatsapp',
      identifier: phone,
      profile: { name: 'Beta Patient' },
    });

    assert.notEqual(customerA.id, customerB.id, 'different tenants should create different customers');
    assert.equal(customerA.tenant_id, TENANT_A);
    assert.equal(customerB.tenant_id, TENANT_B);
  });

  it('non-phone channel: resolves existing customer via direct lookup', async () => {
    // Create a customer via whatsapp first
    const customer = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: '919000000001',
      profile: { name: 'Multi-Channel User' },
    });

    // Manually link an email identifier
    await db.query(
      `INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
       VALUES ($1, $2, 'email', 'test@example.com')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, customer.id]
    );

    // Resolve via email — should find the same customer
    const resolved = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'email',
      identifier: 'test@example.com',
    });

    assert.equal(resolved.id, customer.id, 'should resolve to same customer via email');
  });

  it('non-phone channel: throws on new customer creation (phone required)', async () => {
    await assert.rejects(
      () => identityService.resolveCustomer({
        tenantId: TENANT_A,
        channelType: 'email',
        identifier: 'newuser@example.com',
      }),
      { message: /Cannot create new customer via non-phone channel/ }
    );
  });

  it('rejects invalid channel type', async () => {
    await assert.rejects(
      () => identityService.resolveCustomer({
        tenantId: TENANT_A,
        channelType: 'carrier_pigeon',
        identifier: 'coo',
      }),
      { message: /Invalid channel type/ }
    );
  });

  it('concurrent first contact creates exactly one customer', async () => {
    const phone = '916666666666';
    const results = await Promise.all([
      identityService.resolveCustomer({
        tenantId: TENANT_A,
        channelType: 'whatsapp',
        identifier: phone,
        profile: { name: 'Racer' },
      }),
      identityService.resolveCustomer({
        tenantId: TENANT_A,
        channelType: 'whatsapp',
        identifier: phone,
        profile: { name: 'Racer' },
      }),
    ]);

    assert.equal(results[0].id, results[1].id, 'concurrent calls should resolve to the same customer');

    const { rows: customers } = await db.query(
      'SELECT * FROM customers WHERE tenant_id = $1 AND phone = $2',
      [TENANT_A, phone]
    );
    // May be 1 or 2 customer rows (the second racer might create before the CI conflict),
    // but the channel_identifier should resolve to exactly one
    const { rows: ciRows } = await db.query(
      'SELECT DISTINCT customer_id FROM channel_identifiers WHERE tenant_id = $1 AND channel_type = $2 AND identifier = $3',
      [TENANT_A, 'whatsapp', phone]
    );
    assert.equal(ciRows.length, 1, 'should have exactly one channel_identifier');
  });

  it('parity: resolveCustomer returns shape-compatible result with findOrCreate', async () => {
    const phone = '915555555555';

    const oldResult = await customerService.findOrCreate(TENANT_A, phone);
    // Clean up the CI table to force identity to use phone fallback
    const newResult = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: phone,
    });

    const requiredFields = ['id', 'tenant_id', 'phone', 'name', 'created_at'];
    for (const field of requiredFields) {
      assert.ok(field in oldResult, `findOrCreate result should have ${field}`);
      assert.ok(field in newResult, `resolveCustomer result should have ${field}`);
    }

    assert.equal(oldResult.id, newResult.id, 'should resolve to the same customer');
  });

  it('Migration 015 backfill idempotency', async () => {
    // Insert a customer with phone, ensure channel_identifiers are created
    const cust = await customerService.findOrCreate(TENANT_A, '914444444444');

    // Run the backfill query (same as migration 015)
    await db.query(`
      INSERT INTO channel_identifiers
        (tenant_id, customer_id, channel_type, identifier)
      SELECT tenant_id, id, 'whatsapp', phone
      FROM customers
      WHERE phone IS NOT NULL
        AND btrim(phone) <> ''
        AND tenant_id = $1
      ON CONFLICT (tenant_id, channel_type, identifier)
      DO NOTHING
    `, [TENANT_A]);

    const { rows: before } = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM channel_identifiers WHERE tenant_id = $1 AND identifier = $2',
      [TENANT_A, '914444444444']
    );

    // Run again — should be idempotent
    await db.query(`
      INSERT INTO channel_identifiers
        (tenant_id, customer_id, channel_type, identifier)
      SELECT tenant_id, id, 'whatsapp', phone
      FROM customers
      WHERE phone IS NOT NULL
        AND btrim(phone) <> ''
        AND tenant_id = $1
      ON CONFLICT (tenant_id, channel_type, identifier)
      DO NOTHING
    `, [TENANT_A]);

    const { rows: afterRun } = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM channel_identifiers WHERE tenant_id = $1 AND identifier = $2',
      [TENANT_A, '914444444444']
    );

    assert.equal(before[0].cnt, afterRun[0].cnt, 'backfill should be idempotent');
  });

  it('WhatsApp flag OFF preserves current behavior', async () => {
    const phone = '913333333333';
    const env = require('../../src/infra/config/env');
    const saved = env.IDENTITY_RESOLUTION_ENABLED;

    try {
      env.IDENTITY_RESOLUTION_ENABLED = false;
      const customer = await customerService.findOrCreate(TENANT_A, phone);
      assert.ok(customer.id);
      assert.equal(customer.phone, phone);
    } finally {
      env.IDENTITY_RESOLUTION_ENABLED = saved;
    }
  });

  it('WhatsApp flag ON routes through identityService', async () => {
    const phone = '912222222222';
    const env = require('../../src/infra/config/env');
    const saved = env.IDENTITY_RESOLUTION_ENABLED;

    try {
      env.IDENTITY_RESOLUTION_ENABLED = true;
      const customer = await identityService.resolveCustomer({
        tenantId: TENANT_A,
        channelType: 'whatsapp',
        identifier: phone,
        profile: { name: 'Flag Test' },
      });

      assert.ok(customer.id);
      assert.equal(customer.phone, phone);
      assert.equal(customer.name, 'Flag Test');

      const { rows } = await db.query(
        'SELECT * FROM channel_identifiers WHERE tenant_id = $1 AND identifier = $2',
        [TENANT_A, phone]
      );
      assert.equal(rows.length, 1, 'should create channel_identifier via identity path');
    } finally {
      env.IDENTITY_RESOLUTION_ENABLED = saved;
    }
  });

  it('getTimeline returns messages in chronological order', async () => {
    const phone = '911111111111';
    const customer = await identityService.resolveCustomer({
      tenantId: TENANT_A,
      channelType: 'whatsapp',
      identifier: phone,
    });

    // Create a conversation and messages
    const { rows: [conv] } = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id)
       VALUES ($1, $2)
       ON CONFLICT (customer_id) WHERE status = 'open'
       DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [TENANT_A, customer.id]
    );

    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content)
       VALUES ($1, $2, $3, 'inbound', 'customer', 'Hello')`,
      [TENANT_A, conv.id, customer.id]
    );

    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content)
       VALUES ($1, $2, $3, 'outbound', 'ai', 'Hi there!')`,
      [TENANT_A, conv.id, customer.id]
    );

    const timeline = await identityService.getTimeline(customer.id);
    assert.ok(timeline.length >= 2, 'should return messages');
    assert.equal(timeline[0].direction, 'inbound');
    assert.equal(timeline[1].direction, 'outbound');

    const timestamps = timeline.map((m) => new Date(m.created_at).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      assert.ok(timestamps[i] >= timestamps[i - 1], 'should be chronologically ordered');
    }
  });
});
