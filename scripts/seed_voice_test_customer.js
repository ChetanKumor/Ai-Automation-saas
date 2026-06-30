'use strict';

/**
 * Seed a RETURNING customer (with prior WhatsApp history + memory) for the PR7
 * local voice e2e. Running this makes the identity proof observable:
 *
 *   worker call/start(caller_id = VOICE_DEV_CALLER_NUMBER)
 *     → identityService matches this customer by phone
 *     → reuses their EXISTING open WhatsApp conversation
 *     → the brain's spoken reply reflects this prior history + memory,
 *       proving voice and WhatsApp share one customer / conversation / memory.
 *
 * Idempotent: re-running resets the seeded conversation's messages and re-upserts
 * the tenant, schedule, customer, identifier, and memory.
 *
 *   node scripts/seed_voice_test_customer.js
 *
 * Env (all optional; defaults shown):
 *   VOICE_TENANT_ID          11111111-1111-1111-1111-111111111111
 *   VOICE_DEV_CALLER_NUMBER  +919000000001
 *   VOICE_DEV_PHONE_NUMBER_ID pnid_voice_dev
 */

require('dotenv').config();

const db = require('../src/db/db');
const { encrypt } = require('../src/utils/encryption');

const TENANT_ID = process.env.VOICE_TENANT_ID || '11111111-1111-1111-1111-111111111111';
const CALLER = process.env.VOICE_DEV_CALLER_NUMBER || '+919000000001';
const PHONE_NUMBER_ID = process.env.VOICE_DEV_PHONE_NUMBER_ID || 'pnid_voice_dev';

async function seed() {
  // 1. Tenant (wa_token is encrypted — tenantService decrypts it on hydrate).
  await db.query(
    `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
     VALUES ($1, 'Smile Dental (Voice Dev)', $2, $3,
             'You are the friendly receptionist for Smile Dental. Help callers with dental queries and appointments.',
             true, true)
     ON CONFLICT (id) DO UPDATE SET
       business_name   = EXCLUDED.business_name,
       phone_number_id = EXCLUDED.phone_number_id,
       wa_token        = EXCLUDED.wa_token,
       ai_prompt       = EXCLUDED.ai_prompt,
       ai_enabled      = true,
       active          = true`,
    [TENANT_ID, PHONE_NUMBER_ID, encrypt('dummy-wa-token')]
  );

  // 2. Doctor schedule (so the "book an appointment" turn can fire book_appointment).
  await db.query("DELETE FROM tenant_entities WHERE tenant_id = $1 AND type = 'schedule'", [TENANT_ID]);
  await db.query(
    "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, 'schedule', $2)",
    [TENANT_ID, JSON.stringify({
      doctor: 'Dr. Rao',
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      start: '09:00', end: '18:00', slot_minutes: 30,
    })]
  );

  // 3. Returning customer (preferred_language left NULL so the first voice turn's
  //    STT detection persists the prior — proving language write-back).
  const { rows: [customer] } = await db.query(
    `INSERT INTO customers (tenant_id, phone, name, last_seen_at)
     VALUES ($1, $2, 'Ravi Kumar', NOW())
     ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name, last_seen_at = NOW()
     RETURNING *`,
    [TENANT_ID, CALLER]
  );

  // 4. WhatsApp channel identifier (the prior channel). Voice gets linked at call/start.
  await db.query(
    `INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
     VALUES ($1, $2, 'whatsapp', $3)
     ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING`,
    [TENANT_ID, customer.id, CALLER]
  );

  // 5. The customer's single OPEN conversation (channel whatsapp). call/start's
  //    getOrCreateOpenConversation will REUSE this exact row for the voice call.
  const { rows: [conversation] } = await db.query(
    `INSERT INTO conversations (tenant_id, customer_id, channel)
     VALUES ($1, $2, 'whatsapp')
     ON CONFLICT (tenant_id, customer_id) WHERE status = 'open'
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [TENANT_ID, customer.id]
  );

  // 6. Prior WhatsApp history (reset for idempotency, then seed a short thread).
  await db.query('DELETE FROM messages WHERE conversation_id = $1', [conversation.id]);
  const history = [
    ['inbound', 'customer', 'Namaste, naa peru Ravi. Meeru dental checkup chestara?'],
    ['outbound', 'ai', 'Namaste Ravi! Avunu, Dr. Rao tho dental checkup available. Meeku appointment kavala?'],
    ['inbound', 'customer', 'Tarvata cheptanu, thanks.'],
  ];
  for (const [direction, sender, content] of history) {
    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'whatsapp', 'text')`,
      [TENANT_ID, conversation.id, customer.id, direction, sender, content]
    );
  }

  // 7. Long-term memory the brain should reflect on the voice call.
  await db.query(
    `INSERT INTO customer_memory (tenant_id, customer_id, key, value, source)
     VALUES ($1, $2, 'interest', 'dental checkup', 'ai')
     ON CONFLICT (customer_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [TENANT_ID, customer.id]
  );

  return { customer, conversation };
}

seed()
  .then(({ customer, conversation }) => {
    console.log('✓ Seeded voice test customer (returning, with prior WhatsApp history)\n');
    console.log('  tenant_id            :', TENANT_ID);
    console.log('  customer_id          :', customer.id, `(${customer.name})`);
    console.log('  open conversation_id :', conversation.id, `(channel=${conversation.channel})`);
    console.log('  caller / phone       :', CALLER);
    console.log('\nWorker env to match (voice-agent/.env):');
    console.log('  VOICE_TENANT_ID=' + TENANT_ID);
    console.log('  VOICE_DEV_CALLER_NUMBER=' + CALLER);
    return db.close();
  })
  .catch(async (err) => {
    console.error('✗ seed failed:', err.message);
    try { await db.close(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
