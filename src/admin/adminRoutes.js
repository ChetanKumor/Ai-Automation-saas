const express = require('express');
const path    = require('path');
const db      = require('../db/db');
const router  = express.Router();

const ADMIN_PUBLIC = path.join(__dirname, '../../public/admin');

// ── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Serve admin static files (CSS, JS, HTML pages) ───────────
router.use(express.static(ADMIN_PUBLIC));

// ── Pages ────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin/tenants.html');
  }
  res.sendFile(path.join(ADMIN_PUBLIC, 'login.html'));
});

// ── Auth endpoints ───────────────────────────────────────────
router.post('/login', express.json(), (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin');
});

// ── API: Tenants ─────────────────────────────────────────────
router.get('/api/tenants', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, business_name, phone_number_id, ai_enabled, active, created_at
     FROM tenants ORDER BY created_at DESC`
  );
  res.json(rows);
});

module.exports = router;
