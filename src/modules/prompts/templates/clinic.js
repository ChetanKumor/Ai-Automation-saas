'use strict';

// Clinic vertical prompt template (Issue 10). The template is CODE — versioned
// in git, never tenant-editable; tenant config only fills slots. Rendering is
// pure and deterministic: same (config, channel) → byte-identical output, no
// clock, no randomness, no I/O (warnings surface through the onWarn callback,
// which the hook site wires to the logger).
//
// Section order is a tested product invariant:
//   role/identity → clinic facts → greeting + consent → personality →
//   custom_instructions → guardrails LAST.
// The guardrail block is hardcoded and always renders after operator text, so
// custom_instructions can never displace or countermand it by position.
//
// Phone numbers NEVER render: escalation.phone_numbers / notifications.* are
// data for other subsystems; escalation appears only as behavior ("offer a
// staff callback") gated on escalation.enabled.

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
    greetLines.join('\n') || null,
    personality,
    customBlock,
    guardrailBlock(who),
  ];
  return sections.filter(Boolean).join('\n\n');
}

module.exports = { renderClinic, VOICE_CUSTOM_INSTRUCTIONS_CHARS, LANG_NAMES };
