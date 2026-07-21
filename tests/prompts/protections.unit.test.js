require('dotenv').config();

// ============================================================================
//  PORTAL-P3-S10 — the protections panel's proof.
//
//  The Safety page shows a clinic a list of things its receptionist will never
//  do. Every one of those claims is a promise made to a paying business about
//  patient-facing behaviour, so this suite exists to make an UNENFORCED claim
//  impossible to ship: it iterates src/portal/protections.js — the same catalog
//  GET /portal/api/protections renders from — and asserts each claim's enforcing
//  instruction is present, verbatim, in the system prompt the model receives.
//
//  Add a claim without its enforcing text and this goes red. That's structural,
//  not a convention: there is no path to displaying a claim we haven't proven.
//
//  We assert against the FULL prompt (aiService's buildSystemPrompt output,
//  captured through the model provider), not renderSystemPrompt alone — three of
//  the five claims are enforced by the outer tail that the clinic template never
//  sees, which is exactly the trap GUARD-01's Phase 0 found.
// ============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiService = require('../../src/modules/ai/aiService');
const configService = require('../../src/modules/config/configService');
const logger = require('../../src/infra/logging/logger');
const { PROTECTIONS, protectionsForDisplay } = require('../../src/portal/protections');
const { clinicDefaults } = require('../../src/modules/config/defaults');
const { configSchema } = require('../../src/modules/config/schema');

const CONVERSATION = { id: 'C1', mode: 'ai', summary: null };
const LEGACY_PROMPT = 'You are the receptionist for Dr. Sharma Dental Clinic.';

function capturingModel() {
  const seen = { config: null };
  const provider = (config) => {
    seen.config = config;
    return {
      startChat: () => ({
        sendMessage: async () => ({
          response: { functionCalls: () => undefined, text: () => 'ok', usageMetadata: {} },
        }),
      }),
    };
  };
  return { provider, seen };
}

const orig = { getTenantConfig: configService.getTenantConfig, warn: logger.warn, error: logger.error };

beforeEach(() => { logger.warn = () => {}; logger.error = () => {}; });
afterEach(() => {
  configService.getTenantConfig = orig.getTenantConfig;
  logger.warn = orig.warn;
  logger.error = orig.error;
  aiService._setModelProvider(null);
});

const EMPTY_CONFIG = () => configSchema.parse(clinicDefaults);
const PRICED_CONFIG = () => configSchema.parse({
  ...clinicDefaults,
  pricing: { ...clinicDefaults.pricing, consultation_fee: 500 },
});

// The prompt states each protection reaches. `mode` is the provenance branch
// (legacy ai_prompt override / config-rendered / minimal-safe fallback), because
// a protection anchored in the clinic template alone would silently vanish for
// two of the three — the GUARD-01 lesson, re-tested here for every claim.
const VARIANTS = [
  { id: 'rendered · whatsapp · nothing priced · name known', mode: 'rendered', channel: 'whatsapp', priced: false, named: true, knowledge: false },
  { id: 'rendered · whatsapp · priced · name unknown', mode: 'rendered', channel: 'whatsapp', priced: true, named: false, knowledge: false },
  { id: 'rendered · whatsapp · knowledge retrieved · name known', mode: 'rendered', channel: 'whatsapp', priced: false, named: true, knowledge: true },
  { id: 'rendered · voice · priced · name unknown', mode: 'rendered', channel: 'voice', priced: true, named: false, knowledge: false },
  { id: 'legacy ai_prompt · whatsapp · name unknown', mode: 'legacy', channel: 'whatsapp', priced: false, named: false, knowledge: false },
  { id: 'minimal-safe fallback · whatsapp · name unknown', mode: 'default', channel: 'whatsapp', priced: false, named: false, knowledge: false },
];

// Build one variant's full system prompt.
async function promptFor(v) {
  const config = v.mode === 'rendered' ? (v.priced ? PRICED_CONFIG() : EMPTY_CONFIG()) : null;
  configService.getTenantConfig = async () => config;
  const m = capturingModel();
  aiService._setModelProvider(m.provider);

  const tenant = { id: 'T1', business_name: 'Clinic', ai_prompt: v.mode === 'legacy' ? LEGACY_PROMPT : null };
  const customer = { id: 'U1', phone: '+919000000001', name: v.named ? 'Ravi' : null };
  const knowledge = v.knowledge ? [{ content: 'We have free parking behind the building.' }] : [];

  await aiService.generateReply(tenant, customer, CONVERSATION, 'hello', [], knowledge, [], { channel: v.channel });
  return m.seen.config.systemInstruction;
}

const whoOf = (v) => (v.channel === 'voice' ? 'caller' : 'customer');
const fill = (text, v) => text.replace(/\{who\}/g, whoOf(v));

// Which variants a `when` condition selects. Anything not listed is a typo in the
// catalog rather than a silently-unasserted claim — see the guard test below.
const SELECTORS = {
  always: () => true,
  rendered: (v) => v.mode === 'rendered',
  priced: (v) => v.mode === 'rendered' && v.priced,
  unnamed: (v) => !v.named,
  knowledge: (v) => v.knowledge,
};

describe('PORTAL-P3-S10 — built-in protections are enforced in the prompt', () => {
  // Guard the guard: an unknown `when` would select no variants and the claim
  // would ship asserted-by-nothing.
  it('every catalog entry has evidence, and every condition is one we can test', () => {
    assert.ok(PROTECTIONS.length > 0, 'the panel is not empty');
    for (const p of PROTECTIONS) {
      assert.ok(p.evidence && p.evidence.length > 0, `${p.id}: a claim with no evidence must not exist`);
      for (const e of p.evidence) {
        assert.ok(SELECTORS[e.when], `${p.id}: unknown condition '${e.when}'`);
        assert.ok(typeof e.text === 'string' && e.text.length > 0, `${p.id}: evidence text is required`);
        const matched = VARIANTS.filter(SELECTORS[e.when]);
        assert.ok(matched.length > 0, `${p.id}: '${e.when}' selects no prompt variant`);
      }
    }
  });

  // ── The assertion that matters ──────────────────────────────────────────────
  for (const v of VARIANTS) {
    it(`${v.id}: carries every protection that applies to it`, async () => {
      const prompt = await promptFor(v);
      let asserted = 0;
      for (const p of PROTECTIONS) {
        for (const e of p.evidence) {
          if (!SELECTORS[e.when](v)) continue;
          assert.ok(prompt.includes(fill(e.text, v)),
            `${p.id} (${e.when}) is displayed on the panel but its instruction is NOT in this prompt:\n  ${fill(e.text, v)}`);
          asserted += 1;
        }
      }
      assert.ok(asserted > 0, 'this variant proved nothing — the matrix is wrong');
    });
  }

  // ── Negative controls ───────────────────────────────────────────────────────
  // A claim that "renders" only because the string happens to be in every prompt
  // proves nothing. These pin the two conditional ones to their real trigger.
  it('the price rule appears only once the clinic has entered a price', async () => {
    const rule = PROTECTIONS.find((p) => p.id === 'prices').evidence.find((e) => e.when === 'priced').text;
    const unpriced = await promptFor(VARIANTS[0]);
    assert.ok(!unpriced.includes(fill(rule, VARIANTS[0])),
      'with nothing priced there is no price block at all (silence-on-empty)');
    const priced = await promptFor(VARIANTS[1]);
    assert.ok(priced.includes(fill(rule, VARIANTS[1])));
  });

  it('the no-invented-names rule appears only when the name is unknown', async () => {
    const rule = PROTECTIONS.find((p) => p.id === 'names').evidence[0].text;
    const known = await promptFor(VARIANTS[0]);
    assert.ok(!known.includes(fill(rule, VARIANTS[0])), 'a known name needs no suppression rule');
    assert.ok(known.includes('Customer name: Ravi'), 'it uses the real name instead');
    const unknown = await promptFor(VARIANTS[1]);
    assert.ok(unknown.includes(fill(rule, VARIANTS[1])));
  });

  // ── Panel projection ────────────────────────────────────────────────────────
  it('the owner-facing projection carries every claim and no internals', () => {
    const shown = protectionsForDisplay();
    assert.equal(shown.length, PROTECTIONS.length, 'nothing is hidden from the owner');
    for (const p of shown) {
      assert.ok(p.title && p.detail, 'each row states the claim and what it means');
      assert.ok(p.instructions.length > 0, 'and quotes the instruction behind it');
      for (const line of p.instructions) {
        assert.ok(!line.includes('{who}'), 'the placeholder is resolved before display');
        assert.ok(!line.includes('caller'), 'the panel shows the WhatsApp wording (the page notes the call variant)');
      }
      // INV-3: displayed as a platform invariant, never as a setting.
      assert.ok(!('enabled' in p) && !('key' in p) && !('configPath' in p),
        'a protection must not look like something an owner could switch off');
    }
  });
});
