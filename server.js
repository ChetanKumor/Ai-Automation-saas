require('dotenv').config();

const REQUIRED_ENV = ['DATABASE_URL', 'GEMINI_API_KEY', 'WEBHOOK_VERIFY_TOKEN', 'META_APP_SECRET', 'ENCRYPTION_KEY', 'ADMIN_PASSWORD'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
}

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});