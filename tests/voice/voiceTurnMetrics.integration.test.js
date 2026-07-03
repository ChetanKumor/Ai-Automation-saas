require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const turnMetrics         = require('../../src/infra/logging/turnMetrics');

// PR9A test (e): a full turn through the REAL route + DB emits ONE structured
// log line whose stages cover every step (hydrate_validate, persist_inbound,
// fetch_parallel + sub-timings, gemini_call_<n>, tool_exec_<n>_<name>,
// persist_outbound) with one gemini.calls entry per model call.

const TENANT_ID       = '00000000-0000-0000-0000-mmmm00000012'.replace(/m/g, 'a');
const PHONE_NUMBER_ID = 'pnid_voice_metrics';
const SECRET          = 'metrics-voice-secret';

function istDateString(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Scripted 3-call turn: check_availability → book_appointment → final text,
// with usageMetadata on each response so token propagation is asserted too.
function scriptedBookingModel({ date, appointmentTime }) {
  const script = [
    { functionCalls: [{ name: 'check_availability', args: { date } }],
      usage: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } },
    { functionCalls: [{ name: 'book_appointment', args: { doctor_name: 'Dr. Rao', appointment_time: appointmentTime, patient_name: 'Meena' } }],
      usage: { promptTokenCount: 140, candidatesTokenCount: 20, totalTokenCount: 160 } },
    { functionCalls: null, text: 'Booked for ten thirty tomorrow.',
      usage: { promptTokenCount: 180, candidatesTokenCount: 15, thoughtsTokenCount: 0, totalTokenCount: 195 } },
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
              usageMetadata: step.usage,
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
const emitted = [];

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

describe('voice turn metrics — one structured log line per turn (PR9A)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Metrics Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
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

    knowledgeMock = require('node:test').mock.method(knowledgeService, 'getRelevantChunks', async () => []);
    turnMetrics._setEmitFn((payload) => emitted.push(payload));

    const app = express();
    app.use('/internal/voice', require('../../src/routes/internalVoice'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    turnMetrics._setEmitFn(null);
    aiService._setModelProvider(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  it('a booking turn emits every stage key + one gemini.calls entry per model call', async () => {
    const { rows: [cust] } = await db.query(
      'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *',
      [TENANT_ID, '+919000000012']
    );
    const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
    const session = await voiceAdapter.startSession({
      tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
      provider: 'noop', direction: 'inbound', fromNumber: '+919000000012',
    });

    const date = istDateString(1);
    aiService._setModelProvider(scriptedBookingModel({
      date, appointmentTime: `${date}T10:30:00+05:30`,
    }));

    const res = await postTurn({
      call_session_id: session.id,
      channel: 'voice',
      language: 'te-IN',
      transcript: 'రేపు ఉదయం అపాయింట్‌మెంట్ కావాలి',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.reply_text, 'Booked for ten thirty tomorrow.');

    // Exactly ONE metrics line for this turn.
    const lines = emitted.filter((l) => l.call_session_id === session.id);
    assert.equal(lines.length, 1);
    const line = lines[0];

    assert.ok(line.turn_id, 'turn_id present');
    assert.equal(line.tenant_id, TENANT_ID);
    assert.ok(typeof line.total_node_ms === 'number' && line.total_node_ms > 0);

    // Every stage key, each a non-negative number.
    const expectedStages = [
      'hydrate_validate',
      'persist_inbound',
      'fetch_parallel',
      'fetch_parallel_history',
      'fetch_parallel_memory',
      'fetch_parallel_knowledge',
      'gemini_call_1',
      'gemini_call_2',
      'gemini_call_3',
      'tool_exec_1_check_availability',
      'tool_exec_2_book_appointment',
      'persist_outbound',
    ];
    for (const key of expectedStages) {
      assert.ok(typeof line.stages[key] === 'number' && line.stages[key] >= 0, `stage ${key}`);
    }

    // One gemini.calls entry per model call, with token telemetry.
    assert.equal(line.gemini.calls.length, 3);
    assert.deepEqual(line.gemini.calls.map((c) => c.n), [1, 2, 3]);
    assert.equal(line.gemini.calls[0].input_tokens, 100);
    assert.equal(line.gemini.calls[0].output_tokens, 12);
    assert.equal(line.gemini.calls[0].thinking_tokens, 0); // absent in usage ⇒ 0
    assert.equal(line.gemini.calls[2].thinking_tokens, 0); // explicit 0 stays 0

    // Named tool execs, in order.
    assert.deepEqual(line.tools.map((t) => t.name), ['check_availability', 'book_appointment']);
  });

  it('a mode-gated turn (human) still emits a line — hydrate + persist stages only', async () => {
    const { rows: [cust] } = await db.query(
      'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *',
      [TENANT_ID, '+919000000013']
    );
    const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
    await conversationService.setMode(TENANT_ID, conv.id, 'human');
    const session = await voiceAdapter.startSession({
      tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
      provider: 'noop', direction: 'inbound', fromNumber: '+919000000013',
    });

    const res = await postTurn({
      call_session_id: session.id,
      channel: 'voice',
      language: 'te-IN',
      transcript: 'హలో',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.reply_text, '');

    const line = emitted.find((l) => l.call_session_id === session.id);
    assert.ok(line, 'metrics line emitted for gated turn');
    assert.ok(typeof line.stages.hydrate_validate === 'number');
    assert.ok(typeof line.stages.persist_inbound === 'number');
    assert.equal(line.gemini.calls.length, 0);
  });
});
