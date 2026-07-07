'use strict';

// Prompt renderer (Issue 10) — the system prompt as a function of tenant
// config. `renderSystemPrompt(config, { channel })` is pure and deterministic:
// no I/O, no clock; warnings surface via the optional onWarn(event, detail)
// callback so the hook site (aiService) owns all logging.
//
// Vertical dispatch: templates live in ./templates/<vertical>.js, versioned in
// git, never tenant-editable. v1 has exactly one vertical, 'clinic'.
//
// Errors THROW (unknown vertical, structurally broken config, garbage hours) —
// the hook site catches and falls back to MINIMAL_SAFE_PROMPT; a render
// problem must never take down a live turn.

const { renderClinic } = require('./templates/clinic');
const { medicalGuardrailLines } = require('./guardrail');

const VERTICALS = { clinic: renderClinic };

// Last-resort system prompt: no config and no legacy ai_prompt (or the render
// threw). Keeps the medical guardrail (shared text — see ./guardrail) even
// when we know nothing else about the tenant.
const MINIMAL_SAFE_PROMPT = [
  'You are a polite AI receptionist for a medical clinic.',
  'Keep replies short and helpful. If you do not know something, say so and offer to have clinic staff follow up.',
  'Medical safety rules — absolute:',
  ...medicalGuardrailLines('person'),
].join('\n');

function renderSystemPrompt(config, { channel = 'whatsapp', onWarn = null } = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('renderSystemPrompt: config document is required');
  }
  const vertical = config.business && config.business.vertical;
  const render = VERTICALS[vertical];
  if (!render) {
    throw new Error(`renderSystemPrompt: unknown vertical '${vertical}'`);
  }
  return render(config, { channel, onWarn });
}

// Rough token estimate (chars/4) — for budget tests and PR reporting only,
// never for enforcement decisions at runtime.
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

module.exports = { renderSystemPrompt, estimateTokens, MINIMAL_SAFE_PROMPT };
