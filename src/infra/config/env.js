'use strict';

const logger = require('../logging/logger');

const REQUIRED = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'WEBHOOK_VERIFY_TOKEN',
  'META_APP_SECRET',
  'ENCRYPTION_KEY',
  'ADMIN_PASSWORD',
];

const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length > 0) {
  logger.error({ missing }, 'missing required env var(s)');
  process.exit(1);
}

if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
  logger.error('SESSION_SECRET must be at least 32 characters');
  process.exit(1);
}

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  META_APP_SECRET: process.env.META_APP_SECRET,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET,
  PORT: process.env.PORT || 3000,
  IDENTITY_RESOLUTION_ENABLED: process.env.IDENTITY_RESOLUTION_ENABLED === 'true',

  // Voice channel (PR6) — all optional; off by default. With VOICE_ENABLED off,
  // nothing voice-related is wired and the WhatsApp path is unchanged.
  VOICE_ENABLED: process.env.VOICE_ENABLED === 'true',
  TELEPHONY_PROVIDER: process.env.TELEPHONY_PROVIDER || 'noop',
  SARVAM_API_KEY: process.env.SARVAM_API_KEY,
  VOICE_INTERNAL_SECRET: process.env.VOICE_INTERNAL_SECRET,

  // Voice turn latency knobs (PR9A) — all optional, voice-channel only; the
  // WhatsApp/default Gemini config is untouched. Read at call time by aiService.
  VOICE_THINKING_BUDGET: process.env.VOICE_THINKING_BUDGET,     // default 0 (thinking off)
  VOICE_MAX_OUTPUT_TOKENS: process.env.VOICE_MAX_OUTPUT_TOKENS, // default 150
  VOICE_HISTORY_TURNS: process.env.VOICE_HISTORY_TURNS,         // default 8
  VOICE_MEMORY_FACTS_MAX: process.env.VOICE_MEMORY_FACTS_MAX,   // default 10
};
