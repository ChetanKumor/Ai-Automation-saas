'use strict';

// conversation_events emission (migration 029, audit §8/P-2).
//
// Runs against the dev DATABASE_URL database, the same idiom as
// traces.integration.test.js and voiceTurnMetrics.integration.test.js:
// migration 029 must be applied. The schema.sql-vs-migration lockstep is proved
// separately, on a scratch DB, by tests/db/conversationEvents.test.js.
//
// What this file proves:
//   1. a real WhatsApp inbound turn, through the real route, writes one
//      `handled` row with channel='whatsapp' and call_session_id NULL
//   2. a real voice turn (JSON transport) writes one with channel='voice' and
//      the call_session_id populated
//   3. a real voice turn (SSE transport) writes exactly ONE — the two voice
//      sites are mutually exclusive, not additive
//   4. the mode gate is honoured: a `human` thread produces NO `handled` row,
//      because the AI did not handle it
//   5. tenant scoping is structural — a second tenant cannot write an event
//      onto another tenant's conversation and cannot read one
//   6. `detail` is NULL at every emitter: no patient text leaves `messages`

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const channelRegistry     = require('../../src/modules/channels');
const waAdapter           = require('../../src/modules/channels/whatsapp/adapter');
const waSender            = require('../../src/modules/channels/whatsapp/sender');

const TENANT_ID       = '00000000-0000-0000-0000-ce2900000029';
const OTHER_TENANT_ID = '00000000-0000-0000-0000-ce290000002a';
const PHONE_NUMBER_ID = 'pnid_conv_events_29';
const VOICE_SECRET    = 'conv-events-voice-secret';
const META_SECRET     = 'conv-events-meta-secret';

const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';

// Scripted model implementing BOTH surfaces — sendMessage for the JSON branch,
// sendMessageStream for the SSE branch — so one provider drives every transport
// under test. No live Gemini, no quota.
function scriptedTextModel(text) {
  return () => ({
    startChat: () => ({
      sendMessage: async () => ({
        response: {
          functionCalls: () => undefined,
          text: () => text,
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 11, totalTokenCount: 101 },
          candidates: [{ finishReason: 'STOP' }],
        },
      }),
      sendMessageStream: async () => {
        const aggregated = {
          functionCalls: () => undefined,
          text: () => text,
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 11, totalTokenCount: 101 },
        };
        async function* gen() {
          yield { candidates: [{ content: { parts: [{ text }] } }] };
        }
        return { stream: gen(), response: Promise.resolve(aggregated) };
      },
    }),
  });
}

let server;
let baseUrl;
let knowledgeMock;
let senderMock;

async function cleanup() {
  for (const t of [TENANT_ID, OTHER_TENANT_ID]) {
    await db.query('DELETE FROM conversation_events WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM messages WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM appointments WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM conversations WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM channel_identifiers WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM customers WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM tenant_entities WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
}

// The WA webhook answers 200 and finishes the reply pipeline after; poll.
async function eventually(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function eventsFor(tenantId, conversationId) {
  const { rows } = await db.query(
    `SELECT * FROM conversation_events
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY created_at, id`,
    [tenantId, conversationId]
  );
  return rows;
}

function waSignature(raw) {
  return 'sha256=' + crypto.createHmac('sha256', META_SECRET).update(raw).digest('hex');
}

async function postWebhookText({ from, text, wamid }) {
  const body = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      contacts: [{ profile: { name: 'Meena' } }],
      messages: [{ id: wamid, from, type: 'text', text: { body: text } }],
    } }] }],
  };
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': waSignature(raw) },
    body: raw,
  });
  return { status: res.status };
}

async function postVoiceTurn(body) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-signature': hmac.sign(raw, VOICE_SECRET) },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

async function readSSE(res) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const rawEvt = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = { event: 'message', data: null };
      for (const line of rawEvt.split('\n')) {
        if (line.startsWith('event: ')) evt.event = line.slice(7);
        else if (line.startsWith('data: ')) evt.data = JSON.parse(line.slice(6));
      }
      events.push(evt);
    }
  }
  return events;
}

async function postVoiceTurnSSE(body) {
  const raw = JSON.stringify({ ...body, stream: true });
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-signature': hmac.sign(raw, VOICE_SECRET),
      accept: 'text/event-stream',
    },
    body: raw,
  });
  return { status: res.status, events: res.status === 200 ? await readSSE(res) : null };
}

async function newVoiceSession(phone, { mode } = {}) {
  const { rows: [cust] } = await db.query(
    'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *', [TENANT_ID, phone]);
  const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
  if (mode) await conversationService.setMode(TENANT_ID, conv.id, mode);
  const session = await voiceAdapter.startSession({
    tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
    provider: 'noop', direction: 'inbound', fromNumber: phone,
  });
  return { cust, conv, session };
}

describe('conversation_events — `handled` emission from both channels (migration 029)', { skip: SKIP }, () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = VOICE_SECRET;
    process.env.META_APP_SECRET = META_SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Events Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
      [TENANT_ID, PHONE_NUMBER_ID, encrypt('dummy-wa-token')]
    );
    // A second tenant with its own thread — the negative side of tenant scoping
    // needs a REAL other tenant, not just a random UUID.
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Other Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
      [OTHER_TENANT_ID, PHONE_NUMBER_ID + '_other', encrypt('dummy-wa-token')]
    );

    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks', async () => []);
    senderMock = mock.method(waSender, 'sendMessage', async () =>
      'wamid.out.' + crypto.randomBytes(4).toString('hex'));
    channelRegistry.register(waAdapter);
    aiService._setModelProvider(scriptedTextModel('We are open 9am to 6pm.'));

    const app = express();
    app.use('/webhook', express.raw({ type: 'application/json' }), require('../../src/modules/channels/whatsapp/routes'));
    app.use('/internal/voice', require('../../src/routes/internalVoice'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    if (senderMock) senderMock.mock.restore();
    aiService._setModelProvider(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  it('a real WhatsApp inbound turn writes one `handled` event, channel whatsapp, no call session', async () => {
    const from = '919000000291';
    const { status } = await postWebhookText({
      from, text: 'what time do you open?', wamid: 'wamid.ce.' + crypto.randomBytes(4).toString('hex'),
    });
    assert.equal(status, 200);

    const { rows: [conv] } = await eventually(async () => {
      const r = await db.query(
        `SELECT c.* FROM conversations c JOIN customers cu ON cu.id = c.customer_id
          WHERE c.tenant_id = $1 AND cu.phone = $2`, [TENANT_ID, '+' + from]);
      return r.rows.length ? r : null;
    }) || { rows: [] };
    assert.ok(conv, 'the webhook opened a conversation');

    const events = await eventually(async () => {
      const e = await eventsFor(TENANT_ID, conv.id);
      return e.length ? e : null;
    });
    assert.ok(events, 'a conversation_event was written');
    assert.equal(events.length, 1, 'exactly one event for one turn');

    const ev = events[0];
    assert.equal(ev.type, 'handled');
    assert.equal(ev.channel, 'whatsapp');
    assert.equal(ev.actor, 'ai');
    assert.equal(ev.call_session_id, null, 'WhatsApp has no call session');
    assert.equal(ev.detail, null, 'detail is NULL — no patient text leaves `messages`');
    assert.equal(ev.tenant_id, TENANT_ID);
    assert.equal(ev.conversation_id, conv.id);
    assert.equal(ev.customer_id, conv.customer_id, 'customer_id taken from the conversation row');
    assert.ok(ev.created_at instanceof Date);
  });

  it('a real voice turn (JSON transport) writes one `handled` event carrying the call session', async () => {
    const { cust, conv, session } = await newVoiceSession('+919000000292');

    const { status, json } = await postVoiceTurn({
      call_session_id: session.id, channel: 'voice', language: 'en-IN', transcript: 'what time do you open?',
    });
    assert.equal(status, 200);
    assert.ok(json.reply_text, 'the turn produced a reply');

    const events = await eventsFor(TENANT_ID, conv.id);
    assert.equal(events.length, 1, 'exactly one event for one turn');

    const ev = events[0];
    assert.equal(ev.type, 'handled');
    assert.equal(ev.channel, 'voice');
    assert.equal(ev.actor, 'ai');
    assert.equal(ev.call_session_id, session.id, 'the call session is recorded on voice');
    assert.equal(ev.detail, null, 'detail is NULL — no patient text leaves `messages`');
    assert.equal(ev.customer_id, cust.id);
  });

  it('a real voice turn (SSE transport) writes exactly ONE event — the two voice sites are exclusive', async () => {
    const { conv, session } = await newVoiceSession('+919000000293');

    const { status, events: sseEvents } = await postVoiceTurnSSE({
      call_session_id: session.id, channel: 'voice', language: 'en-IN', transcript: 'what time do you open?',
    });
    assert.equal(status, 200);
    assert.ok(sseEvents.some((e) => e.event === 'done'), 'the SSE turn completed');

    const events = await eventsFor(TENANT_ID, conv.id);
    assert.equal(events.length, 1,
      'ONE event: handleTurn returns into handleTurnSSE, so a turn takes one branch — emitting at both sites does not double-count');
    assert.equal(events[0].type, 'handled');
    assert.equal(events[0].channel, 'voice');
    assert.equal(events[0].call_session_id, session.id);
    assert.equal(events[0].detail, null);
  });

  it('a `human`-mode voice turn writes NO event — the AI did not handle it', async () => {
    const { conv, session } = await newVoiceSession('+919000000294', { mode: 'human' });

    const { status } = await postVoiceTurn({
      call_session_id: session.id, channel: 'voice', language: 'en-IN', transcript: 'is anyone there?',
    });
    assert.equal(status, 200);

    assert.deepEqual(await eventsFor(TENANT_ID, conv.id), [],
      'the mode gate returns before the emitter; `handled` would be a false claim');
  });

  it('tenant scoping is structural: another tenant cannot write onto this tenant\'s thread', async () => {
    const { conv } = await newVoiceSession('+919000000295');

    // The negative. OTHER_TENANT_ID is a real, active tenant passing a real
    // conversation id that simply is not its own. The INSERT ... SELECT finds
    // no row, so nothing is written and the helper returns undefined — the same
    // silent-empty shape getParticipatingChannels has for a foreign id.
    const written = await conversationService.recordEvent(OTHER_TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    assert.equal(written, undefined, 'no row inserted for a foreign tenant');

    const { rows: leaked } = await db.query(
      'SELECT * FROM conversation_events WHERE tenant_id = $1', [OTHER_TENANT_ID]);
    assert.deepEqual(leaked, [], 'the other tenant has no events at all');

    // And the thread itself is untouched: a failed cross-tenant write must not
    // have written the row under the OWNING tenant either.
    assert.deepEqual(await eventsFor(TENANT_ID, conv.id), [],
      'the owning tenant did not silently receive the foreign write');

    // The same call from the RIGHT tenant does write — so the assertion above
    // is about the tenant filter, not about the helper being broken.
    const ok = await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    assert.ok(ok, 'the owning tenant writes normally');
    assert.equal(ok.tenant_id, TENANT_ID);
  });

  it('a non-existent conversation writes nothing rather than raising', async () => {
    const written = await conversationService.recordEvent(
      TENANT_ID, '00000000-0000-0000-0000-000000000000',
      { type: 'handled', channel: 'voice', actor: 'ai' }
    );
    assert.equal(written, undefined);
  });

  it('the actor CHECK rejects an unknown actor, while `type` and `channel` stay open', async () => {
    const { conv } = await newVoiceSession('+919000000296');

    await assert.rejects(
      () => conversationService.recordEvent(TENANT_ID, conv.id, {
        type: 'handled', channel: 'voice', actor: 'robot',
      }),
      (err) => err.code === '23514',
      'actor is a closed set and the DB says so'
    );

    // The other half of the vocabulary decision: a type nobody has defined yet
    // is accepted today, which is the whole reason `type` is unconstrained. The
    // day an escalation signal exists, `escalated` is an INSERT, not a migration.
    const future = await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'escalated', channel: 'sms', actor: 'system',
    });
    assert.equal(future.type, 'escalated', '`type` is an open set');
    assert.equal(future.channel, 'sms', '`channel` is an open set, as turn_traces.channel is');
  });
});
