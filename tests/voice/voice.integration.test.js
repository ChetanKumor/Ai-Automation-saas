require('dotenv').config();

const { describe, it, before, after } = require('node:test');
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
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const telephony           = require('../../src/modules/telephony/telephonyProvider');

const TENANT_ID        = '00000000-0000-0000-0000-vvvv00000010'.replace(/v/g, 'a');
const PHONE_NUMBER_ID  = 'pnid_voice_integration';
const SECRET           = 'integration-voice-secret';

const tick = () => new Promise((r) => setImmediate(r));

function istDateString(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// A scripted model that drives the REAL tool loop deterministically (no live
// Gemini): turn 1 -> check_availability, turn 2 -> book_appointment, turn 3 -> text.
function scriptedBookingModel({ date, doctorName, appointmentTime, patientName, replyText }) {
  const script = [
    { functionCalls: [{ name: 'check_availability', args: { date } }] },
    { functionCalls: [{ name: 'book_appointment', args: { doctor_name: doctorName, appointment_time: appointmentTime, patient_name: patientName } }] },
    { functionCalls: null, text: replyText },
  ];
  return () => ({
    startChat: () => {
      let i = 0;
      return {
        sendMessage: async () => {
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          return {
            response: {
              functionCalls: () => step.functionCalls || undefined,
              text: () => step.text || '',
            },
          };
        },
      };
    },
  });
}

let server;
let baseUrl;
let knowledgeMock;
const started = [];
const ended = [];
const messagesReceived = [];

async function cleanup() {
  await db.query('DELETE FROM messages WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM appointments WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM conversations WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenant_entities WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function postTurn(body) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-signature': hmac.sign(raw, SECRET) },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

async function newScenario(phone) {
  const { rows: [cust] } = await db.query(
    'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *', [TENANT_ID, phone]
  );
  const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
  const session = await voiceAdapter.startSession({
    tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
    provider: 'noop', direction: 'inbound', fromNumber: phone, languageDetected: null,
  });
  await tick();
  return { cust, conv, session };
}

describe('Voice turn → existing brain (the PR6 proof; no telephony, no audio)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Voice Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
      [TENANT_ID, PHONE_NUMBER_ID, encrypt('dummy-wa-token')]
    );
    await db.query(
      "INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1, 'schedule', $2)",
      [TENANT_ID, JSON.stringify({
        doctor: 'Dr. Rao',
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        start: '09:00', end: '18:00', slot_minutes: 30,
      })]
    );

    // Keep the turn hermetic: no live Gemini embeddings for RAG.
    knowledgeMock = require('node:test').mock.method(knowledgeService, 'getRelevantChunks', async () => []);

    eventBus.on(EVENT.CALL_STARTED, (e) => started.push(e.payload));
    eventBus.on(EVENT.CALL_ENDED, (e) => ended.push(e.payload));
    eventBus.on(EVENT.MESSAGE_RECEIVED, (e) => messagesReceived.push(e.payload));

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
  });

  // Shared assertion body for both languages.
  async function bookingProof({ phone, language, transcript, patientName, daysAhead, hhmm, replyText }) {
    const { cust, conv, session } = await newScenario(phone);

    const date = istDateString(daysAhead);
    const appointmentTime = `${date}T${hhmm}:00+05:30`;
    aiService._setModelProvider(scriptedBookingModel({
      date, doctorName: 'Dr. Rao', appointmentTime, patientName, replyText,
    }));

    const res = await postTurn({
      tenant_id: TENANT_ID,
      customer_id: cust.id,
      conversation_id: conv.id,
      call_session_id: session.id,
      channel: 'voice',
      language,
      transcript,
    });

    // 1. Endpoint returned a spoken reply in the caller's language.
    assert.equal(res.status, 200);
    assert.equal(res.json.reply_text, replyText);
    assert.equal(res.json.end_call, false);
    assert.equal(res.json.language, language);

    // 2. The SAME booking tool + guards fired: a real appointment exists.
    const { rows: appts } = await db.query(
      "SELECT doctor_name, status FROM appointments WHERE tenant_id = $1 AND customer_id = $2",
      [TENANT_ID, cust.id]
    );
    assert.equal(appts.length, 1);
    assert.equal(appts[0].doctor_name, 'Dr. Rao');
    assert.equal(appts[0].status, 'booked');

    // 3. CRM/customer state updated through the shared tool (name written).
    const { rows: [c2] } = await db.query('SELECT name, preferred_language FROM customers WHERE id = $1', [cust.id]);
    assert.equal(c2.name, patientName);

    // 4. preferred_language prior persisted from STT detection (was null).
    assert.equal(c2.preferred_language, language);

    // 5. Voice turns persisted to messages with channel='voice' (inbound + outbound).
    const { rows: msgs } = await db.query(
      'SELECT direction, sender, channel, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conv.id]
    );
    assert.equal(msgs.length, 2);
    assert.deepEqual(
      msgs.map((m) => [m.direction, m.sender, m.channel]),
      [['inbound', 'customer', 'voice'], ['outbound', 'ai', 'voice']]
    );
    assert.equal(msgs[0].content, transcript);
    assert.equal(msgs[1].content, replyText);

    // 6. call_session was created (started) and is closed on end.
    await voiceAdapter.endSession(session.id, TENANT_ID, { durationSeconds: 30 });
    await tick();
    const closed = await callSessions.get(session.id, TENANT_ID);
    assert.equal(closed.status, 'completed');
    assert.ok(closed.ended_at);

    // 7. call.started / call.ended emitted on the existing bus for this session.
    assert.ok(started.find((p) => p.call_session_id === session.id), 'call.started emitted');
    assert.ok(ended.find((p) => p.call_session_id === session.id && p.status === 'completed'), 'call.ended emitted');

    // 8. message.received from the JSON-turn emit site carries channel +
    //    msg_type (V-002 — the extraction policy gate reads these).
    const mr = messagesReceived.find((p) => p.conversation_id === conv.id);
    assert.ok(mr, 'message.received emitted for the voice turn');
    assert.equal(mr.channel, 'voice');
    assert.equal(mr.msg_type, 'text');
    assert.equal(mr.text, transcript);
  }

  it('Telugu "book appointment" transcript books via the same tool/guards', async () => {
    await bookingProof({
      phone: '+919000000010',
      language: 'te-IN',
      transcript: 'రేపు ఉదయం డాక్టర్ రావు దగ్గర అపాయింట్‌మెంట్ కావాలి', // "I want an appointment with Dr. Rao tomorrow morning"
      patientName: 'Ravi',
      daysAhead: 1,
      hhmm: '10:30',
      replyText: 'Done — your appointment with Dr. Rao is booked for tomorrow at ten thirty in the morning.',
    });
  });

  it('Hinglish (Hindi+English) transcript books via the same tool/guards', async () => {
    await bookingProof({
      phone: '+919000000011',
      language: 'hi-IN',
      transcript: 'Mujhe parso Dr. Rao ke saath ek appointment book karna hai gyarah baje', // "book me an appointment with Dr. Rao day-after at eleven"
      patientName: 'Priya',
      daysAhead: 2,
      hhmm: '11:00',
      replyText: 'Theek hai Priya — Dr. Rao ke saath aapka appointment book ho gaya hai.',
    });
  });

  it('rejects a turn with a bad HMAC signature (401)', async () => {
    const raw = JSON.stringify({ tenant_id: TENANT_ID, customer_id: 'x', conversation_id: 'y', channel: 'voice', transcript: 'hi' });
    const res = await fetch(`${baseUrl}/internal/voice/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-signature': 'sha256=deadbeef' },
      body: raw,
    });
    assert.equal(res.status, 401);
  });
});

// ── call_sessions CRUD + telephony-mock argument capture (DB-backed) ─────────

describe('call_sessions CRUD + telephony mock', () => {
  const T = '00000000-0000-0000-0000-vvvv00000011'.replace(/v/g, 'a');

  before(async () => {
    await db.query(
      "INSERT INTO tenants (id, business_name, phone_number_id, active, ai_enabled) VALUES ($1,'CRUD','pnid_crud',true,true) ON CONFLICT (id) DO NOTHING",
      [T]
    );
  });

  after(async () => {
    await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [T]);
    await db.query('DELETE FROM customers WHERE tenant_id = $1', [T]);
    await db.query('DELETE FROM tenants WHERE id = $1', [T]);
  });

  it('create / get / updateStatus are tenant-scoped', async () => {
    const { rows: [cust] } = await db.query(
      "INSERT INTO customers (tenant_id, phone) VALUES ($1,'+919000000099') RETURNING *", [T]
    );
    const s = await callSessions.create({ tenantId: T, customerId: cust.id, provider: 'noop', direction: 'inbound', status: 'in_progress' });
    assert.equal(s.status, 'in_progress');
    assert.ok(s.started_at);

    assert.equal((await callSessions.get(s.id, T)).id, s.id);
    assert.equal(await callSessions.get(s.id, '00000000-0000-0000-0000-aaaa99999999'), null); // wrong tenant

    const upd = await callSessions.updateStatus(s.id, T, { status: 'completed', endedAt: new Date(), durationSeconds: 12 });
    assert.equal(upd.status, 'completed');
    assert.equal(upd.duration_seconds, 12);
  });

  it('a TelephonyProvider mock is called with the expected args', async () => {
    const calls = [];
    const mockProvider = {
      name: 'mock',
      onInboundCall: (h) => calls.push(['onInboundCall', typeof h]),
      startCall: async (meta) => { calls.push(['startCall', meta]); return { id: 'h1' }; },
      streamAudioIn: (h) => calls.push(['streamAudioIn', h]),
      streamAudioOut: (h, a) => calls.push(['streamAudioOut', h, a]),
      endCall: async (h) => { calls.push(['endCall', h]); },
    };
    telephony.register(mockProvider);
    const p = telephony.getProvider('mock');

    p.onInboundCall(() => {});
    const handle = await p.startCall({ direction: 'inbound', from: '+91900', to: '+91800' });
    await p.endCall(handle);

    assert.deepEqual(calls[0], ['onInboundCall', 'function']);
    assert.equal(calls[1][0], 'startCall');
    assert.equal(calls[1][1].from, '+91900');
    assert.deepEqual(calls[2], ['endCall', { id: 'h1' }]);
  });
});
