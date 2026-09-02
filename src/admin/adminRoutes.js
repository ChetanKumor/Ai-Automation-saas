const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const logger     = require('../infra/logging/logger');
const db         = require('../db/db');
const { encrypt } = require('../utils/encryption');
const tenantService = require('../modules/tenant/tenantService');
const lifecycleService = require('../modules/tenant/lifecycleService');
const { CHECK_NAMES } = require('../modules/validation/validationService');
const configService = require('../modules/config/configService');
const conversationService = require('../modules/conversation/conversationService');
const tracesQuery = require('../modules/traces/queryService');
const { renderSystemPrompt, estimateTokens } = require('../modules/prompts');
// Reuse the portal's scrypt hashing for operator-created owner accounts (S3) — the
// single hashing path, never duplicated. auth.js lazy-requires db, so pulling it in
// here does not bind a pg Pool as an import side effect.
const { hashPassword } = require('../portal/auth');
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

// Correlation context (Issue 21). Admin is a public (session-authed) edge:
// always a fresh adm_ id, never adopted from the request.
const requestContext = require('../core/requestContext');
router.use(requestContext.middleware({ prefix: 'adm', channel: 'admin' }));

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

    // Issue 34: this route no longer births legacy-prompt tenants. A non-null
    // tenants.ai_prompt makes configForPrompt return before reading the config
    // document at all (aiService.js:466-467), so every field the owner later
    // saves in the portal is silently inert. Removing the form field alone would
    // leave the API surface unchanged and invite a rebuilt UI to reset the trap,
    // so the parameter is refused here too.
    //
    // Refused only when it carries text: a browser holding a cached copy of the
    // old form still posts `ai_prompt: null`, and 400-ing that would break
    // creation for a caller who supplied nothing. Empty is not the hazard.
    //
    // The capability is preserved, not removed — scripts/update-prompt.js remains
    // the deliberate path for setting a legacy prompt.
    if (typeof ai_prompt === 'string' && ai_prompt.trim() !== '') {
      return res.status(400).json({
        error: 'ai_prompt is not accepted here. Tenants are created on the rendered prompt; ' +
               'set a legacy prompt deliberately via scripts/update-prompt.js.',
      });
    }

    const encryptedToken = wa_token ? encrypt(wa_token) : null;

    // Shared insert path (Issue 15). Omitting slug/active/status keeps the DB
    // defaults this route always relied on — behavior is unchanged.
    const tenant = await tenantService.insertTenant(db, {
      business_name,
      phone_number_id: phone_number_id || null,
      wa_token: encryptedToken,
      waba_id: waba_id || null,
      ai_prompt: null,   // born on the renderer (Issue 34), as provisioningService does
      ai_enabled: ai_enabled !== false,
    });
    res.status(201).json(tenant);
  } catch (err) {
    logger.error({ err: err.message }, 'create tenant error');
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

// ── API: Toggle tenant reminders ────────────────────────────
router.patch('/api/tenants/:id/reminders', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, async (req, res) => {
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
router.get('/api/tenants/:id/reminders', requireAuth, requireUuidPathParam, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, business_name, reminders_enabled, reminder_hours_before, reminder_template_id
     FROM tenants WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
  res.json(rows[0]);
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
// Topology (verified against 016/017/018/028 + the voice bridge in internalVoice.js):
// there is ONE open conversation per (tenant, customer) — the voice worker
// resolves the caller by phone and REUSES their existing open conversation, then
// bridges the call_session to conversation_id. So a single conversation can hold
// both WhatsApp and voice messages, and call_sessions join cleanly on
// conversation_id.
//
// Channel is a per-MESSAGE fact (messages.channel, NOT NULL, written explicitly
// at every INSERT site). A thread's participating channels are therefore DERIVED
// from its messages, in two forms that are the plural and singular of one rule:
// array_agg(DISTINCT m.channel) below for a whole page in one round trip, and
// conversationService.getParticipatingChannels for a single thread. The list
// route keeps the set-wise form deliberately — routing a 25-row page through the
// singular function would cost 25 extra round trips to say the same thing.
//
// conversations.origin_channel is NOT that answer and must never be read as it:
// it records only which edge created the row and is never updated (migration 028
// renamed it from `channel` for exactly this reason). Before the rename this
// route returned it as `channel` on the detail response while the list beside it
// derived the truth — the two disagreed about the same thread.
//
// The UI reflects the derived model: channel chips per message, channel(s)
// aggregated per row, call-session cards inline.
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

// List: ONE tenant, narrowed by channel/status + cursor pagination on (updated_at, id).
//
// tenant_id is REQUIRED (ADMIN-S3a). The filter used to be optional over a
// `WHERE 1=1` default, so omitting it listed every tenant's threads to any
// authenticated caller — customer name, phone number and a message preview on
// every row. There is no all-tenants view here any more; the tenant picker at
// GET /api/tenants is the one route that is cross-tenant by design.
router.get('/api/conversations', requireAuth, async (req, res) => {
  const { tenant_id, channel, status } = req.query;
  if (status && !CONV_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
  if (channel && !MSG_CHANNELS.includes(channel)) return res.status(400).json({ error: 'Invalid channel filter' });
  // Deliberately AFTER the two checks above and not before them: a request whose
  // status or channel filter is garbage is malformed in its own right, and
  // answering it with the tenant message would make those two 400s unreachable
  // for exactly the requests that test them.
  if (!UUID_RE.test(tenant_id)) return res.status(400).json({ error: 'tenant_id is required and must be a UUID' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const params = [tenant_id];
  let where = 'WHERE c.tenant_id = $1';

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
//
// `tenant_id` is a REQUIRED query parameter and is the only source of the tenant
// (ADMIN-S3a). It cannot come from the row. Until this change all three reads
// below keyed on the conversation id alone, and the one call that did take a
// tenant — getParticipatingChannels — was handed the tenant read OUT of the row
// it was guarding, so it could never refuse: a request naming any other tenant
// returned the patient's name, phone number and every message body.
//
// A wrong tenant, an absent conversation, a malformed conversation id and a
// missing or malformed tenant_id all answer with the SAME 404. Deny has to be
// indistinguishable from absent, or the shape of the refusal is the answer.
// 404 rather than 400 on the malformed cases is this route's own convention,
// already established for a malformed :id.
router.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  // tenant_id may arrive absent, or repeated (Express yields an array for a
  // repeated key). test() coerces: 'undefined' and 'a,b' are both non-UUIDs.
  const tenantId = req.query.tenant_id;
  if (!UUID_RE.test(id) || !UUID_RE.test(tenantId)) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  try {
    const { rows: metaRows } = await db.query(
      `SELECT c.id, c.tenant_id, c.mode, c.status, c.created_at, c.updated_at,
              t.business_name AS tenant_name,
              cust.name AS customer_name, cust.phone AS customer_phone
       FROM conversations c
       JOIN tenants t   ON t.id = c.tenant_id
       JOIN customers cust ON cust.id = c.customer_id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [id, tenantId]
    );
    if (!metaRows[0]) return res.status(404).json({ error: 'Conversation not found' });
    const meta = metaRows[0];

    // Newest 500 (capped for big-thread query cost), re-ordered ascending for reading.
    const { rows: messages } = await db.query(
      `SELECT id, direction, sender, channel, msg_type, content, created_at, external_id
       FROM (
         SELECT id, direction, sender, channel, msg_type, content, created_at, external_id
         FROM messages WHERE conversation_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 500
       ) sub
       ORDER BY created_at ASC, id ASC`,
      [id, tenantId]
    );

    const { rows: callSessions } = await db.query(
      `SELECT id, direction, provider, status, language_detected,
              started_at, ended_at, duration_seconds
       FROM call_sessions WHERE conversation_id = $1 AND tenant_id = $2
       ORDER BY started_at ASC NULLS LAST, created_at ASC`,
      [id, tenantId]
    );

    // Derived from ALL of this thread's messages, not from the `messages` array
    // above — that one is capped at the newest 500, so a channel that only
    // appears earlier in a long thread would silently drop out of the answer.
    // The tenant is the request's, not meta.tenant_id: a read must not source its
    // own scope from the row it is reading, even where the two are now provably
    // equal. That circularity is what made this call unable to deny.
    const channels = await conversationService.getParticipatingChannels(tenantId, id);

    res.json({
      id: meta.id,
      tenant_id: meta.tenant_id,
      tenant_name: meta.tenant_name,
      customer_display: meta.customer_name || meta.customer_phone || '—',
      customer_phone: meta.customer_phone,
      // Plural, and the same field name the list route uses (`channels: []`), so
      // the two routes cannot drift or be read as answering different questions.
      // Replaces the pre-028 singular `channel`, which returned the raw column
      // and was wrong for every cross-channel thread. origin_channel is
      // deliberately NOT exposed here: no client asks how a thread began, and a
      // singular channel field beside a plural one is a trap waiting for a
      // reader in a hurry.
      channels,
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
// still 404s naturally from each route's own query. Syntax only: it says nothing
// about who owns the tenant, which is why it is not named for tenancy.
//
// Hoisted on purpose — the two reminders routes above this line mount it too
// (ADMIN-S3a). The declaration stays here, beside the routes it was written for.
function requireUuidPathParam(req, res, next) {
  if (UUID_RE.test(req.params.id)) return next();
  res.status(404).json({ error: 'Tenant not found' });
}

// Full config + header metadata in one round trip. `has_ai_prompt` lets the page
// warn the operator that a legacy ai_prompt override is set (the renderer is
// dormant for that tenant until Issue 9 repoints reads).
router.get('/api/tenants/:id/config', requireAuth, requireUuidPathParam, async (req, res) => {
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
router.put('/api/tenants/:id/config', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, express.json(), async (req, res) => {
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
router.post('/api/tenants/:id/config/defaults', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, async (req, res) => {
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
router.get('/api/tenants/:id/revisions', requireAuth, requireUuidPathParam, async (req, res) => {
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
router.get('/api/tenants/:id/revisions/:version', requireAuth, requireUuidPathParam, async (req, res) => {
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
router.post('/api/tenants/:id/revisions/:version/restore', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, async (req, res) => {
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
router.get('/api/tenants/:id/prompt-preview', requireAuth, requireUuidPathParam, async (req, res) => {
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

// ── API: Tenant lifecycle — validate / activate / pause (Issue 17) ───────────
// Thin routes over lifecycleService.transition (the single status+active writer).
// Guard failures are NOT 500s: they are the expected answer to "may I go live?",
// so they return 409 with the structured { code, error } the panel renders
// verbatim. A missing tenant is 404. Only an unexpected throw is a 500.
//
//   code ∈ NOT_VALIDATED | STALE_VALIDATION | VALIDATION_FAILED:<check> | INVALID_TRANSITION
//
// POST /validate carries the full run in the body on BOTH outcomes (200 passed,
// 409 failed) so the panel can render the check table without a second fetch.
function lifecycleError(res, err, what) {
  if (err.name !== 'LifecycleError') {
    logger.error({ err: err.message }, `${what} failed`);
    return res.status(500).json({ error: `Failed to ${what}` });
  }
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Tenant not found' });
  return res.status(409).json({
    code: err.code,
    error: err.message,
    ...(err.from ? { from: err.from } : {}),
    ...(err.run ? { run: err.run } : {}),
    ...(err.validated_at ? { validated_at: err.validated_at } : {}),
    ...(err.config_updated_at ? { config_updated_at: err.config_updated_at } : {}),
  });
}

// Run the full catalog; on pass the tenant moves to `validated`. Optional body
// { skip: ["kb.populated", …] } mirrors the CLI's --skip, including its `kb` /
// `turn` aliases. An unknown name is a 400, never a silent no-op: skipping is how
// an operator declines a check, and a typo that quietly RUNS the live scripted-turn
// check (spending model calls) is exactly the surprise we owe them protection from.
const SKIP_ALIASES = { kb: ['kb.populated', 'kb.retrieval'], turn: ['turn.scripted'] };

function expandSkips(names) {
  const out = [];
  for (const n of names) {
    if (SKIP_ALIASES[n]) out.push(...SKIP_ALIASES[n]);
    else if (CHECK_NAMES.includes(n)) out.push(n);
    else {
      const err = new Error(`unknown skip name '${n}'`);
      err.validNames = [...CHECK_NAMES, ...Object.keys(SKIP_ALIASES)];
      throw err;
    }
  }
  return [...new Set(out)];
}

router.post('/api/tenants/:id/validate', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, express.json(), async (req, res) => {
  const raw = Array.isArray(req.body && req.body.skip) ? req.body.skip : [];
  let skip;
  try {
    skip = expandSkips(raw);
  } catch (err) {
    return res.status(400).json({ error: err.message, valid: err.validNames });
  }
  try {
    const out = await lifecycleService.transition(req.params.id, 'validate', { validate: { skip } });
    res.json(out);
  } catch (err) {
    lifecycleError(res, err, 'validate tenant');
  }
});

router.post('/api/tenants/:id/activate', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, async (req, res) => {
  try {
    res.json(await lifecycleService.transition(req.params.id, 'activate'));
  } catch (err) {
    lifecycleError(res, err, 'activate tenant');
  }
});

router.post('/api/tenants/:id/pause', requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, async (req, res) => {
  try {
    res.json(await lifecycleService.transition(req.params.id, 'pause'));
  } catch (err) {
    lifecycleError(res, err, 'pause tenant');
  }
});

// Validation history (Issue 16) — read-only list of past runs, newest first.
// The panel renders each run's stored `result` (checks/skipped) inline.
router.get('/api/tenants/:id/validation-runs', requireAuth, requireUuidPathParam, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const { rows } = await db.query(
    `SELECT id, passed, result, created_at
     FROM validation_runs WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows);
});

// ── API: Owner portal account (PORTAL-P1-S3) ─────────────────────────────────
// Operator-assisted account creation (spec §3): there is NO self-signup. This
// creates ONE owner account for the tenant with a server-generated temporary
// password that is returned EXACTLY ONCE in the response and is never persisted in
// plaintext nor logged. The owner then signs into /portal with it. Password reset
// in v1 is the operator running this again — but a re-create is REJECTED here while
// an account exists (duplicate email per tenant), so a reset today is a deliberate
// operator action against a removed account, not this route. Hashing reuses the
// portal scrypt path (no duplicated crypto).
//
// This is an ADMIN route (cross-tenant operator surface): the tenant comes from the
// path :id, which is correct here — INV-1 (tenant-from-session-only) is a PORTAL
// invariant, not an admin one.

// Deliberately permissive email shape: one @, a dot in the domain, no whitespace.
// We guard obvious garbage before storing; we are not the arbiter of deliverable
// addresses (there is no email sending in v1).
const OWNER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Temp password: 12 random bytes → base64url (16 chars, ~96 bits of entropy). Long
// enough that guessing is a non-issue, short enough to hand over, and copy-pasted
// via the button in the UI. Only its scrypt hash is stored — this value is shown
// once and then unrecoverable.
function generateTempPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

router.post('/api/tenants/:id/owner',
  requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam, express.json(),
  async (req, res) => {
    const raw = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
    // Store lowercased so it matches portal login, which lowercases the input and
    // looks up on lower(email).
    const email = raw.toLowerCase();
    if (!email || !OWNER_EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    try {
      // Existence, not syntax. requireUuidPathParam has already rejected a malformed
      // id; a well-formed absent one must 404 here rather than reach the INSERT below
      // as an FK-violation 500.
      const t = await db.query('SELECT id FROM tenants WHERE id = $1', [req.params.id]);
      if (!t.rows[0]) return res.status(404).json({ error: 'Tenant not found' });

      // Clear up-front rejection for the common case; the UNIQUE (tenant_id, email)
      // constraint is the race backstop, caught as 23505 below.
      const dup = await db.query(
        'SELECT 1 FROM users WHERE tenant_id = $1 AND lower(email) = $2',
        [req.params.id, email]);
      if (dup.rows[0]) {
        return res.status(409).json({ error: 'An account with this email already exists for this clinic.' });
      }

      const password = generateTempPassword();
      const { rows } = await db.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, active)
         VALUES ($1, $2, $3, 'owner', true) RETURNING id`,
        [req.params.id, email, hashPassword(password)]);

      // Log the creation WITHOUT the password (it is never logged) — ids + email only.
      logger.info({ tenantId: req.params.id, userId: rows[0].id, email }, 'owner portal account created');

      // The temporary password crosses the wire exactly here, once.
      res.status(201).json({ ok: true, email, user_id: rows[0].id, password });
    } catch (err) {
      if (err.code === '23505') { // create/create race lost the unique constraint
        return res.status(409).json({ error: 'An account with this email already exists for this clinic.' });
      }
      logger.error({ err: err.message }, 'create owner account error');
      res.status(500).json({ error: 'Failed to create owner account' });
    }
  });

// ── Owner password reset (F3-R1) ─────────────────────────────────────────────
// public/portal/login.html tells an owner who has forgotten their password to
// message Veprio on WhatsApp and it will be reset for them. These two routes
// are how that promise is kept. Reset is OPERATOR-ASSISTED by design: there is no
// email transport anywhere in the repo, so a self-serve token flow would mean a
// transport, an issue-and-expiry table and a reset route before a single paying
// customer. The operator does it, here, for an owner who has phoned or messaged.
//
// Both routes are tenant-scoped from the PATH parameter only — never from a body.
// The reset takes no body at all.

// Resolve the single owner account for a tenant. Fails CLOSED on ambiguity rather
// than guessing, mirroring portal login's `rows.length === 1` rule: `users` is
// UNIQUE (tenant_id, email), so nothing stops a tenant having two owner rows under
// two addresses, and silently resetting whichever sorted first is how an operator
// hands a working password to the wrong person. Returns a count so the caller can
// say which of "none" and "several" it is.
async function findTenantOwner(tenantId) {
  const { rows } = await db.query(
    `SELECT id, email FROM users
     WHERE tenant_id = $1 AND role = 'owner' AND active = true
     ORDER BY created_at`,
    [tenantId]
  );
  return { count: rows.length, owner: rows.length === 1 ? rows[0] : null };
}

// GET the operator's verification card for ONE tenant. Read-only.
//
// This route is a PREREQUISITE for the reset, not a convenience: before it, the
// owner's email was displayed nowhere in the panel — the create card renders it
// only in its one-time success message — so an operator resetting a password
// could not see which account they were about to reset without opening psql.
// Acting blind on an auth action is itself the defect.
//
// `verify_number` is config.notifications.owner_numbers[0], which B1 established
// is the real owner alert recipient (tenants.owner_notify_phone has no production
// writer and is empty for every real tenant). It is the number the operator should
// match the incoming call or message against, and it is surfaced as a LABELLED
// field because "dig it out of the config JSON editor" is not a verification
// procedure.
//
// Deliberately narrow: NO password_hash, and no user fields beyond the email. The
// counts and flags below are this route's own status, not user data.
router.get('/api/tenants/:id/owner',
  requireAuth, apiLimiter, requireUuidPathParam,
  async (req, res) => {
    try {
      const t = await db.query('SELECT id FROM tenants WHERE id = $1', [req.params.id]);
      if (!t.rows[0]) return res.status(404).json({ error: 'Tenant not found' });

      const { count, owner } = await findTenantOwner(req.params.id);

      // A configless tenant is normal (the config is written at provisioning or
      // by the portal), so a missing number is null, never an error.
      let verifyNumber = null;
      try {
        const config = await configService.getTenantConfig(req.params.id);
        const numbers = config && config.notifications && config.notifications.owner_numbers;
        if (Array.isArray(numbers) && numbers.length > 0) verifyNumber = numbers[0];
      } catch (_) {
        verifyNumber = null;
      }

      res.json({
        owner_count: count,
        email: owner ? owner.email : null,
        verify_number: verifyNumber,
        verify_number_source: 'config.notifications.owner_numbers[0]',
      });
    } catch (err) {
      logger.error({ err: err.message }, 'owner verification lookup error');
      res.status(500).json({ error: 'Failed to load owner account' });
    }
  });

// POST a password reset for a tenant's owner. The operator does NOT choose the
// password — the server generates one, returns it exactly once, and the operator
// reads it to the owner. An operator-typed password is an operator-KNOWN password.
//
// Same middleware chain as every other mutating admin route, including the create
// route directly above. No body is read, so there is no express.json() and no way
// for a caller to influence the target: the tenant comes from the path, and the
// user from that tenant's single owner row.
//
// ⚠️ The UPDATE also moves password_changed_at, and that is the load-bearing half.
// Phase 0 established that rotating password_hash alone leaves every live
// portal.sid authenticated for the rest of its 12h window, because
// requirePortalAuth never re-reads the hash. The owner asking for a reset is
// frequently the owner who suspects compromise, so a reset that leaves the
// intruder signed in is a false assurance delivered at the worst possible moment.
// See migration 027 and src/portal/auth.js:sessionEpochMatches.
router.post('/api/tenants/:id/owner/reset',
  requireAuth, apiLimiter, requireAdminHeader, requireUuidPathParam,
  async (req, res) => {
    try {
      const t = await db.query('SELECT id FROM tenants WHERE id = $1', [req.params.id]);
      if (!t.rows[0]) return res.status(404).json({ error: 'Tenant not found' });

      const { count, owner } = await findTenantOwner(req.params.id);
      if (count === 0) {
        return res.status(404).json({ error: 'This clinic has no owner account yet. Create one instead.' });
      }
      if (!owner) {
        return res.status(409).json({
          error: `This clinic has ${count} active owner accounts. Reset is refused rather than guess which one — resolve the duplicate first.`,
        });
      }

      const password = generateTempPassword();

      // Single guarded UPDATE. tenant_id is in the predicate as well as the id, so
      // the row can only be one this tenant owns even if findTenantOwner were ever
      // widened — the route parameter scopes the write itself, not just the lookup.
      // rowCount reports the outcome, so a row that vanished between the lookup and
      // the write is a clean 404 rather than a silent success.
      const { rowCount } = await db.query(
        `UPDATE users SET password_hash = $1, password_changed_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND role = 'owner' AND active = true`,
        [hashPassword(password), owner.id, req.params.id]
      );
      if (rowCount === 0) {
        return res.status(404).json({ error: 'This clinic has no owner account yet. Create one instead.' });
      }

      // The audit line. Follows the create route's shape above; correlation_id is
      // attached automatically by the pino mixin (Issue 21) from the adm_ context
      // this router installs. actor is 'admin_session' and NOT a person: admin auth
      // is one shared ADMIN_PASSWORD with no operator identity (requireAuth checks
      // a boolean), so naming a human here would be fiction. A named operator needs
      // operator accounts, which do not exist.
      //
      // The password is NOT logged, and neither is the email — the userId
      // identifies the row and carries less PII.
      logger.info(
        { scope: 'owner_auth', tenantId: req.params.id, userId: owner.id, actor: 'admin_session' },
        'owner portal password reset');

      // The new password crosses the wire exactly here, once. It is never stored
      // in plaintext (only its scrypt hash is written above) and never logged.
      res.json({ ok: true, email: owner.email, user_id: owner.id, password });
    } catch (err) {
      logger.error({ err: err.message }, 'reset owner password error');
      res.status(500).json({ error: 'Failed to reset owner password' });
    }
  });

// ── API: Turn traces (Issue 22) — thin read-only queries ─────────────────────
// The queryable twin of the correlation-id log chains. Issue 27's viewer page
// consumes exactly these two endpoints; no UI here.

// List traces for ONE tenant, newest first. tenant_id is required (ADMIN-S3a)
// and conversation_id / correlation_id narrow within it; each filter is
// shape-validated (400 on garbage — a malformed UUID must not 500 as a
// Postgres 22P02, and a malformed correlation id is a caller bug, not an
// empty result).
router.get('/api/traces', requireAuth, async (req, res) => {
  const { conversation_id, correlation_id, tenant_id, limit } = req.query;

  if (conversation_id !== undefined && !UUID_RE.test(conversation_id)) {
    return res.status(400).json({ error: 'conversation_id must be a UUID' });
  }
  if (tenant_id !== undefined && !UUID_RE.test(tenant_id)) {
    return res.status(400).json({ error: 'tenant_id must be a UUID' });
  }
  if (correlation_id !== undefined && !requestContext.isValidCorrelationId(correlation_id)) {
    return res.status(400).json({ error: 'correlation_id must look like <prefix>_<16 hex>' });
  }
  // The three filters used to be interchangeable — any one of them satisfied the
  // check — so a conversation id or a correlation id on its own listed traces
  // for whatever tenant owned them. Required last, after the shape checks above,
  // for the same reason as the conversations list.
  if (!tenant_id) {
    return res.status(400).json({ error: 'tenant_id is required; conversation_id and correlation_id narrow within it' });
  }
  const parsedLimit = limit === undefined ? 50 : Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
  }

  try {
    const rows = await tracesQuery.listTraces({
      conversationId: conversation_id,
      correlationId: correlation_id,
      tenantId: tenant_id,
      limit: parsedLimit,
    });
    res.json(rows);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to list turn traces');
    res.status(500).json({ error: 'Failed to list traces' });
  }
});

// One trace. `tenant_id` is required and shape-checked exactly like every filter
// on the list route above (ADMIN-S3a) — naming no tenant is a malformed request,
// which is a 400. The two cases that must be indistinguishable are a trace on
// ANOTHER tenant and a trace that does not exist, and both are the 404 below.
router.get('/api/traces/:turn_id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.turn_id)) {
    return res.status(400).json({ error: 'turn_id must be a UUID' });
  }
  if (!UUID_RE.test(req.query.tenant_id)) {
    return res.status(400).json({ error: 'tenant_id is required and must be a UUID' });
  }
  try {
    const trace = await tracesQuery.getTrace(req.query.tenant_id, req.params.turn_id);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json(trace);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch turn trace');
    res.status(500).json({ error: 'Failed to fetch trace' });
  }
});

module.exports = router;
