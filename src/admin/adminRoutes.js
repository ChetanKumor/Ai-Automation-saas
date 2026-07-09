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

    // Shared insert path (Issue 15). Omitting slug/active/status keeps the DB
    // defaults this route always relied on — behavior is unchanged.
    const tenant = await tenantService.insertTenant(db, {
      business_name,
      phone_number_id: phone_number_id || null,
      wa_token: encryptedToken,
      waba_id: waba_id || null,
      ai_prompt: ai_prompt || null,
      ai_enabled: ai_enabled !== false,
    });
    res.status(201).json(tenant);
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

// Shared UUID guard for path params (used by conversations + tenant detail).
// A malformed id renders a clean 404 instead of a Postgres 22P02 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── API: Conversations — read-only cross-channel thread view (Issue 26) ──────
// Topology (verified against 016/017/018 + the voice bridge in internalVoice.js):
// there is ONE open conversation per (tenant, customer) — the voice worker
// resolves the caller by phone and REUSES their existing open conversation, then
// bridges the call_session to conversation_id. So a single conversation can hold
// both WhatsApp and voice messages; `channel` is a per-MESSAGE fact (messages.channel),
// and call_sessions join cleanly on conversation_id. The UI reflects this: channel
// chips per message, channel(s) aggregated per row, call-session cards inline.
//
// Strictly read-only: GETs only, no send/takeover/status mutation anywhere here.
const CONV_STATUSES = ['open', 'closed', 'pending'];
const MSG_CHANNELS  = ['whatsapp', 'voice'];

// Cursor = "<updated_at ISO>|<uuid>", opaque to the client. Tuple comparison on
// (updated_at, id) gives a stable, gap-free walk even when timestamps tie.
function encodeCursor(row) {
  return Buffer.from(`${row.updated_at.toISOString()}|${row.id}`, 'utf8').toString('base64');
}
function decodeCursor(raw) {
  try {
    const [ts, id] = Buffer.from(String(raw), 'base64').toString('utf8').split('|');
    if (!ts || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts))) return null;
    return { ts, id };
  } catch (_) { return null; }
}

// List: filter bar over tenant/channel/status + cursor pagination on (updated_at, id).
router.get('/api/conversations', requireAuth, async (req, res) => {
  const { tenant_id, channel, status } = req.query;
  if (status && !CONV_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
  if (channel && !MSG_CHANNELS.includes(channel)) return res.status(400).json({ error: 'Invalid channel filter' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const params = [];
  let where = 'WHERE 1=1';

  if (tenant_id) { params.push(tenant_id); where += ` AND c.tenant_id = $${params.length}`; }
  if (status)    { params.push(status);    where += ` AND c.status = $${params.length}`; }
  if (channel) {
    params.push(channel);
    where += ` AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.channel = $${params.length})`;
  }
  if (req.query.before) {
    const cur = decodeCursor(req.query.before);
    if (!cur) return res.status(400).json({ error: 'Invalid cursor' });
    params.push(cur.ts); const tsIdx = params.length;
    params.push(cur.id); const idIdx = params.length;
    where += ` AND (c.updated_at, c.id) < ($${tsIdx}::timestamptz, $${idIdx}::uuid)`;
  }
  params.push(limit + 1); // one extra row tells us whether a next page exists

  try {
    const { rows } = await db.query(
      `SELECT c.id, c.tenant_id, c.status, c.updated_at,
              t.business_name AS tenant_name,
              cust.name AS customer_name, cust.phone AS customer_phone,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT array_agg(DISTINCT m.channel) FROM messages m WHERE m.conversation_id = c.id) AS channels,
              lm.content AS last_content, lm.msg_type AS last_msg_type
       FROM conversations c
       JOIN tenants t   ON t.id = c.tenant_id
       JOIN customers cust ON cust.id = c.customer_id
       LEFT JOIN LATERAL (
         SELECT content, msg_type FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) lm ON true
       ${where}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      rows: page.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name,
        customer_display: r.customer_name || r.customer_phone || '—',
        channels: r.channels || [],
        status: r.status,
        message_count: r.message_count,
        // Never leak a raw media payload into the list — non-text collapses to its type.
        preview: previewOf(r.last_content, r.last_msg_type),
        updated_at: r.updated_at,
      })),
      next_before: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to list conversations');
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// ~80-char preview; media/non-text messages render as a "[type]" placeholder.
function previewOf(content, msgType) {
  if (msgType && msgType !== 'text') return `[${msgType}]`;
  const s = (content || '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

// Detail: meta + ordered messages + linked call_sessions (by conversation_id).
router.get('/api/conversations/:id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  const id = req.params.id;
  try {
    const { rows: metaRows } = await db.query(
      `SELECT c.id, c.tenant_id, c.channel, c.mode, c.status, c.created_at, c.updated_at,
              t.business_name AS tenant_name,
              cust.name AS customer_name, cust.phone AS customer_phone
       FROM conversations c
       JOIN tenants t   ON t.id = c.tenant_id
       JOIN customers cust ON cust.id = c.customer_id
       WHERE c.id = $1`,
      [id]
    );
    if (!metaRows[0]) return res.status(404).json({ error: 'Conversation not found' });
    const meta = metaRows[0];

    // Newest 500 (capped for big-thread query cost), re-ordered ascending for reading.
    const { rows: messages } = await db.query(
      `SELECT id, direction, sender, channel, msg_type, content, created_at, external_id
       FROM (
         SELECT id, direction, sender, channel, msg_type, content, created_at, external_id
         FROM messages WHERE conversation_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 500
       ) sub
       ORDER BY created_at ASC, id ASC`,
      [id]
    );

    const { rows: callSessions } = await db.query(
      `SELECT id, direction, provider, status, language_detected,
              started_at, ended_at, duration_seconds
       FROM call_sessions WHERE conversation_id = $1
       ORDER BY started_at ASC NULLS LAST, created_at ASC`,
      [id]
    );

    res.json({
      id: meta.id,
      tenant_id: meta.tenant_id,
      tenant_name: meta.tenant_name,
      customer_display: meta.customer_name || meta.customer_phone || '—',
      customer_phone: meta.customer_phone,
      channel: meta.channel,
      mode: meta.mode,
      status: meta.status,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      message_count: messages.length,
      messages,
      call_sessions: callSessions,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch conversation');
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// ── API: Tenant detail — config editor, revisions, prompt preview (Issue 25) ──
// Thin routes over configService (writer/loader) and the prompt renderer. Status
// stays read-only here — validate/activate controls arrive with Issues 16/17.
// (UUID_RE is defined above, shared with the conversations routes.)

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
