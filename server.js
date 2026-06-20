require('dotenv').config();
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

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Admin dashboard — double-mount so both /admin and /admin/ work in Express 5
const adminRoutes = require('./src/admin/adminRoutes');
app.use('/admin/', adminRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});