'use strict';

// ============================================================
//  Portal API router (PORTAL-P1-S1) — mounted at /portal
//
//  Owner-facing auth surface. Carries its OWN session (cookie `portal.sid`),
//  distinct from the admin `connect.sid` — the two never share a cookie or a
//  store. In server.js this router is mounted BEFORE the global admin session
//  middleware so that middleware never runs for /portal paths (clean isolation).
//
//  Backend only in this session: login / logout / me. No portal pages (S2), no
//  account-creation UI (S3). Tests seed users directly.
// ============================================================

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const db = require('../db/db');
const logger = require('../infra/logging/logger');
const { securityHeaders, createRateLimiter } = require('../admin/security');
const { verifyPassword, requirePortalAuth, hashPassword } = require('./auth');
const validationService = require('../modules/validation/validationService');
const configService = require('../modules/config/configService');
const { LANG_CODES } = require('../modules/config/schema');
const { normalizePhone } = require('../utils/phone');

const router = express.Router();

// Same minimal headers as the admin panel: nosniff, DENY framing, no-referrer.
router.use(securityHeaders);

// ── Portal session — path-scoped to this router ──────────────────────────────
// Distinct cookie name so it can coexist with the admin session. httpOnly +
// sameSite=strict + secure-in-prod + 12h, mirroring the admin hardening. secure
// relies on the app-level `trust proxy` set in server.js (prod only). In-memory
// store: same single-instance tradeoff documented for the admin session.
const isProd = process.env.NODE_ENV === 'production';
router.use(session({
  name: 'portal.sid',
  secret: process.env.PORTAL_SESSION_SECRET
    || process.env.SESSION_SECRET
    || process.env.ADMIN_PASSWORD
    || 'dev-fallback',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProd,
    maxAge: 12 * 60 * 60 * 1000,
  },
}));

// Login brute-force cap, mirroring admin: 5 attempts / 15 min, per-IP, in-memory.
const loginLimiter = createRateLimiter({
  max: 5, windowMs: 15 * 60 * 1000,
  message: 'Too many login attempts. Try again later.',
});

// Decoy hash computed once at module load. When a login names an unknown email we
// still run one scrypt against this decoy so the response time does not reveal
// whether the account exists (no user-enumeration timing oracle). Paired with the
// generic message + constant delay below.
const DECOY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

// ── POST /portal/api/login ───────────────────────────────────────────────────
// email + password. Generic failure (no existence oracle) + ~300ms constant delay
// + session.regenerate on success (fixation defense). Records last_login_at.
router.post('/api/login', loginLimiter, express.json(), async (req, res) => {
  const email = req.body && typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  const password = req.body && req.body.password;

  // Single generic failure path: same body + same ~300ms delay for every reason
  // (unknown email, wrong password, ambiguous match). No enumeration signal.
  const fail = () => setTimeout(() => res.status(401).json({ error: 'Invalid credentials' }), 300);

  if (!email || typeof password !== 'string' || password.length === 0) return fail();

  let user = null;
  try {
    // Login is the ONE tenant-agnostic lookup (email is the key). email is unique
    // only per-tenant, so a cross-tenant collision yields >1 row — we fail closed
    // rather than guess a tenant (INV-1). Only active accounts can authenticate.
    const { rows } = await db.query(
      'SELECT id, password_hash, active FROM users WHERE lower(email) = $1 AND active = true',
      [email]
    );
    if (rows.length === 1) user = rows[0];
  } catch (err) {
    logger.error({ err: err.message }, 'portal login lookup failed');
    return res.status(500).json({ error: 'Login failed' });
  }

  // Always run one scrypt (decoy when the account is unknown) so the two paths
  // cost the same. Result is only trusted when a real user matched.
  const ok = verifyPassword(password, user ? user.password_hash : DECOY_HASH);
  if (!user || !ok) return fail();

  // Fresh session id on privilege change: a pre-login (attacker-planted) cookie
  // cannot be reused as an authenticated one.
  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err: err.message }, 'portal session regenerate failed');
      return res.status(500).json({ error: 'Login failed' });
    }
    req.session.portal = { userId: user.id };
    // Best-effort stamp; never block or fail login on it.
    db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])
      .catch((e) => logger.error({ err: e.message }, 'last_login_at update failed'));
    res.json({ ok: true });
  });
});

// ── POST /portal/api/logout ──────────────────────────────────────────────────
router.post('/api/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('portal.sid');
    res.json({ ok: true });
  });
});

// ── GET /portal/api/me ───────────────────────────────────────────────────────
// The scoping probe. tenant is loaded via req.portalUser.tenantId (set by
// requirePortalAuth from the user row) and NOTHING else — this handler never
// reads req.query / req.body / req.params / a header for a tenant id. A crafted
// ?tenantId=<other> is inert by construction.
router.get('/api/me', requirePortalAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, business_name FROM tenants WHERE id = $1',
      [req.portalUser.tenantId]
    );
    const tenant = rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({
      user: { id: req.portalUser.id, role: req.portalUser.role },
      tenant: { id: tenant.id, name: tenant.business_name },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'portal /me failed');
    res.status(500).json({ error: 'Failed to load account' });
  }
});

// ── GET /portal/api/readiness ────────────────────────────────────────────────
// The Home page's data source (PORTAL-P1-S2). Returns the tenant's lifecycle
// status + its LATEST validation run — read-only, and for the SESSION'S tenant
// ONLY (INV-1): tenantId comes from req.portalUser, never from the request. This
// route NEVER triggers a new validation run (that stays operator/lifecycle-only);
// it reads whatever the last run recorded, or null if none has ever run.
//
// Owner-safe projection: only each check's `name` + `severity` cross the wire —
// not the raw `detail` strings, which carry operator phrasing. The owner sees the
// friendly copy map (spec §5.1) rendered client-side; the operator keeps the full
// catalog + details in the admin panel.
router.get('/api/readiness', requirePortalAuth, async (req, res) => {
  try {
    const snap = await readinessSnapshot(req.portalUser.tenantId);
    if (!snap) return res.status(404).json({ error: 'Tenant not found' });
    res.json(snap);
  } catch (err) {
    logger.error({ err: err.message }, 'portal readiness failed');
    res.status(500).json({ error: 'Failed to load readiness' });
  }
});

// Owner-safe readiness snapshot for ONE tenant (INV-1: caller always passes the
// SESSION's tenantId). Shared by GET /api/readiness and every config-write
// response, so a save can refresh the header/ring without a second round-trip.
// It reads the latest PERSISTED validation run and NEVER triggers a new one —
// validation stays operator/lifecycle-only (§8). A config edit therefore only
// moves the ring after the operator's next validation run; the version bump +
// "Saved" toast are immediate. Same name+severity projection as the GET (no
// operator `detail` crosses the wire). Returns null when the tenant is gone.
async function readinessSnapshot(tenantId) {
  const { rows } = await db.query('SELECT status FROM tenants WHERE id = $1', [tenantId]);
  const tenant = rows[0];
  if (!tenant) return null;

  const latest = await validationService.getLatestValidation(tenantId);
  let run = null;
  if (latest) {
    const result = latest.result || {};
    run = {
      passed: latest.passed,
      created_at: latest.created_at,
      checks: (result.checks || []).map((c) => ({ name: c.name, severity: c.severity })),
      skipped: (result.skipped || []).map((s) => ({ name: s.name })),
    };
  }
  return { status: tenant.status, run };
}

// ── Config section: identity (Clinic profile, PORTAL-P2-S4) ──────────────────
// The FIRST owner-writable config surface; it establishes the pattern every
// later page copies. Spec §5.2 calls this section `identity.*`; the storage home
// is `business.*` (name/address/landmark/website/phone_numbers/timezone) +
// `languages.*` (enabled set). This projection is the owner-safe view of both.
function projectIdentity(config) {
  const b = (config && config.business) || {};
  const l = (config && config.languages) || {};
  return {
    display_name: typeof b.display_name === 'string' ? b.display_name : '',
    address: typeof b.address === 'string' ? b.address : '',
    landmark: typeof b.landmark === 'string' ? b.landmark : '',
    website: typeof b.website === 'string' ? b.website : '',
    phone_numbers: Array.isArray(b.phone_numbers) ? b.phone_numbers : [],
    // Timezone is a v1 constant (Asia/Kolkata) — surfaced for display, never editable.
    timezone: (typeof b.timezone === 'string' && b.timezone) ? b.timezone : 'Asia/Kolkata',
    // Enabled languages as a flat list of codes (the page's toggles). The
    // `default` language is derived server-side, not shown here.
    languages: Array.isArray(l.supported) ? l.supported.slice() : [],
  };
}

// GET the session tenant's clinic-profile section. tenant from req.portalUser
// ONLY (INV-1); a crafted ?tenantId is inert. `version` lets the page show the
// current config version and detect drift (0 = no config written yet).
router.get('/api/config/identity', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const version = config ? (configService.getCachedConfigVersion(tenantId) || 0) : 0;
    res.json({ identity: projectIdentity(config), version });
  } catch (err) {
    logger.error({ err: err.message }, 'portal identity GET failed');
    res.status(500).json({ error: 'Failed to load clinic profile' });
  }
});

// getTenantConfig proxy — kept as a named seam so the read path is obvious and
// testable, and so a future per-section reader can slot in without touching the
// route body.
function getConfigForSession(tenantId) {
  return configService.getTenantConfig(tenantId);
}

// POST a partial clinic-profile update. Zod-validated THROUGH configService
// (INV-2 — no raw SQL here); the revision records the acting owner (INV-4);
// phone fields pass through normalizePhone (INV-6 — invalid rejected, never
// silently rewritten). Returns { section, version, readiness }.
router.post('/api/config/identity', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};

  // Field-level validation with copy that names the fix (spec §4). We validate
  // here (owner-friendly messages) AND let configService re-validate the whole
  // merged document (the real gate) — belt and suspenders.
  const fields = [];
  const business = {};

  const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  if (name.length === 0) fields.push({ field: 'display_name', message: 'Enter your clinic name.' });
  else if (name.length > 120) fields.push({ field: 'display_name', message: 'Clinic name must be 120 characters or fewer.' });
  else business.display_name = name;

  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (address.length > 500) fields.push({ field: 'address', message: 'Address must be 500 characters or fewer.' });
  else business.address = address;

  const landmark = typeof body.landmark === 'string' ? body.landmark.trim() : '';
  if (landmark.length > 200) fields.push({ field: 'landmark', message: 'Landmark must be 200 characters or fewer.' });
  else business.landmark = landmark;

  const website = typeof body.website === 'string' ? body.website.trim() : '';
  if (website && !/^https?:\/\/\S+\.\S+/.test(website)) {
    fields.push({ field: 'website', message: 'Enter a full web address starting with http:// or https:// — e.g. https://myclinic.in' });
  } else if (website.length > 300) {
    fields.push({ field: 'website', message: 'Website must be 300 characters or fewer.' });
  } else business.website = website;

  // INV-6: each phone through normalizePhone. An empty row is an unfilled input,
  // not an error; a non-empty invalid one is rejected with its index so the page
  // can mark the exact row.
  const rawPhones = Array.isArray(body.phone_numbers) ? body.phone_numbers : [];
  const phones = [];
  rawPhones.forEach((raw, i) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return;
    try { phones.push(normalizePhone(s)); }
    catch (_) {
      fields.push({ field: `phone_numbers.${i}`, message: `“${s}” isn’t a valid phone number. Use the full number with country code, e.g. +91 98765 43210.` });
    }
  });
  if (phones.length > 10) fields.push({ field: 'phone_numbers', message: 'Add at most 10 phone numbers.' });
  business.phone_numbers = phones;

  // Languages: ≥1 required, each a supported code (te/hi/en), de-duplicated.
  const rawLangs = Array.isArray(body.languages) ? body.languages : [];
  const supported = [];
  for (const code of rawLangs) {
    if (LANG_CODES.includes(code) && !supported.includes(code)) supported.push(code);
  }
  if (supported.length === 0) {
    fields.push({ field: 'languages', message: 'Turn on at least one language your clinic serves.' });
  }

  if (fields.length) {
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields });
  }

  try {
    // Merge the partial onto the CURRENT full document. writeTenantConfig
    // materialises against clinicDefaults (not the live doc), so sending only the
    // identity section would reset every other section to defaults — read + merge
    // first. getTenantConfig is DB-consistent here (every write invalidates the
    // cache): a configless tenant reads null → first save seeds defaults.
    const current = await getConfigForSession(tenantId);

    // Derive languages.default (no owner-facing picker on this page): keep the
    // existing default if it's still enabled, else the first enabled language.
    // Guarantees the schema invariant `languages.default ∈ supported`.
    const curDefault = current && current.languages && current.languages.default;
    const nextDefault = supported.includes(curDefault) ? curDefault : supported[0];

    const partial = { business, languages: { supported, default: nextDefault } };
    const next = configService.deepMerge(current || {}, partial);

    const { version, config } = await configService.writeTenantConfig(tenantId, next, 'portal', {
      actorUserId: req.portalUser.id, // INV-4: attribute the revision to this owner
    });

    const readiness = await readinessSnapshot(tenantId);
    res.json({ section: projectIdentity(config), version, readiness });
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      // Defensive: fields are pre-validated, so this only fires on a schema rule
      // the form doesn't model. Surface it rather than a blank 500.
      return res.status(422).json({ error: 'Some details couldn’t be saved.', issues: err.issues });
    }
    if (/tenant not found/.test(err.message || '')) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'portal identity POST failed');
    res.status(500).json({ error: 'Failed to save clinic profile' });
  }
});

module.exports = router;
