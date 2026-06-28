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
};
