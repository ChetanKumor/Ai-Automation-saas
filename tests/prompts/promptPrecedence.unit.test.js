require('dotenv').config();

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Hook-level precedence (Issue 10), pure-unit (no DB, no live Gemini):
//   ai_prompt set → verbatim + WARN legacy_prompt_override (config not fetched)
//   ai_prompt empty + config → rendered prompt, channel threaded through
//   neither → MINIMAL_SAFE_PROMPT + ERROR (never throws mid-turn)
const aiService = require('../../src/modules/ai/aiService');
const configService = require('../../src/modules/config/configService');
const logger = require('../../src/infra/logging/logger');
const { MINIMAL_SAFE_PROMPT } = require('../../src/modules/prompts');
const { clinicDefaults, configSchema } = configService;

const CUSTOMER = { id: 'U1', phone: '+919000000001', name: 'Ravi' };
const CONVERSATION = { id: 'C1', mode: 'ai', summary: null };
const LEGACY_PROMPT = 'You are the receptionist for Dr.Sharma Dental Clinic.';
const RENDERED_HEAD = 'You are the AI receptionist for New Clinic';

// Capturing model provider (voicePerf pattern): records systemInstruction,
// supports both sendMessage and sendMessageStream so the SSE path is covered.
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

// Spies restored per-test: configService.getTenantConfig + logger.warn/error.
const orig = {
  getTenantConfig: configService.getTenantConfig,
  warn: logger.warn,
  error: logger.error,
};
let configCalls, warns, errors, seen;

function arm({ config } = {}) {
  configCalls = 0;
  configService.getTenantConfig = async (tenantId) => {
    configCalls += 1;
    if (config instanceof Error) throw config;
    return typeof config === 'function' ? config(tenantId) : (config ?? null);
  };
  const m = capturingModel();
  aiService._setModelProvider(m.provider);
  seen = m.seen;
}

beforeEach(() => {
  warns = []; errors = [];
  logger.warn = (obj, msg) => { warns.push({ obj, msg }); };
  logger.error = (obj, msg) => { errors.push({ obj, msg }); };
});

afterEach(() => {
  configService.getTenantConfig = orig.getTenantConfig;
  logger.warn = orig.warn;
  logger.error = orig.error;
  aiService._setModelProvider(null);
});

const reply = (tenant, opts) =>
  aiService.generateReply(tenant, CUSTOMER, CONVERSATION, 'hello', [], [], [], opts);

describe('prompt precedence at the assembly hook', () => {
  it('ai_prompt set → verbatim head + WARN legacy_prompt_override; config never fetched', async () => {
    arm({ config: configSchema.parse(clinicDefaults) });
    await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: LEGACY_PROMPT });
    assert.ok(seen.config.systemInstruction.startsWith(LEGACY_PROMPT));
    assert.ok(!seen.config.systemInstruction.includes(RENDERED_HEAD));
    assert.ok(warns.some((w) => w.obj.event === 'legacy_prompt_override'));
    assert.equal(configCalls, 0, 'legacy path must not add a config read');
  });

  it('ai_prompt empty + config → rendered prompt, no legacy WARN', async () => {
    arm({ config: configSchema.parse(clinicDefaults) });
    await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: null });
    assert.ok(seen.config.systemInstruction.includes(RENDERED_HEAD));
    assert.ok(seen.config.systemInstruction.includes('chatting with a customer on WhatsApp'));
    assert.ok(!warns.some((w) => w.obj.event === 'legacy_prompt_override'));
    assert.equal(configCalls, 1);
  });

  it('whitespace-only ai_prompt counts as empty (rendered path)', async () => {
    arm({ config: configSchema.parse(clinicDefaults) });
    await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: '   ' });
    assert.ok(seen.config.systemInstruction.includes(RENDERED_HEAD));
  });

  it('channel threads through: voice turn gets the voice render', async () => {
    arm({ config: configSchema.parse(clinicDefaults) });
    await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: null }, { channel: 'voice' });
    assert.ok(seen.config.systemInstruction.includes('a clinic, on a phone call'));
  });

  it('generateReplyStream (voice SSE) uses the same precedence chain', async () => {
    arm({ config: configSchema.parse(clinicDefaults) });
    const out = await aiService.generateReplyStream(
      { id: 'T1', business_name: 'Clinic', ai_prompt: null }, CUSTOMER, CONVERSATION, 'hello', [], [], []);
    assert.equal(out, 'ok');
    assert.ok(seen.config.systemInstruction.includes('a clinic, on a phone call'));
  });

  it('no config AND no ai_prompt → minimal safe prompt + ERROR (never throws)', async () => {
    arm({ config: null });
    await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: null });
    assert.ok(seen.config.systemInstruction.includes(MINIMAL_SAFE_PROMPT));
    assert.ok(errors.some((e) => e.obj.event === 'no_prompt_source'));
  });

  it('config fetch failure degrades to the safe prompt + ERROR, turn continues', async () => {
    arm({ config: new Error('db down') });
    const text = await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: null });
    assert.equal(text, 'ok');
    assert.ok(seen.config.systemInstruction.includes(MINIMAL_SAFE_PROMPT));
    assert.ok(errors.some((e) => /config fetch failed/.test(e.msg)));
    // A fetch failure is NOT "tenant has no config" — the misleading event must not fire.
    assert.ok(!errors.some((e) => e.obj.event === 'no_prompt_source'));
  });

  it('a config the renderer rejects degrades to the safe prompt + ERROR, turn continues', async () => {
    arm({ config: { business: { vertical: 'spa' } } });
    const text = await reply({ id: 'T1', business_name: 'Clinic', ai_prompt: null });
    assert.equal(text, 'ok');
    assert.ok(seen.config.systemInstruction.includes(MINIMAL_SAFE_PROMPT));
    assert.ok(errors.some((e) => /prompt render failed/.test(e.msg)));
  });
});
