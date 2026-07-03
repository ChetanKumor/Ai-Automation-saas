require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const turnMetrics         = require('../../src/infra/logging/turnMetrics');
const internalVoice       = require('../../src/routes/internalVoice');

// PR9C: the opt-in SSE turn mode through the REAL route + DB — event protocol
// (ack/delta/done order), flag-off byte-identity, disconnect abort + partial
// persistence, HMAC-before-bytes, thinking canary, and the mode gate.

const TENANT_ID       = '00000000-0000-0000-0000-aaaa00000021';
const PHONE_NUMBER_ID = 'pnid_voice_stream';
const SECRET          = 'stream-voice-secret';

function istDateString(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Scripted model implementing BOTH surfaces: sendMessage (JSON branch) and
// sendMessageStream (SSE branch, per-part chunks + aggregated promise).
function scriptedModel(script) {
  const seen = { sends: [] };
  const provider = () => ({
    startChat: () => {
      let i = 0;
      const step = () => {
        const s = script[Math.min(i, script.length - 1)];
        i += 1;
        return s;
      };
      return {
        sendMessage: async () => {
          const s = step();
          const text = (s.parts || []).filter((p) => p.text).map((p) => p.text).join('');
          const fcs = (s.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
          return {
            response: {
              functionCalls: () => (fcs.length ? fcs : undefined),
              text: () => text,
              usageMetadata: s.usage,
            },
          };
        },
        sendMessageStream: async (payload, requestOptions = {}) => {
          const s = step();
          seen.sends.push({ payload, requestOptions });
          const signal = requestOptions.signal;
          const abortError = () => new Error('[GoogleGenerativeAI Error]: Error reading from the stream');
          async function* gen() {
            for (const part of s.parts) {
              yield { candidates: [{ content: { parts: [part] } }] };
            }
            if (s.hangUntilAbort) {
              await new Promise((_, reject) => {
                if (signal && signal.aborted) return reject(abortError());
                if (signal) signal.addEventListener('abort', () => reject(abortError()));
              });
            }
          }
          const text = s.parts.filter((p) => p.text).map((p) => p.text).join('');
          const fcs = s.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
          const aggregated = {
            functionCalls: () => (fcs.length ? fcs : undefined),
            text: () => text,
            usageMetadata: s.usage,
          };
          const response = s.hangUntilAbort
            ? new Promise((resolve, reject) => {
                if (signal && signal.aborted) return reject(abortError());
                if (signal) signal.addEventListener('abort', () => reject(abortError()));
              })
            : Promise.resolve(aggregated);
          return { stream: gen(), response };
        },
      };
    },
  });
  return { provider, seen };
}

const bookingScript = ({ date, appointmentTime }) => [
  { parts: [{ functionCall: { name: 'check_availability', args: { date } } }],
    usage: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } },
  { parts: [{ functionCall: { name: 'book_appointment', args: { doctor_name: 'Dr. Rao', appointment_time: appointmentTime, patient_name: 'Meena' } } }],
    usage: { promptTokenCount: 140, candidatesTokenCount: 20, totalTokenCount: 160 } },
  { parts: [{ text: 'Booked for ' }, { text: 'ten thirty tomorrow.' }],
    usage: { promptTokenCount: 180, candidatesTokenCount: 15, totalTokenCount: 195 } },
];

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

async function seedCall(phone, { mode } = {}) {
  const { rows: [cust] } = await db.query(
    'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *',
    [TENANT_ID, phone]
  );
  const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
  if (mode) await conversationService.setMode(TENANT_ID, conv.id, mode);
  const session = await voiceAdapter.startSession({
    tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
    provider: 'noop', direction: 'inbound', fromNumber: phone,
  });
  return { cust, conv, session };
}

function signedHeaders(raw, { sse = false } = {}) {
  return {
    'content-type': 'application/json',
    'x-internal-signature': hmac.sign(raw, SECRET),
    ...(sse ? { accept: 'text/event-stream' } : {}),
  };
}

/** Incrementally parse an SSE response body; onEvent fires per event as it
 * arrives (before the stream is fully consumed). Returns all events. */
async function readSSE(res, onEvent) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
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
      if (onEvent) await onEvent(evt);
    }
  }
  return events;
}

async function postTurnSSE(body, onEvent) {
  const raw = JSON.stringify({ ...body, stream: true });
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: signedHeaders(raw, { sse: true }),
    body: raw,
  });
  return { res, events: res.status === 200 ? await readSSE(res, onEvent) : null };
}

describe('voice turn SSE mode (PR9C)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Stream Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
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
    app.use('/internal/voice', internalVoice);
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

  it('(1) tool turn: ack -> deltas -> done; done after outbound persistence; ack text from constants', async () => {
    const { session, conv } = await seedCall('+919000000021');
    const date = istDateString(1);
    aiService._setModelProvider(scriptedModel(bookingScript({
      date, appointmentTime: `${date}T10:30:00+05:30`,
    })).provider);

    let rowAtDone = null;
    const { res, events } = await postTurnSSE({
      call_session_id: session.id, channel: 'voice', language: 'te-IN',
      transcript: 'రేపు ఉదయం అపాయింట్‌మెంట్ కావాలి',
    }, async (evt) => {
      if (evt.event === 'done') {
        // The outbound row must ALREADY be persisted when done arrives.
        const { rows } = await db.query(
          "SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND channel = 'voice'",
          [conv.id]
        );
        rowAtDone = rows[0] || null;
      }
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    assert.deepEqual(events.map((e) => e.event), ['ack', 'delta', 'delta', 'done']);
    assert.deepEqual(events[0].data, {
      text: internalVoice._VOICE_ACK_COPY['te-IN'],
      language: 'te-IN',
    });
    assert.equal(events[1].data.text, 'Booked for ');
    assert.equal(events[2].data.text, 'ten thirty tomorrow.');
    assert.deepEqual(events[3].data, {
      reply_text: 'Booked for ten thirty tomorrow.',
      end_call: false,
      language: 'te-IN',
    });
    assert.ok(rowAtDone, 'outbound row persisted before done was emitted');
    assert.equal(rowAtDone.content, 'Booked for ten thirty tomorrow.');

    // Metrics: stream_mode line, ack offset, per-call streamed + thinking canary.
    const line = emitted.find((l) => l.call_session_id === session.id);
    assert.ok(line, 'metrics line emitted');
    assert.equal(line.stream_mode, true);
    assert.ok(typeof line.ack_emitted_ms === 'number' && line.ack_emitted_ms > 0);
    assert.ok(typeof line.first_delta_ms === 'number' && line.first_delta_ms >= line.ack_emitted_ms);
    assert.equal(line.gemini.calls.length, 3);
    for (const c of line.gemini.calls) {
      assert.equal(c.streamed, true);
      assert.equal(c.thinking_tokens, 0); // (6) canary
    }
    assert.deepEqual(line.tools.map((t) => t.name), ['check_availability', 'book_appointment']);
  });

  it('(2) plain turn: NO ack, deltas -> done', async () => {
    const { session } = await seedCall('+919000000022');
    aiService._setModelProvider(scriptedModel([
      { parts: [{ text: 'మేము ఉదయం తొమ్మిది నుండి ' }, { text: 'తెరిచి ఉంటాము.' }], usage: {} },
    ]).provider);

    const { events } = await postTurnSSE({
      call_session_id: session.id, channel: 'voice', language: 'te-IN',
      transcript: 'మీ పని వేళలు ఏమిటి?',
    });

    assert.deepEqual(events.map((e) => e.event), ['delta', 'delta', 'done']);
    assert.equal(events[2].data.reply_text, 'మేము ఉదయం తొమ్మిది నుండి తెరిచి ఉంటాము.');

    const line = emitted.find((l) => l.call_session_id === session.id);
    assert.equal(line.stream_mode, true);
    assert.equal(line.ack_emitted_ms, undefined); // no tool round -> no ack
    assert.ok(typeof line.first_delta_ms === 'number');
  });

  it('(3) flag off: JSON response byte-identical to the pre-PR recorded fixture', async () => {
    const { session } = await seedCall('+919000000023');
    aiService._setModelProvider(scriptedModel([
      { parts: [{ text: 'మేము ఉదయం తొమ్మిది నుండి సాయంత్రం ఆరు వరకు తెరిచి ఉంటాము.' }], usage: {} },
    ]).provider);

    const raw = JSON.stringify({
      call_session_id: session.id, channel: 'voice', language: 'te-IN',
      transcript: 'మీ పని వేళలు ఏమిటి?',
    });
    const res = await fetch(`${baseUrl}/internal/voice/turn`, {
      method: 'POST', headers: signedHeaders(raw), body: raw,
    });
    assert.equal(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'pr9c-json-turn-body.bin'));
    assert.ok(body.equals(fixture), `body diverged from pre-PR fixture:\n got: ${body}\n want: ${fixture}`);
  });

  it('(3b) belt-and-braces: stream:true WITHOUT the Accept header stays JSON', async () => {
    const { session } = await seedCall('+919000000024');
    aiService._setModelProvider(scriptedModel([
      { parts: [{ text: 'ok' }], usage: {} },
    ]).provider);

    const raw = JSON.stringify({
      call_session_id: session.id, channel: 'voice', language: 'en-IN',
      transcript: 'hello', stream: true,
    });
    const res = await fetch(`${baseUrl}/internal/voice/turn`, {
      method: 'POST', headers: signedHeaders(raw), body: raw,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { reply_text: 'ok', end_call: false, language: 'en-IN' });
  });

  it('(4) client disconnect mid-stream: model stream aborted, partial outbound persisted, no crash', async () => {
    const { session, conv } = await seedCall('+919000000025');
    const scripted = scriptedModel([
      { parts: [{ text: 'The first half of a long answer ' }], usage: {}, hangUntilAbort: true },
    ]);
    aiService._setModelProvider(scripted.provider);

    const controller = new AbortController();
    const raw = JSON.stringify({
      call_session_id: session.id, channel: 'voice', language: 'en-IN',
      transcript: 'tell me everything about the clinic', stream: true,
    });
    const res = await fetch(`${baseUrl}/internal/voice/turn`, {
      method: 'POST', headers: signedHeaders(raw, { sse: true }), body: raw,
      signal: controller.signal,
    });
    assert.equal(res.status, 200);

    // Read up to the first delta, then hang up (barge-in / dead client).
    await readSSE(res, async (evt) => {
      if (evt.event === 'delta') controller.abort();
    }).catch(() => {}); // the fetch abort surfaces here — expected

    // Server side settles asynchronously: wait for the partial row.
    let row = null;
    for (let i = 0; i < 50 && !row; i++) {
      const { rows } = await db.query(
        "SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND channel = 'voice'",
        [conv.id]
      );
      row = rows[0] || null;
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }

    // The in-flight Gemini stream was aborted via the AbortSignal (spy).
    assert.equal(scripted.seen.sends.length, 1);
    assert.equal(scripted.seen.sends[0].requestOptions.signal.aborted, true);
    // What was generated so far became the outbound message.
    assert.ok(row, 'partial outbound persisted after disconnect');
    assert.equal(row.content, 'The first half of a long answer');
    // The turn still emitted its metrics line (no crash, clean teardown).
    const line = emitted.find((l) => l.call_session_id === session.id);
    assert.ok(line);
    assert.equal(line.stream_mode, true);

    // The server is still healthy: a fresh turn on a new call succeeds.
    const again = await seedCall('+919000000026');
    aiService._setModelProvider(scriptedModel([{ parts: [{ text: 'still alive' }], usage: {} }]).provider);
    const { events } = await postTurnSSE({
      call_session_id: again.session.id, channel: 'voice', language: 'en-IN', transcript: 'ping',
    });
    assert.equal(events.at(-1).data.reply_text, 'still alive');
  });

  it('(5) HMAC failure: 401, no SSE bytes', async () => {
    const raw = JSON.stringify({
      call_session_id: '00000000-0000-0000-0000-000000000000', channel: 'voice',
      language: 'en-IN', transcript: 'hi', stream: true,
    });
    const res = await fetch(`${baseUrl}/internal/voice/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-internal-signature': 'sha256=' + '0'.repeat(64),
      },
      body: raw,
    });
    assert.equal(res.status, 401);
    assert.doesNotMatch(String(res.headers.get('content-type')), /text\/event-stream/);
  });

  it('(7) mode gate (human): SSE turn -> done with empty reply, no ack/deltas, no model call', async () => {
    const { session } = await seedCall('+919000000027', { mode: 'human' });
    // Any model call would throw: provider must never be reached.
    aiService._setModelProvider(() => { throw new Error('model must not be called for gated turns'); });

    const { events } = await postTurnSSE({
      call_session_id: session.id, channel: 'voice', language: 'te-IN', transcript: 'హలో',
    });

    assert.deepEqual(events.map((e) => e.event), ['done']);
    assert.deepEqual(events[0].data, { reply_text: '', end_call: false, language: 'te-IN' });

    const line = emitted.find((l) => l.call_session_id === session.id);
    assert.equal(line.stream_mode, true);
    assert.equal(line.gemini.calls.length, 0);
  });
});
