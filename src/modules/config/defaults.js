'use strict';

// clinicDefaults — a COMPLETE, self-valid config document for the clinic
// vertical. It is the base every write deep-merges onto (write-materialization)
// and the seed the backfill script (and future provisioning) writes verbatim.
//
// Invariant: `configSchema.safeParse(clinicDefaults).success === true` on its
// own, with zero input. There is a unit test that pins exactly this — if you add
// a required field to the schema, add its default here or that test goes red.
//
// These are safe, inert starting values: channels reflect the common case
// (WhatsApp on, voice off), alert lists are empty (provisioning fills real
// numbers), and voice CRM extraction is off (Issue 3: per-utterance extraction
// burns a Gemini call per utterance).

const clinicDefaults = {
  business: {
    display_name: 'New Clinic',
    vertical: 'clinic',
    timezone: 'Asia/Kolkata',
    address: '',
    landmark: '',
    website: '',
    phone_numbers: [],
  },
  languages: {
    supported: ['te', 'hi', 'en'],
    default: 'en',
  },
  greeting: {
    en: 'Hello! Welcome. How can I help you today?',
    hi: 'नमस्ते! आपका स्वागत है। मैं आपकी कैसे मदद कर सकता/सकती हूँ?',
    te: 'నమస్తే! స్వాగతం. నేను మీకు ఎలా సహాయం చేయగలను?',
  },
  hours: {
    mon: { open: '09:00', close: '18:00' },
    tue: { open: '09:00', close: '18:00' },
    wed: { open: '09:00', close: '18:00' },
    thu: { open: '09:00', close: '18:00' },
    fri: { open: '09:00', close: '18:00' },
    sat: { open: '09:00', close: '14:00' },
    sun: { closed: true },
    holidays: [],
  },
  // Deliberately EMPTY (PORTAL-P2-S6). A fresh clinic has no prices we could
  // honestly invent, and an empty price list renders NO pricing block in the
  // prompt at all — so the receptionist keeps refusing to quote a number until
  // the owner enters real ones. A "sample" fee here would be a lie the
  // receptionist would state as fact.
  pricing: {
    consultation_fee: null,
    follow_up_fee: null,
    emergency_fee: null,
    payment_methods: [],
    insurance: {
      stance: 'not_accepted',
      note: '',
    },
    treatments: [],
  },
  booking: {
    slot_minutes: 30,
    advance_days: 30,
    buffer_minutes: 0,
    allow_same_day: true,
  },
  escalation: {
    enabled: true,
    phone_numbers: [],
  },
  notifications: {
    owner_numbers: [],
    on_booking: true,
    on_escalation: true,
  },
  personality: {
    style: 'warm_professional',
    custom_instructions: '',
  },
  tools: {
    booking: true,
  },
  crm: {
    extraction: {
      whatsapp: 'per_message',
      voice: 'off',
    },
  },
  voice: {
    enabled: false,
    did: null,
    provider: 'plivo',
    sarvam_speaker: 'anushka',
    sarvam_voice_id: 'bulbul:v2',
  },
  whatsapp: {
    enabled: true,
  },
  recording_consent: {
    enabled: false,
    line: {
      en: 'This call may be recorded for quality and training purposes.',
      hi: 'गुणवत्ता और प्रशिक्षण उद्देश्यों के लिए इस कॉल को रिकॉर्ड किया जा सकता है।',
      te: 'నాణ్యత మరియు శిక్షణ కోసం ఈ కాల్ రికార్డ్ చేయబడవచ్చు.',
    },
  },
  retention_days: 365,
};

module.exports = { clinicDefaults };
