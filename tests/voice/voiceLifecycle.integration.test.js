require('dotenv').config();

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db                  = require('../../src/db/db');
const eventBus            = require('../../core/events');
const EVENT               = require('../../core/eventTypes');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const customerService     = require('../../src/modules/customer/customerService');
const conversationService = require('../../src/modules/conversation/conversationService');
const callSessions        = require('../../src/modules/voice/callSessions');

// PR7 lifecycle proof (DB-backed): identity resolution at /call/start (new +
// returning), turn resolution from call_session_id ALONE, and CRM/memory event
// parity (voice emits the SAME message.received WhatsApp emits). No telephony,
// no audio — this is the brain-side half of the runtime.

const TENANT_ID       = '00000000-0000-0000-0000-bbbb00000007'.replace(/b/g, 'a');
const PHONE_NUMBER_ID = 'pnid_voice_lifecycle';
const SECRET          = 'lifecycle-integration-secret';

const tick = () => new Promise((r) => setImmediate(r));

let server;
let baseUrl;
let knowledgeMock;
const started = [];
const ended = [];
const received = [];

async function cleanup() {
  await db.query('DELETE FROM messages WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customer_memory WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM channel_identifiers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM conversations WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function signedPost(path, body) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/internal/voice${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-signature': hmac.sign(raw, SECRET) },
    body: raw,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// A scripted text model (no tools): the turn returns a fixed spoken reply.
function scriptedTextModel(replyText) {
  return () => ({
    startChat: () => ({
      sendMessage: async () => ({
        response: { functionCalls: () => undefined, text: () => replyText },
      }),
    }),
  });
}

describe('PR7 voice lifecycle — identity, turn-from-session, event parity', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Voice Lifecycle Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
      [TENANT_ID, PHONE_NUMBER_ID, encrypt('dummy-wa-token')]
    );

    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks', async () => []);
    eventBus.on(EVENT.CALL_STARTED, (e) => started.push(e.payload));
    eventBus.on(EVENT.CALL_ENDED, (e) => ended.push(e.payload));
    eventBus.on(EVENT.MESSAGE_RECEIVED, (e) => received.push(e.payload));

    const app = express();
    app.use('/internal/voice', require('../../src/routes/internalVoice'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    aiService._setModelProvider(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
    await db.close();
  });

  it('call/start: NEW caller creates customer + conversation + call_session, emits call.started', async () => {
    const caller = '+919000000701';
    const res = await signedPost('/call/start', { tenant_id: TENANT_ID, caller_id: caller, channel: 'voice' });
    await tick();

    assert.equal(res.status, 200);
    assert.ok(res.json.call_session_id);
    assert.ok(res.json.customer_id);
    assert.ok(res.json.conversation_id);

    // call_session persisted, in_progress, linked to the resolved ids.
    const session = await callSessions.get(res.json.call_session_id, TENANT_ID);
    assert.equal(session.status, 'in_progress');
    assert.equal(session.customer_id, res.json.customer_id);
    assert.equal(session.conversation_id, res.json.conversation_id);

    // A 'voice' channel identifier was linked for the new caller.
    const { rows: ci } = await db.query(
      `SELECT 1 FROM channel_identifiers WHERE tenant_id = $1 AND channel_type = 'voice' AND identifier = $2`,
      [TENANT_ID, caller]
    );
    assert.equal(ci.length, 1);

    assert.ok(started.find((p) => p.call_session_id === res.json.call_session_id), 'call.started emitted');
  });

  it('call/start: RETURNING customer reuses the SAME open conversation (cross-channel continuity)', async () => {
    const caller = '+919000000702';
    // Pre-existing WhatsApp customer + open conversation (as if they messaged before).
    const existing = await customerService.findOrCreate(TENANT_ID, caller);
    const priorConv = await conversationService.getOrCreateOpenConversation(TENANT_ID, existing.id, 'whatsapp');

    const res = await signedPost('/call/start', { tenant_id: TENANT_ID, caller_id: caller, channel: 'voice' });

    assert.equal(res.status, 200);
    assert.equal(res.json.customer_id, existing.id, 'same customer (resolved by phone)');
    assert.equal(res.json.conversation_id, priorConv.id, 'reuses the existing open conversation');
  });

  it('turn: resolves customer/conversation from call_session_id ALONE and runs the brain', async () => {
    const caller = '+919000000703';
    const start = await signedPost('/call/start', { tenant_id: TENANT_ID, caller_id: caller, channel: 'voice' });
    aiService._setModelProvider(scriptedTextModel('Namaste! How can I help you today?'));

    // Minimal new contract: NO customer_id / conversation_id in the body.
    const turn = await signedPost('/turn', {
      call_session_id: start.json.call_session_id,
      channel: 'voice',
      language: 'te-IN',
      transcript: 'Namaste',
    });

    assert.equal(turn.status, 200);
    assert.equal(turn.json.reply_text, 'Namaste! How can I help you today?');
    assert.equal(turn.json.language, 'te-IN');

    // Persisted as voice messages on the session's conversation.
    const { rows: msgs } = await db.query(
      `SELECT direction, sender, channel FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [start.json.conversation_id]
    );
    assert.deepEqual(
      msgs.map((m) => [m.direction, m.sender, m.channel]),
      [['inbound', 'customer', 'voice'], ['outbound', 'ai', 'voice']]
    );
  });

  it('event parity: a voice turn emits message.received with the SAME shape as WhatsApp', async () => {
    const caller = '+919000000704';
    const start = await signedPost('/call/start', { tenant_id: TENANT_ID, caller_id: caller, channel: 'voice' });
    aiService._setModelProvider(scriptedTextModel('Sure, happy to help.'));

    received.length = 0;
    await signedPost('/turn', {
      call_session_id: start.json.call_session_id,
      channel: 'voice',
      language: 'en-IN',
      transcript: 'Do you have appointments today?',
    });
    await tick();

    const ev = received.find((p) => p.conversation_id === start.json.conversation_id);
    assert.ok(ev, 'voice turn emitted message.received');
    // Same payload keys handleInbound emits for a WhatsApp inbound message.
    assert.deepEqual(
      Object.keys(ev).sort(),
      ['conversation_id', 'customer_id', 'message_id', 'mode', 'tenant_id', 'text'].sort()
    );
    assert.equal(ev.tenant_id, TENANT_ID);
    assert.equal(ev.customer_id, start.json.customer_id);
    assert.equal(ev.text, 'Do you have appointments today?');
    assert.equal(ev.mode, 'ai');
  });

  it('call/end: closes the session (completed) and emits call.ended', async () => {
    const caller = '+919000000705';
    const start = await signedPost('/call/start', { tenant_id: TENANT_ID, caller_id: caller, channel: 'voice' });

    const res = await signedPost('/call/end', {
      call_session_id: start.json.call_session_id,
      status: 'completed',
      duration_seconds: 42,
    });
    await tick();

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    const closed = await callSessions.get(start.json.call_session_id, TENANT_ID);
    assert.equal(closed.status, 'completed');
    assert.equal(closed.duration_seconds, 42);
    assert.ok(closed.ended_at);
    assert.ok(ended.find((p) => p.call_session_id === start.json.call_session_id && p.status === 'completed'));
  });

  it('call/end: status=failed marks the session failed', async () => {
    const caller = '+919000000706';
    const start = await signedPost('/call/start', { tenant_id: TENANT_ID, caller_id: caller, channel: 'voice' });

    const res = await signedPost('/call/end', { call_session_id: start.json.call_session_id, status: 'failed', duration_seconds: 3 });
    assert.equal(res.status, 200);

    const closed = await callSessions.get(start.json.call_session_id, TENANT_ID);
    assert.equal(closed.status, 'failed');
  });

  it('call/end: unknown call_session_id → 404', async () => {
    const res = await signedPost('/call/end', {
      call_session_id: '00000000-0000-0000-0000-000000000000',
      status: 'completed',
      duration_seconds: 1,
    });
    assert.equal(res.status, 404);
  });
});
