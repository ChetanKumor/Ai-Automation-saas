require('dotenv').config();

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const appointmentService  = require('../../src/modules/appointment/appointmentService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const turnMetrics         = require('../../src/infra/logging/turnMetrics');
const internalVoice       = require('../../src/routes/internalVoice');

// Issue 29 (V-001/V-003): JSON-path turn cancellation + coordinated deadline
// through the REAL route + DB. The review's repro — client aborts, server
// executes the tool anyway — is asserted GREEN here: aborted turns stop at the
// checkpoints, mutating tools cross the point of no return, and every abort
// traces honestly (outcome/abort_reason/aborted_after_commit — V-011 rider).

const TENANT_ID       = '00000000-0000-0000-0000-aaaa00000029';
const PHONE_NUMBER_ID = 'pnid_voice_cancel';
const SECRET          = 'cancel-voice-secret';

function istDateString(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const waitFor = async (fn, { timeoutMs = 5000, stepMs = 25 } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
};

/**
 * Scripted JSON-path model. Each step may carry:
 *   parts          [{text}|{functionCall}] — the completion
 *   beforeReturn   async ({ signal }) hook that runs INSIDE the server's
 *                  sendMessage before it returns (inject aborts mid-call)
 *   hangUntilAbort never resolve until the server-side signal aborts, then
 *                  reject the way the SDK does (deadline-path simulation)
 * Records every requestOptions seen so tests can assert signal presence.
 */
function scriptedModel(script) {
  const seen = { sends: [] };
  const abortError = () => {
    const err = new Error('[GoogleGenerativeAI Error]: request aborted');
    return err;
  };
  const provider = () => ({
    startChat: () => {
      let i = 0;
      return {
        sendMessage: async (payload, requestOptions = {}) => {
          const s = script[Math.min(i, script.length - 1)];
          i += 1;
          seen.sends.push({ payload, requestOptions });
          const signal = requestOptions.signal;
          if (s.hangUntilAbort) {
            await new Promise((_, reject) => {
              if (signal && signal.aborted) return reject(abortError());
              if (signal) signal.addEventListener('abort', () => reject(abortError()));
              // no signal: hang forever (bounded by the test timeout)
            });
          }
          if (s.beforeReturn) await s.beforeReturn({ signal });
          const text = (s.parts || []).filter((p) => p.text).map((p) => p.text).join('');
          const fcs = (s.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
          return {
            response: {
              functionCalls: () => (fcs.length ? fcs : undefined),
              text: () => text,
              usageMetadata: s.usage || {},
            },
          };
        },
        sendMessageStream: async () => { throw new Error('SSE surface not used by the JSON branch'); },
      };
    },
  });
  return { provider, seen };
}

let server;
let baseUrl;
let knowledgeMock;
let emitted = [];

async function cleanup() {
  await db.query('DELETE FROM turn_traces WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM notifications WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM appointments WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM messages WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM conversations WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenant_entities WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function seedCall(phone) {
  const { rows: [cust] } = await db.query(
    'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *',
    [TENANT_ID, phone]
  );
  const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
  const session = await voiceAdapter.startSession({
    tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
    provider: 'noop', direction: 'inbound', fromNumber: phone,
  });
  return { cust, conv, session };
}

function postTurn(body, opts = {}) {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-signature': hmac.sign(raw, SECRET) },
    body: raw,
    ...opts,
  });
}

const messagesOf = async (convId, direction) => {
  const { rows } = await db.query(
    'SELECT content FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = $3 AND channel = $4 ORDER BY created_at',
    [TENANT_ID, convId, direction, 'voice']
  );
  return rows;
};

const traceOf = (sessionId) => waitFor(async () => {
  const { rows } = await db.query(
    'SELECT error, tool_calls, llm FROM turn_traces WHERE tenant_id = $1 AND call_session_id = $2',
    [TENANT_ID, sessionId]
  );
  return rows[0] || null;
});

describe('voice turn cancellation + deadlines (Issue 29)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Cancel Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
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

    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks', async () => []);
    turnMetrics._setEmitFn((payload) => emitted.push(payload));

    const app = express();
    app.use('/internal/voice', internalVoice);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    turnMetrics._setEmitFn(null);
    aiService._setModelProvider(null);
    delete process.env.TURN_BUDGET_MS;
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  beforeEach(async () => {
    emitted = [];
    // Each test asserts the appointments table from empty (a failed test must
    // not leak its booking into the next one).
    await db.query('DELETE FROM appointments WHERE tenant_id = $1', [TENANT_ID]);
  });

  it('(1) client abort before the tool round: zero tool executions, zero outbound writes, trace outcome:aborted/client_gone (the V-001 repro, green)', async () => {
    const { session, conv } = await seedCall('+919000000031');
    const date = istDateString(1);
    const clientController = new AbortController();

    // Step 1 returns the check_availability call — but only after the client
    // has hung up and the server's close listener has aborted the turn signal
    // (deterministic: the hook waits for the propagated abort, exactly the
    // review's "tool executes after abandonment" window).
    const scripted = scriptedModel([
      {
        parts: [{ functionCall: { name: 'check_availability', args: { date } } }],
        beforeReturn: async ({ signal }) => {
          assert.ok(signal, 'pre-commit Gemini call must carry the turn signal');
          clientController.abort();
          const propagated = await waitFor(async () => signal.aborted, { timeoutMs: 3000 });
          assert.ok(propagated, "res.on('close') abort propagated into the turn signal");
        },
      },
    ]);
    aiService._setModelProvider(scripted.provider);
    const availabilitySpy = mock.method(appointmentService, 'checkAvailability');

    const t0 = Date.now();
    await assert.rejects(
      postTurn({
        call_session_id: session.id, channel: 'voice', language: 'en-IN',
        transcript: 'I want to book an appointment tomorrow morning',
      }, { signal: clientController.signal }),
      /abort/i
    );

    // Server settles: metrics line emitted, then assert the world.
    const line = await waitFor(async () => emitted.find((l) => l.call_session_id === session.id));
    assert.ok(line, 'turn emitted its metrics line (clean teardown)');
    assert.ok(Date.now() - t0 < 8000, 'server stopped within the turn budget');

    availabilitySpy.mock.restore();
    assert.equal(availabilitySpy.mock.callCount(), 0, 'no tool executed after the client was gone');
    assert.equal(line.tools.length, 0);
    assert.equal((await messagesOf(conv.id, 'inbound')).length, 1, 'inbound persists — the caller spoke');
    assert.equal((await messagesOf(conv.id, 'outbound')).length, 0, 'no outbound write for an aborted turn');

    const trace = await traceOf(session.id);
    assert.ok(trace, 'aborted turn still traces');
    assert.equal(trace.error.outcome, 'aborted');
    assert.equal(trace.error.abort_reason, 'client_gone');
    assert.equal(trace.error.aborted_after_commit, false);
  });

  it('(2) deadline: slow Gemini aborts at TURN_BUDGET_MS with a distinct 503, trace abort_reason:deadline, well inside the worker patience', async () => {
    const { session, conv } = await seedCall('+919000000032');
    process.env.TURN_BUDGET_MS = '400';
    try {
      aiService._setModelProvider(scriptedModel([{ hangUntilAbort: true }]).provider);

      const t0 = Date.now();
      const res = await postTurn({
        call_session_id: session.id, channel: 'voice', language: 'en-IN',
        transcript: 'hello?',
      });
      const elapsed = Date.now() - t0;

      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'turn aborted' });
      assert.ok(elapsed >= 350, `budget respected (elapsed ${elapsed}ms)`);
      assert.ok(elapsed < 10_000, `server gave up before the worker's 10s patience (elapsed ${elapsed}ms)`);

      assert.equal((await messagesOf(conv.id, 'outbound')).length, 0);
      const trace = await traceOf(session.id);
      assert.equal(trace.error.outcome, 'aborted');
      assert.equal(trace.error.abort_reason, 'deadline');
      assert.equal(trace.error.aborted_after_commit, false);
    } finally {
      delete process.env.TURN_BUDGET_MS;
    }
  });

  it('(3) point of no return: abort AFTER book_appointment executed -> turn completes persistence; booking + outbound + trace aborted_after_commit:true; post-commit calls drop the signal', async () => {
    const { session, conv } = await seedCall('+919000000033');
    const date = istDateString(2);
    const clientController = new AbortController();

    const scripted = scriptedModel([
      { parts: [{ functionCall: { name: 'check_availability', args: { date } } }] },
      { parts: [{ functionCall: { name: 'book_appointment', args: {
          doctor_name: 'Dr. Rao', appointment_time: `${date}T10:30:00+05:30`, patient_name: 'Meena' } } }] },
      {
        parts: [{ text: 'Booked for ten thirty.' }],
        // The booking committed one round earlier: the client hangs up NOW.
        beforeReturn: async ({ signal }) => {
          assert.equal(signal, undefined, 'post-commit Gemini calls must NOT carry the abort signal');
          clientController.abort();
          // Give the socket close a beat to reach the route's listener.
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    ]);
    aiService._setModelProvider(scripted.provider);

    await assert.rejects(
      postTurn({
        call_session_id: session.id, channel: 'voice', language: 'en-IN',
        transcript: 'yes, book the ten thirty slot for Meena',
      }, { signal: clientController.signal }),
      /abort/i
    );

    const line = await waitFor(async () => emitted.find((l) => l.call_session_id === session.id));
    assert.ok(line);
    assert.deepEqual(line.tools.map((t) => t.name), ['check_availability', 'book_appointment']);

    const { rows: appts } = await db.query(
      'SELECT doctor_name FROM appointments WHERE tenant_id = $1', [TENANT_ID]);
    assert.equal(appts.length, 1, 'the committed booking stands');
    assert.equal(appts[0].doctor_name, 'Dr. Rao');

    const outbound = await messagesOf(conv.id, 'outbound');
    assert.equal(outbound.length, 1, 'confirmation text persisted unconditionally');
    assert.equal(outbound[0].content, 'Booked for ten thirty.');

    const trace = await traceOf(session.id);
    assert.equal(trace.error.outcome, 'aborted');
    assert.equal(trace.error.abort_reason, 'client_gone');
    assert.equal(trace.error.aborted_after_commit, true);
  });

  it('(4) read-only tool then abort: stops before the mutating tool — no booking, no outbound', async () => {
    const { session, conv } = await seedCall('+919000000034');
    const date = istDateString(3);
    const clientController = new AbortController();

    const scripted = scriptedModel([
      { parts: [{ functionCall: { name: 'check_availability', args: { date } } }] },
      {
        // The NEXT completion would book — but the client hangs up while this
        // call is in flight; the pre-tool checkpoint must stop the booking.
        parts: [{ functionCall: { name: 'book_appointment', args: {
          doctor_name: 'Dr. Rao', appointment_time: `${date}T11:00:00+05:30`, patient_name: 'Meena' } } }],
        beforeReturn: async ({ signal }) => {
          assert.ok(signal, 'still pre-commit: signal present');
          clientController.abort();
          await waitFor(async () => signal.aborted, { timeoutMs: 3000 });
        },
      },
    ]);
    aiService._setModelProvider(scripted.provider);
    const bookSpy = mock.method(appointmentService, 'bookAppointment');

    await assert.rejects(
      postTurn({
        call_session_id: session.id, channel: 'voice', language: 'en-IN',
        transcript: 'anything free day after tomorrow?',
      }, { signal: clientController.signal }),
      /abort/i
    );

    const line = await waitFor(async () => emitted.find((l) => l.call_session_id === session.id));
    assert.ok(line);
    bookSpy.mock.restore();
    assert.equal(bookSpy.mock.callCount(), 0, 'read-only tool does not cross the point of no return');
    assert.deepEqual(line.tools.map((t) => t.name), ['check_availability']);

    const { rows: appts } = await db.query('SELECT 1 FROM appointments WHERE tenant_id = $1', [TENANT_ID]);
    assert.equal(appts.length, 0);
    assert.equal((await messagesOf(conv.id, 'outbound')).length, 0);

    const trace = await traceOf(session.id);
    assert.equal(trace.error.outcome, 'aborted');
    assert.equal(trace.error.abort_reason, 'client_gone');
    assert.equal(trace.error.aborted_after_commit, false);
  });

  it('(5) happy path: normal booking turn unchanged — 200, booked, trace error null', async () => {
    const { session, conv } = await seedCall('+919000000035');
    const date = istDateString(4);
    const scripted = scriptedModel([
      { parts: [{ functionCall: { name: 'check_availability', args: { date } } }] },
      { parts: [{ functionCall: { name: 'book_appointment', args: {
          doctor_name: 'Dr. Rao', appointment_time: `${date}T12:00:00+05:30`, patient_name: 'Ravi' } } }] },
      { parts: [{ text: 'Booked for noon.' }] },
    ]);
    aiService._setModelProvider(scripted.provider);

    const res = await postTurn({
      call_session_id: session.id, channel: 'voice', language: 'en-IN',
      transcript: 'book me the noon slot',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reply_text: 'Booked for noon.', end_call: false, language: 'en-IN' });

    // Every pre-commit call carried the signal; the post-commit one did not.
    assert.equal(scripted.seen.sends.length, 3);
    assert.ok(scripted.seen.sends[0].requestOptions.signal);
    assert.ok(scripted.seen.sends[1].requestOptions.signal);
    assert.equal(scripted.seen.sends[2].requestOptions.signal, undefined);

    assert.equal((await messagesOf(conv.id, 'outbound')).length, 1);
    const trace = await traceOf(session.id);
    assert.equal(trace.error, null, 'clean success traces with error null');
  });
});
