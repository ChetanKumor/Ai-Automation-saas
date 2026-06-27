const express    = require('express');
const path       = require('path');
const logger     = require('../infra/logging/logger');
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
    logger.error({ err: err.message }, 'create tenant error');
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

// ── API: CRM Leads ──────────────────────────────────────────
router.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const { tenant_id, stage, limit = 50 } = req.query;

    const VALID_STAGES = ['new', 'contacted', 'converted', 'lost'];
    if (stage && !VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage filter' });
    }

    let sql = `SELECT l.id, l.tenant_id, t.business_name, l.customer_id,
                      l.name, l.phone, l.requirement, l.budget, l.intent_level,
                      l.stage, l.source, l.notes, l.created_at, l.updated_at,
                      c.phone AS customer_phone, c.name AS customer_name
               FROM leads l
               JOIN tenants t ON t.id = l.tenant_id
               JOIN customers c ON c.id = l.customer_id
               WHERE 1=1`;
    const params = [];

    if (tenant_id) { params.push(tenant_id); sql += ` AND l.tenant_id = $${params.length}`; }
    if (stage)     { params.push(stage);     sql += ` AND l.stage = $${params.length}`; }

    params.push(Math.min(Number(limit) || 50, 200));
    sql += ` ORDER BY l.updated_at DESC LIMIT $${params.length}`;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch leads');
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// ── API: Collections / Payment Schedules ────────────────────
router.get('/api/collections', requireAuth, async (req, res) => {
  try {
    const { tenant_id, status, limit = 50 } = req.query;

    const VALID = ['pending', 'sending', 'sent', 'paid', 'overdue', 'failed', 'needs_template', 'needs_review'];
    if (status && !VALID.includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    let sql = `SELECT ps.id, ps.tenant_id, t.business_name, ps.customer_id,
                      ps.amount, ps.currency, ps.due_date, ps.reminder_send_at,
                      ps.status, ps.attempts, ps.last_attempt_at,
                      ps.created_at, ps.updated_at,
                      c.phone AS customer_phone, c.name AS customer_name
               FROM payment_schedules ps
               JOIN tenants t ON t.id = ps.tenant_id
               JOIN customers c ON c.id = ps.customer_id
               WHERE 1=1`;
    const params = [];

    if (tenant_id) { params.push(tenant_id); sql += ` AND ps.tenant_id = $${params.length}`; }
    if (status)    { params.push(status);    sql += ` AND ps.status = $${params.length}`; }

    params.push(Math.min(Number(limit) || 50, 200));
    sql += ` ORDER BY ps.due_date ASC LIMIT $${params.length}`;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch collections');
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// ── API: Appointments ───────────────────────────────────────
router.get('/api/appointments', requireAuth, async (req, res) => {
  try {
    const { tenant_id, reminder_status, limit = 50 } = req.query;

    const VALID_RS = ['pending', 'sending', 'sent', 'failed', 'needs_template', 'needs_review'];
    if (reminder_status && !VALID_RS.includes(reminder_status)) {
      return res.status(400).json({ error: 'Invalid reminder_status filter' });
    }

    let sql = `SELECT a.id, a.tenant_id, t.business_name, a.customer_id,
                      a.doctor_name, a.appointment_time, a.status,
                      a.reminder_status, a.reminder_attempts, a.reminder_sent_at,
                      a.last_attempt_at, a.created_at,
                      c.phone AS customer_phone, c.name AS customer_name
               FROM appointments a
               JOIN tenants t ON t.id = a.tenant_id
               JOIN customers c ON c.id = a.customer_id
               WHERE 1=1`;
    const params = [];

    if (tenant_id)       { params.push(tenant_id);       sql += ` AND a.tenant_id = $${params.length}`; }
    if (reminder_status) { params.push(reminder_status); sql += ` AND a.reminder_status = $${params.length}`; }

    params.push(Math.min(Number(limit) || 50, 200));
    sql += ` ORDER BY a.appointment_time DESC LIMIT $${params.length}`;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch appointments');
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

// ── API: Workflow Executions ────────────────────────────────
router.get('/api/workflow-executions', requireAuth, async (req, res) => {
  try {
    const { tenant_id, status, limit = 50 } = req.query;

    const VALID = ['running', 'success', 'failed', 'skipped'];
    if (status && !VALID.includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    let sql = `SELECT we.id, we.tenant_id, t.business_name,
                      wr.name AS rule_name, wr.action, we.event_type,
                      we.status, we.error, we.created_at
               FROM workflow_executions we
               JOIN workflow_rules wr ON wr.id = we.rule_id
               JOIN tenants t ON t.id = we.tenant_id
               WHERE 1=1`;
    const params = [];

    if (tenant_id) { params.push(tenant_id); sql += ` AND we.tenant_id = $${params.length}`; }
    if (status)    { params.push(status);    sql += ` AND we.status = $${params.length}`; }

    params.push(Math.min(Number(limit) || 50, 200));
    sql += ` ORDER BY we.created_at DESC LIMIT $${params.length}`;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch workflow executions');
    res.status(500).json({ error: 'Failed to fetch workflow executions' });
  }
});

module.exports = router;
