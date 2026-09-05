'use strict';

// INCIDENTS-A — the SSE voice turn records its aborts.
//
// `handleTurnSSE` has TWO abort sites, and before this session neither called
// `trace.setAbort`. Both `return` into the handler's `finally { trace.flush() }`,
// so an abandoned call — the caller hung up mid-answer — persisted a turn_traces
// row with `error: NULL`. statusOf ranked it ok. The unary branch's twin sites
// have recorded since Issue 29; the SSE wiring was described in the code as an
// "intentional mirror" and this is the part that was not mirrored.
//
// This is not dark code. `VOICE_STREAM_TURNS` is read only by the Python worker
// (voice-agent/agent.py) and decides whether the WORKER sends the opt-in; Node
// selects this branch purely on request shape (`wantsStream`: Accept
// text/event-stream + body stream:true). The handler is therefore reachable at
// HEAD with no flag set anywhere, which is exactly how both tests below reach it
// — and at deploy it becomes the branch every live call takes.
//
// §Site attribution. "An abort was recorded" is not enough: both sites write the
// identical envelope, so a pair of tests could both land on one site and leave
// the other uncovered. Each test therefore pins its site two ways:
//   site A (clean return) — the model's generator finishes NORMALLY after the
//     abort, and the catch's "client disconnected" log line is NOT emitted.
//   site B (throw)        — the model rejects the way the SDK does, and that
//     same log line IS emitted.
// Only one site can produce each combination.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const logger              = require('../../src/infra/logging/logger');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const internalVoice       = require('../../src/routes/internalVoice');

// Disjoint from every other fixture tenant in tests/ — voiceStream owns
// ...aaaa00000021, voiceCancellation ...aaaa00000029, voiceStreamRagSignal
// ...aaaa00000041. These suites run against one database and each cleans up its
// own tenant by id, so a shared id would delete another suite's fixture mid-run.
const TENANT_ID       = '00000000-0000-0000-0000-aaaa00000047';
const PHONE_NUMBER_ID = 'pnid_voice_abort_trace';
const SECRET          = 'abort-trace-voice-secret';

const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';

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
 * Streaming model that yields `text`, then waits for the SERVER-side turn signal
 * to abort before finishing. That wait is what makes both tests deterministic
 * rather than a race: the handler sets its `aborted` flag immediately before it
 * aborts the controller, so by the time this resolves the handler is guaranteed
 * to take its abort branch.
 *
 * `mode: 'return'` ends the stream normally afterwards (site A); `mode: 'throw'`
 * rejects the way the SDK does on an aborted read (site B).
 */
function abortingStreamModel(text, mode) {
  const seen = { completedNormally: false, threw: false };
  const provider = () => ({
    startChat: () => ({
      sendMessageStream: async (payload, requestOptions = {}) => {
        const signal = requestOptions.signal;
        const abortError = () => new Error('[GoogleGenerativeAI Error]: Error reading from the stream');
        const untilAborted = () => new Promise((resolve) => {
          if (signal && signal.aborted) return resolve();
          if (signal) return signal.addEventListener('abort', () => resolve());
          // no signal: this model would hang, which the test timeout catches
        });

        async function* gen() {
          yield { candidates: [{ content: { parts: [{ text }] } }] };
          await untilAborted();
          if (mode === 'throw') { seen.threw = true; throw abortError(); }
          seen.completedNormally = true;
        }

        const aggregated = {
          functionCalls: () => undefined,
          text: () => text,
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
        const response = mode === 'throw'
          ? untilAborted().then(() => { throw abortError(); })
          : untilAborted().then(() => aggregated);
        return { stream: gen(), response };
      },
    }),
  });
  return { provider, seen };
}

let server;
let baseUrl;
let knowledgeMock;
let infoMock;
let infoMessages = [];

async function cleanup() {
  await db.query('DELETE FROM turn_traces WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM messages WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM conversations WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT_ID]);
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

/** Post one SSE turn and hang up on the first delta (barge-in / dead client). */
async function postAndHangUp(session, transcript) {
  const controller = new AbortController();
  const raw = JSON.stringify({
    call_session_id: session.id, channel: 'voice', language: 'en-IN',
    transcript, stream: true,
  });
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-signature': hmac.sign(raw, SECRET),
      accept: 'text/event-stream',
    },
    body: raw,
    signal: controller.signal,
  });

  // Prove the SSE branch actually ran: a turn that quietly fell through to the
  // JSON branch would make every assertion below meaningless.
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream\b/,
    'these assertions are only meaningful on the SSE branch');

  let sawDelta = false;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (!sawDelta && buf.includes('event: delta')) {
        sawDelta = true;
        controller.abort(); // the caller hangs up
      }
    }
  } catch { /* the fetch abort surfaces here — that IS the hang-up */ }
  assert.ok(sawDelta, 'the turn streamed at least one delta before the hang-up');
  return res;
}

const traceOf = (sessionId) => waitFor(async () => {
  const { rows } = await db.query(
    'SELECT error, channel FROM turn_traces WHERE tenant_id = $1 AND call_session_id = $2',
    [TENANT_ID, sessionId]
  );
  return rows[0] || null;
});

const outboundOf = (convId) => waitFor(async () => {
  const { rows } = await db.query(
    "SELECT content FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'outbound'",
    [TENANT_ID, convId]
  );
  return rows[0] || null;
});

const sawDisconnectLog = () =>
  infoMessages.some((m) => m.includes('client disconnected, stream aborted'));

describe('the SSE voice turn records its aborts (INCIDENTS-A)', { skip: SKIP }, () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Abort Trace Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
      [TENANT_ID, PHONE_NUMBER_ID, encrypt('dummy-wa-token')]
    );

    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks', async () => []);
    // The catch-side log line is one half of each test's site attribution.
    infoMock = mock.method(logger, 'info', (...args) => {
      infoMessages.push(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
    });

    const app = express();
    app.use('/internal/voice', internalVoice);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    if (infoMock) infoMock.mock.restore();
    aiService._setModelProvider(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  beforeEach(() => { infoMessages = []; });

  it('(A) hang-up, model returns cleanly: the post-generation abort site records outcome:aborted / client_gone', async () => {
    const { session, conv } = await seedCall('+919000000047');
    const scripted = abortingStreamModel('The first half of a long answer', 'return');
    aiService._setModelProvider(scripted.provider);

    await postAndHangUp(session, 'tell me everything about the clinic');

    const trace = await traceOf(session.id);
    assert.ok(trace, 'an abandoned turn still traces');

    // The defect, stated as an assertion: before this change the row read NULL
    // and the caller who hung up mid-answer looked like a satisfied one.
    assert.notEqual(trace.error, null,
      'a caller who hung up mid-answer must not trace as a clean success');
    assert.equal(trace.error.outcome, 'aborted');
    assert.equal(trace.error.abort_reason, 'client_gone',
      'this handler arms no budget timer, so the close listener is its only abort source');
    assert.equal(trace.error.aborted_after_commit, false);
    assert.equal(trace.channel, 'voice');

    // Site attribution: generation finished normally, so the throw-side catch was
    // never entered — this can only be the post-generation site.
    assert.equal(scripted.seen.completedNormally, true, 'the model returned rather than threw');
    assert.equal(scripted.seen.threw, false);
    assert.equal(sawDisconnectLog(), false,
      "the catch's disconnect line is absent — this turn took the OTHER abort site");

    // Behaviour is unchanged: the partial reply is still persisted, as before.
    const row = await outboundOf(conv.id);
    assert.ok(row, 'the partial reply is still persisted');
    assert.equal(row.content, 'The first half of a long answer');
  });

  it('(B) hang-up, model throws mid-stream: the catch-side abort site records outcome:aborted / client_gone', async () => {
    const { session, conv } = await seedCall('+919000000048');
    const scripted = abortingStreamModel('A partial sentence that stops', 'throw');
    aiService._setModelProvider(scripted.provider);

    await postAndHangUp(session, 'keep talking until I hang up');

    const trace = await traceOf(session.id);
    assert.ok(trace, 'an abandoned turn still traces');

    assert.notEqual(trace.error, null,
      'an abort that surfaces as a throw is the same abandoned turn');
    assert.equal(trace.error.outcome, 'aborted');
    assert.equal(trace.error.abort_reason, 'client_gone');
    assert.equal(trace.error.aborted_after_commit, false);

    // Site attribution: the model threw and the catch logged its disconnect line.
    assert.equal(scripted.seen.threw, true, 'the model rejected the way the SDK does');
    assert.equal(scripted.seen.completedNormally, false);
    assert.ok(await waitFor(async () => sawDisconnectLog()),
      "the catch's disconnect line IS present — this turn took the throw-side site");

    // An abort is not a failure: the failure envelope must not appear here.
    // `status` is the field only setErrorFromException writes, so its absence is
    // what separates the two shapes in a column that holds either.
    assert.equal(trace.error.status, undefined,
      'aborts use the abort envelope, never the {stage, message, status} failure one');
    assert.equal(trace.error.message, 'voice turn aborted',
      'the abort envelope carries a fixed string, not free text (F-A031 unwidened)');

    const row = await outboundOf(conv.id);
    assert.ok(row, 'the partial reply is still persisted');
    assert.equal(row.content, 'A partial sentence that stops');
  });
});
