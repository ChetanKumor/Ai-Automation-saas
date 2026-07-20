require('dotenv').config();

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// GUARD-01: the no-invented-names guardrail. Phase 0 found that caller/patient
// identity is NOT part of the Issue-10 renderer (renderSystemPrompt/clinic.js
// take only (config, channel) — no customer data, which is why none of the six
// committed prompt snapshots include one). Identity is threaded in per turn at
// aiService.js's buildSystemPrompt, the one place shared by generateReply and
// generateReplyStream (both channels) AND all three prompt-provenance modes
// (legacy ai_prompt override, rendered config, minimal-safe fallback). So the
// guardrail is anchored there, sourced from prompts/guardrail.js — the existing
// home for hardcoded, non-configurable safety text — rather than inside the
// clinic template, which would only reach the 'rendered' mode.
const aiService = require('../../src/modules/ai/aiService');
const configService = require('../../src/modules/config/configService');
const logger = require('../../src/infra/logging/logger');
const { clinicDefaults, configSchema } = configService;

const CONVERSATION = { id: 'C1', mode: 'ai', summary: null };
const LEGACY_PROMPT = 'You are the receptionist for Dr.Sharma Dental Clinic.';

const UNKNOWN_RULE = (who) =>
  `The ${who}'s name is not known — never guess or invent one. Address them without a name, and ask for it only if the conversation genuinely needs it.`;

function capturingModel() {
  const seen = { config: null };
  const provider = (config) => {
    seen.config = config;
    return {
      startChat: () => ({
        sendMessage: async () => ({
          response: { functionCalls: () => undefined, text: () => 'ok', usageMetadata: {} },
        }),
        sendMessageStream: async () => {
          async function* gen() { yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }; }
          return {
            stream: gen(),
            response: Promise.resolve({ functionCalls: () => undefined, text: () => 'ok', usageMetadata: {} }),
          };
        },
      }),
    };
  };
  return { provider, seen };
}

const orig = { getTenantConfig: configService.getTenantConfig, warn: logger.warn, error: logger.error };
let seen;

function arm({ config } = {}) {
  configService.getTenantConfig = async (tenantId) =>
    typeof config === 'function' ? config(tenantId) : (config ?? null);
  const m = capturingModel();
  aiService._setModelProvider(m.provider);
  seen = m.seen;
}

beforeEach(() => {
  logger.warn = () => {};
  logger.error = () => {};
});

afterEach(() => {
  configService.getTenantConfig = orig.getTenantConfig;
  logger.warn = orig.warn;
  logger.error = orig.error;
  aiService._setModelProvider(null);
});

const TENANT_RENDERED = { id: 'T1', business_name: 'Clinic', ai_prompt: null };
const TENANT_LEGACY = { id: 'T1', business_name: 'Clinic', ai_prompt: LEGACY_PROMPT };
const CONFIG = () => configSchema.parse(clinicDefaults);

describe('GUARD-01 — no-invented-names guardrail', () => {
  it('identity known: name is available, no suppression rule (whatsapp)', async () => {
    arm({ config: CONFIG() });
    const customer = { id: 'U1', phone: '+919000000001', name: 'Ravi' };
    await aiService.generateReply(TENANT_RENDERED, customer, CONVERSATION, 'hello', [], [], []);
    assert.ok(seen.config.systemInstruction.includes('Customer name: Ravi'));
    assert.ok(!seen.config.systemInstruction.includes(UNKNOWN_RULE('customer')));
  });

  it('identity known: name is available, no suppression rule (voice)', async () => {
    arm({ config: CONFIG() });
    const customer = { id: 'U1', phone: '+919000000001', name: 'Ravi' };
    await aiService.generateReply(TENANT_RENDERED, customer, CONVERSATION, 'hello', [], [], [], { channel: 'voice' });
    assert.ok(seen.config.systemInstruction.includes('Customer name: Ravi'));
    assert.ok(!seen.config.systemInstruction.includes(UNKNOWN_RULE('caller')));
  });

  for (const [label, name] of [['null', null], ['undefined', undefined], ['empty string', '']]) {
    it(`identity unknown (${label}): the rule is present, verbatim (whatsapp)`, async () => {
      arm({ config: CONFIG() });
      const customer = { id: 'U1', phone: '+919000000001', name };
      await aiService.generateReply(TENANT_RENDERED, customer, CONVERSATION, 'hello', [], [], []);
      assert.ok(seen.config.systemInstruction.includes(UNKNOWN_RULE('customer')));
      assert.ok(!seen.config.systemInstruction.includes('Customer name:'));
    });
  }

  it('identity unknown: the rule is present, verbatim, and says "caller" on voice', async () => {
    arm({ config: CONFIG() });
    const customer = { id: 'U1', phone: '+919000000001', name: null };
    await aiService.generateReply(TENANT_RENDERED, customer, CONVERSATION, 'hello', [], [], [], { channel: 'voice' });
    assert.ok(seen.config.systemInstruction.includes(UNKNOWN_RULE('caller')));
    assert.ok(!seen.config.systemInstruction.includes(UNKNOWN_RULE('customer')));
  });

  it('generateReplyStream (voice SSE) carries the same rule when identity is unknown', async () => {
    arm({ config: CONFIG() });
    const customer = { id: 'U1', phone: '+919000000001', name: null };
    await aiService.generateReplyStream(TENANT_RENDERED, customer, CONVERSATION, 'hello', [], [], []);
    assert.ok(seen.config.systemInstruction.includes(UNKNOWN_RULE('caller')));
  });

  // The rule is a platform invariant: it must reach every prompt-provenance
  // mode, not just the config-rendered one — a fix scoped to the clinic
  // template would miss these two.
  it('unknown identity reaches the legacy ai_prompt override path too', async () => {
    arm({ config: CONFIG() });
    const customer = { id: 'U1', phone: '+919000000001', name: null };
    await aiService.generateReply(TENANT_LEGACY, customer, CONVERSATION, 'hello', [], [], []);
    assert.ok(seen.config.systemInstruction.startsWith(LEGACY_PROMPT));
    assert.ok(seen.config.systemInstruction.includes(UNKNOWN_RULE('customer')));
  });

  it('unknown identity reaches the minimal-safe fallback path too (no config, no ai_prompt)', async () => {
    arm({ config: null });
    const customer = { id: 'U1', phone: '+919000000001', name: null };
    await aiService.generateReply(TENANT_RENDERED, customer, CONVERSATION, 'hello', [], [], []);
    assert.ok(seen.config.systemInstruction.includes(UNKNOWN_RULE('customer')));
  });
});
