require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const crypto  = require('crypto');
const express = require('express');
const db      = require('../../src/db/db');

const BATCH_TENANT_ID = '00000000-0000-0000-0000-f00500000001';
const BATCH_PNID      = 'pnid_f005_batch';
const APP_SECRET      = 'test-f005-batch-secret';

function sig(body) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

async function cleanup() {
  await db.query('DELETE FROM messages          WHERE tenant_id = $1', [BATCH_TENANT_ID]);
  await db.query('DELETE FROM conversations     WHERE tenant_id = $1', [BATCH_TENANT_ID]);
  await db.query('DELETE FROM channel_identifiers WHERE tenant_id = $1', [BATCH_TENANT_ID]);
  await db.query('DELETE FROM customers         WHERE tenant_id = $1', [BATCH_TENANT_ID]);
  await db.query('DELETE FROM tenants           WHERE id = $1', [BATCH_TENANT_ID]);
}

// Poll every 100ms until the DB has the expected row count (or timeout).
// Avoids brittle fixed-sleep waits: fast on quick DBs, never races on slow ones.
async function waitForRows(externalIds, maxMs = 3000) {
  const deadline = Date.now() + maxMs;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      `SELECT external_id FROM messages
       WHERE tenant_id = $1 AND external_id = ANY($2::text[])
       ORDER BY created_at`,
      [BATCH_TENANT_ID, externalIds]
    ));
    if (rows.length >= externalIds.length) return rows;
    await new Promise(r => setTimeout(r, 100));
  }
  return rows;
}

describe('F-005: webhook batch ingest', () => {
  let server, baseUrl;
  const savedSecret = process.env.META_APP_SECRET;
  const savedToken  = process.env.WEBHOOK_VERIFY_TOKEN;

  before(async () => {
    process.env.META_APP_SECRET       = APP_SECRET;
    process.env.WEBHOOK_VERIFY_TOKEN  = 'test-token';
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    }

    await cleanup();

    // tenantService.getByPhoneNumberId calls decrypt(wa_token) — null throws.
    // Provide a real encrypted value so the lookup succeeds.
    const { encrypt } = require('../../src/utils/encryption');
    const dummyToken = encrypt('dummy-wa-token-for-batch-test');

    // Tenant with ai_enabled=false so the pipeline stops after storage
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, active, ai_enabled)
       VALUES ($1, 'Batch Test Clinic', $2, $3, true, false)
       ON CONFLICT (id) DO NOTHING`,
      [BATCH_TENANT_ID, BATCH_PNID, dummyToken]
    );

    const app = express();
    app.use('/webhook',
      express.raw({ type: 'application/json' }),
      require('../../src/modules/channels/whatsapp/routes'));

    await new Promise(resolve => {
      server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    process.env.META_APP_SECRET      = savedSecret;
    process.env.WEBHOOK_VERIFY_TOKEN = savedToken;
    await cleanup();
    if (server) await new Promise(r => server.close(r));
    await db.close();
  });

  it('two messages in one POST → both rows stored (F-005)', async () => {
    const body = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: BATCH_PNID },
            contacts: [{ wa_id: '919100000020', profile: { name: 'Alice' } }],
            messages: [
              { id: 'wamid_f005_r_a', from: '919100000020', type: 'text', text: { body: 'Msg A' } },
              { id: 'wamid_f005_r_b', from: '919100000020', type: 'text', text: { body: 'Msg B' } },
            ],
          },
        }],
      }],
    });

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(body) },
      body,
    });
    assert.equal(res.status, 200);

    const rows = await waitForRows(['wamid_f005_r_a', 'wamid_f005_r_b']);
    assert.equal(rows.length, 2, 'both messages should be stored');
  });

  it('two entries in one POST → both rows stored (F-005)', async () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [{
            value: {
              metadata: { phone_number_id: BATCH_PNID },
              contacts: [{ wa_id: '919100000021', profile: { name: 'Bob' } }],
              messages: [{ id: 'wamid_f005_e1', from: '919100000021', type: 'text', text: { body: 'Entry 1' } }],
            },
          }],
        },
        {
          changes: [{
            value: {
              metadata: { phone_number_id: BATCH_PNID },
              contacts: [{ wa_id: '919100000021', profile: { name: 'Bob' } }],
              messages: [{ id: 'wamid_f005_e2', from: '919100000021', type: 'text', text: { body: 'Entry 2' } }],
            },
          }],
        },
      ],
    });

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(body) },
      body,
    });
    assert.equal(res.status, 200);

    const rows = await waitForRows(['wamid_f005_e1', 'wamid_f005_e2']);
    assert.equal(rows.length, 2, 'both entries should be processed');
  });

  it('two changes in one entry → both rows stored (F-005)', async () => {
    const body = JSON.stringify({
      entry: [{
        changes: [
          {
            value: {
              metadata: { phone_number_id: BATCH_PNID },
              contacts: [{ wa_id: '919100000022', profile: { name: 'Carol' } }],
              messages: [{ id: 'wamid_f005_c1', from: '919100000022', type: 'text', text: { body: 'Change 1' } }],
            },
          },
          {
            value: {
              metadata: { phone_number_id: BATCH_PNID },
              contacts: [{ wa_id: '919100000022', profile: { name: 'Carol' } }],
              messages: [{ id: 'wamid_f005_c2', from: '919100000022', type: 'text', text: { body: 'Change 2' } }],
            },
          },
        ],
      }],
    });

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(body) },
      body,
    });
    assert.equal(res.status, 200);

    const rows = await waitForRows(['wamid_f005_c1', 'wamid_f005_c2']);
    assert.equal(rows.length, 2, 'both changes should be processed');
  });

  it('idempotency: same batch delivered twice → no duplicate rows', async () => {
    const body = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: BATCH_PNID },
            contacts: [{ wa_id: '919100000023', profile: { name: 'Dave' } }],
            messages: [
              { id: 'wamid_f005_idem_a', from: '919100000023', type: 'text', text: { body: 'Idem A' } },
              { id: 'wamid_f005_idem_b', from: '919100000023', type: 'text', text: { body: 'Idem B' } },
            ],
          },
        }],
      }],
    });

    const opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(body) },
      body,
    };

    await fetch(`${baseUrl}/webhook`, opts);
    // Wait for first delivery to complete before redelivering
    await waitForRows(['wamid_f005_idem_a', 'wamid_f005_idem_b']);

    await fetch(`${baseUrl}/webhook`, opts);  // redelivery
    await new Promise(r => setTimeout(r, 500)); // let redelivery no-op through

    const { rows } = await db.query(
      `SELECT external_id FROM messages
       WHERE tenant_id = $1 AND external_id = ANY($2::text[])`,
      [BATCH_TENANT_ID, ['wamid_f005_idem_a', 'wamid_f005_idem_b']]
    );
    assert.equal(rows.length, 2, 'redelivery of a batch must not create duplicate rows');
  });

  it('status-only payload → 200, no message rows created', async () => {
    const body = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: BATCH_PNID },
            statuses: [{ id: 'wamid_status_001', status: 'delivered', recipient_id: '919100000024' }],
          },
        }],
      }],
    });

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(body) },
      body,
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 300));

    // Status callbacks must never produce a message row
    const { rows } = await db.query(
      `SELECT external_id FROM messages
       WHERE tenant_id = $1 AND external_id = 'wamid_status_001'`,
      [BATCH_TENANT_ID]
    );
    assert.equal(rows.length, 0, 'status-only payload should not store any messages');
  });
});
