const express    = require('express');
const path       = require('path');
const logger     = require('../infra/logging/logger');
const db         = require('../db/db');
const { encrypt } = require('../utils/encryption');
const tenantService = require('../modules/tenant/tenantService');
const configService = require('../modules/config/configService');
const { renderSystemPrompt, estimateTokens } = require('../modules/prompts');
const {
  safeEqual,
  securityHeaders,
  requireAdminHeader,
  createRateLimiter,
} = require('./security');
const router     = express.Router();

const ADMIN_PUBLIC = path.join(__dirname, '../../public/admin');

// ── Rate limiters (in-memory, per-IP, single-instance) ───────
// Login is capped hard (brute-force defense); mutating APIs loosely (abuse
// ceiling that won't wedge a busy operator). See security.js for semantics.
const loginLimiter = createRateLimiter({
  max: 5, windowMs: 15 * 60 * 1000,
  message: 'Too many login attempts. Try again later.',
});
const apiLimiter = createRateLimiter({
  max: 60, windowMs: 60 * 1000,
  message: 'Too many requests. Slow down.',
});

// Minimal security headers on every panel page + admin API response.
router.use(securityHeaders);

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
router.post('/login', loginLimiter, express.json(), (req, res) => {
  const supplied = req.body && req.body.password;
  if (safeEqual(supplied, process.env.ADMIN_PASSWORD || '')) {
    // Session fixation defense: issue a fresh session id on privilege change so a
    // pre-login (attacker-planted) cookie can't be reused as an authenticated one.
    return req.session.regenerate((err) => {
      if (err) {
        logger.error({ err: err.message }, 'session regenerate failed');
        return res.status(500).json({ error: 'Login failed' });
      }
      req.session.admin = true;
      res.json({ ok: true });
    });
  }
  // Generic message (no user/enumeration signal) + constant ~300ms delay to blunt
  // timing analysis and slow online brute force. Pairs with loginLimiter above.
  setTimeout(() => res.status(401).json({ error: 'Invalid credentials' }), 300);
});

// Logout stays a GET navigation (the panel nav links to it). Not CSRF-sensitive:
// sameSite=strict means a cross-site navigation carries no session cookie, so a
// forged logout has nothing to destroy.
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// ── API: Tenants ─────────────────────────────────────────────
router.get('/api/tenants', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, business_name, phone_number_id, ai_enabled, active, created_at
     FROM tenants ORDER BY created_at DESC`
  );
  res.json(rows);
});

router.post('/api/tenants', requireAuth, apiLimiter, requireAdminHeader, async (req, res) => {
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
router.patch('/api/tenants/:id/reminders', requireAuth, apiLimiter, requireAdminHeader, async (req, res) => {
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

// ── API: Invalidate caches ──────────────────────────────────
// Evict stale tenant credentials AND tenant config without a redeploy. Body:
// optional `tenant_id` → evict that tenant in both caches; omitted → full flush
// of both. Single-instance (in-process) semantics — see the two services.
//
// Response shape (changed in Issue 8 — now covers both caches):
//   { scope: 'tenant'|'all', evicted: <total>, caches: { tenant, config } }
// `evicted` remains a number (the combined total) for backward compatibility;
// `caches` breaks it out per cache.
router.post('/api/cache/invalidate', requireAuth, apiLimiter, requireAdminHeader, express.json(), (req, res) => {
  // Presence, not truthiness: pass '' through as a scoped no-op rather than
  // collapsing it to a full flush (see each service's invalidate function).
  const tenantId = req.body ? req.body.tenant_id : undefined;
  const tenant = tenantService.invalidateTenantCache(tenantId);
  const config = configService.invalidateConfigCache(tenantId);
  res.json({
    scope: tenantId != null ? 'tenant' : 'all',
    evicted: tenant + config,
    caches: { tenant, config },
  });
});

// ── API: Tenant detail — config editor, revisions, prompt preview (Issue 25) ──
// Thin routes over configService (writer/loader) and the prompt renderer. Status
// stays read-only here — validate/activate controls arrive with Issues 16/17.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guard the :id path param so a malformed UUID renders a clean 404 instead of a
// Postgres 22P02 (invalid_text_representation) 500. A well-formed but absent id
// still 404s naturally from the query below.
function requireTenantId(req, res, next) {
  if (UUID_RE.test(req.params.id)) return next();
  res.status(404).json({ error: 'Tenant not found' });
}

// Full config + header metadata in one round trip. `has_ai_prompt` lets the page
// warn the operator that a legacy ai_prompt override is set (the renderer is
// dormant for that tenant until Issue 9 repoints reads).
router.get('/api/tenants/:id/config', requireAuth, requireTenantId, async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.business_name, t.status, (t.ai_prompt IS NOT NULL) AS has_ai_prompt,
            c.version, c.config, c.updated_at
     FROM tenants t
     LEFT JOIN tenant_configs c ON c.tenant_id = t.id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
  const r = rows[0];
  res.json({
    name: r.business_name,
    status: r.status,
    has_ai_prompt: r.has_ai_prompt,
    has_config: r.config != null,
    version: r.version,
    config: r.config,
    updated_at: r.updated_at,
  });
});

// Versioned write with optimistic concurrency. 422 carries Zod path-level issues;
// 409 carries the live version so the editor can reload-and-rediff.
router.put('/api/tenants/:id/config', requireAuth, apiLimiter, requireAdminHeader, requireTenantId, express.json(), async (req, res) => {
  const { config, expected_version } = req.body || {};
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'config object is required' });
  }
  try {
    const { version } = await configService.writeTenantConfig(
      req.params.id, config, 'admin', { expectedVersion: expected_version });
    res.json({ version });
  } catch (err) {
    if (err.name === 'ConfigValidationError') return res.status(422).json({ issues: err.issues });
    if (err.name === 'ConfigConflictError') return res.status(409).json({ current_version: err.currentVersion });
    if (/tenant not found/.test(err.message)) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'write tenant config error');
    res.status(500).json({ error: 'Failed to write config' });
  }
});

// Seed clinicDefaults for a configless tenant. 409 if a config already exists —
// this is a create, not an overwrite (use PUT to edit).
router.post('/api/tenants/:id/config/defaults', requireAuth, apiLimiter, requireAdminHeader, requireTenantId, async (req, res) => {
  const { rows } = await db.query('SELECT 1 FROM tenant_configs WHERE tenant_id = $1', [req.params.id]);
  if (rows[0]) return res.status(409).json({ error: 'config already exists' });
  try {
    const { version } = await configService.writeTenantConfig(req.params.id, {}, 'admin');
    res.status(201).json({ version });
  } catch (err) {
    if (/tenant not found/.test(err.message)) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'seed defaults error');
    res.status(500).json({ error: 'Failed to seed defaults' });
  }
});

// Revision history (newest first) — metadata only.
router.get('/api/tenants/:id/revisions', requireAuth, requireTenantId, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const { rows } = await db.query(
    `SELECT version, source, created_at
     FROM tenant_config_revisions WHERE tenant_id = $1
     ORDER BY version DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows);
});

// Full config of one historical revision (for View / diff).
router.get('/api/tenants/:id/revisions/:version', requireAuth, requireTenantId, async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version)) return res.status(404).json({ error: 'Revision not found' });
  const { rows } = await db.query(
    'SELECT config FROM tenant_config_revisions WHERE tenant_id = $1 AND version = $2',
    [req.params.id, version]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Revision not found' });
  res.json(rows[0].config);
});

// Restore = append-only: write revision N's config as a NEW version (source
// 'admin'). History never rewinds.
router.post('/api/tenants/:id/revisions/:version/restore', requireAuth, apiLimiter, requireAdminHeader, requireTenantId, async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version)) return res.status(404).json({ error: 'Revision not found' });
  const { rows } = await db.query(
    'SELECT config FROM tenant_config_revisions WHERE tenant_id = $1 AND version = $2',
    [req.params.id, version]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Revision not found' });
  try {
    const { version: newVersion } = await configService.writeTenantConfig(
      req.params.id, rows[0].config, 'admin');
    res.status(201).json({ version: newVersion });
  } catch (err) {
    if (err.name === 'ConfigValidationError') return res.status(422).json({ issues: err.issues });
    if (/tenant not found/.test(err.message)) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'restore revision error');
    res.status(500).json({ error: 'Failed to restore revision' });
  }
});

// Rendered system-prompt preview per channel/language. `lang` (optional) previews
// with languages.default overridden on a COPY — never persisted.
router.get('/api/tenants/:id/prompt-preview', requireAuth, requireTenantId, async (req, res) => {
  const config = await configService.getTenantConfig(req.params.id);
  if (!config) return res.status(404).json({ error: 'no config to preview' });

  const channel = req.query.channel === 'voice' ? 'voice' : 'whatsapp';
  const preview = structuredClone(config);
  if (req.query.lang) {
    preview.languages = preview.languages || {};
    preview.languages.default = req.query.lang; // override on the copy only
  }
  try {
    const prompt = renderSystemPrompt(preview, { channel });
    res.json({ prompt, est_tokens: estimateTokens(prompt) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
