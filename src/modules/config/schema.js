'use strict';

// Per-tenant config schema (Issue 8) — the single, strict contract for every
// knob that shapes a tenant's behavior. Zod is the sanctioned validator: it
// gives us path-level errors (for a future admin PUT) and, via `.strict()`,
// hard rejection of unknown keys (typo/stale-field protection).
//
// Every field below carries a one-line comment — this file doubles as the
// config reference until the control-plane pages exist (Issue 25).
//
// SECRETS RULE: no credential-bearing field lives here. WhatsApp tokens / WABA
// ids stay in their encrypted `tenants` columns. `whatsapp`/`voice` carry only
// non-secret toggles and public identifiers (DID, speaker). Enforced by grep.

const { z } = require('zod');

// ── Reusable field validators ────────────────────────────────────────────────
const LANG_CODES = ['te', 'hi', 'en'];                                   // Telugu, Hindi, English — the only languages v1 supports
const LANG  = z.enum(LANG_CODES);                                        // a single language code
const E164  = z.string().regex(/^\+[1-9]\d{1,14}$/, 'must be E.164 (e.g. +919876543210)'); // international phone number
const HHMM  = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be 24h HH:MM'); // wall-clock time of day
const YMD   = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date'); // calendar date

// ── business ─────────────────────────────────────────────────────────────────
const businessSchema = z.object({
  display_name: z.string().min(1).max(120),   // business name shown to customers on chat/voice
  vertical: z.literal('clinic'),              // product vertical — only 'clinic' exists in v1
  timezone: z.string().min(1).default('Asia/Kolkata'), // IANA tz used for hours/booking arithmetic
}).strict();

// ── languages ────────────────────────────────────────────────────────────────
const languagesSchema = z.object({
  supported: z.array(LANG).nonempty(),        // languages this tenant serves (non-empty subset of te/hi/en)
  default: LANG,                              // language used before the customer picks one
}).strict().refine((v) => v.supported.includes(v.default), {
  message: 'default language must be one of `supported`',
  path: ['default'],                          // → surfaces at `languages.default`
});

// ── hours ────────────────────────────────────────────────────────────────────
const dayScheduleSchema = z.union([
  z.object({ closed: z.literal(true) }).strict(),   // a day the business is fully closed
  z.object({
    open: HHMM,                                     // opening time (HH:MM, 24h)
    close: HHMM,                                     // closing time (HH:MM, 24h)
  }).strict().refine((d) => d.open < d.close, { message: 'open must be before close', path: ['close'] }),
]);
const holidaySchema = z.object({
  date: YMD,                                  // holiday date (business closed that day)
  name: z.string().min(1).max(120).optional(), // optional human label for the holiday
}).strict();
const hoursSchema = z.object({
  mon: dayScheduleSchema,                     // Monday schedule (open/close or closed)
  tue: dayScheduleSchema,                     // Tuesday schedule
  wed: dayScheduleSchema,                     // Wednesday schedule
  thu: dayScheduleSchema,                     // Thursday schedule
  fri: dayScheduleSchema,                     // Friday schedule
  sat: dayScheduleSchema,                     // Saturday schedule
  sun: dayScheduleSchema,                     // Sunday schedule
  holidays: z.array(holidaySchema),           // dated one-off closures on top of the weekly grid
}).strict();

// ── booking ──────────────────────────────────────────────────────────────────
const bookingSchema = z.object({
  slot_minutes: z.number().int().positive().max(480),    // length of one bookable slot, in minutes
  advance_days: z.number().int().positive().max(365),    // how many days ahead booking is allowed
  buffer_minutes: z.number().int().nonnegative().max(240), // gap enforced between adjacent bookings
  allow_same_day: z.boolean(),                           // whether same-day booking is permitted
}).strict();

// ── escalation ───────────────────────────────────────────────────────────────
const escalationSchema = z.object({
  enabled: z.boolean(),                       // whether the AI may hand a conversation to a human
  phone_numbers: z.array(E164),               // agent numbers notified on escalation (E.164)
}).strict();

// ── notifications ────────────────────────────────────────────────────────────
const notificationsSchema = z.object({
  owner_numbers: z.array(E164),               // owner/manager numbers for operational alerts (E.164)
  on_booking: z.boolean(),                    // notify owners when a booking is made
  on_escalation: z.boolean(),                 // notify owners when a conversation escalates
}).strict();

// ── personality ──────────────────────────────────────────────────────────────
const personalitySchema = z.object({
  style: z.enum(['warm_professional', 'concise', 'friendly', 'formal']).default('warm_professional'), // agent tone preset
  custom_instructions: z.string().max(2000).default(''), // free-text persona tweaks appended to the prompt
}).strict();

// ── tools ────────────────────────────────────────────────────────────────────
const toolsSchema = z.object({
  booking: z.boolean(),                       // master toggle for the appointment-booking tool
}).strict();

// ── crm ──────────────────────────────────────────────────────────────────────
const crmSchema = z.object({
  extraction: z.object({
    whatsapp: z.enum(['per_message', 'off']).default('per_message'),      // when to run CRM extraction on WhatsApp messages
    voice: z.enum(['per_message', 'on_close', 'off']).default('off'),     // voice extraction — OFF by default (per-utterance burns a Gemini call, Issue 3)
  }).strict(),
}).strict();

// ── voice ────────────────────────────────────────────────────────────────────
const voiceSchema = z.object({
  enabled: z.boolean(),                       // whether this tenant has the voice (phone) channel on
  did: E164.nullable(),                       // inbound phone number (DID) in E.164, or null if none provisioned
  provider: z.literal('plivo'),               // telephony provider — only Plivo in v1
  sarvam_speaker: z.string().min(1),          // Sarvam Bulbul TTS speaker (the synthesized voice, e.g. 'anushka')
  sarvam_voice_id: z.string().min(1),         // Sarvam TTS model id (e.g. 'bulbul:v2')
}).strict();

// ── whatsapp ─────────────────────────────────────────────────────────────────
const whatsappSchema = z.object({
  enabled: z.boolean(),                       // whether the WhatsApp channel is active (credentials stay in tenants columns — NOT here)
}).strict();

// ── recording_consent ────────────────────────────────────────────────────────
const recordingConsentSchema = z.object({
  enabled: z.boolean(),                       // whether a spoken consent line is played (recordings themselves are off in v1)
  line: z.record(z.string(), z.string().min(1)), // per-language consent sentence; must cover every supported language (refined below)
}).strict();

// ── top-level document ───────────────────────────────────────────────────────
const configSchema = z.object({
  business: businessSchema,                   // identity + locale of the business
  languages: languagesSchema,                 // supported languages + default
  greeting: z.record(z.string(), z.string().min(1)), // per-language opening line; must cover every supported language (refined below)
  hours: hoursSchema,                         // weekly opening hours + holidays
  booking: bookingSchema,                     // appointment-booking rules
  escalation: escalationSchema,               // human-handoff config
  notifications: notificationsSchema,         // owner-alert config
  personality: personalitySchema,             // agent tone + custom instructions
  tools: toolsSchema,                         // per-tool toggles
  crm: crmSchema,                             // CRM extraction policy
  voice: voiceSchema,                         // voice channel config
  whatsapp: whatsappSchema,                   // WhatsApp channel toggle
  recording_consent: recordingConsentSchema,  // spoken call-recording consent line
  retention_days: z.number().int().min(30).max(3650).default(365), // days to retain conversation/customer data
}).strict()
  // Cross-section refinement: the per-language maps (greeting + consent line)
  // MUST cover every supported language, and MUST NOT carry stray language keys
  // (records aren't `.strict()`, so we police their keys here). Runs only after
  // the object parses; each issue is reported at its exact path.
  .superRefine((cfg, ctx) => {
    const supported = cfg.languages ? cfg.languages.supported : [];
    const maps = [
      { map: cfg.greeting, path: ['greeting'] },
      { map: cfg.recording_consent && cfg.recording_consent.line, path: ['recording_consent', 'line'] },
    ];
    for (const { map, path } of maps) {
      const m = map || {};
      for (const lang of supported) {
        if (typeof m[lang] !== 'string' || m[lang].length === 0) {
          ctx.addIssue({ code: 'custom', path: [...path, lang], message: `missing entry for supported language '${lang}'` });
        }
      }
      for (const key of Object.keys(m)) {
        if (!LANG_CODES.includes(key)) {
          ctx.addIssue({ code: 'custom', path: [...path, key], message: `unknown language key '${key}'` });
        }
      }
    }
  });

module.exports = { configSchema, LANG_CODES };
