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

// ── Config section: hours (Hours & holidays, PORTAL-P2-S5) ───────────────────
// The second owner-writable surface; it COPIES the identity pattern above (read
// current → merge partial → configService write with actorUserId → return
// { section, version, readiness }). Storage home is `hours.*`
// (per-day open/close-or-closed grid + holidays[]). Spec §5.3 also lists an
// after-hours message and an emergency contact number; both were DEFERRED for S5
// (no schema home — the after-hours field doesn't exist on `escalation`, and
// escalation numbers live on Safety & handoff / S10). This page ships the grid +
// holidays only, against the schema exactly as it stands.
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;   // 24h HH:MM (mirrors schema.js HHMM)
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;          // YYYY-MM-DD (mirrors schema.js YMD)
// Visible defaults for a day with no stored times (or a closed day's hidden
// inputs) so the grid never renders blank time fields.
const DEFAULT_OPEN = '09:00';
const DEFAULT_CLOSE = '18:00';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A real calendar date (the YMD regex alone would accept 2026-13-45). Kept strict
// here for an owner-friendly 400; the schema only regex-checks the shape.
function isRealDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Owner-safe projection of the hours section. Days become a uniform
// { key, closed, open, close } shape (a closed day still carries visible default
// times for when the owner re-opens it); holidays are normalized to
// { date, name } and sorted ascending by date (client re-sorts on render too).
function projectHours(config) {
  const h = (config && config.hours) || {};
  const days = DAYS.map((key) => {
    const d = h[key];
    if (d && d.closed === true) return { key, closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
    if (d && typeof d.open === 'string' && typeof d.close === 'string') {
      return { key, closed: false, open: d.open, close: d.close };
    }
    return { key, closed: false, open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
  });
  const holidays = Array.isArray(h.holidays)
    ? h.holidays
      .filter((x) => x && typeof x.date === 'string')
      .map((x) => ({ date: x.date, name: typeof x.name === 'string' ? x.name : '' }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    : [];
  return { days, holidays };
}

// GET the session tenant's hours section (INV-1: tenant from req.portalUser only).
router.get('/api/config/hours', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const version = config ? (configService.getCachedConfigVersion(tenantId) || 0) : 0;
    res.json({ hours: projectHours(config), version });
  } catch (err) {
    logger.error({ err: err.message }, 'portal hours GET failed');
    res.status(500).json({ error: 'Failed to load hours' });
  }
});

// POST a full hours update. Same contract as identity: validated here with
// owner-friendly messages AND re-validated by configService (the real gate,
// INV-2); the revision records the acting owner (INV-4). Returns
// { section, version, readiness }.
router.post('/api/config/hours', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};
  const fields = [];

  // Days: build a complete 7-day block; each day is EITHER {closed:true} or
  // {open,close} (the schema's strict discriminated union). close must be after
  // open on an open day.
  const rawDays = isPlainObject(body.days) ? body.days : {};
  const hoursOut = {};
  for (const key of DAYS) {
    const d = isPlainObject(rawDays[key]) ? rawDays[key] : {};
    if (d.closed === true) { hoursOut[key] = { closed: true }; continue; }
    const open = typeof d.open === 'string' ? d.open.trim() : '';
    const close = typeof d.close === 'string' ? d.close.trim() : '';
    if (!HHMM_RE.test(open) || !HHMM_RE.test(close)) {
      fields.push({ field: `days.${key}`, message: `Set opening and closing times for ${DAY_LABEL[key]}, or mark it closed.` });
      continue;
    }
    if (open >= close) {
      fields.push({ field: `days.${key}`, message: `${DAY_LABEL[key]}: closing time must be later than the opening time.` });
      continue;
    }
    hoursOut[key] = { open, close };
  }

  // Holidays: each row needs a real date; the label (schema `name`) is optional
  // (≤120). Duplicate dates are rejected. A wholly empty row is an unfilled input,
  // skipped silently. The row index rides on the error so the page marks the row.
  const rawHols = Array.isArray(body.holidays) ? body.holidays : [];
  const holidaysOut = [];
  const seen = new Set();
  rawHols.forEach((h, i) => {
    const date = h && typeof h.date === 'string' ? h.date.trim() : '';
    const name = h && typeof h.name === 'string' ? h.name.trim() : '';
    if (!date && !name) return; // unfilled row
    if (!YMD_RE.test(date) || !isRealDate(date)) {
      fields.push({ field: `holidays.${i}`, message: 'Pick a valid date for this holiday.' });
      return;
    }
    if (name.length > 120) {
      fields.push({ field: `holidays.${i}`, message: 'Holiday name must be 120 characters or fewer.' });
      return;
    }
    if (seen.has(date)) {
      fields.push({ field: `holidays.${i}`, message: `You’ve already added a holiday on ${date}. Each date can appear only once.` });
      return;
    }
    seen.add(date);
    const entry = { date };
    if (name) entry.name = name; // schema `name` is optional + min(1): omit when blank
    holidaysOut.push(entry);
  });

  if (fields.length) {
    return res.status(400).json({ error: 'Please fix the highlighted items.', fields });
  }

  // Stable stored order, oldest first.
  holidaysOut.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  try {
    // Read-merge (S4 rule): preserve every OTHER section. Unlike identity, hours is
    // REPLACED wholesale (shallow) rather than deep-merged — a day schedule is a
    // discriminated union that must not merge across branches (configService does
    // the same on the clinicDefaults side; both are required to close a day cleanly).
    const current = await getConfigForSession(tenantId);
    const next = { ...(current || {}), hours: { ...hoursOut, holidays: holidaysOut } };

    const { version, config } = await configService.writeTenantConfig(tenantId, next, 'portal', {
      actorUserId: req.portalUser.id, // INV-4
    });

    const readiness = await readinessSnapshot(tenantId);
    res.json({ section: projectHours(config), version, readiness });
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      return res.status(422).json({ error: 'Some hours couldn’t be saved.', issues: err.issues });
    }
    if (/tenant not found/.test(err.message || '')) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'portal hours POST failed');
    res.status(500).json({ error: 'Failed to save hours' });
  }
});

module.exports = router;
