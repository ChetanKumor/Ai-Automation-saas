'use strict';

// ============================================================================
//  Built-in protections catalog (PORTAL-P3-S10, spec §5.10)
//
//  The claims the portal is allowed to make to a paying clinic about what its
//  receptionist will never do. Displayed read-only on the Safety page; NEVER
//  configurable (INV-3) — these are platform invariants, not settings.
//
//  THE RULE THIS FILE EXISTS TO ENFORCE: a claim may appear here only if the
//  instruction that enforces it is present, verbatim, in the system prompt the
//  model actually receives. `evidence` is that instruction, quoted exactly, and
//  tests/prompts/protections.unit.test.js iterates THIS ARRAY and asserts every
//  entry against real rendered prompts. So a claim added here without its
//  enforcing text turns the suite red; a claim cannot be displayed and
//  unverified at the same time. Displaying an unenforced safety promise is the
//  worst defect this portal could ship, so the binding is structural rather
//  than a convention someone has to remember.
//
//  `{who}` is substituted per channel ('customer' on WhatsApp, 'caller' on
//  voice), mirroring the prompt's own split. `when` names the prompt condition
//  under which the line appears:
//
//    always    — every prompt, every provenance mode (aiService's outer tail)
//    rendered  — the config-rendered prompt (clinic template)
//    priced    — additionally, when the clinic has entered at least one price
//    unnamed   — additionally, when the caller's name is not known
//    knowledge — additionally, when FAQ/document chunks were retrieved
//
//  KNOWN GAP (reported, not papered over): the 'medical' claim's evidence lives
//  in the clinic template, so it does NOT render for a legacy tenant whose
//  `tenants.ai_prompt` override replaces the template wholesale. That state is
//  already surfaced by the advisory `tenant.legacy_prompt` validation check.
// ============================================================================

const PROTECTIONS = [
  {
    id: 'prices',
    title: 'Never invents a price',
    detail: 'It quotes only the amounts on your Pricing page. For anything you haven’t priced it offers to check with the clinic instead of naming a number.',
    evidence: [
      { when: 'priced', text: 'If a price is not listed above, do not state a number — tell the {who} you will check with the clinic and get back to them.' },
      { when: 'always', text: '- NEVER make up information you don\'t have — say "Let me check and get back to you"' },
    ],
  },
  {
    id: 'names',
    title: 'Never invents a patient’s name',
    detail: 'When it doesn’t know who it’s speaking to, it talks to them without using a name rather than guessing one.',
    evidence: [
      { when: 'unnamed', text: "The {who}'s name is not known — never guess or invent one. Address them without a name, and ask for it only if the conversation genuinely needs it." },
    ],
  },
  {
    id: 'unsure',
    title: 'Says “Let me check and get back to you” when it’s unsure',
    detail: 'Where it has no answer it says so and offers to come back to the patient, instead of filling the gap with something that merely sounds right.',
    evidence: [
      { when: 'always', text: '- NEVER make up information you don\'t have — say "Let me check and get back to you"' },
    ],
  },
  {
    id: 'scope',
    title: 'Doesn’t add details beyond what you’ve entered',
    detail: 'When it answers from your FAQs it uses only what’s written there — it won’t extend or embellish them. (It can still answer general questions in its own words; restricting every answer to your material is not something we enforce today.)',
    evidence: [
      { when: 'always', text: '- If business knowledge is provided above, use it to answer. Do NOT add details beyond what is given.' },
      { when: 'knowledge', text: 'Business knowledge (use ONLY this to answer questions — do not invent information):' },
    ],
  },
  {
    id: 'medical',
    title: 'Never diagnoses, prescribes, or gives medical advice',
    detail: 'Medical questions go to your doctor, and anyone describing an emergency is told to call emergency services immediately. You can add your clinic’s own emergency guidance above — it’s given alongside this rule, never instead of it.',
    evidence: [
      { when: 'rendered', text: '- Never diagnose, prescribe, or give medical advice, medication suggestions, or dosage information.' },
      { when: 'rendered', text: '- If the {who} describes a medical emergency, tell them to call emergency services immediately.' },
    ],
  },
];

// The panel shows the WhatsApp wording of each instruction (the page carries one
// note that calls say "caller"), so the owner reads the real line rather than a
// paraphrase of it.
function protectionsForDisplay() {
  return PROTECTIONS.map((p) => ({
    id: p.id,
    title: p.title,
    detail: p.detail,
    instructions: p.evidence.map((e) => e.text.replace(/\{who\}/g, 'customer')),
  }));
}

module.exports = { PROTECTIONS, protectionsForDisplay };
