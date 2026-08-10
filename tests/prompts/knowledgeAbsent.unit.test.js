'use strict';

// Q4-3 (01-map.md §7) — zero retrieved chunks removes the ENTIRE knowledge
// section from the prompt, and the anti-invention instruction leaves with it.
//
// `aiService.buildSystemPrompt:567-569`:
//
//     const knowledgeSection = knowledgeChunks.length
//       ? `\nBusiness knowledge (use ONLY this to answer questions — do not invent information):\n…`
//       : '';
//
// The string "do not invent information" occurs exactly once in `src/`, on that
// one line. So the prompt that goes out with no knowledge is the prompt with the
// least reason to trust the model and the fewest instructions telling it not to
// improvise.
//
// This file ships in the same commit as the embedding deadline on purpose, and
// the coupling is the whole point. A timeout converts a hung RAG call into a FAST
// RAG failure; `contextAssembler.js:67-70` catches any RAG failure and returns
// `[]`; zero chunks then takes the branch above. Bounding the embedding call
// therefore RAISES the rate at which this path fires. Shipping the timeout alone
// would trade a hung turn for a confidently invented one — in Telugu, about a
// clinic the model knows nothing about. That is a worse outcome, not a better
// one, so the mitigation lands with the change that increases the exposure.
//
// The path fires for three distinct reasons and the instruction must survive all
// three: a tenant with no knowledge base at all, a query that retrieves nothing,
// and a retrieval FAILURE (timeout, Google outage, a `22P02` from a malformed
// tenant id) — which is indistinguishable from the other two by the time the
// prompt is assembled, because the catch returns `[]` for every one of them.
//
// §7.4: the assertion is on the ASSEMBLED PROMPT captured through the model
// provider, not on a helper's return value. Three of the prompt's guarantees are
// enforced by the outer tail that the clinic template never sees — the GUARD-01
// trap — so a test against `renderSystemPrompt` alone could pass while the real
// prompt lacked the line.

require('dotenv').config();

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiService     = require('../../src/modules/ai/aiService');
const configService = require('../../src/modules/config/configService');
const logger        = require('../../src/infra/logging/logger');
const { clinicDefaults } = require('../../src/modules/config/defaults');
const { configSchema }   = require('../../src/modules/config/schema');

const CONVERSATION = { id: 'C1', mode: 'ai', summary: null };

// The instruction under test, verbatim from aiService.js:568.
const ANTI_INVENTION = 'do not invent information';

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

/** The full system prompt for a rendered-config tenant, given some chunks. */
async function promptWith(knowledgeChunks, { channel = 'whatsapp' } = {}) {
  configService.getTenantConfig = async () => configSchema.parse(clinicDefaults);
  const m = capturingModel();
  aiService._setModelProvider(m.provider);

  const tenant   = { id: 'T1', business_name: 'Clinic', ai_prompt: null };
  const customer = { id: 'U1', phone: '+919000000001', name: null };

  await aiService.generateReply(
    tenant, customer, CONVERSATION, 'do you do root canals?', [], knowledgeChunks, [], { channel }
  );
  return m.seen.config.systemInstruction;
}

describe('Q4-3 — the anti-invention instruction survives an empty knowledge section', () => {
  // ── The finding ─────────────────────────────────────────────────────────────
  it('(1) a turn with zero chunks still carries the instruction not to invent', async () => {
    const prompt = await promptWith([]);

    assert.ok(prompt.includes(ANTI_INVENTION),
      'with no knowledge retrieved the whole section is dropped at HEAD, taking the ' +
      '"do not invent information" instruction with it — which is precisely the turn ' +
      'that most needs it (Q4-3)');
  });

  // A retrieval FAILURE and an empty KB are the same `[]` by the time the prompt
  // is built (contextAssembler.js:67-70). Pinning the voice channel too, because
  // the voice branch is where the new deadline will most often fire.
  it('(2) the instruction survives on the voice channel as well', async () => {
    const prompt = await promptWith([], { channel: 'voice' });

    assert.ok(prompt.includes(ANTI_INVENTION),
      'a timeout on a voice turn must not silently strip the guard — the SSE branch ' +
      'is the one production runs (ARCHITECTURE.md:90)');
  });

  // ── Controls ────────────────────────────────────────────────────────────────
  // Green at HEAD. Here so the fix cannot be "always print the instruction and
  // drop the knowledge", and so the populated wording the protections panel
  // quotes to owners (src/portal/protections.js:68) stays byte-exact.
  it('(3) a turn WITH chunks is unchanged — same header, and the chunks are rendered', async () => {
    const prompt = await promptWith([{ content: 'We have free parking behind the building.' }]);

    assert.ok(prompt.includes(
      'Business knowledge (use ONLY this to answer questions — do not invent information):'),
      'the populated header is what the Safety panel quotes verbatim to owners');
    assert.ok(prompt.includes('- We have free parking behind the building.'),
      'the retrieved chunk still reaches the prompt');
  });

  it('(4) the empty section does not claim knowledge the turn does not have', async () => {
    const prompt = await promptWith([]);

    assert.ok(!prompt.includes('use ONLY this to answer questions'),
      '"use ONLY this" with nothing to point at would tell the model to answer from an ' +
      'empty set — the instruction to keep is the anti-invention one, not the scoping one');
  });
});
