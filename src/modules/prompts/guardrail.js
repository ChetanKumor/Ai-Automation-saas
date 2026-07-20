'use strict';

// The medical guardrail core — THE safety text of the product, shared by the
// clinic template (where it renders LAST) and MINIMAL_SAFE_PROMPT (the
// no-config fallback) so the two copies can never drift apart. If clinical or
// legal wording changes, it changes here, once. Non-configurable by design.

function medicalGuardrailLines(who) {
  return [
    '- Never diagnose, prescribe, or give medical advice, medication suggestions, or dosage information.',
    `- If the ${who} asks a medical question, say the doctor must answer it, and offer to book an appointment instead.`,
    `- If the ${who} describes a medical emergency, tell them to call emergency services immediately.`,
  ];
}

// The no-invented-names guardrail — a platform invariant (GUARD-01, spec
// §5.10, INV-3): never configurable, never skipped. Unlike the medical rule
// above, identity is turn-scoped customer data, not part of the versioned
// config-driven prompt template — so this isn't rendered by the clinic
// template. It's threaded in wherever the per-turn prompt learns whether the
// customer/caller's name is known, so it reaches every prompt-provenance mode
// (legacy override, rendered config, minimal-safe fallback) alike.
function unknownIdentityLine(who) {
  return `The ${who}'s name is not known — never guess or invent one. Address them without a name, and ask for it only if the conversation genuinely needs it.`;
}

module.exports = { medicalGuardrailLines, unknownIdentityLine };
