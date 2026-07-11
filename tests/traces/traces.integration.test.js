'use strict';

// Turn traces (Issue 22) — capture, error path, isolation, probe, retention.
// Runs against the dev DATABASE_URL database (same idiom as
// voiceTurnMetrics.integration.test.js): migration 022 must be applied. The
// admin query routes live in tracesRoutes.test.js (scratch DB — that file also
// proves the schema.sql lockstep via genesis). Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const db                  = require('../../src/db/db');
const hmac                = require('../../src/utils/hmac');
const { encrypt }         = require('../../src/utils/encryption');
const logger              = require('../../src/infra/logging/logger');
const aiService           = require('../../src/modules/ai/aiService');
const knowledgeService    = require('../../src/modules/knowledge/knowledgeService');
const conversationService = require('../../src/modules/conversation/conversationService');
const voiceAdapter        = require('../../src/modules/channels/voice/voiceChannelAdapter');
const channelRegistry     = require('../../src/modules/channels');
const waAdapter           = require('../../src/modules/channels/whatsapp/adapter');
const waSender            = require('../../src/modules/channels/whatsapp/sender');
const requestContext      = require('../../src/core/requestContext');
const traces              = require('../../src/modules/traces/collector');
const eventBus            = require('../../core/events');
const writer              = require('../../src/modules/traces/writer');
const retention           = require('../../src/modules/traces/retentionCron');
const { checkScriptedTurn } = require('../../src/modules/validation/scriptedTurnCheck');

const TENANT_ID       = '00000000-0000-0000-0000-mmmm00000022'.replace(/m/g, 'a');
const PHONE_NUMBER_ID = 'pnid_traces_22';
const VOICE_SECRET    = 'traces-voice-secret';
const META_SECRET     = 'traces-meta-secret';

const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';

function istDateString(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Poll until fn() resolves truthy (the WA webhook processes after its 200).
async function eventually(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function traceByCorrelation(correlationId) {
  const { rows } = await db.query(
    'SELECT * FROM turn_traces WHERE correlation_id = $1 ORDER BY created_at DESC', [correlationId]);
  return rows;
}

// Scripted 3-call booking turn (check_availability → book_appointment → text),
// with usageMetadata + finishReason so llm-meta aggregation is asserted.
function scriptedBookingModel({ date, appointmentTime }) {
  const script = [
    { functionCalls: [{ name: 'check_availability', args: { date } }],
      usage: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } },
    { functionCalls: [{ name: 'book_appointment', args: { doctor_name: 'Dr. Rao', appointment_time: appointmentTime, patient_name: 'Meena' } }],
      usage: { promptTokenCount: 140, candidatesTokenCount: 20, totalTokenCount: 160 } },
    { functionCalls: null, text: 'Booked for ten thirty tomorrow.',
      usage: { promptTokenCount: 180, candidatesTokenCount: 15, totalTokenCount: 195 } },
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
              candidates: [{ finishReason: 'STOP' }],
            },
          };
        },
      };
    },
  });
}

// Single-text-reply model (the WA capture turn — no tools).
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
    }),
  });
}

// Model whose first call fails like a Gemini quota 500.
function quotaFailingModel() {
  return () => ({
    startChat: () => ({
      sendMessage: async () => {
        const err = new Error('got status: 500 — quota exceeded');
        err.response = { status: 500 };
        throw err;
      },
    }),
  });
}

let server;
let baseUrl;
let knowledgeChunksResult = []; // per-test knob for the mocked RAG result
let knowledgeMock;
let senderMock;

async function cleanup() {
  await db.query('DELETE FROM turn_traces WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM messages WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM appointments WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM call_sessions WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM conversations WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM channel_identifiers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM notifications WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenant_entities WHERE tenant_id = $1', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
}

async function postVoiceTurn(body) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/internal/voice/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-signature': hmac.sign(raw, VOICE_SECRET) },
    body: raw,
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
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
  return { status: res.status, correlationId: res.headers.get('x-correlation-id') };
}

async function newVoiceSession(phone) {
  const { rows: [cust] } = await db.query(
    'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING *', [TENANT_ID, phone]);
  const conv = await conversationService.getOrCreateOpenConversation(TENANT_ID, cust.id, 'voice');
  const session = await voiceAdapter.startSession({
    tenantId: TENANT_ID, customerId: cust.id, conversationId: conv.id,
    provider: 'noop', direction: 'inbound', fromNumber: phone,
  });
  return { cust, conv, session };
}

describe('turn traces — capture + isolation + probe + retention (Issue 22)', { skip: SKIP }, () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = VOICE_SECRET;
    process.env.META_APP_SECRET = META_SECRET;
    await cleanup();

    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, ai_prompt, ai_enabled, active)
       VALUES ($1, 'Traces Clinic', $2, $3, 'You are a clinic receptionist.', true, true)`,
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

    knowledgeMock = mock.method(knowledgeService, 'getRelevantChunks', async () => knowledgeChunksResult);
    senderMock = mock.method(waSender, 'sendMessage', async () => 'wamid.out.' + crypto.randomBytes(4).toString('hex'));
    channelRegistry.register(waAdapter);

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
    writer._setInsertFn(null);
    if (server) await new Promise((r) => server.close(r));
    await cleanup();
  });

  it('a WhatsApp text turn persists a full trace row (stages, retrieval, prompt provenance, llm, correlation id)', async () => {
    knowledgeChunksResult = [{ id: '11111111-2222-3333-4444-555555555555', content: 'Hours: 9-6.', similarity: 0.91 }];
    aiService._setModelProvider(scriptedTextModel('We are open 9am to 6pm.'));

    const { status, correlationId } = await postWebhookText({
      from: '919000002201', text: 'What are your clinic hours?', wamid: 'wamid.trace.' + Date.now(),
    });
    assert.equal(status, 200);
    assert.match(correlationId, /^wa_[0-9a-f]{16}$/, 'webhook echoes a wa_ correlation id');

    const rows = await eventually(async () => {
      const r = await traceByCorrelation(correlationId);
      return r.length ? r : null;
    });
    assert.ok(rows, 'trace row appears after dispatch');
    const trace = rows[0];

    assert.equal(trace.tenant_id, TENANT_ID);
    assert.equal(trace.channel, 'whatsapp');
    assert.ok(trace.conversation_id, 'conversation id recorded');
    assert.equal(trace.call_session_id, null);

    // Stages: the shared fetch + WA-specific dispatch/persist, plus total.
    for (const key of ['fetch_parallel', 'fetch_parallel_knowledge', 'fetch_parallel_history',
      'fetch_parallel_memory', 'gemini_call_1', 'dispatch', 'persist_outbound', 'total_ms']) {
      assert.ok(typeof trace.stage_timings[key] === 'number' && trace.stage_timings[key] >= 0, `stage ${key}`);
    }

    // Retrieval: chunk ids + scores, never content.
    assert.deepEqual(trace.retrieval, [{ chunk_id: '11111111-2222-3333-4444-555555555555', score: 0.91 }]);

    // Prompt provenance: hash + version + mode, never the text. This tenant has
    // a legacy ai_prompt → mode 'legacy', hash still computed, version null.
    assert.deepEqual(Object.keys(trace.prompt).sort(), ['config_version', 'hash', 'mode']);
    assert.match(trace.prompt.hash, /^[0-9a-f]{64}$/);
    assert.equal(trace.prompt.mode, 'legacy');
    assert.equal(trace.prompt.config_version, null);

    // LLM meta.
    assert.equal(trace.llm.model, 'gemini-2.5-flash');
    assert.equal(trace.llm.input_tokens, 90);
    assert.equal(trace.llm.output_tokens, 11);
    assert.equal(trace.llm.finish_reason, 'STOP');
    assert.equal(trace.llm.calls.length, 1);

    assert.equal(trace.tool_calls, null);
    assert.equal(trace.error, null);
  });

  it('a voice booking turn traces tool calls in order, with outcomes and aggregated llm meta', async () => {
    knowledgeChunksResult = []; // KB-less turn → retrieval must be null, not []
    const { session } = await newVoiceSession('+919000002202');

    const date = istDateString(1);
    aiService._setModelProvider(scriptedBookingModel({ date, appointmentTime: `${date}T10:30:00+05:30` }));

    const res = await postVoiceTurn({
      call_session_id: session.id, channel: 'voice', language: 'te-IN',
      transcript: 'I want an appointment tomorrow morning',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.reply_text, 'Booked for ten thirty tomorrow.');

    const correlationId = res.headers.get('x-correlation-id');
    assert.match(correlationId, /^call_[0-9a-f]{16}$/);

    const rows = await eventually(async () => {
      const r = await traceByCorrelation(correlationId);
      return r.length ? r : null;
    });
    assert.ok(rows, 'voice trace row exists');
    const trace = rows[0];

    assert.equal(trace.channel, 'voice');
    assert.equal(trace.call_session_id, session.id);
    assert.ok(trace.conversation_id);
    assert.equal(trace.retrieval, null, 'no retrieval → null, not []');

    // Both tools, in execution order, with compact outcomes (never tool output).
    assert.equal(trace.tool_calls.length, 2);
    assert.deepEqual(trace.tool_calls.map((t) => t.name), ['check_availability', 'book_appointment']);
    assert.deepEqual(trace.tool_calls.map((t) => t.n), [1, 2]);
    assert.equal(trace.tool_calls[0].outcome.status, 'ok');
    assert.equal(trace.tool_calls[1].outcome.status, 'ok');
    assert.equal(trace.tool_calls[1].outcome.success, true);

    // Aggregated llm meta across the 3 calls.
    assert.equal(trace.llm.calls.length, 3);
    assert.equal(trace.llm.input_tokens, 100 + 140 + 180);
    assert.equal(trace.llm.output_tokens, 12 + 20 + 15);
    assert.equal(trace.llm.finish_reason, 'STOP');

    // Voice stages (the PR9A set) made it into the trace.
    for (const key of ['hydrate_validate', 'persist_inbound', 'fetch_parallel', 'gemini_call_1',
      'tool_exec_1_check_availability', 'tool_exec_2_book_appointment', 'persist_outbound', 'total_ms']) {
      assert.ok(typeof trace.stage_timings[key] === 'number', `stage ${key}`);
    }

    assert.equal(trace.prompt.mode, 'legacy');
    assert.equal(trace.error, null);
  });

  it('an induced LLM failure (quota 500) errors the turn gracefully AND leaves a trace row with error populated', async () => {
    knowledgeChunksResult = [];
    const { session } = await newVoiceSession('+919000002203');
    aiService._setModelProvider(quotaFailingModel());

    const res = await postVoiceTurn({
      call_session_id: session.id, channel: 'voice', language: 'te-IN', transcript: 'hello',
    });
    assert.equal(res.status, 500, 'turn fails gracefully');

    const correlationId = res.headers.get('x-correlation-id');
    const rows = await eventually(async () => {
      const r = await traceByCorrelation(correlationId);
      return r.length ? r : null;
    });
    assert.ok(rows, 'failed turn still traces — this is when a trace is needed');
    const trace = rows[0];

    assert.equal(trace.error.stage, 'generate_reply');
    assert.match(trace.error.message, /quota exceeded/);
    assert.equal(trace.error.status, 500);
    assert.equal(trace.llm, null, 'no completed model call');
    // Provenance was recorded BEFORE the model call — it survives the failure.
    assert.equal(trace.prompt.mode, 'legacy');
  });

  it('a WhatsApp AI failure traces with error and stores no outbound message', async () => {
    knowledgeChunksResult = [];
    aiService._setModelProvider(quotaFailingModel());

    const { status, correlationId } = await postWebhookText({
      from: '919000002204', text: 'hello?', wamid: 'wamid.fail.' + Date.now(),
    });
    assert.equal(status, 200, 'webhook always 200s');

    const rows = await eventually(async () => {
      const r = await traceByCorrelation(correlationId);
      return r.length ? r : null;
    });
    assert.ok(rows, 'failed WA turn traces');
    assert.equal(rows[0].error.stage, 'generate_reply');
    assert.equal(rows[0].error.status, 500);

    const { rows: outbound } = await db.query(
      `SELECT 1 FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'outbound'`,
      [TENANT_ID, rows[0].conversation_id]);
    assert.equal(outbound.length, 0, 'no outbound stored on AI failure');
  });

  it('a poisoned trace insert never touches the turn: reply succeeds, WARN emitted, no throw', async () => {
    knowledgeChunksResult = [];
    const { session } = await newVoiceSession('+919000002205');
    aiService._setModelProvider(scriptedTextModel('Hello there.'));

    const warnMock = mock.method(logger, 'warn', () => {});
    writer._setInsertFn(async () => { throw new Error('insert poisoned'); });

    let res;
    try {
      res = await postVoiceTurn({
        call_session_id: session.id, channel: 'voice', language: 'en-IN', transcript: 'hi',
      });
    } finally {
      writer._setInsertFn(null);
    }

    assert.equal(res.status, 200, 'turn unaffected by the poisoned insert');
    assert.equal(res.json.reply_text, 'Hello there.');

    // WARN carrying the failure surfaced (fire-and-forget → allow a beat).
    const warned = await eventually(async () =>
      warnMock.mock.calls.some((c) => String(c.arguments[1]).includes('turn trace insert failed')) || null);
    warnMock.mock.restore();
    assert.ok(warned, 'writer WARNed about the dropped trace');

    const rows = await traceByCorrelation(res.headers.get('x-correlation-id'));
    assert.equal(rows.length, 0, 'trace dropped, not retried');
  });

  it('event handlers spawned by a turn do NOT inherit its collector (no cross-chain pollution)', async () => {
    await requestContext.runWith(
      { correlationId: requestContext.newCorrelationId('wa'), channel: 'whatsapp' },
      async () => {
        const trace = traces.open({ channel: 'whatsapp', tenantId: TENANT_ID });
        assert.equal(traces.current(), trace, 'the turn itself sees its collector');

        // The bus derives handler contexts by spreading ctx — a handler must
        // still see NO collector (it could run after flush, or pollute the
        // turn's retrieval/prompt with its own capture).
        const seen = await new Promise((resolve) => {
          const off = eventBus.on('trace.isolation.test', () => {
            off();
            resolve(traces.current());
          });
          eventBus.emit('trace.isolation.test', { tenant_id: TENANT_ID });
        });
        assert.equal(seen, null, 'handler context carries no collector');
      });
  });

  it('the booking probe (turn.scripted) traces its turns under the probe_ correlation id and traces survive cleanup', async () => {
    knowledgeChunksResult = [];
    const { rows: [tenant] } = await db.query('SELECT * FROM tenants WHERE id = $1', [TENANT_ID]);

    // Scripted model that reads the slot from the probe's own transcript
    // (same pattern as lifecycle.integration.test.js).
    const resp = (fc, text) => ({
      response: {
        functionCalls: () => fc || undefined,
        text: () => text || '',
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9, totalTokenCount: 59 },
        candidates: [{ finishReason: 'STOP' }],
      },
    });
    aiService._setModelProvider(() => ({
      startChat: () => {
        let i = 0; let slot = null;
        return {
          sendMessage: async (payload) => {
            i += 1;
            if (i === 1) {
              const m = String(payload).match(/on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/);
              slot = { date: m[1], time: m[2] };
              return resp([{ name: 'check_availability', args: { date: slot.date } }]);
            }
            if (i === 2) {
              return resp([{ name: 'book_appointment', args: {
                doctor_name: 'Dr. Rao',
                appointment_time: `${slot.date}T${slot.time}:00+05:30`,
                patient_name: 'Zyon Validation Probe',
              } }]);
            }
            return resp(null, 'Your appointment is booked.');
          },
        };
      },
    }));

    const probeId = requestContext.newCorrelationId('probe');
    const result = await requestContext.runWith(
      { correlationId: probeId, channel: 'validation' },
      () => checkScriptedTurn({ tenantId: TENANT_ID, tenant, deps: {} })
    );
    assert.equal(result.severity, 'pass', `probe passed: ${result.detail}`);

    const rows = await traceByCorrelation(probeId);
    assert.ok(rows.length >= 1, 'probe turn left a trace row');
    const booked = rows.find((r) => (r.tool_calls || []).some((t) => t.name === 'book_appointment'));
    assert.ok(booked, 'booking turn traced with tool calls');
    assert.equal(booked.channel, 'voice');
    // Synthetic cleanup cascaded the conversation away — the trace survived
    // with its FK nulled (probe traces age out via retention, not cleanup).
    assert.equal(booked.conversation_id, null);
    assert.equal(booked.tool_calls[booked.tool_calls.length - 1].outcome.success, true);
  });
});

describe('turn trace retention — per-tenant windows + advisory lock', { skip: SKIP }, () => {
  const T_A = '00000000-0000-0000-0000-mmmm00002231'.replace(/m/g, 'b');
  const T_B = '00000000-0000-0000-0000-mmmm00002232'.replace(/m/g, 'b');

  async function seedTrace(tenantId, ageDays) {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO turn_traces (turn_id, tenant_id, channel, correlation_id, created_at)
       VALUES ($1, $2, 'whatsapp', $3, NOW() - make_interval(days => $4))`,
      [id, tenantId, 'wa_' + crypto.randomBytes(8).toString('hex'), ageDays]);
    return id;
  }

  async function traceIds(tenantId) {
    const { rows } = await db.query(
      'SELECT turn_id FROM turn_traces WHERE tenant_id = $1', [tenantId]);
    return rows.map((r) => r.turn_id);
  }

  async function wipe() {
    await db.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[T_A, T_B]]);
  }

  before(async () => {
    await wipe();
    await db.query(
      `INSERT INTO tenants (id, business_name, active) VALUES ($1, 'Retention A', true), ($2, 'Retention B', true)`,
      [T_A, T_B]);
    // Tenant A: explicit 30-day window (only the key retention reads matters here).
    await db.query(
      `INSERT INTO tenant_configs (tenant_id, version, config) VALUES ($1, 1, $2)`,
      [T_A, JSON.stringify({ retention_days: 30 })]);
    // Tenant B: no config row → default 365.
  });

  after(async () => {
    await wipe();
  });

  it('deletes per-tenant: 30-day tenant loses 40-day rows, default tenant keeps them', async () => {
    const aOld = await seedTrace(T_A, 40);   // expired (window 30)
    const aNew = await seedTrace(T_A, 10);   // kept
    const bMid = await seedTrace(T_B, 40);   // kept (window 365)
    const bOld = await seedTrace(T_B, 400);  // expired

    // Dry-run preview matches what the tick will do.
    const previewRows = await retention.preview();
    const forA = previewRows.find((r) => r.tenant_id === T_A);
    const forB = previewRows.find((r) => r.tenant_id === T_B);
    assert.equal(forA.expired, 1);
    assert.equal(forA.retention_days, 30);
    assert.equal(forB.expired, 1);
    assert.equal(forB.retention_days, 365);

    const result = await retention.tick();
    assert.equal(result.skipped, false);
    assert.ok(result.deleted >= 2, `deleted the two expired rows (got ${result.deleted})`);

    const aLeft = await traceIds(T_A);
    const bLeft = await traceIds(T_B);
    assert.ok(!aLeft.includes(aOld) && aLeft.includes(aNew), 'tenant A: 40d gone, 10d kept');
    assert.ok(bLeft.includes(bMid) && !bLeft.includes(bOld), 'tenant B: 40d kept, 400d gone');
  });

  it('advisory lock prevents a double-run: a held lock makes tick skip without deleting', async () => {
    const expired = await seedTrace(T_A, 40);

    const holder = await db.getClient();
    try {
      const { rows: [{ acquired }] } = await holder.query(
        'SELECT pg_try_advisory_lock($1) AS acquired', [retention.LOCK_KEY]);
      assert.equal(acquired, true, 'test client holds the lock');

      const result = await retention.tick();
      assert.equal(result.skipped, true, 'tick skipped while the lock is held');
      assert.ok((await traceIds(T_A)).includes(expired), 'nothing deleted under a held lock');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [retention.LOCK_KEY]).catch(() => {});
      holder.release();
    }

    // Lock released → the next tick reaps it.
    const result = await retention.tick();
    assert.equal(result.skipped, false);
    assert.ok(!(await traceIds(T_A)).includes(expired), 'reaped after the lock was released');
  });
});
