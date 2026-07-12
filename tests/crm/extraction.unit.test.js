const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Gemini SDK stub (must be in require cache BEFORE the handler loads) ──
// `nextResponse` is mutable so each test scripts the model output
// (finishReason + text); `lastGenerationConfig` captures the config the
// handler sent, so the thinking-off / cap-512 pin can be asserted.
let lastGenerationConfig = null;
let nextResponse = null;

const genaiPath = require.resolve('@google/generative-ai');
require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: async ({ generationConfig }) => {
            lastGenerationConfig = generationConfig;
            return nextResponse;
          },
        };
      }
    },
  },
};

// ── crmService stub — records upserts, keeps the DB out of a unit test ──
const crmPath = require.resolve('../../src/modules/crm/crmService');
let upsertCalls = [];
require.cache[crmPath] = {
  id: crmPath,
  filename: crmPath,
  loaded: true,
  exports: {
    upsertLead: async (...args) => { upsertCalls.push(args); return null; },
    updateStage: async () => ({}),
  },
};

// ── config/tenant service stubs — the V-002 gate reads both; keep the DB
// out of a unit test. Defaults-shaped policy (whatsapp per_message, voice
// off) and an ai_enabled tenant, so the pre-gate tests behave as before. ──
const configPath = require.resolve('../../src/modules/config/configService');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    getTenantConfig: async () => ({ crm: { extraction: { whatsapp: 'per_message', voice: 'off' } } }),
  },
};

const tenantPath = require.resolve('../../src/modules/tenant/tenantService');
require.cache[tenantPath] = {
  id: tenantPath,
  filename: tenantPath,
  loaded: true,
  exports: {
    getById: async () => ({ id: 'T1', ai_enabled: true }),
  },
};

// ── logger stub — capture warn/error without pino in the way ────────────
const loggerPath = require.resolve('../../src/infra/logging/logger');
let warnCalls = [];
let errorCalls = [];
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    info: () => {},
    debug: () => {},
    warn: (...args) => { warnCalls.push(args); },
    error: (...args) => { errorCalls.push(args); },
  },
};

const eventBus = require('../../core/events');
const EVENT = require('../../core/eventTypes');
const extractionHandler = require('../../src/modules/crm/extractionHandler');

function mkResponse({ finishReason, text }) {
  return { response: { candidates: [{ finishReason }], text: () => text } };
}

function emitMessage() {
  eventBus.emit(EVENT.MESSAGE_RECEIVED, {
    tenant_id: 'T1',
    customer_id: 'C1',
    conversation_id: 'CV1',
    text: 'I want a 2BHK flat, budget 50 lakh',
    mode: 'ai',
    channel: 'whatsapp',
    msg_type: 'text',
  });
}

// The bus dispatches on setImmediate and the handler is async; give it a beat.
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('CRM extraction — generation config + truncation guard (unit)', () => {
  before(() => extractionHandler.init());
  beforeEach(() => {
    upsertCalls = [];
    warnCalls = [];
    errorCalls = [];
    lastGenerationConfig = null;
    nextResponse = null;
  });

  it('extraction request disables thinking and pins the raised output cap', async () => {
    nextResponse = mkResponse({
      finishReason: 'STOP',
      text: '{"name":null,"requirement":null,"budget":null,"intent_level":null}',
    });
    emitMessage();
    await settle();

    // Pinned so a future default-on-thinking / cap regression fails loudly.
    assert.deepEqual(lastGenerationConfig, {
      temperature: 0,
      maxOutputTokens: 512,
      thinkingConfig: { thinkingBudget: 0 },
    });
    assert.equal(errorCalls.length, 0, 'no error path on a clean response');
  });

  it('MAX_TOKENS finishReason emits a WARN with context and writes no lead', async () => {
    // Truncated mid-JSON, exactly what the live 200-cap reproduction returned.
    nextResponse = mkResponse({ finishReason: 'MAX_TOKENS', text: '{"name": "Vikram", "' });
    emitMessage();
    await settle();

    assert.equal(upsertCalls.length, 0, 'truncated response must not write a partial lead');
    assert.equal(warnCalls.length, 1, 'exactly one truncation WARN');
    const [ctx, msg] = warnCalls[0];
    assert.equal(ctx.finishReason, 'MAX_TOKENS');
    assert.equal(ctx.tenant_id, 'T1');
    assert.equal(ctx.conversation_id, 'CV1');
    assert.equal(ctx.customer_id, 'C1');
    assert.match(msg, /truncat/i);
    assert.equal(errorCalls.length, 0, 'truncation is a WARN, not an error');
  });

  it('a complete STOP response with signal still upserts a lead', async () => {
    nextResponse = mkResponse({
      finishReason: 'STOP',
      text: '{"name":"Vikram","requirement":"2BHK flat","budget":"50 lakh","intent_level":"high"}',
    });
    emitMessage();
    await settle();

    assert.equal(warnCalls.length, 0, 'no truncation WARN on a complete response');
    assert.equal(upsertCalls.length, 1, 'complete response with signal upserts once');
    const [tenantId, customerId, data] = upsertCalls[0];
    assert.equal(tenantId, 'T1');
    assert.equal(customerId, 'C1');
    assert.equal(data.name, 'Vikram');
    assert.equal(data.intent_level, 'high');
    assert.equal(data.source, 'whatsapp', 'lead source is the envelope channel, not a hardcode');
  });
});
