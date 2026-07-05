require('dotenv').config();
require('./src/infra/config/env');

const express = require('express');
const crypto  = require('crypto');
const session = require('express-session');
const path    = require('path');
const logger  = require('./src/infra/logging/logger');

const app = express();

// Request-ID middleware
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  logger.info({ requestId: req.id, method: req.method, path: req.url }, 'incoming request');
  next();
});

// Register channel adapters before accepting connections
const channelRegistry = require('./src/modules/channels');
const whatsappAdapter = require('./src/modules/channels/whatsapp/adapter');
channelRegistry.register(whatsappAdapter);

// Webhook needs raw body for signature verification — mount before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }), require('./src/modules/channels/whatsapp/routes'));

// ── Voice channel (PR6) — gated; off by default → zero behavior change ──
// Mounted before express.json() because the internal endpoint authenticates over
// the raw HMAC-signed body.
if (process.env.VOICE_ENABLED === 'true') {
  const voiceChannelAdapter = require('./src/modules/channels/voice/voiceChannelAdapter');
  channelRegistry.register(voiceChannelAdapter);

  app.use('/internal/voice', require('./src/routes/internalVoice'));

  try {
    const telephony = require('./src/modules/telephony/telephonyProvider');
    const provider = telephony.getProvider(process.env.TELEPHONY_PROVIDER || 'noop');
    provider.onInboundCall(() => logger.info('voice: inbound call received'));
    logger.info({ telephonyProvider: provider.name }, 'voice channel enabled');
  } catch (err) {
    logger.error(
      { err: err.message, telephonyProvider: process.env.TELEPHONY_PROVIDER },
      'voice telephony wiring failed (voice inbound disabled)'
    );
  }
}

// JSON parsing for all other routes
app.use(express.json());

// Sessions (admin dashboard)
app.use(session({
  secret: process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-fallback',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Admin dashboard
const adminRoutes = require('./src/admin/adminRoutes');
app.use('/admin', adminRoutes);

// Static files (for non-admin assets)
app.use(express.static(path.join(__dirname, 'public')));

const db                = require('./src/db/db');

// Health check
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'up', ts: new Date().toISOString() });
  } catch (err) {
    logger.error({ requestId: req.id, err: err.message }, 'health check DB ping failed');
    res.status(503).json({ status: 'error', db: 'down', ts: new Date().toISOString() });
  }
});
const reminderCron      = require('./src/scheduler/reminderCron');
const tenantService     = require('./src/modules/tenant/tenantService');
const coreActions       = require('./core/coreActions');
const crmModule         = require('./src/modules/crm');
const collectionsModule = require('./src/modules/collections');
const workflowEngine    = require('./src/modules/workflow/workflowEngine');
coreActions.init();
crmModule.init();
collectionsModule.init();
workflowEngine.init();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'server started');
});

const reminderTask = reminderCron.start();
const collectionsTask = collectionsModule.cronTask;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown received — draining');

  const forceTimer = setTimeout(() => {
    logger.error('drain timeout — forcing exit');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  server.close(() => {
    logger.info('HTTP server closed');

    if (reminderTask) reminderTask.stop();
    if (collectionsTask) collectionsTask.stop();
    tenantService.stop();
    logger.info('cron tasks stopped + tenant cache timers cleared');

    db.close()
      .then(() => {
        logger.info('DB pool closed');
        process.exit(0);
      })
      .catch((err) => {
        logger.error({ err: err.message }, 'DB pool close error');
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));