require('dotenv').config();

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Pure-unit (no DB, no HTTP, no live Gemini): PR9C generateReplyStream — the
// streamed tool loop behind the SSE turn branch. The scripted model provider
// implements sendMessageStream the way the installed SDK surfaces it: a
// per-chunk async iterator of GenerateContentResponse-shaped objects plus an
// aggregated-response promise.
const aiService          = require('../../src/modules/ai/aiService');
const appointmentService = require('../../src/modules/appointment/appointmentService');

const TENANT       = { id: 'T1', business_name: 'Clinic', ai_prompt: 'You are a clinic receptionist.' };
const CUSTOMER     = { id: 'U1', phone: '+919000000001', name: 'Ravi' };
const CONVERSATION = { id: 'C1', mode: 'ai', summary: null };

// script: array of steps, one per model call. step = {
//   parts: [{ functionCall } | { text }...],  // streamed one chunk per part
//   usage,                                    // aggregated usageMetadata
//   hangUntilAbort: bool,                     // stream never ends; rejects on signal abort
// }
function scriptedStreamModel(script) {
  const seen = { config: null, startChatArgs: null, sends: [] };
  const provider = (config) => {
    seen.config = config;
    return {
      startChat: (args) => {
        seen.startChatArgs = args;
        let i = 0;
        return {
          sendMessageStream: async (payload, requestOptions = {}) => {
            const step = script[Math.min(i, script.length - 1)];
            i += 1;
            seen.sends.push({ payload, requestOptions });
            const signal = requestOptions.signal;

            const abortError = () => {
              const e = new Error('[GoogleGenerativeAI Error]: Error reading from the stream');
              return e;
            };
            async function* gen() {
              for (const part of step.parts) {
                yield { candidates: [{ content: { parts: [part] } }] };
              }
              if (step.hangUntilAbort) {
                await new Promise((_, reject) => {
                  if (signal && signal.aborted) return reject(abortError());
                  if (signal) signal.addEventListener('abort', () => reject(abortError()));
                });
              }
            }
            const text = step.parts.filter((p) => p.text).map((p) => p.text).join('');
            const fcs = step.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
            const aggregated = {
              functionCalls: () => (fcs.length ? fcs : undefined),
              text: () => text,
              usageMetadata: step.usage,
            };
            // Mirror the SDK: on an aborted stream the aggregated-response
            // promise REJECTS independently (the Phase 0 probe crashed on this
            // very unhandled rejection when no handler was attached).
            const response = step.hangUntilAbort
              ? new Promise((resolve, reject) => {
                  if (signal && signal.aborted) return reject(abortError());
                  if (signal) signal.addEventListener('abort', () => reject(abortError()));
                })
              : Promise.resolve(aggregated);
            return { stream: gen(), response };
          },
        };
      },
    };
  };
  return { provider, seen };
}

const BOOKING_SCRIPT = [
  { parts: [{ functionCall: { name: 'check_availability', args: { date: '2026-07-04' } } }],
    usage: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } },
  { parts: [{ functionCall: { name: 'book_appointment', args: { doctor_name: 'Dr. Rao', appointment_time: '2026-07-04T10:30:00+05:30', patient_name: 'Ravi' } } }],
    usage: { promptTokenCount: 140, candidatesTokenCount: 20, totalTokenCount: 160 } },
  { parts: [{ text: 'Booked for ' }, { text: 'ten thirty tomorrow.' }],
    usage: { promptTokenCount: 180, candidatesTokenCount: 15, totalTokenCount: 195 } },
];

async function run({ script, options = {}, history = [], facts = [] }) {
  const { provider, seen } = scriptedStreamModel(script);
  aiService._setModelProvider(provider);
  const reply = await aiService.generateReplyStream(
    TENANT, CUSTOMER, CONVERSATION, 'hello', history, [], facts, options
  );
  return { reply, seen };
}

afterEach(() => {
  aiService._setModelProvider(null);
  mock.restoreAll();
});

describe('generateReplyStream — ack ordering (tool turns)', () => {
  it('onToolRound fires BEFORE any tool executes, once per round', async () => {
    const order = [];
    mock.method(appointmentService, 'checkAvailability', async () => { order.push('tool:check'); return { slots: ['10:30'] }; });
    mock.method(appointmentService, 'bookAppointment', async () => { order.push('tool:book'); return { success: false, reason: 'test' }; });

    const { reply } = await run({
      script: BOOKING_SCRIPT,
      options: {
        onToolRound: () => order.push('ack'),
        onDelta: (t) => order.push(`delta:${t}`),
      },
    });

    assert.equal(reply, 'Booked for ten thirty tomorrow.');
    assert.deepEqual(order, [
      'ack', 'tool:check',          // ack precedes the first tool execution
      'ack', 'tool:book',           // fires per round — the ROUTE de-dupes to one SSE event
      'delta:Booked for ', 'delta:ten thirty tomorrow.',
    ]);
  });

  it('never emits deltas for a completion that turns out to be a tool call', async () => {
    mock.method(appointmentService, 'checkAvailability', async () => ({ slots: [] }));
    mock.method(appointmentService, 'bookAppointment', async () => ({ success: false }));
    const deltas = [];
    const { reply } = await run({
      script: BOOKING_SCRIPT,
      options: { onDelta: (t) => deltas.push(t) },
    });
    assert.deepEqual(deltas, ['Booked for ', 'ten thirty tomorrow.']);
    assert.equal(reply, 'Booked for ten thirty tomorrow.');
  });

  it('plain (no-tool) turn: onToolRound never fires, deltas stream in order', async () => {
    const order = [];
    const { reply } = await run({
      script: [{ parts: [{ text: 'We open ' }, { text: 'at nine.' }], usage: {} }],
      options: {
        onToolRound: () => order.push('ack'),
        onDelta: (t) => order.push(`delta:${t}`),
      },
    });
    assert.equal(reply, 'We open at nine.');
    assert.deepEqual(order, ['delta:We open ', 'delta:at nine.']);
  });
});

describe('generateReplyStream — voice generationConfig (canary)', () => {
  it('streamed calls carry thinkingBudget 0 + voice output cap (single startChat)', async () => {
    const { seen } = await run({
      script: [{ parts: [{ text: 'ok' }], usage: {} }],
    });
    assert.deepEqual(seen.startChatArgs.generationConfig, {
      maxOutputTokens: 150,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('records streamed:true + thinking_tokens on the metrics collector per call', async () => {
    mock.method(appointmentService, 'checkAvailability', async () => ({ slots: [] }));
    mock.method(appointmentService, 'bookAppointment', async () => ({ success: false }));
    const calls = [];
    const metrics = {
      recordGeminiCall: (c) => calls.push(c),
      recordToolExec: () => {},
    };
    await run({ script: BOOKING_SCRIPT, options: { metrics } });
    assert.equal(calls.length, 3);
    for (const c of calls) assert.equal(c.streamed, true);
    assert.equal(calls[2].usageMetadata.totalTokenCount, 195);
  });
});

describe('generateReplyStream — abort (client disconnect)', () => {
  it('signal abort mid-stream rejects out of the loop (partial handled by the route)', async () => {
    const controller = new AbortController();
    const deltas = [];
    await assert.rejects(
      run({
        script: [{
          parts: [{ text: 'The first part of a long answer ' }],
          usage: {},
          hangUntilAbort: true,
        }],
        options: {
          signal: controller.signal,
          onDelta: (t) => { deltas.push(t); controller.abort(); },
        },
      }),
      /Error reading from the stream/
    );
    // The delta seen before the abort is exactly what the route persists.
    assert.deepEqual(deltas, ['The first part of a long answer ']);
  });

  it('an ALREADY-aborted signal stops the loop before the next model call / tool', async () => {
    const controller = new AbortController();
    let toolRan = false;
    mock.method(appointmentService, 'checkAvailability', async () => { toolRan = true; return { slots: [] }; });
    controller.abort();
    await assert.rejects(
      run({ script: BOOKING_SCRIPT, options: { signal: controller.signal } }),
      /voice turn aborted/
    );
    assert.equal(toolRan, false);
  });
});
