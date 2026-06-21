const express    = require('express');
const path       = require('path');
const db         = require('../db/db');
const { encrypt } = require('../utils/encryption');
const router     = express.Router();

const ADMIN_PUBLIC = path.join(__dirname, '../../public/admin');

// ── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Pages ────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin/tenants.html');
  }
  res.sendFile(path.join(ADMIN_PUBLIC, 'login.html'));
});

// ── Serve admin static files (CSS, JS, HTML pages) ───────────
router.use(express.static(ADMIN_PUBLIC));

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

router.post('/api/tenants', requireAuth, async (req, res) => {
  try {
    const { business_name, phone_number_id, wa_token, waba_id, ai_prompt, ai_enabled } = req.body;
    if (!business_name) return res.status(400).json({ error: 'Business name is required' });

    const encryptedToken = wa_token ? encrypt(wa_token) : null;

    const { rows } = await db.query(
      `INSERT INTO tenants (business_name, phone_number_id, wa_token, waba_id, ai_prompt, ai_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, business_name, created_at`,
      [business_name, phone_number_id || null, encryptedToken, waba_id || null, ai_prompt || null, ai_enabled !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create tenant error:', err.message);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// ── API: Notifications / Reminders log ──────────────────────
router.get('/api/notifications', requireAuth, async (req, res) => {
  const { tenant_id, type, status, limit = 50 } = req.query;
  let sql = `SELECT n.id, n.tenant_id, t.business_name, n.type, n.content, n.sent_status, n.created_at
             FROM notifications n
             JOIN tenants t ON t.id = n.tenant_id
             WHERE 1=1`;
  const params = [];

  if (tenant_id) { params.push(tenant_id); sql += ` AND n.tenant_id = $${params.length}`; }
  if (type) { params.push(type); sql += ` AND n.type = $${params.length}`; }
  if (status) { params.push(status); sql += ` AND n.sent_status = $${params.length}`; }

  params.push(Math.min(Number(limit) || 50, 200));
  sql += ` ORDER BY n.created_at DESC LIMIT $${params.length}`;

  const { rows } = await db.query(sql, params);
  res.json(rows);
});

// ── API: Toggle tenant reminders ────────────────────────────
router.patch('/api/tenants/:id/reminders', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { enabled, hours_before } = req.body;

  const updates = [];
  const params = [id];

  if (typeof enabled === 'boolean') {
    params.push(enabled);
    updates.push(`reminders_enabled = $${params.length}`);
  }
  if (hours_before !== undefined) {
    const h = Math.max(1, Math.min(72, Number(hours_before) || 24));
    params.push(h);
    updates.push(`reminder_hours_before = $${params.length}`);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  const { rows } = await db.query(
    `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1
     RETURNING id, business_name, reminders_enabled, reminder_hours_before`,
    params
  );

  if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
  res.json(rows[0]);
});

// ── API: Get tenant reminder settings ───────────────────────
router.get('/api/tenants/:id/reminders', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, business_name, reminders_enabled, reminder_hours_before, reminder_template_id
     FROM tenants WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
  res.json(rows[0]);
});

module.exports = router;
