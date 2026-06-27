require('dotenv').config();
require('./src/infra/config/env');

const express = require('express');
const session = require('express-session');
const path    = require('path');

const app = express();

// Webhook needs raw body for signature verification — mount before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }), require('./src/webhook/webhookRoutes'));

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

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const db                = require('./src/db/db');
const reminderCron      = require('./src/scheduler/reminderCron');
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
  console.log(`Server running on port ${PORT}`);
});

const reminderTask = reminderCron.start();
const collectionsTask = collectionsModule.cronTask;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received — draining…`);

  const forceTimer = setTimeout(() => {
    console.error('[Shutdown] Drain timeout — forcing exit');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  server.close(() => {
    console.log('[Shutdown] HTTP server closed');

    if (reminderTask) reminderTask.stop();
    if (collectionsTask) collectionsTask.stop();
    console.log('[Shutdown] Cron tasks stopped');

    db.close()
      .then(() => {
        console.log('[Shutdown] DB pool closed');
        process.exit(0);
      })
      .catch((err) => {
        console.error('[Shutdown] DB pool close error:', err.message);
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));