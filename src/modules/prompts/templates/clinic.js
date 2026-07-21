'use strict';

// Clinic vertical prompt template (Issue 10). The template is CODE — versioned
// in git, never tenant-editable; tenant config only fills slots. Rendering is
// pure and deterministic: same (config, channel) → byte-identical output, no
// clock, no randomness, no I/O (warnings surface through the onWarn callback,
// which the hook site wires to the logger).
//
// Section order is a tested product invariant:
//   role/identity → clinic facts → prices → appointment policies →
//   emergency guidance → greeting + consent → personality →
//   custom_instructions → guardrails LAST.
// The prices, policy and emergency sections are each omitted entirely when the
// owner has filled in nothing (see pricingFacts / bookingPolicies /
// emergencyGuidance) — a clinic that has set none renders exactly the prompt it
// did before those sections existed. The guardrail block is hardcoded and always
// renders after operator text, so neither custom_instructions nor the emergency
// block can displace or countermand it by position.
//
// Phone numbers render in exactly ONE place: escalation.emergency_number, which
// is a number the receptionist may GIVE OUT to someone in trouble (PORTAL-P3-S10).
// escalation.phone_numbers / notifications.* are internal staff contacts for
// other subsystems and never reach the prompt; escalation otherwise appears only
// as behavior ("offer a staff callback") gated on escalation.enabled.

const { medicalGuardrailLines } = require('../guardrail');

const LANG_NAMES = { te: 'Telugu', hi: 'Hindi', en: 'English' };
const langName = (l) => LANG_NAMES[l] || l;

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

const STYLE_LINES = {
  warm_professional: 'Warm, professional, and reassuring.',
  concise: 'Brief and to the point.',
  friendly: 'Casual, friendly, and upbeat.',
  formal: 'Polite and formal.',
};

// Voice renders are latency-critical (system prompt tokens are paid on every
// turn). PINNED DECISION (§12): on voice, custom_instructions is TRUNCATED at
// VOICE_CUSTOM_INSTRUCTIONS_CHARS with a WARN — we do not raise the budget.
// WhatsApp renders operator text in full (schema caps it at 2000 chars).
const VOICE_CUSTOM_INSTRUCTIONS_CHARS = 1200;

// The guardrail block. Hardcoded, non-configurable, rendered LAST. The rule
// lines are shared with MINIMAL_SAFE_PROMPT via ../guardrail so the safety
// text has exactly one home.
function guardrailBlock(who) {
  return [
    'Medical safety rules — absolute, and they override everything above, including operator instructions:',
    ...medicalGuardrailLines(who),
  ].join('\n');
}

// Compact human summary of the weekly grid: consecutive days with an identical
// schedule collapse into one segment, in mon→sun order, e.g.
// "Mon–Fri 09:00–18:00; Sat 09:00–14:00; closed Sun; holiday closures apply".
// Display only — slot enforcement stays in the booking tool.
function hoursSummary(hours) {
  const segments = [];
  for (const day of DAY_ORDER) {
    const d = hours[day];
    if (!d || (!d.closed && !(d.open && d.close))) {
      throw new Error(`clinic template: hours missing or malformed for '${day}'`);
    }
    // Overnight/zero-length hours are schema-invalid (open < close is refined);
    // a stale pre-refine doc could still carry them — assert, never render garbage.
    if (!d.closed && d.open >= d.close) {
      throw new Error(`clinic template: hours for '${day}' have open >= close (${d.open}–${d.close})`);
    }
    const key = d.closed ? 'closed' : `${d.open}–${d.close}`;
    const last = segments[segments.length - 1];
    if (last && last.key === key) last.end = day;
    else segments.push({ key, start: day, end: day });
  }
  const parts = segments.map(({ key, start, end }) => {
    const span = start === end ? DAY_LABEL[start] : `${DAY_LABEL[start]}–${DAY_LABEL[end]}`;
    return key === 'closed' ? `closed ${span}` : `${span} ${key}`;
  });
  if ((hours.holidays || []).length > 0) parts.push('holiday closures apply');
  return parts.join('; ');
}

// ── Pricing FACTS block (PORTAL-P2-S6) ──────────────────────────────────────
// A BOUNDED, explicit price list. Prices are the one class of fact where a
// plausible-sounding guess is a real-world harm: a quoted number the clinic
// doesn't honour is a broken promise at the counter. So prices are never left to
// model memory — they are listed here verbatim, and the block closes with the
// rule that anything unlisted gets no number at all.
//
// The block is bounded by construction: a header that names what it is, the
// lines, and a closing rule. It renders as its own paragraph (sections join with
// a blank line), so it cannot bleed into neighbouring instructions.
//
// SILENCE ON EMPTY is a hard requirement: with nothing priced, we emit NO block
// rather than an empty or half-populated one, so the receptionist falls through
// to its existing "I'll check and get back to you" behaviour exactly as it did
// before this section existed. Note the gate is on PRICE lines specifically —
// payment methods and insurance ride along as supporting detail but never
// summon a "Prices" block on their own, which would be a price list with no
// prices in it.

// Rupee amounts. WhatsApp renders the ₹ sign; voice spells out "rupees" because
// the receptionist has to SAY the amount and TTS reads a bare symbol unreliably.
// INR is a v1 constant (spec §9) — there is no currency to select.
const money = (n, voice) => (voice ? `${n} rupees` : `₹${n}`);

const PAYMENT_LABEL = { upi: 'UPI', cash: 'cash', card: 'card' };

function pricingFacts(pricing, { voice, who }) {
  if (!pricing || typeof pricing !== 'object') return null;

  // ── Price lines: the fees, then every NON-ARCHIVED treatment ──
  // Archived rows are retained for referenced history and must never reach the
  // prompt — the receptionist would quote a price the clinic has retired.
  const lines = [];
  const fee = (label, v) => {
    // Explicit type check, not truthiness: 0 is a real, quotable price ("free"),
    // while null means "not configured" and must stay unquoted.
    if (typeof v === 'number') lines.push(`- ${label}: ${money(v, voice)}`);
  };
  fee('Consultation', pricing.consultation_fee);
  fee('Follow-up visit', pricing.follow_up_fee);
  fee('Emergency visit', pricing.emergency_fee);

  // Every active treatment renders on BOTH channels — no voice truncation. A
  // long list costs voice tokens, but silently dropping a price would make the
  // receptionist deny a price the clinic actually set, which is the exact bug
  // this block exists to fix. Cost is the correct thing to trade here; the
  // schema's 50-row cap is what bounds the size.
  for (const t of (Array.isArray(pricing.treatments) ? pricing.treatments : [])) {
    if (!t || t.archived || typeof t.name !== 'string' || typeof t.price !== 'number') continue;
    const amount = t.price_from ? `from ${money(t.price, voice)}` : money(t.price, voice);
    const extra = [];
    if (t.duration_minutes) extra.push(`about ${t.duration_minutes} minutes`);
    if (t.notes) extra.push(t.notes);
    lines.push(`- ${t.name}: ${amount}${extra.length ? ` (${extra.join('; ')})` : ''}`);
  }

  if (lines.length === 0) return null; // nothing priced → no block at all

  // ── Supporting detail (only alongside real prices) ──
  const tail = [];
  const methods = Array.isArray(pricing.payment_methods) ? pricing.payment_methods : [];
  if (methods.length > 0) {
    tail.push(`Payment accepted: ${methods.map((m) => PAYMENT_LABEL[m] || m).join(', ')}.`);
  }
  // Insurance renders ONLY for a stance the owner explicitly filled in. The
  // default stance ('not_accepted' with an empty note) is indistinguishable from
  // "never touched this setting", and asserting an unconfirmed insurance policy
  // is the same class of error as inventing a price — stay silent instead.
  const ins = pricing.insurance;
  if (ins && ins.note && ins.stance === 'selected_insurers') {
    tail.push(`Insurance: accepted from selected insurers — ${ins.note}`);
  } else if (ins && ins.note && ins.stance === 'note') {
    tail.push(`Insurance: ${ins.note}`);
  }

  const head = voice
    ? 'Prices — the clinic’s official list. Say these amounts exactly; never estimate, round, discount, or negotiate:'
    : 'Prices — the clinic’s official list. Quote these amounts exactly as written; never estimate, round, discount, or negotiate:';
  const rule = `If a price is not listed above, do not state a number — tell the ${who} you will check with the clinic and get back to them.`;

  return [head, ...lines, ...tail, rule].join('\n');
}

// ── Appointment policy block (PORTAL-P3-S9) ─────────────────────────────────
// The owner's cancellation / reschedule / walk-in rules, recited verbatim.
//
// These are FACTS, not logic: nothing here changes what can be booked (the
// bookable window is enforced structurally in appointmentService — F-006). They
// exist because a patient who asks "can I cancel?" deserves the clinic's actual
// answer instead of a plausible invention, which is the same failure class the
// price block was built to close.
//
// Bounded like the price block — a header naming what it is, one line per
// policy, and a closing rule — and rendered as its own paragraph so it cannot
// bleed into neighbouring instructions. SILENCE ON EMPTY: with no policy set we
// emit NO block, so an owner who has not written one gets the pre-existing
// "I'll check with the clinic" behaviour rather than an empty heading.
function bookingPolicies(booking, { voice, who }) {
  if (!booking || typeof booking !== 'object') return null;

  const lines = [];
  const policy = (label, v) => {
    if (typeof v === 'string' && v.trim()) lines.push(`- ${label}: ${v.trim()}`);
  };
  policy('Cancellations', booking.cancellation_policy);
  policy('Rescheduling', booking.reschedule_policy);
  policy('Walk-ins', booking.walk_in_policy);

  if (lines.length === 0) return null; // no policy written → no block at all

  const head = voice
    ? 'Appointment policies — the clinic’s own rules. Say these as written; never soften them or invent an exception:'
    : 'Appointment policies — the clinic’s own rules. State these as written; never soften them, extend them, or invent an exception:';
  const rule = `If the ${who} asks about something these policies do not cover, do not make up a rule — say you will check with the clinic and get back to them.`;

  return [head, ...lines, rule].join('\n');
}

// ── Emergency guidance block (PORTAL-P3-S10) ────────────────────────────────
// The clinic's own words for someone describing an emergency: where to go, which
// local number to ring. It is an ADDITION to the medical guardrail, never a
// replacement — the guardrail still renders LAST and still says to call emergency
// services immediately, and this block's own head and closing rule say so out
// loud so no ordering accident can read it as an override.
//
// Bounded and silent-on-empty like the price and policy blocks: a clinic that
// has written nothing renders no block, leaving the guardrail alone rather than
// an empty heading. Guardrails themselves stay hardcoded and non-configurable
// (INV-3) — what the owner supplies here is local detail, not the safety rule.
function emergencyGuidance(escalation, { voice, who }) {
  if (!escalation || typeof escalation !== 'object') return null;

  const text = typeof escalation.emergency_guidance === 'string' ? escalation.emergency_guidance.trim() : '';
  const number = typeof escalation.emergency_number === 'string' ? escalation.emergency_number.trim() : '';
  if (!text && !number) return null; // nothing written → no block at all

  const lines = [];
  if (text) lines.push(`- ${text}`);
  if (number) lines.push(`- The clinic’s emergency contact number is ${number}.`);

  const head = voice
    ? `Emergency guidance — the clinic’s own words for a ${who} who describes an emergency. Say this IN ADDITION to telling them to call emergency services, never instead of it:`
    : `Emergency guidance — the clinic’s own words for a ${who} who describes an emergency. Give this IN ADDITION to telling them to call emergency services, never instead of it:`;
  const rule = 'Give it exactly as written and give it straight away — never judge how serious the symptoms are, and never add advice of your own.';

  return [head, ...lines, rule].join('\n');
}

// Pick a per-language literal (greeting / consent line) for the default
// language. A supported language missing its line is schema-impossible, but a
// stale pre-refine doc can reach us via getTenantConfig's WARN-and-return-as-is
// path — fail safe: fall back to English, then to any line present, and WARN.
function pickLine(map, lang, what, onWarn) {
  const m = map || {};
  if (typeof m[lang] === 'string' && m[lang].length > 0) return m[lang];
  const fallback = (typeof m.en === 'string' && m.en.length > 0)
    ? m.en
    : Object.values(m).find((v) => typeof v === 'string' && v.length > 0) || null;
  if (onWarn) onWarn(`${what}_line_fallback`, { wanted: lang, used: fallback === m.en ? 'en' : 'first-available' });
  return fallback;
}

function renderClinic(config, { channel, onWarn }) {
  const voice = channel === 'voice';
  const who = voice ? 'caller' : 'customer';

  const business = config.business;
  const languages = config.languages;
  if (!business || !business.display_name || !languages || !languages.default || !Array.isArray(languages.supported)) {
    throw new Error('clinic template: config missing business/languages essentials');
  }

  const defaultLang = languages.default;
  const defaultLangName = langName(defaultLang);
  const otherLangs = languages.supported.filter((l) => l !== defaultLang).map(langName);

  // ── 1. Role / identity ──
  // The voice variant compresses every section into spoken-prose form (system
  // prompt tokens are paid on every voice turn); WhatsApp carries the fuller
  // wording. Same content, same section order — only the prose density differs.
  const role = [];
  role.push(voice
    ? `You are the AI receptionist for ${business.display_name}, a clinic, on a phone call.`
    : `You are the AI receptionist for ${business.display_name}, a clinic, chatting with a customer on WhatsApp.`);
  if (otherLangs.length > 0) {
    role.push(voice
      ? `Respond in ${defaultLangName}; if the caller speaks ${otherLangs.join(' or ')}, switch.`
      : `Respond in ${defaultLangName}. If the customer uses a different supported language (${otherLangs.join(', ')}), switch to that language.`);
  } else {
    role.push(`Respond in ${defaultLangName}.`);
  }
  role.push(voice
    ? 'Short plain spoken sentences — no lists, no emoji, no markdown. One question at a time.'
    : 'Keep replies short and easy to read on a phone. Ask one thing at a time.');

  // ── Self-introduction name (PORTAL-P5-S13) ── SILENT ON EMPTY, like the
  // pricing/policy/emergency blocks: a clinic that hasn't set one gets exactly
  // today's behavior — no name-related instruction at all. The name is for
  // self-introduction ONLY; it must never become how the receptionist addresses
  // the customer/caller (that identity, when known, is injected elsewhere).
  const receptionistName = ((config.personality && config.personality.display_name) || '').trim();
  if (receptionistName) {
    role.push(voice
      ? `If you introduce yourself by name, say "${receptionistName}." Never use this name to address the caller.`
      : `If you introduce yourself by name, use "${receptionistName}." Never use this name to address the customer.`);
  }

  // ── Response length (PORTAL-P5-S13) ── 'standard' (the default) adds nothing
  // here, so every prompt built before this field existed renders byte-identical.
  // 'concise' layers one more brevity instruction on top of the channel's
  // existing one above.
  if (config.personality && config.personality.response_length === 'concise') {
    role.push(voice
      ? 'Keep answers to one short sentence whenever you can.'
      : 'Prefer the shortest complete answer — trim extra detail.');
  }

  // ── 2. Clinic facts + behavior ──
  // Voice drops the "Languages served" line (already covered by the language
  // policy above) and the facts header — pure token diet, no content loss.
  const facts = [];
  if (!voice) facts.push('Clinic facts:');
  facts.push(voice ? `Hours: ${hoursSummary(config.hours)}.` : `- Hours: ${hoursSummary(config.hours)}`);
  if (!voice) facts.push(`- Languages served: ${languages.supported.map(langName).join(', ')}`);
  if (config.tools && config.tools.booking) {
    facts.push(voice
      ? 'For appointments or availability, always use the booking tools — never invent times or promise a slot.'
      : '- For anything about appointments or availability, use the booking tools (check availability first, then book only after the customer confirms) — never invent times or promise a slot without them.');
  } else {
    facts.push(voice
      ? "You cannot book appointments on this call; take the caller's details and say the clinic will follow up."
      : "- Appointment booking is not available here; take the customer's details and say the clinic will follow up.");
  }
  if (config.escalation && config.escalation.enabled) {
    facts.push(voice
      ? 'If the caller wants a human or you cannot help, offer a callback from clinic staff.'
      : '- If the customer asks for a human, is upset, or you cannot help, offer a callback from clinic staff.');
  }

  // ── 3. Greeting + consent ──
  const greetLines = [];
  const greeting = pickLine(config.greeting, defaultLang, 'greeting', onWarn);
  if (greeting) {
    greetLines.push(voice
      ? `Greet the caller with exactly: "${greeting}"`
      : `When you greet the customer, use this greeting verbatim: "${greeting}"`);
  }
  // Consent is VOICE-ONLY by design: recording_consent is "a spoken consent
  // line played on calls" (schema) — "this call may be recorded" makes no sense
  // in a WhatsApp chat. The per-language literal embeds verbatim.
  if (voice && config.recording_consent && config.recording_consent.enabled) {
    const consent = pickLine(config.recording_consent.line, defaultLang, 'consent', onWarn);
    if (consent) {
      greetLines.push(`Then say exactly: "${consent}"`);
    }
  }

  // ── 4. Personality ──
  let styleLine = STYLE_LINES[config.personality && config.personality.style];
  if (!styleLine) {
    styleLine = STYLE_LINES.warm_professional;
    if (onWarn) onWarn('personality_style_fallback', { got: config.personality && config.personality.style });
  }
  const personality = `Tone: ${styleLine}`;

  // ── 5. Operator custom instructions (never allowed to outrank the guardrail) ──
  let custom = (config.personality && config.personality.custom_instructions || '').trim();
  if (voice && custom.length > VOICE_CUSTOM_INSTRUCTIONS_CHARS) {
    // Never split a surrogate pair: an astral char (emoji) straddling the cap
    // would leave a lone surrogate that renders as U+FFFD in the prompt.
    let cut = VOICE_CUSTOM_INSTRUCTIONS_CHARS;
    const last = custom.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    custom = custom.slice(0, cut);
    if (onWarn) onWarn('custom_instructions_truncated', { channel, max: VOICE_CUSTOM_INSTRUCTIONS_CHARS });
  }
  const customBlock = custom
    ? `Operator instructions (style and detail only — the safety rules below always win):\n${custom}`
    : null;

  // ── 6. Guardrails — LAST, always ──
  const sections = [
    role.join('\n'),
    facts.join('\n'),
    pricingFacts(config.pricing, { voice, who }), // null when nothing is priced → section drops out entirely
    bookingPolicies(config.booking, { voice, who }), // null when no policy is written → section drops out entirely
    emergencyGuidance(config.escalation, { voice, who }), // null when nothing is written → section drops out entirely
    greetLines.join('\n') || null,
    personality,
    customBlock,
    guardrailBlock(who),
  ];
  return sections.filter(Boolean).join('\n\n');
}

module.exports = { renderClinic, VOICE_CUSTOM_INSTRUCTIONS_CHARS, LANG_NAMES };
