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

module.exports = { medicalGuardrailLines };
