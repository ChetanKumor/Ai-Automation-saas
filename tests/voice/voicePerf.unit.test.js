require('dotenv').config();

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Pure-unit (no DB, no live Gemini): PR9A voice-channel generation config +
// prompt diet, and the byte-for-byte guard on the default (WhatsApp) config.
const aiService          = require('../../src/modules/ai/aiService');
const appointmentService = require('../../src/modules/appointment/appointmentService');

const TENANT       = { id: 'T1', business_name: 'Clinic', ai_prompt: 'You are a clinic receptionist.' };
const CUSTOMER     = { id: 'U1', phone: '+919000000001', name: 'Ravi' };
const CONVERSATION = { id: 'C1', mode: 'ai', summary: null };

const VOICE_ENV = ['VOICE_THINKING_BUDGET', 'VOICE_MAX_OUTPUT_TOKENS', 'VOICE_HISTORY_TURNS', 'VOICE_MEMORY_FACTS_MAX'];

// Scripted model provider that records what aiService hands the SDK.
// script: array of { functionCalls?, text? } steps consumed per sendMessage.
function capturingModel(script = [{ text: 'ok' }]) {
  const seen = { config: null, startChatArgs: null, startChatCalls: 0, sendCalls: 0 };
  const provider = (config) => {
    seen.config = config;
    return {
      startChat: (args) => {
        seen.startChatCalls += 1;
        seen.startChatArgs = args;
        let i = 0;
        return {
          sendMessage: async () => {
            seen.sendCalls += 1;
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
    };
  };
  return { provider, seen };
}

async function reply({ channel, history = [], facts = [], script } = {}) {
  const { provider, seen } = capturingModel(script);
  aiService._setModelProvider(provider);
  const opts = channel === undefined ? undefined : { channel };
  // Positional call shape matches BOTH real call sites (WhatsApp passes no options).
  await aiService.generateReply(TENANT, CUSTOMER, CONVERSATION, 'hello', history, [], facts, opts);
  return seen;
}

afterEach(() => {
  aiService._setModelProvider(null);
  mock.restoreAll();
  for (const k of VOICE_ENV) delete process.env[k];
});

// ── (a) voice-channel Gemini calls carry the thinking/output config ──────────
describe('voice generation config (channel === "voice")', () => {
  it('defaults: thinkingBudget 0 + maxOutputTokens 150', async () => {
    const seen = await reply({ channel: 'voice' });
    assert.deepEqual(seen.startChatArgs.generationConfig, {
      maxOutputTokens: 150,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('is env-tunable via VOICE_THINKING_BUDGET / VOICE_MAX_OUTPUT_TOKENS', async () => {
    process.env.VOICE_THINKING_BUDGET = '64';
    process.env.VOICE_MAX_OUTPUT_TOKENS = '99';
    const seen = await reply({ channel: 'voice' });
    assert.deepEqual(seen.startChatArgs.generationConfig, {
      maxOutputTokens: 99,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 64 },
    });
  });

  it('one config governs every call in the tool loop (startChat once, N sendMessage)', async () => {
    mock.method(appointmentService, 'checkAvailability', async () => ({ slots: ['10:30'] }));
    mock.method(appointmentService, 'bookAppointment', async () => ({ success: false, reason: 'test' }));
    const seen = await reply({
      channel: 'voice',
      script: [
        { functionCalls: [{ name: 'check_availability', args: { date: '2026-07-04' } }] },
        { functionCalls: [{ name: 'book_appointment', args: { doctor_name: 'Dr. Rao', appointment_time: '2026-07-04T10:30:00+05:30', patient_name: 'Ravi' } }] },
        { text: 'Booked.' },
      ],
    });
    // The SDK's ChatSession reuses startChat's generationConfig for every
    // sendMessage — a single startChat with the voice config covers all 3 calls.
    assert.equal(seen.startChatCalls, 1);
    assert.equal(seen.sendCalls, 3);
    assert.deepEqual(seen.startChatArgs.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });
});

// ── (b) default-channel config deep-equals the pre-PR shape ──────────────────
describe('default-channel config guard (byte-for-byte)', () => {
  it('no options (exact WhatsApp call shape) → pre-PR generationConfig', async () => {
    const seen = await reply({});
    assert.deepEqual(seen.startChatArgs.generationConfig, { maxOutputTokens: 250, temperature: 0.7 });
  });

  it('stays pre-PR even when the voice env knobs are set', async () => {
    process.env.VOICE_THINKING_BUDGET = '0';
    process.env.VOICE_MAX_OUTPUT_TOKENS = '10';
    process.env.VOICE_HISTORY_TURNS = '1';
    process.env.VOICE_MEMORY_FACTS_MAX = '1';
    const seen = await reply({ channel: 'whatsapp', history: mkHistory(12), facts: mkFacts(15) });
    assert.deepEqual(seen.startChatArgs.generationConfig, { maxOutputTokens: 250, temperature: 0.7 });
    assert.equal(seen.startChatArgs.history.length, 12);          // no history cap
    assert.match(seen.config.systemInstruction, /fact01/);        // no facts cap
  });
});

// ── (c) history pruning (voice) ───────────────────────────────────────────────
function mkHistory(n) {
  // Alternating customer/ai, starting with customer: msg00 (customer), msg01 (ai)...
  return Array.from({ length: n }, (_, i) => ({
    sender: i % 2 === 0 ? 'customer' : 'ai',
    content: `msg${String(i).padStart(2, '0')}`,
  }));
}

describe('voice history cap (VOICE_HISTORY_TURNS)', () => {
  it('keeps the LAST 8 entries by default', async () => {
    const seen = await reply({ channel: 'voice', history: mkHistory(12) });
    const texts = seen.startChatArgs.history.map((h) => h.parts[0].text);
    assert.equal(texts.length, 8);
    assert.deepEqual(texts, ['msg04', 'msg05', 'msg06', 'msg07', 'msg08', 'msg09', 'msg10', 'msg11']);
    assert.equal(seen.startChatArgs.history[0].role, 'user');
  });

  it('respects a custom VOICE_HISTORY_TURNS', async () => {
    process.env.VOICE_HISTORY_TURNS = '4';
    const seen = await reply({ channel: 'voice', history: mkHistory(12) });
    const texts = seen.startChatArgs.history.map((h) => h.parts[0].text);
    assert.deepEqual(texts, ['msg08', 'msg09', 'msg10', 'msg11']);
  });

  it('still drops a leading model entry after the cap (Gemini first-role rule)', async () => {
    // 9 entries starting with customer → slice(-8) starts at msg01 (ai) → trimmed.
    const seen = await reply({ channel: 'voice', history: mkHistory(9) });
    assert.equal(seen.startChatArgs.history[0].role, 'user');
    assert.equal(seen.startChatArgs.history[0].parts[0].text, 'msg02');
  });
});

// ── (d) memory-facts cap (voice) ──────────────────────────────────────────────
function mkFacts(n) {
  // fact01 oldest … fact<n> most recently updated.
  return Array.from({ length: n }, (_, i) => ({
    key: `fact${String(i + 1).padStart(2, '0')}`,
    value: `v${i + 1}`,
    updated_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  }));
}

describe('voice memory-facts cap (VOICE_MEMORY_FACTS_MAX)', () => {
  it('keeps the 10 most recently updated facts, most recent first', async () => {
    const seen = await reply({ channel: 'voice', facts: mkFacts(15) });
    const sys = seen.config.systemInstruction;
    for (const kept of ['fact15', 'fact06']) assert.match(sys, new RegExp(kept));
    for (const dropped of ['fact05', 'fact01']) assert.doesNotMatch(sys, new RegExp(dropped));
    assert.ok(sys.indexOf('fact15') < sys.indexOf('fact06'), 'most recent first');
  });

  it('respects a custom VOICE_MEMORY_FACTS_MAX', async () => {
    process.env.VOICE_MEMORY_FACTS_MAX = '2';
    const seen = await reply({ channel: 'voice', facts: mkFacts(5) });
    const sys = seen.config.systemInstruction;
    assert.match(sys, /fact05/);
    assert.match(sys, /fact04/);
    assert.doesNotMatch(sys, /fact03/);
  });

  it('under the cap, facts pass through in the existing key order', async () => {
    const seen = await reply({ channel: 'voice', facts: mkFacts(3) });
    const sys = seen.config.systemInstruction;
    assert.ok(sys.indexOf('fact01') < sys.indexOf('fact02'));
    assert.ok(sys.indexOf('fact02') < sys.indexOf('fact03'));
  });
});
