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
  // ── Owner-facing identity fields (PORTAL-P2-S4). All DEFAULTED so a config
  // written before these existed still validates on read (Zod fills the default;
  // an absent key is not a strict violation). They live in the JSONB config
  // document — no DDL. `phone_numbers` are patient-facing clinic contacts, kept
  // distinct from escalation/owner-notification numbers (those are behaviour, not
  // identity) and never rendered into the prompt (see templates/clinic.js).
  address: z.string().max(500).default(''),   // clinic street address (patient-facing)
  landmark: z.string().max(200).default(''),  // nearby landmark to help patients find it
  website: z.string().max(300)                // optional public website — '' or an http(s) URL
    .refine((v) => v === '' || /^https?:\/\/\S+\.\S+/.test(v), { message: 'website must start with http:// or https://' })
    .default(''),
  phone_numbers: z.array(E164).max(10).default([]), // public clinic contact numbers (E.164)
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

// ── pricing ──────────────────────────────────────────────────────────────────
// The receptionist's price list (spec §5.4). Everything here is quoted VERBATIM
// from the prompt's bounded FACTS block — never recalled, estimated, converted,
// or negotiated. Anything absent falls through to the uncertainty fallback, so a
// half-filled section is always safer than a guessed one. Discounts are excluded
// by design (spec §9): free-text discounts invite price negotiation.
//
// Currency is INR by v1 constant (no picker, spec §9), so fees are plain whole
// rupees. Fees are NULLABLE on purpose: `null` means "not configured" (the
// receptionist won't quote it), which is materially different from `0` ("free").
// Nullable also makes CLEARING a fee work through deepMerge — an explicit null
// replaces, whereas an omitted key would be key-additively preserved.
const FEE = z.number().int().nonnegative().max(10000000); // whole rupees, ≤1 crore

const treatmentSchema = z.object({
  name: z.string().min(1).max(120),           // what the patient asks for, in their words
  price: FEE,                                 // whole rupees
  price_from: z.boolean().default(false),     // true → quoted as "starts at ₹X" (varies by case)
  duration_minutes: z.number().int().positive().max(480).nullable().default(null), // optional appointment length
  notes: z.string().max(300).default(''),     // optional qualifier the receptionist may state
  archived: z.boolean().default(false),       // retired row — kept for referenced history, NEVER rendered
}).strict();

const insuranceSchema = z.object({
  stance: z.enum(['not_accepted', 'selected_insurers', 'note']).default('not_accepted'), // how the clinic handles insurance
  note: z.string().max(300).default(''),      // the detail the stance promises — required unless 'not_accepted' (refined below)
}).strict();

const pricingSchema = z.object({
  consultation_fee: FEE.nullable().default(null), // first/standard consultation
  follow_up_fee: FEE.nullable().default(null),    // repeat visit
  emergency_fee: FEE.nullable().default(null),    // urgent/after-hours visit
  payment_methods: z.array(z.enum(['upi', 'cash', 'card'])).max(3).default([]), // what the clinic accepts
  insurance: insuranceSchema.default({ stance: 'not_accepted', note: '' }),
  treatments: z.array(treatmentSchema).max(50).default([]), // the priced procedure list (cap 50, spec §5.4)
}).strict()
  .superRefine((p, ctx) => {
    // A stance that promises detail must carry it: "we accept selected insurers"
    // with no list is a fact the receptionist cannot actually use on a call.
    if (p.insurance && p.insurance.stance !== 'not_accepted' && !p.insurance.note.trim()) {
      ctx.addIssue({
        code: 'custom', path: ['insurance', 'note'],
        message: 'add the insurance details this stance promises',
      });
    }
    // Payment methods are a SET — a repeated method would render twice.
    const seenMethod = new Set();
    (p.payment_methods || []).forEach((m, i) => {
      if (seenMethod.has(m)) {
        ctx.addIssue({ code: 'custom', path: ['payment_methods', i], message: `duplicate payment method '${m}'` });
      }
      seenMethod.add(m);
    });
    // Duplicate ACTIVE treatment names (case-insensitive): two live rows sharing a
    // name give the receptionist two prices for one question. Archived rows are
    // exempt so a retired name can legitimately be reused.
    const seenName = new Set();
    (p.treatments || []).forEach((t, i) => {
      if (!t || t.archived || typeof t.name !== 'string') return;
      const key = t.name.trim().toLowerCase();
      if (seenName.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['treatments', i, 'name'], message: `duplicate treatment name '${t.name}'` });
      }
      seenName.add(key);
    });
  });

// ── booking ──────────────────────────────────────────────────────────────────
// The four knobs above the policy texts are BEHAVIOUR: appointmentService's
// resolveBookingRules (F-006) reads exactly these paths and enforces them on both
// sides (what availability offers and what a booking write accepts). Their bounds
// are therefore contractual — `advance_days` is `.positive()` because 0 has no
// defined enforcement meaning (resolveBookingRules' posInt guard would silently
// fall back to the default), while `buffer_minutes` 0 legitimately means "no
// minimum notice".
const POLICY_TEXT = z.string().max(500);

const bookingSchema = z.object({
  slot_minutes: z.number().int().positive().max(480),    // length of one bookable slot, in minutes
  advance_days: z.number().int().positive().max(365),    // how many days ahead booking is allowed
  buffer_minutes: z.number().int().nonnegative().max(240), // gap enforced between adjacent bookings
  allow_same_day: z.boolean(),                           // whether same-day booking is permitted
  // ── Policy texts (PORTAL-P3-S9) ──
  // FACTS the receptionist recites when asked — NOT logic. Nothing reads these to
  // decide whether a booking is allowed; they render verbatim into the prompt's
  // bounded appointment-policy block. DEFAULTED for the same reason `pricing` is
  // (S6): every config written before this section existed has no such key and the
  // object is `.strict()`, so an absent key must not fail validation on READ.
  cancellation_policy: POLICY_TEXT.default(''), // what the receptionist says about cancelling
  reschedule_policy: POLICY_TEXT.default(''),   // what it says about moving an appointment
  walk_in_policy: POLICY_TEXT.default(''),      // what it says about walking in without one
}).strict();

// ── escalation ───────────────────────────────────────────────────────────────
// What the receptionist does when a conversation outgrows it, plus the clinic's
// own words for an emergency.
//
// HONESTY NOTE (PORTAL-P3-S10, verified against the code): `phone_numbers` is
// read by exactly ONE consumer — validationService.checkNumbers, the go-live
// gate. Nothing dials or messages these numbers; `notifications.on_escalation`
// has no consumer either, and handoff today is owner-INITIATED (the WhatsApp
// TAKEOVER/MSG/DONE commands). `enabled` is real behaviour: it renders the
// "offer a callback from clinic staff" line. The portal's Safety page says
// exactly this and promises nothing more.
const escalationSchema = z.object({
  enabled: z.boolean(),                       // whether the AI offers a staff callback when it can't help
  phone_numbers: z.array(E164),               // staff contacts for that callback (E.164) — validated, not auto-dialled
  // ── Emergency guidance (PORTAL-P3-S10) ──
  // The clinic's own words for someone describing an emergency, rendered as a
  // bounded prompt block ALONGSIDE the medical guardrail's "call emergency
  // services immediately" — never instead of it. The guardrail stays hardcoded
  // and non-configurable (INV-3); this only adds the clinic's local detail
  // ("our 24-hour line is…", "go to X hospital"). DEFAULTED for the same reason
  // `pricing` and the booking policies are: the top-level object is `.strict()`,
  // so a config written before this field existed must still validate on READ.
  emergency_guidance: z.string().max(400).default(''), // what the receptionist adds in an emergency
  emergency_number: E164.nullable().default(null),     // a number the receptionist may GIVE OUT in an emergency
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
    voice: z.enum(['per_message', 'on_close', 'off']).default('off'),     // voice extraction — OFF by default (per-utterance burns a Gemini call, Issue 3); 'on_close' is accepted but enforced as skip for now — close-triggered extraction is a future feature (Issue 30)
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
  // DEFAULTED (PORTAL-P2-S6): every config written before this section existed
  // has no `pricing` key, and the top-level object is `.strict()` — without a
  // default those documents would fail validation on READ and every existing
  // tenant would fall into getTenantConfig's stale-schema WARN path. The default
  // is the fully-empty price list, which renders NO pricing block at all.
  pricing: pricingSchema.default({
    consultation_fee: null,
    follow_up_fee: null,
    emergency_fee: null,
    payment_methods: [],
    insurance: { stance: 'not_accepted', note: '' },
    treatments: [],
  }),
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
