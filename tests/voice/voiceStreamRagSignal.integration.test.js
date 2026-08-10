'use strict';

// D-09 (01-map.md §5) — the SSE turn branch does not bound its RAG embedding call.
//
// `internalVoice.js` builds one AbortController per turn and arms it with the
// 8,000 ms budget (:65-68). The JSON branch hands that signal to
// `assembleConversationContext` (:233), which forwards it to
// `knowledgeService.getRelevantChunks` and on into `embed`. The SSE branch
// (:435-442) builds the same controller, passes it to `generateReplyStream`
// (:455) — and omits it from the context call. On that branch the embedding has
// no abort, no deadline, and (before this session) no client-side HTTP timeout
// either: it is bounded only by the worker hanging up.
//
// This is not a dark-code finding. `ARCHITECTURE.md:90` states production sets
// `VOICE_STREAM_TURNS=true` at deploy, so the SSE branch is the one a live call
// is intended to take. At the genesis deploy every live voice turn's embedding
// call becomes the unbounded one.
//
// §7.3: this file asserts the SSE branch specifically. A test that exercised the
// JSON branch would pass at HEAD and prove nothing — the JSON branch already
// works, and its correctness is exactly what makes the SSE omission easy to miss.
//
// The strong form of the assertion is IDENTITY, not shape. Handing retrieval a
// freshly-minted, never-aborted AbortController would satisfy `instanceof
// AbortSignal` while bounding nothing at all. So this file captures the signal
// the scripted model receives at `:455` — known to be the turn's real controller —
// and asserts retrieval was handed the SAME object.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const internalVoice       = require('../../src/routes/internalVoice');

// Disjoint from every other fixture tenant in tests/ — voiceCancellation owns
// ...aaaa00000029 and voiceStream owns ...aaaa00000021. These suites run in
// parallel against one database and each `cleanup()`s its own tenant by id, so a
// shared id is not a style issue: it deletes another suite's fixture mid-run.
const TENANT_ID       = '00000000-0000-0000-0000-aaaa00000041';
const PHONE_NUMBER_ID = 'pnid_voice_rag_signal';
const SECRET          = 'rag-signal-voice-secret';

let server;
let baseUrl;
let knowledgeMock;

// What retrieval was handed, and what the model was handed. The claim is that
// these are the same AbortSignal.
let ragOpts;
let modelSignal;

/** Minimal streaming model: one text part, no tools. Records the signal it was
 *  given at internalVoice.js:455 — the turn's real controller. */
function recordingStreamModel() {
  return () => ({
    startChat: () => ({
      sendMessageStream: async (payload, requestOptions = {}) => {
        modelSignal = requestOptions.signal;
        async function* gen() {
          yield { candidates: [{ content: { parts: [{ text: 'Sure, ten thirty works.' }] } }] };
        }
        return {
          stream: gen(),
          response: Promise.resolve({
            functionCalls: () => undefined,
            text: () => 'Sure, ten thirty works.',
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
        };
      },
    }),
  });
}

async function cleanup() {
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

/** Post one turn on the SSE branch (Accept header AND body flag — `wantsStream`
 *  at internalVoice.js:71-74 requires both) and drain the event stream. */
async function postTurnSSE(body) {
  const raw = JSON.stringify({ ...body, stream: true });
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-signature': hmac.sign(raw, SECRET),
      accept: 'text/event-stream',
    },
    body: raw,
  });
  const events = [];
  if (res.status === 200) {
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
  }
  return { res, events };
}

describe('the SSE voice turn bounds its RAG embedding call (D-09)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'RAG Signal Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
      [TENANT_ID, PHONE_NUMBER_ID, encrypt('dummy-wa-token')]
    );

    // Retrieval is stubbed at the export, which is what contextAssembler.js:67
    // calls. It returns no chunks — this file makes no claim about ranking, only
    // about what the SSE branch hands the retrieval call.
    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks',
      async (tenantId, text, topK, opts) => { ragOpts = opts; return []; });

    const app = express();
    app.use('/internal/voice', internalVoice);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (knowledgeMock) knowledgeMock.mock.restore();
    aiService._setModelProvider(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  it('(1) retrieval on the SSE branch receives the turn\'s own abort signal', async () => {
    ragOpts = undefined;
    modelSignal = undefined;
    const { session } = await seedCall('+919000000041');
    aiService._setModelProvider(recordingStreamModel());

    const { res, events } = await postTurnSSE({
      call_session_id: session.id, channel: 'voice', language: 'en-IN',
      transcript: 'can I get an appointment tomorrow morning',
    });

    // Prove the SSE branch actually ran. Without this, a route that silently fell
    // through to JSON would let the real assertion pass for the wrong reason.
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream\b/,
      'this test is only meaningful on the SSE branch (§7.3)');
    assert.ok(events.some((e) => e.event === 'done'), 'the SSE turn completed');

    assert.notEqual(ragOpts, undefined, 'retrieval was called with an options object');
    assert.ok(ragOpts.signal instanceof AbortSignal,
      'the SSE branch must pass the turn signal to retrieval — at HEAD it passes nothing, ' +
      'so the embedding call is unbounded on the branch production actually runs ' +
      '(ARCHITECTURE.md:90, D-09)');

    // Identity, not shape: a fresh controller would satisfy `instanceof` and bound
    // nothing. internalVoice.js:455 hands the model the turn's real controller.
    assert.ok(modelSignal instanceof AbortSignal, 'the model received the turn signal');
    assert.equal(ragOpts.signal, modelSignal,
      'retrieval and generation must share ONE turn controller — a separate signal ' +
      'would be armed by no budget and aborted by no disconnect');
  });
});
