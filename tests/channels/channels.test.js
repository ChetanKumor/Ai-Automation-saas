require('dotenv').config();

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const db = require('../../src/db/db');
const eventBus = require('../../core/events');
const EVENT = require('../../core/eventTypes');

const TENANT_ID = '00000000-0000-0000-0000-cccccccc0001';
const APP_SECRET = 'test-channel-secret';

async function ensureTenant() {
  await db.query(
    `INSERT INTO tenants (id, business_name, phone_number_id, active, ai_enabled)
     VALUES ($1, 'Channel Test Clinic', 'pnid_channel_test', true, true)
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID]
  );
}

async function ensureCustomer(phone) {
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET last_seen_at = NOW()
     RETURNING *`,
    [TENANT_ID, phone]
  );
  return rows[0];
}

async function cleanup() {
  await db.query('DELETE FROM messages WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM conversations WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM channel_identifiers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

// ── Adapter contract tests ──────────────────────────────────────────

describe('ChannelAdapter contract', () => {
  const waAdapter = require('../../src/modules/channels/whatsapp/adapter');

  it('WA adapter has required interface fields', () => {
    assert.equal(waAdapter.channelType, 'whatsapp');
    assert.equal(typeof waAdapter.verifyWebhook, 'function');
    assert.equal(typeof waAdapter.parseInbound, 'function');
    assert.equal(typeof waAdapter.send, 'function');
  });

  it('mock adapter satisfies the interface', () => {
    const mock = {
      channelType: 'mock',
      verifyWebhook: () => true,
      parseInbound: () => [],
      send: async () => ({ externalId: 'mock-id' }),
    };
    assert.equal(mock.channelType, 'mock');
    assert.equal(typeof mock.verifyWebhook, 'function');
    assert.equal(typeof mock.parseInbound, 'function');
    assert.equal(typeof mock.send, 'function');
  });
});

// ── Registry tests ──────────────────────────────────────────────────

describe('Channel registry', () => {
  const { register, getAdapter, dispatchOutbound } = require('../../src/modules/channels');

  it('getAdapter(unknown) throws', () => {
    assert.throws(
      () => getAdapter('carrier_pigeon'),
      { message: /Unknown channel: carrier_pigeon/ }
    );
  });

  it('dispatchOutbound(unknown) throws', async () => {
    await assert.rejects(
      () => dispatchOutbound({ tenantId: 'x', customerId: 'y', channel: 'smoke_signal', payload: {} }),
      { message: /Unknown channel: smoke_signal/ }
    );
  });

  it('register requires channelType', () => {
    assert.throws(
      () => register({}),
      { message: /Adapter must define channelType/ }
    );
  });

  it('registered adapter is retrievable', () => {
    const mock = {
      channelType: 'test_channel',
      verifyWebhook: () => true,
      parseInbound: () => [],
      send: async () => ({ externalId: 'test' }),
    };
    register(mock);
    const retrieved = getAdapter('test_channel');
    assert.equal(retrieved.channelType, 'test_channel');
  });
});

// ── WA adapter: verifyWebhook ───────────────────────────────────────

describe('WA adapter verifyWebhook', () => {
  const waAdapter = require('../../src/modules/channels/whatsapp/adapter');
  const savedSecret = process.env.META_APP_SECRET;

  before(() => {
    process.env.META_APP_SECRET = APP_SECRET;
  });

  after(() => {
    process.env.META_APP_SECRET = savedSecret;
  });

  it('valid HMAC returns true', () => {
    const body = Buffer.from(JSON.stringify({ test: true }));
    const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
    assert.equal(waAdapter.verifyWebhook({ headers: { 'x-hub-signature-256': sig }, body }), true);
  });

  it('invalid HMAC returns false', () => {
    const body = Buffer.from(JSON.stringify({ test: true }));
    assert.equal(waAdapter.verifyWebhook({ headers: { 'x-hub-signature-256': 'sha256=bad' + 'a'.repeat(60) }, body }), false);
  });

  it('missing header returns false', () => {
    assert.equal(waAdapter.verifyWebhook({ headers: {}, body: Buffer.from('{}') }), false);
  });
});

// ── WA adapter: parseInbound ────────────────────────────────────────

describe('WA adapter parseInbound', () => {
  const waAdapter = require('../../src/modules/channels/whatsapp/adapter');

  it('text message produces correct envelope', () => {
    const waValue = {
      metadata: { phone_number_id: 'pnid_test' },
      contacts: [{ profile: { name: 'Test User' } }],
      messages: [{
        id: 'wamid_text_123',
        from: '919876543210',
        type: 'text',
        text: { body: 'Hello world' },
      }],
    };

    const envelopes = waAdapter.parseInbound(waValue, TENANT_ID);
    assert.equal(envelopes.length, 1);
    const env = envelopes[0];
    assert.equal(env.tenantId, TENANT_ID);
    assert.equal(env.channel, 'whatsapp');
    assert.equal(env.direction, 'inbound');
    assert.equal(env.identifier, '919876543210');
    assert.equal(env.externalId, 'wamid_text_123');
    assert.equal(env.messageType, 'text');
    assert.equal(env.text, 'Hello world');
    assert.equal(env.mediaRef, null);
    assert.deepEqual(env.profile, { name: 'Test User' });
    assert.equal(typeof env.timestamp, 'number');
  });

  it('image message produces correct envelope with mediaRef', () => {
    const waValue = {
      messages: [{
        id: 'wamid_img_123',
        from: '919876543210',
        type: 'image',
        image: { id: 'media_img_001', caption: 'My photo' },
      }],
    };

    const envelopes = waAdapter.parseInbound(waValue, TENANT_ID);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].messageType, 'image');
    assert.equal(envelopes[0].text, 'My photo');
    assert.equal(envelopes[0].mediaRef, 'media_img_001');
  });

  it('audio message produces correct envelope', () => {
    const waValue = {
      messages: [{
        id: 'wamid_aud_123',
        from: '919876543210',
        type: 'audio',
        audio: { id: 'media_aud_001' },
      }],
    };

    const envelopes = waAdapter.parseInbound(waValue, TENANT_ID);
    assert.equal(envelopes[0].messageType, 'audio');
    assert.equal(envelopes[0].text, '[audio]');
    assert.equal(envelopes[0].mediaRef, 'media_aud_001');
  });

  it('location message produces correct envelope', () => {
    const waValue = {
      messages: [{
        id: 'wamid_loc_123',
        from: '919876543210',
        type: 'location',
        location: { latitude: 17.385, longitude: 78.486 },
      }],
    };

    const envelopes = waAdapter.parseInbound(waValue, TENANT_ID);
    assert.equal(envelopes[0].messageType, 'location');
    assert.equal(envelopes[0].text, '[location: 17.385,78.486]');
    assert.equal(envelopes[0].mediaRef, null);
  });

  it('no messages → empty array', () => {
    assert.deepEqual(waAdapter.parseInbound({}, TENANT_ID), []);
    assert.deepEqual(waAdapter.parseInbound({ messages: [] }, TENANT_ID), []);
  });

  it('empty text body → empty array', () => {
    const waValue = {
      messages: [{
        id: 'wamid_empty',
        from: '919876543210',
        type: 'text',
        text: {},
      }],
    };
    assert.deepEqual(waAdapter.parseInbound(waValue, TENANT_ID), []);
  });
});

// ── WA adapter: extractMessageContent ───────────────────────────────

describe('extractMessageContent parity', () => {
  const { extractMessageContent } = require('../../src/modules/channels/whatsapp/adapter');

  it('document with filename', () => {
    const result = extractMessageContent({
      type: 'document',
      document: { id: 'doc1', filename: 'report.pdf' },
    });
    assert.equal(result.content, 'report.pdf');
    assert.equal(result.mediaRef, 'doc1');
    assert.equal(result.msgType, 'document');
  });

  it('video with caption', () => {
    const result = extractMessageContent({
      type: 'video',
      video: { id: 'vid1', caption: 'My video' },
    });
    assert.equal(result.content, 'My video');
    assert.equal(result.mediaRef, 'vid1');
    assert.equal(result.msgType, 'video');
  });

  it('sticker', () => {
    const result = extractMessageContent({
      type: 'sticker',
      sticker: { id: 'stk1' },
    });
    assert.equal(result.content, '[sticker]');
    assert.equal(result.mediaRef, 'stk1');
    assert.equal(result.msgType, 'sticker');
  });

  it('unknown type', () => {
    const result = extractMessageContent({ type: 'reaction' });
    assert.equal(result.content, '[reaction]');
    assert.equal(result.msgType, 'reaction');
  });
});

// ── handleInbound parity ────────────────────────────────────────────

describe('handleInbound (channel-agnostic ingest)', () => {
  const { handleInbound } = require('../../src/modules/channels');
  const conversationService = require('../../src/modules/conversation/conversationService');

  before(async () => {
    await cleanup();
    await ensureTenant();
  });

  after(async () => {
    await cleanup();
    await db.close();
  });

  it('stores inbound text and emits message.received', async () => {
    const emitted = [];
    const off = eventBus.on(EVENT.MESSAGE_RECEIVED, (env) => emitted.push(env));

    const envelope = {
      tenantId: TENANT_ID,
      channel: 'whatsapp',
      direction: 'inbound',
      identifier: '919100000001',
      externalId: 'wamid_hi_test_001',
      messageType: 'text',
      text: 'Hello from test',
      mediaRef: null,
      timestamp: Date.now(),
    };

    const results = await handleInbound([envelope]);
    await new Promise(r => setTimeout(r, 50));
    off();

    assert.equal(results.length, 1);
    assert.ok(results[0].customer.id);
    assert.ok(results[0].conversation.id);

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_ID, 'wamid_hi_test_001']
    );
    assert.equal(msg.channel, 'whatsapp');
    assert.equal(msg.direction, 'inbound');
    assert.equal(msg.msg_type, 'text');
    assert.equal(msg.content, 'Hello from test');

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].payload.text, 'Hello from test');
  });

  it('duplicate externalId is skipped (dedup)', async () => {
    const envelope = {
      tenantId: TENANT_ID,
      channel: 'whatsapp',
      direction: 'inbound',
      identifier: '919100000001',
      externalId: 'wamid_hi_test_001',
      messageType: 'text',
      text: 'Hello from test',
      mediaRef: null,
      timestamp: Date.now(),
    };

    const results = await handleInbound([envelope]);
    assert.equal(results.length, 0, 'duplicate should produce no results');
  });

  it('non-text message stored with correct type and mediaRef', async () => {
    const envelope = {
      tenantId: TENANT_ID,
      channel: 'whatsapp',
      direction: 'inbound',
      identifier: '919100000002',
      externalId: 'wamid_img_test_001',
      messageType: 'image',
      text: '[image]',
      mediaRef: 'wa_media_test_img',
      timestamp: Date.now(),
    };

    const results = await handleInbound([envelope]);
    assert.equal(results.length, 1);

    const { rows: [msg] } = await db.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_ID, 'wamid_img_test_001']
    );
    assert.equal(msg.msg_type, 'image');
    assert.equal(msg.media_ref, 'wa_media_test_img');
  });

  it('dispatchOutbound → WA sender returns externalId', async () => {
    const { register, dispatchOutbound, getAdapter } = require('../../src/modules/channels');

    const sentIds = [];
    const mockAdapter = {
      channelType: 'mock_wa_test',
      verifyWebhook: () => true,
      parseInbound: () => [],
      send: async ({ tenantId, customerId, payload }) => {
        sentIds.push({ tenantId, customerId, text: payload.text });
        return { externalId: 'mock_sent_001' };
      },
    };
    register(mockAdapter);

    const result = await dispatchOutbound({
      tenantId: TENANT_ID,
      customerId: 'cust-1',
      channel: 'mock_wa_test',
      payload: { text: 'Test reply' },
    });

    assert.equal(result.externalId, 'mock_sent_001');
    assert.equal(sentIds.length, 1);
    assert.equal(sentIds[0].text, 'Test reply');
  });

  it('dispatchOutbound send failure propagates', async () => {
    const { register, dispatchOutbound } = require('../../src/modules/channels');

    register({
      channelType: 'fail_test',
      verifyWebhook: () => true,
      parseInbound: () => [],
      send: async () => { throw new Error('WA API down'); },
    });

    await assert.rejects(
      () => dispatchOutbound({
        tenantId: TENANT_ID,
        customerId: 'cust-1',
        channel: 'fail_test',
        payload: { text: 'fail' },
      }),
      { message: 'WA API down' }
    );
  });
});

// ── Boot registration ───────────────────────────────────────────────

describe('Boot: adapters registered before listen', () => {
  it('whatsapp adapter registers and becomes retrievable', () => {
    const { register, getAdapter } = require('../../src/modules/channels');
    const waAdapter = require('../../src/modules/channels/whatsapp/adapter');
    register(waAdapter);
    const retrieved = getAdapter('whatsapp');
    assert.equal(retrieved.channelType, 'whatsapp');
    assert.equal(retrieved, waAdapter);
  });

  it('server.js registers adapter before routes', () => {
    const fs = require('fs');
    const serverSrc = fs.readFileSync(require.resolve('../../server.js'), 'utf8');
    const registerIdx = serverSrc.indexOf('channelRegistry.register');
    const routeIdx = serverSrc.indexOf("app.use('/webhook'");
    assert.ok(registerIdx > 0, 'server.js should call channelRegistry.register');
    assert.ok(routeIdx > 0, 'server.js should mount webhook routes');
    assert.ok(registerIdx < routeIdx, 'register must come before route mount');
  });
});

// ── Status callbacks ────────────────────────────────────────────────

describe('Status callbacks handled as before', () => {
  const waAdapter = require('../../src/modules/channels/whatsapp/adapter');

  it('status-only payload produces no envelopes', () => {
    const waValue = {
      statuses: [{ id: 'wamid_123', status: 'delivered', recipient_id: '919876543210' }],
    };
    const envelopes = waAdapter.parseInbound(waValue, TENANT_ID);
    assert.equal(envelopes.length, 0);
  });
});
