require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/db/db');
const conversationService = require('../../src/modules/conversation/conversationService');

const TENANT_A = '00000000-0000-0000-0000-bbbbbbbbb001';
const TENANT_B = '00000000-0000-0000-0000-bbbbbbbbb002';

async function ensureTenant(tenantId, name) {
  await db.query(
    `INSERT INTO tenants (id, business_name, phone_number_id, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO NOTHING`,
    [tenantId, name, `pnid_mem_${tenantId.slice(-4)}`]
  );
}

async function ensureCustomer(tenantId, phone) {
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET last_seen_at = NOW()
     RETURNING *`,
    [tenantId, phone]
  );
  return rows[0];
}

async function ensureSchema() {
  // Ensure origin_channel exists on conversations.
  //
  // ⚠️ This block MUST test for `origin_channel`, never for `channel`. Migration
  // 028 renamed the column; a check that still looked for the old name would
  // find nothing on a correctly migrated database and ADD IT BACK — resurrecting
  // the dead column on the one long-lived database `npm test` actually uses,
  // while every scratch-DB suite (which genesises from schema.sql) stayed green.
  // The suite passing is exactly what that failure mode looks like, so the guard
  // is the column name here, not a green run.
  const { rows: convCols } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'conversations' AND column_name = 'origin_channel'`
  );
  if (convCols.length === 0) {
    await db.query(`ALTER TABLE conversations ADD COLUMN origin_channel TEXT NOT NULL DEFAULT 'whatsapp'`);
  }

  // Drop old conversation unique if it exists, create new one
  await db.query(`DROP INDEX IF EXISTS uniq_open_conversation_per_customer`);
  const { rows: idxRows } = await db.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_open_conversation'`
  );
  if (idxRows.length === 0) {
    await db.query(
      `CREATE UNIQUE INDEX uniq_open_conversation
       ON conversations (tenant_id, customer_id) WHERE status = 'open'`
    );
  }

  // Ensure new message columns exist
  const { rows: msgCols } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'messages' AND column_name IN ('channel', 'external_id', 'media_ref')`
  );
  const existingCols = msgCols.map(r => r.column_name);
  if (!existingCols.includes('channel')) {
    await db.query(`ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'`);
  }
  if (!existingCols.includes('external_id')) {
    await db.query(`ALTER TABLE messages ADD COLUMN external_id TEXT`);
  }
  if (!existingCols.includes('media_ref')) {
    await db.query(`ALTER TABLE messages ADD COLUMN media_ref TEXT`);
  }

  // Channel-scoped dedup index (external_id is the sole message id)
  const { rows: msgIdx } = await db.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_msg_external'`
  );
  if (msgIdx.length === 0) {
    await db.query(
      `CREATE UNIQUE INDEX uniq_msg_external
       ON messages (tenant_id, channel, external_id) WHERE external_id IS NOT NULL`
    );
  }
}

async function cleanup() {
  await db.query('DELETE FROM messages WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM conversations WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM customers WHERE tenant_id IN ($1, $2)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM tenants WHERE id IN ($1, $2)', [TENANT_A, TENANT_B]);
}

describe('Channel-Agnostic Storage (PR4)', () => {
  let customerA;
  let conversationA;

  before(async () => {
    await ensureSchema();
    await cleanup();
    await ensureTenant(TENANT_A, 'Storage Clinic A');
    await ensureTenant(TENANT_B, 'Storage Clinic B');
    customerA = await ensureCustomer(TENANT_A, '919000000100');
    conversationA = await conversationService.getOrCreateOpenConversation(
      TENANT_A, customerA.id, 'whatsapp'
    );
  });

  after(async () => {
    await cleanup();
    await db.close();
  });

  // ── Relocated dedup ──────────────────────────────────────────────

  it('duplicate external_id delivered twice → exactly one row', async () => {
    const wamid = 'wamid_dedup_test_001';

    const { rowCount: first } = await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', 'Hello', 'whatsapp', 'text')
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid]
    );
    assert.equal(first, 1, 'first insert should succeed');

    const { rowCount: second } = await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', 'Hello', 'whatsapp', 'text')
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid]
    );
    assert.equal(second, 0, 'duplicate should be rejected');

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM messages
       WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, wamid]
    );
    assert.equal(rows[0].cnt, 1, 'exactly one row should exist');
  });

  // ── Inbound text ──────────────────────────────────────────────────

  it('inbound text → channel/direction/external_id/msg_type correct', async () => {
    const wamid = 'wamid_text_001';
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', 'Test text', 'whatsapp', 'text')
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid]
    );

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, wamid]
    );

    assert.equal(msg.channel, 'whatsapp');
    assert.equal(msg.direction, 'inbound');
    assert.equal(msg.external_id, wamid);
    assert.equal(msg.msg_type, 'text');
    assert.equal(msg.content, 'Test text');
    assert.equal(msg.media_ref, null);
  });

  // ── Inbound non-text (image/audio/document/location) ──────────────

  it('inbound image → correct msg_type + media_ref, not dropped', async () => {
    const wamid = 'wamid_image_001';
    const mediaId = 'wa_media_img_12345';
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type, media_ref)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', 'A photo', 'whatsapp', 'image', $5)
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid, mediaId]
    );

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, wamid]
    );
    assert.equal(msg.msg_type, 'image');
    assert.equal(msg.media_ref, mediaId);
    assert.equal(msg.channel, 'whatsapp');
  });

  it('inbound audio → correct msg_type + media_ref', async () => {
    const wamid = 'wamid_audio_001';
    const mediaId = 'wa_media_aud_12345';
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type, media_ref)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', '[audio]', 'whatsapp', 'audio', $5)
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid, mediaId]
    );

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, wamid]
    );
    assert.equal(msg.msg_type, 'audio');
    assert.equal(msg.media_ref, mediaId);
  });

  it('inbound document → correct msg_type + media_ref', async () => {
    const wamid = 'wamid_doc_001';
    const mediaId = 'wa_media_doc_12345';
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type, media_ref)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', 'report.pdf', 'whatsapp', 'document', $5)
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid, mediaId]
    );

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, wamid]
    );
    assert.equal(msg.msg_type, 'document');
    assert.equal(msg.media_ref, mediaId);
  });

  it('inbound location → correct msg_type, no media_ref', async () => {
    const wamid = 'wamid_loc_001';
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, $4, 'inbound', 'customer', '[location: 17.385,78.486]', 'whatsapp', 'location')
       ON CONFLICT (tenant_id, channel, external_id)
         WHERE external_id IS NOT NULL DO NOTHING`,
      [TENANT_A, conversationA.id, customerA.id, wamid]
    );

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, wamid]
    );
    assert.equal(msg.msg_type, 'location');
    assert.equal(msg.media_ref, null);
  });

  // ── Outbound ──────────────────────────────────────────────────────

  it('outbound → direction=outbound, external_id = sent id', async () => {
    const sentWamid = 'wamid_sent_001';
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, external_id,
          direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, $4, 'outbound', 'ai', 'Reply text', 'whatsapp', 'text')`,
      [TENANT_A, conversationA.id, customerA.id, sentWamid]
    );

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, sentWamid]
    );
    assert.equal(msg.direction, 'outbound');
    assert.equal(msg.external_id, sentWamid);
    assert.equal(msg.channel, 'whatsapp');
  });

  // ── Direction ─────────────────────────────────────────────────────

  it('direction column is NOT NULL — all sampled rows have direction', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM messages
       WHERE tenant_id = $1 AND direction IS NULL`,
      [TENANT_A]
    );
    assert.equal(rows[0].cnt, 0, 'no null direction values should exist');
  });

  // ── Partial unique (conversations) ────────────────────────────────

  it('second open conversation per (tenant, customer) rejected', async () => {
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO conversations (tenant_id, customer_id, origin_channel, status)
           VALUES ($1, $2, 'whatsapp', 'open')`,
          [TENANT_A, customerA.id]
        );
      },
      (err) => {
        assert.ok(
          err.message.includes('uniq_open_conversation') ||
          err.message.includes('duplicate key') ||
          err.code === '23505',
          'should violate unique constraint'
        );
        return true;
      }
    );
  });

  it('closed-then-new-open conversation allowed', async () => {
    const cust = await ensureCustomer(TENANT_A, '919000000200');

    // Create first open conversation
    const conv1 = await conversationService.getOrCreateOpenConversation(TENANT_A, cust.id, 'whatsapp');
    assert.ok(conv1.id);

    // Close it
    await db.query(
      `UPDATE conversations SET status = 'closed' WHERE id = $1 AND tenant_id = $2`,
      [conv1.id, TENANT_A]
    );

    // New open conversation should succeed
    const conv2 = await conversationService.getOrCreateOpenConversation(TENANT_A, cust.id, 'whatsapp');
    assert.ok(conv2.id);
    assert.notEqual(conv2.id, conv1.id, 'should be a new conversation');
  });

  // ── Channel default ───────────────────────────────────────────────

  it('channel default → legacy rows read whatsapp', async () => {
    // Insert without specifying channel (uses default)
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content)
       VALUES ($1, $2, $3, 'inbound', 'customer', 'legacy msg')`,
      [TENANT_A, conversationA.id, customerA.id]
    );

    const { rows: [msg] } = await db.query(
      `SELECT channel FROM messages
       WHERE tenant_id = $1 AND content = 'legacy msg'
       ORDER BY created_at DESC LIMIT 1`,
      [TENANT_A]
    );
    assert.equal(msg.channel, 'whatsapp', 'default channel should be whatsapp');
  });

  // ── getOrCreateOpenConversation origin_channel-aware ──────────────

  it('getOrCreateOpenConversation stores origin_channel', async () => {
    const cust = await ensureCustomer(TENANT_A, '919000000300');
    const conv = await conversationService.getOrCreateOpenConversation(
      TENANT_A, cust.id, 'whatsapp'
    );
    assert.equal(conv.origin_channel, 'whatsapp');
  });

  it('getOrCreateOpenConversation defaults to whatsapp', async () => {
    const cust = await ensureCustomer(TENANT_A, '919000000400');
    const conv = await conversationService.getOrCreateOpenConversation(TENANT_A, cust.id);
    assert.equal(conv.origin_channel, 'whatsapp');
  });

  // ── Participation is DERIVED, and disagrees with origin_channel ───
  //
  // The one test that justifies migration 028. A thread BEGUN on WhatsApp and
  // continued by voice reaches the same row through the ON CONFLICT arbiter
  // (tenant_id, customer_id) WHERE status='open' — channel is not in the key —
  // so origin_channel still reads 'whatsapp' while the thread is on both.
  it('getParticipatingChannels returns both channels for a cross-channel thread', async () => {
    const cust = await ensureCustomer(TENANT_A, '919000000500');

    // Begun on WhatsApp.
    const first = await conversationService.getOrCreateOpenConversation(TENANT_A, cust.id, 'whatsapp');
    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'inbound', 'customer', 'Booked me for Tuesday?', 'whatsapp', 'text')`,
      [TENANT_A, first.id, cust.id]
    );

    // Continued by voice — same customer, same open thread.
    const second = await conversationService.getOrCreateOpenConversation(TENANT_A, cust.id, 'voice');
    assert.equal(second.id, first.id, 'the voice turn reuses the open WhatsApp thread');
    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'inbound', 'customer', 'Calling to confirm', 'voice', 'text')`,
      [TENANT_A, second.id, cust.id]
    );

    assert.deepEqual(
      await conversationService.getParticipatingChannels(TENANT_A, first.id),
      ['voice', 'whatsapp'],
      'derived participation sees both channels'
    );
    assert.equal(second.origin_channel, 'whatsapp',
      'origin_channel still records only how the thread BEGAN — this is the divergence 028 names');

    // Tenant-scoped: another tenant asking about this id learns nothing.
    assert.deepEqual(
      await conversationService.getParticipatingChannels(TENANT_B, first.id),
      [],
      'a conversation id alone does not cross the tenant boundary'
    );
  });
});
