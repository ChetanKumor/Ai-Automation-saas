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
const doctorService = require('../modules/doctor/doctorService');
const faqService = require('../modules/knowledge/faqService');
const testTurnService = require('../modules/ai/testTurnService');
const { clinicDefaults } = require('../modules/config/defaults');
const { LANG_CODES, SARVAM_V3_SPEAKERS, SARVAM_V3_SPEAKER_GENDER } = require('../modules/config/schema');
const { normalizePhone } = require('../utils/phone');
const { protectionsForDisplay } = require('./protections');
const requestContext = require('../core/requestContext');

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

// ── Config section: pricing (Pricing, PORTAL-P2-S6) ──────────────────────────
// The third owner-writable surface, same pattern as identity/hours (read current
// → replace this section → configService write with actorUserId → return
// { section, version, readiness }). Storage home is `pricing.*`.
//
// This page closes an observed product gap: on a live Telugu call a patient asked
// what a visit costs and the receptionist correctly refused to invent a number,
// because no price data existed anywhere. What is saved here renders into the
// prompt's bounded FACTS block (templates/clinic.js) and is quoted verbatim.
//
// Discounts are deliberately absent (spec §9) — a free-text discount field invites
// the receptionist into price negotiation.
const PAYMENT_METHODS = ['upi', 'cash', 'card'];
const INSURANCE_STANCES = ['not_accepted', 'selected_insurers', 'note'];
const MAX_TREATMENTS = 50;
const MAX_FEE = 10000000; // ₹1 crore — mirrors the schema's FEE cap

// Owner-safe projection of the pricing section. Fees stay null when unset (never
// coerced to 0 — "not configured" and "free" are different facts), and every
// treatment gets a uniform shape so the page never has to defend against holes.
function projectPricing(config) {
  const p = (config && config.pricing) || {};
  const ins = (p && p.insurance) || {};
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    consultation_fee: num(p.consultation_fee),
    follow_up_fee: num(p.follow_up_fee),
    emergency_fee: num(p.emergency_fee),
    payment_methods: Array.isArray(p.payment_methods)
      ? p.payment_methods.filter((m) => PAYMENT_METHODS.includes(m))
      : [],
    insurance: {
      stance: INSURANCE_STANCES.includes(ins.stance) ? ins.stance : 'not_accepted',
      note: typeof ins.note === 'string' ? ins.note : '',
    },
    treatments: Array.isArray(p.treatments)
      ? p.treatments
        .filter((t) => t && typeof t.name === 'string' && typeof t.price === 'number')
        .map((t) => ({
          name: t.name,
          price: t.price,
          price_from: t.price_from === true,
          duration_minutes: num(t.duration_minutes),
          notes: typeof t.notes === 'string' ? t.notes : '',
          archived: t.archived === true,
        }))
      : [],
  };
}

// Parse one fee input. The form sends a string ('' = cleared) or a number.
// Returns { ok, value }; value === null means "not configured", which the prompt
// omits entirely rather than quoting. 0 is a legitimate price (free) and is kept.
//
// A string must be PLAIN DIGITS. Number() alone would happily read '1e5' as
// 100000 and ' 12 ' as 12 — an owner who typed either made a mistake, and this
// is the one field where silently storing a number nobody meant is exactly the
// failure we are here to prevent (it would then be quoted to patients as fact).
function parseFee(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else {
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return { ok: false, value: null };
    n = Number(s);
  }
  if (!Number.isInteger(n) || n < 0 || n > MAX_FEE) return { ok: false, value: null };
  return { ok: true, value: n };
}

// GET the session tenant's pricing section (INV-1: tenant from req.portalUser only).
router.get('/api/config/pricing', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const version = config ? (configService.getCachedConfigVersion(tenantId) || 0) : 0;
    res.json({ pricing: projectPricing(config), version });
  } catch (err) {
    logger.error({ err: err.message }, 'portal pricing GET failed');
    res.status(500).json({ error: 'Failed to load pricing' });
  }
});

// POST a full pricing update. Validated here with owner-friendly messages AND
// re-validated by configService (the real gate, INV-2); the revision records the
// acting owner (INV-4). Returns { section, version, readiness }.
router.post('/api/config/pricing', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};
  const fields = [];

  // ── Fees ──
  const FEE_LABEL = {
    consultation_fee: 'consultation fee',
    follow_up_fee: 'follow-up fee',
    emergency_fee: 'emergency visit fee',
  };
  const fees = {};
  for (const key of Object.keys(FEE_LABEL)) {
    const parsed = parseFee(body[key]);
    if (!parsed.ok) {
      fields.push({ field: key, message: `Enter the ${FEE_LABEL[key]} as a whole number of rupees — for example 500. Leave it blank if you don’t charge one.` });
    } else fees[key] = parsed.value;
  }

  // ── Payment methods (a SET — de-duplicated, unknown values rejected) ──
  const rawMethods = Array.isArray(body.payment_methods) ? body.payment_methods : [];
  const methods = [];
  for (const m of rawMethods) {
    if (!PAYMENT_METHODS.includes(m)) {
      fields.push({ field: 'payment_methods', message: 'Choose payment methods from UPI, cash, and card.' });
      break;
    }
    if (!methods.includes(m)) methods.push(m);
  }

  // ── Insurance: a stance that promises detail must carry it ──
  const rawIns = isPlainObject(body.insurance) ? body.insurance : {};
  const stance = INSURANCE_STANCES.includes(rawIns.stance) ? rawIns.stance : 'not_accepted';
  const insNote = typeof rawIns.note === 'string' ? rawIns.note.trim() : '';
  if (rawIns.stance !== undefined && !INSURANCE_STANCES.includes(rawIns.stance)) {
    fields.push({ field: 'insurance.stance', message: 'Choose how your clinic handles insurance.' });
  }
  if (stance !== 'not_accepted' && !insNote) {
    fields.push({
      field: 'insurance.note',
      message: stance === 'selected_insurers'
        ? 'List the insurers you accept, so your receptionist can name them.'
        : 'Write what your receptionist should tell patients about insurance.',
    });
  }
  if (insNote.length > 300) {
    fields.push({ field: 'insurance.note', message: 'Keep the insurance note to 300 characters or fewer.' });
  }

  // ── Treatments ──
  // Validation applies to ARCHIVED rows too: archiving retires a row from the
  // prompt, it does not exempt it from being well-formed. Only the duplicate-name
  // rule is active-only, so a retired name can be reused later.
  const rawTreatments = Array.isArray(body.treatments) ? body.treatments : [];
  const treatments = [];
  const seenName = new Map(); // lowercased active name -> row index
  if (rawTreatments.length > MAX_TREATMENTS) {
    fields.push({ field: 'treatments', message: `You can list up to ${MAX_TREATMENTS} treatments. Archive the ones you no longer offer.` });
  }
  rawTreatments.slice(0, MAX_TREATMENTS).forEach((t, i) => {
    const row = isPlainObject(t) ? t : {};
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const archived = row.archived === true;
    const priceRaw = row.price;
    const isBlank = !name && (priceRaw === '' || priceRaw === null || priceRaw === undefined);
    if (isBlank) return; // an untouched empty row is an unfilled input, not an error

    if (!name) {
      fields.push({ field: `treatments.${i}.name`, message: 'Name this treatment as patients would ask for it.' });
    } else if (name.length > 120) {
      fields.push({ field: `treatments.${i}.name`, message: 'Treatment name must be 120 characters or fewer.' });
    } else if (!archived) {
      const key = name.toLowerCase();
      if (seenName.has(key)) {
        fields.push({ field: `treatments.${i}.name`, message: `You’ve already listed “${name}”. Rename or archive one of them.` });
      } else seenName.set(key, i);
    }

    const price = parseFee(priceRaw);
    if (!price.ok || price.value === null) {
      fields.push({ field: `treatments.${i}.price`, message: 'Enter this treatment’s price as a whole number of rupees — for example 1500.' });
    }

    // Duration is optional; when given it must be plain digits in 1–480 (same
    // strictness as a fee — see parseFee).
    let duration = null;
    if (row.duration_minutes !== '' && row.duration_minutes !== null && row.duration_minutes !== undefined) {
      const parsed = parseFee(row.duration_minutes);
      const d = parsed.value;
      if (!parsed.ok || d === null || d <= 0 || d > 480) {
        fields.push({ field: `treatments.${i}.duration_minutes`, message: 'Enter how many minutes this takes (1–480), or leave it blank.' });
      } else duration = d;
    }

    const notes = typeof row.notes === 'string' ? row.notes.trim() : '';
    if (notes.length > 300) {
      fields.push({ field: `treatments.${i}.notes`, message: 'Keep the note to 300 characters or fewer.' });
    }

    treatments.push({
      name,
      price: price.value === null ? 0 : price.value, // placeholder; a bad price already failed above
      price_from: row.price_from === true,
      duration_minutes: duration,
      notes,
      archived,
    });
  });

  if (fields.length) {
    return res.status(400).json({ error: 'Please fix the highlighted items.', fields });
  }

  try {
    // Read-merge (S4 rule): preserve every OTHER section. The `pricing` branch is
    // REPLACED wholesale — the route always builds a complete section, so replacing
    // is what makes a cleared fee actually clear and a removed treatment actually
    // disappear. (deepMerge already replaces arrays wholesale, but replacing the
    // whole branch means treatments can never be element-merged even if that
    // changed.)
    const current = await getConfigForSession(tenantId);
    const next = {
      ...(current || {}),
      pricing: {
        ...fees,
        payment_methods: methods,
        insurance: { stance, note: stance === 'not_accepted' ? '' : insNote },
        treatments,
      },
    };

    const { version, config } = await configService.writeTenantConfig(tenantId, next, 'portal', {
      actorUserId: req.portalUser.id, // INV-4
    });

    const readiness = await readinessSnapshot(tenantId);
    res.json({ section: projectPricing(config), version, readiness });
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      return res.status(422).json({ error: 'Some prices couldn’t be saved.', issues: err.issues });
    }
    if (/tenant not found/.test(err.message || '')) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'portal pricing POST failed');
    res.status(500).json({ error: 'Failed to save pricing' });
  }
});

// ── Config section: booking rules (Booking rules, PORTAL-P3-S9) ──────────────
// Same shape as identity/hours/pricing (read current → replace this section →
// configService write with actorUserId → { section, version, readiness }).
// Storage home is `booking.*`.
//
// This page was deliberately BLOCKED on F-006. Before that change these knobs
// were validated and stored but enforced NOWHERE, so shipping the page would have
// handed owners four controls that changed nothing. Every control here now moves
// real behaviour: appointmentService.resolveBookingRules reads exactly these four
// paths and applies them on BOTH sides — what check_availability offers and what a
// booking write accepts.
//
// The three policy texts are the exception, and the page says so: they are FACTS
// the receptionist recites (they render into the prompt's bounded policy block),
// not logic. Nothing consults them to decide whether a booking is allowed.
const SLOT_CHOICES = [10, 15, 20, 30];
const ADVANCE_MIN = 1;    // 0 has NO defined enforcement meaning — see below
const ADVANCE_MAX = 365;  // mirrors the schema cap
const BUFFER_MIN = 0;     // 0 is meaningful: no minimum notice
const BUFFER_MAX = 240;   // mirrors the schema cap
const POLICY_MAX = 500;   // mirrors the schema cap
const POLICY_KEYS = ['cancellation_policy', 'reschedule_policy', 'walk_in_policy'];

// Owner-safe projection of the booking section. Every field falls back to the
// clinicDefaults value rather than to a hole, so the page never renders a blank
// control for a rule that is nonetheless being enforced — `resolveBookingRules`
// applies exactly this fallback, so what the form shows is what booking does.
function projectBooking(config) {
  const b = (config && config.booking) || {};
  const d = clinicDefaults.booking;
  const int = (v, fallback) => (Number.isInteger(v) ? v : fallback);
  const out = {
    slot_minutes: int(b.slot_minutes, d.slot_minutes),
    advance_days: int(b.advance_days, d.advance_days),
    buffer_minutes: int(b.buffer_minutes, d.buffer_minutes),
    allow_same_day: typeof b.allow_same_day === 'boolean' ? b.allow_same_day : d.allow_same_day,
  };
  for (const key of POLICY_KEYS) out[key] = typeof b[key] === 'string' ? b[key] : '';
  return out;
}

// Parse a whole-number rule input. The form sends a string or a number; a string
// must be PLAIN DIGITS for the same reason a fee must be (parseFee): Number()
// would read '1e3' as 1000 and ' 7 ' as 7, and a booking window nobody meant is
// silently wrong in exactly the way this page exists to prevent.
function parseWholeNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

// Policy text → one prompt line. Interior whitespace (including the newlines a
// textarea makes it easy to type) collapses to single spaces: the prompt block is
// one line per policy, and a multi-line value would inject lines into a block
// whose boundedness is the point. This is normalisation, not reinterpretation —
// the sentence is unchanged, and the response echoes exactly what was stored, so
// the owner sees the stored form rather than having to trust us.
function normalizePolicy(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

// GET the session tenant's booking rules (INV-1: tenant from req.portalUser only).
router.get('/api/config/booking', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const version = config ? (configService.getCachedConfigVersion(tenantId) || 0) : 0;
    res.json({ booking: projectBooking(config), version });
  } catch (err) {
    logger.error({ err: err.message }, 'portal booking GET failed');
    res.status(500).json({ error: 'Failed to load booking rules' });
  }
});

// POST a full booking-rules update. Validated here with owner-friendly messages
// AND re-validated by configService (the real gate, INV-2); the revision records
// the acting owner (INV-4). Returns { section, version, readiness }.
router.post('/api/config/booking', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};

  try {
    // Read FIRST — needed for the read-merge below, and `slot_minutes` validation
    // depends on the stored value (see the enum rule).
    const current = await getConfigForSession(tenantId);
    const stored = projectBooking(current);
    const fields = [];

    // ── slot_minutes ──
    // The page offers four lengths. A tenant whose stored value is outside that
    // set (settable through the admin JSON editor) is ACCEPTED unchanged, so
    // saving some other field on this page can never silently re-grid a clinic
    // to 30 minutes. Changing it still requires one of the four.
    const slot = parseWholeNumber(body.slot_minutes);
    if (slot === null || (SLOT_CHOICES.indexOf(slot) === -1 && slot !== stored.slot_minutes)) {
      const choices = `${SLOT_CHOICES.slice(0, -1).join(', ')} or ${SLOT_CHOICES[SLOT_CHOICES.length - 1]}`;
      fields.push({
        field: 'slot_minutes',
        message: `Choose an appointment length of ${choices} minutes.`,
      });
    }

    // ── advance_days ──
    // The floor is 1, not 0. 0 is not "booking closed": the schema rejects it and
    // resolveBookingRules' positive-integer guard would fall back to the default
    // 30 with a WARN — the owner would believe they had shut booking down while it
    // quietly ran a month out. An undefined value never reaches storage.
    const advance = parseWholeNumber(body.advance_days);
    if (advance === null || advance < ADVANCE_MIN || advance > ADVANCE_MAX) {
      fields.push({
        field: 'advance_days',
        message: `Enter how many days ahead patients can book — a whole number from ${ADVANCE_MIN} to ${ADVANCE_MAX}. To stop taking bookings entirely, turn the booking tool off instead.`,
      });
    }

    // ── buffer_minutes ── 0 is legitimate ("book right up to the start time").
    const buffer = parseWholeNumber(body.buffer_minutes);
    if (buffer === null || buffer < BUFFER_MIN || buffer > BUFFER_MAX) {
      fields.push({
        field: 'buffer_minutes',
        message: `Enter the minimum notice in minutes — a whole number from ${BUFFER_MIN} to ${BUFFER_MAX}. Use 0 to let patients book right up to the start time.`,
      });
    }

    // ── allow_same_day ── a toggle: anything but a boolean is a broken client.
    if (typeof body.allow_same_day !== 'boolean') {
      fields.push({ field: 'allow_same_day', message: 'Choose whether same-day booking is on or off.' });
    }

    // ── Policy texts ── optional, capped, plain text.
    const policies = {};
    const POLICY_LABEL = {
      cancellation_policy: 'cancellation policy',
      reschedule_policy: 'reschedule policy',
      walk_in_policy: 'walk-in policy',
    };
    for (const key of POLICY_KEYS) {
      const raw = body[key];
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        fields.push({ field: key, message: `Write your ${POLICY_LABEL[key]} as plain text.` });
        continue;
      }
      const text = normalizePolicy(raw);
      // These are read aloud and pasted into a prompt — markup would be recited
      // as characters, so reject tags rather than stripping them silently.
      if (/<[^>]*>/.test(text)) {
        fields.push({ field: key, message: `Write your ${POLICY_LABEL[key]} as a plain sentence — no HTML tags.` });
        continue;
      }
      if (text.length > POLICY_MAX) {
        fields.push({ field: key, message: `Keep your ${POLICY_LABEL[key]} to ${POLICY_MAX} characters or fewer.` });
        continue;
      }
      policies[key] = text;
    }

    if (fields.length) {
      return res.status(400).json({ error: 'Please fix the highlighted items.', fields });
    }

    // Read-merge (S4 rule): preserve every OTHER section. The `booking` branch is
    // REPLACED wholesale — the route always builds a complete section, so a
    // cleared policy actually clears (a key-additive merge would leave the old
    // sentence in the prompt after the owner deleted it).
    const next = {
      ...(current || {}),
      booking: {
        slot_minutes: slot,
        advance_days: advance,
        buffer_minutes: buffer,
        allow_same_day: body.allow_same_day,
        ...policies,
      },
    };

    const { version, config } = await configService.writeTenantConfig(tenantId, next, 'portal', {
      actorUserId: req.portalUser.id, // INV-4
    });

    const readiness = await readinessSnapshot(tenantId);
    res.json({ section: projectBooking(config), version, readiness });
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      return res.status(422).json({ error: 'Those booking rules couldn’t be saved.', issues: err.issues });
    }
    if (/tenant not found/.test(err.message || '')) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'portal booking POST failed');
    res.status(500).json({ error: 'Failed to save booking rules' });
  }
});

// ── Config section: safety & handoff (PORTAL-P3-S10) ─────────────────────────
// Same shape as the sections above (read current → replace this section →
// configService write with actorUserId → { section, version, readiness }).
// Storage home is `escalation.*`; there is no `handoff.*` section because
// nothing honest goes in one.
//
// WHAT THIS PAGE MAY CLAIM — verified against the code, not the spec:
//   • `escalation.enabled` is REAL behaviour: it renders "If the customer asks
//     for a human, is upset, or you cannot help, offer a callback from clinic
//     staff" into the prompt. The page's copy is that sentence, in the owner's
//     words.
//   • `escalation.phone_numbers` has exactly ONE consumer — the numbers.e164
//     go-live check. NOTHING dials or messages them; handoff is owner-initiated
//     through the WhatsApp TAKEOVER command. The page says so plainly. Promising
//     an automatic call here would be the F-006 defect class (a control that
//     misrepresents behaviour), which §5.6 already cost us one blocked page.
//   • The emergency fields render as a bounded prompt block ALONGSIDE the
//     hardcoded medical guardrail, never in place of it (INV-3).
//
// DEFERRED, deliberately, and reported rather than faked: automatic handoff
// triggers (nothing detects "asks for a human", no turn counter exists, and no
// code switches conversation mode), and the after-hours message (the per-turn
// prompt carries the date but no clock time, so the receptionist cannot know it
// is after hours).
const ESC_PHONE_MAX = 10;
const EMERGENCY_TEXT_MAX = 400; // mirrors the schema cap

// Parse ONE phone number for this page. normalizePhone (F-003, hardened by
// F-003b) rejects a number missing its country code rather than silently
// reinterpreting it as a real, different number — INV-6. That rejection is
// enforced in the helper now, so this page needs no separate guard; it matters
// most here because this page's emergency number is READ ALOUD to someone in
// trouble, and its staff list is the go-live check's evidence.
function parseOwnerPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  try { return { value: normalizePhone(s) }; }
  catch (_) {
    return { error: `“${s}” isn’t a valid phone number. Use the full number with country code, e.g. +91 98765 43210.` };
  }
}

// Owner-safe projection of the safety section.
function projectSafety(config) {
  const e = (config && config.escalation) || {};
  const d = clinicDefaults.escalation;
  return {
    enabled: typeof e.enabled === 'boolean' ? e.enabled : d.enabled,
    phone_numbers: Array.isArray(e.phone_numbers) ? e.phone_numbers.slice() : [],
    emergency_guidance: typeof e.emergency_guidance === 'string' ? e.emergency_guidance : '',
    emergency_number: typeof e.emergency_number === 'string' ? e.emergency_number : null,
  };
}

// GET the session tenant's safety settings (INV-1: tenant from req.portalUser only).
router.get('/api/config/safety', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const version = config ? (configService.getCachedConfigVersion(tenantId) || 0) : 0;
    res.json({ safety: projectSafety(config), version });
  } catch (err) {
    logger.error({ err: err.message }, 'portal safety GET failed');
    res.status(500).json({ error: 'Failed to load safety settings' });
  }
});

// GET the built-in protections panel (PORTAL-P3-S10). Platform invariants, not
// config: no tenant data in, none out, and nothing here is writable (INV-3).
// Served from the same catalog the protections test asserts against, so the page
// can never display a claim the suite has not proven renders in the prompt.
router.get('/api/protections', requirePortalAuth, (req, res) => {
  res.json({ protections: protectionsForDisplay() });
});

// POST a full safety update. Validated here with owner-friendly messages AND
// re-validated by configService (the real gate, INV-2); phones go through
// normalizePhone (INV-6 — rejected, never silently rewritten); the revision
// records the acting owner (INV-4). Returns { section, version, readiness }.
router.post('/api/config/safety', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};
  const fields = [];

  // ── enabled ── a toggle: anything but a boolean is a broken client.
  if (typeof body.enabled !== 'boolean') {
    fields.push({ field: 'enabled', message: 'Choose whether your receptionist offers a staff callback.' });
  }

  // ── escalation numbers ── INV-6, one message per bad row so the page can mark
  // it. An empty row is an unfilled input, not an error.
  const rawPhones = Array.isArray(body.phone_numbers) ? body.phone_numbers : [];
  const phones = [];
  rawPhones.forEach((raw, i) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return;
    const parsed = parseOwnerPhone(s);
    if (parsed.error) fields.push({ field: `phone_numbers.${i}`, message: parsed.error });
    else phones.push(parsed.value);
  });
  if (phones.length > ESC_PHONE_MAX) {
    fields.push({ field: 'phone_numbers', message: `Add at most ${ESC_PHONE_MAX} staff numbers.` });
  }

  // ── emergency guidance ── optional, capped, plain text. Collapsed to one line
  // for the same reason the booking policies are: it renders as a single line in
  // a bounded block whose boundedness is the point (see normalizePolicy).
  let guidance = '';
  if (body.emergency_guidance !== undefined && body.emergency_guidance !== null
      && typeof body.emergency_guidance !== 'string') {
    fields.push({ field: 'emergency_guidance', message: 'Write your emergency guidance as plain text.' });
  } else {
    guidance = normalizePolicy(body.emergency_guidance);
    if (/<[^>]*>/.test(guidance)) {
      fields.push({ field: 'emergency_guidance', message: 'Write your emergency guidance as a plain sentence — no HTML tags.' });
    } else if (guidance.length > EMERGENCY_TEXT_MAX) {
      fields.push({ field: 'emergency_guidance', message: `Keep your emergency guidance to ${EMERGENCY_TEXT_MAX} characters or fewer.` });
    }
  }

  // ── emergency number ── optional (INV-6). This one is READ ALOUD to a patient,
  // so a typo is worse here than anywhere else on the page: reject it.
  let emergencyNumber = null;
  const rawEmergency = typeof body.emergency_number === 'string' ? body.emergency_number.trim() : '';
  if (rawEmergency) {
    const parsed = parseOwnerPhone(rawEmergency);
    if (parsed.error) fields.push({ field: 'emergency_number', message: parsed.error });
    else emergencyNumber = parsed.value;
  }

  if (fields.length) {
    return res.status(400).json({ error: 'Please fix the highlighted items.', fields });
  }

  try {
    // Read-merge (S4 rule): preserve every OTHER section. The `escalation` branch
    // is REPLACED wholesale — the route always builds a complete section, so a
    // cleared guidance sentence or a removed number actually goes away (a
    // key-additive merge would leave it in the prompt after the owner deleted it).
    const current = await getConfigForSession(tenantId);
    const next = {
      ...(current || {}),
      escalation: {
        enabled: body.enabled,
        phone_numbers: phones,
        emergency_guidance: guidance,
        emergency_number: emergencyNumber,
      },
    };

    const { version, config } = await configService.writeTenantConfig(tenantId, next, 'portal', {
      actorUserId: req.portalUser.id, // INV-4
    });

    const readiness = await readinessSnapshot(tenantId);
    res.json({ section: projectSafety(config), version, readiness });
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      return res.status(422).json({ error: 'Those safety settings couldn’t be saved.', issues: err.issues });
    }
    if (/tenant not found/.test(err.message || '')) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'portal safety POST failed');
    res.status(500).json({ error: 'Failed to save safety settings' });
  }
});

// ── Receptionist (PORTAL-P5-S13) ─────────────────────────────────────────────
// Persona + voice: how the receptionist sounds and speaks. Storage home is
// `personality.*` (spec's `persona.*` was never a real schema section — greeting
// lives at the top-level `greeting` record, and self-intro name/response length
// join `personality` alongside the pre-existing `style`/`custom_instructions`)
// plus `voice.sarvam_speaker`/`voice.pace`.
//
// FIRST page with PARTIAL section ownership: `personality.custom_instructions`
// (admin-only, no UI here) and `voice.enabled`/`did`/`provider`/`sarvam_voice_id`
// (owned by provisioning/ops, no UI here) must survive a save untouched — unlike
// every prior config page, a plain `{ ...current, personality: {...} }` would
// silently wipe them. Both sub-objects are spread from `current` FIRST, then only
// the fields this page owns are overridden.
//
// Tone: the portal's 2-way "Professional / Warm" control is NOT a new field —
// it maps onto 2 of `style`'s existing 4 values (formal / warm_professional).
// See schema.js's personalitySchema comment for the full reasoning.
//
// KNOWN GAP (verified 2026-07-21, reported in the session's closing notes):
// voice_speaker and pace are saved to config but NOT read by the voice worker
// today (voice-agent/agent.py sources Sarvam's model/speaker/pace from
// process-wide env vars). The page visibly flags this — see the UI's gap notice.

const RECEPTIONIST_LANG_LABEL = { te: 'Telugu', hi: 'Hindi', en: 'English' };

// The Voice speaker options this tenant can pick from — the REAL bulbul:v3
// speaker list (schema.js's SARVAM_V3_SPEAKERS, sourced from the vendored
// LiveKit Sarvam plugin), each tagged with its known gender. Computed once;
// per-language support isn't knowable from the plugin, so no claim is made.
const SPEAKER_OPTIONS = SARVAM_V3_SPEAKERS.map((value) => ({
  value,
  gender: SARVAM_V3_SPEAKER_GENDER.female.includes(value) ? 'female'
    : SARVAM_V3_SPEAKER_GENDER.male.includes(value) ? 'male' : null,
}));

// Owner-safe projection. `tone` collapses whichever of the 4 raw `style` values
// is stored into the portal's 2-way control: only 'formal' reads as
// "professional" — everything else (including the 2 legacy values the portal
// never writes) reads as "warm", the same safe default the form already ships.
function projectReceptionist(config) {
  const p = (config && config.personality) || {};
  const v = (config && config.voice) || {};
  const langs = enabledLanguages(config);
  const defaultLang = (config && config.languages && config.languages.default) || langs[0];
  const g = (config && config.greeting) || {};
  const greeting = {};
  for (const lang of langs) greeting[lang] = typeof g[lang] === 'string' ? g[lang] : '';
  return {
    display_name: typeof p.display_name === 'string' ? p.display_name : '',
    languages: langs,
    default_language: defaultLang,
    greeting,
    tone: p.style === 'formal' ? 'professional' : 'warm',
    response_length: p.response_length === 'concise' ? 'concise' : 'standard',
    voice_speaker: typeof v.sarvam_speaker === 'string' ? v.sarvam_speaker : '',
    pace: typeof v.pace === 'number' ? v.pace : 1.0,
  };
}

router.get('/api/config/receptionist', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const version = config ? (configService.getCachedConfigVersion(tenantId) || 0) : 0;
    res.json({ receptionist: projectReceptionist(config), speakers: SPEAKER_OPTIONS, version });
  } catch (err) {
    logger.error({ err: err.message }, 'portal receptionist GET failed');
    res.status(500).json({ error: 'Failed to load receptionist settings' });
  }
});

router.post('/api/config/receptionist', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};

  let current;
  try {
    current = await getConfigForSession(tenantId);
  } catch (err) {
    logger.error({ err: err.message }, 'portal receptionist POST failed (read)');
    return res.status(500).json({ error: 'Failed to save receptionist settings' });
  }

  const langs = enabledLanguages(current);
  const defaultLang = (current && current.languages && current.languages.default) || langs[0];
  const fields = [];

  // ── display name ── optional, plain text — reaches the prompt verbatim.
  let displayName = '';
  if (body.display_name !== undefined && body.display_name !== null && typeof body.display_name !== 'string') {
    fields.push({ field: 'display_name', message: 'Enter your receptionist’s name as plain text.' });
  } else {
    displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (/<[^>]*>/.test(displayName)) {
      fields.push({ field: 'display_name', message: 'Write the name as plain text — no HTML tags.' });
    } else if (displayName.length > 80) {
      fields.push({ field: 'display_name', message: 'Keep the name to 80 characters or fewer.' });
    }
  }

  // ── greeting ── one line per language this clinic actually serves (never
  // trusted from the request — `langs` comes from the tenant's own config).
  // Required for the default language; an owner who leaves another enabled
  // language blank gets it copied from the default's line, because the schema
  // requires every supported language to carry a non-empty string (the same
  // rule recording_consent.line lives under) — there is no "inherit at render
  // time" for an EMPTY entry, only for a MISSING key on a stale document.
  const rawGreeting = (body.greeting && typeof body.greeting === 'object' && !Array.isArray(body.greeting)) ? body.greeting : {};
  const greetingOut = {};
  const greetLine = (lang, required) => {
    const raw = typeof rawGreeting[lang] === 'string' ? rawGreeting[lang].trim() : '';
    if (!raw) {
      if (required) fields.push({ field: `greeting.${lang}`, message: `Add a greeting for ${RECEPTIONIST_LANG_LABEL[lang] || lang} — it’s your default language.` });
      return null;
    }
    if (/<[^>]*>/.test(raw)) {
      fields.push({ field: `greeting.${lang}`, message: 'Write your greeting as plain text — no HTML tags.' });
      return null;
    }
    if (raw.length > 300) {
      fields.push({ field: `greeting.${lang}`, message: 'Keep the greeting to 300 characters or fewer.' });
      return null;
    }
    return raw;
  };
  greetingOut[defaultLang] = greetLine(defaultLang, true);
  for (const lang of langs) {
    if (lang === defaultLang) continue;
    const line = greetLine(lang, false);
    greetingOut[lang] = line; // null placeholder resolved below once the default is known good
  }
  // Resolve blanks to the default's line only once we know the default itself
  // passed validation (otherwise there is nothing safe to copy).
  if (fields.length === 0) {
    for (const lang of langs) {
      if (greetingOut[lang] === null) greetingOut[lang] = greetingOut[defaultLang];
    }
  }

  // ── tone ── maps onto 2 of `style`'s 4 real values (schema.js comment).
  let style = 'warm_professional';
  if (body.tone !== 'professional' && body.tone !== 'warm') {
    fields.push({ field: 'tone', message: 'Choose Professional or Warm.' });
  } else {
    style = body.tone === 'professional' ? 'formal' : 'warm_professional';
  }

  // ── response length ──
  let responseLength = 'standard';
  if (body.response_length !== 'concise' && body.response_length !== 'standard') {
    fields.push({ field: 'response_length', message: 'Choose Concise or Standard.' });
  } else {
    responseLength = body.response_length;
  }

  // ── voice speaker ── must be one of the REAL bulbul:v3 speakers (not the
  // schema's broader backward-compat union — the portal never offers a legacy
  // bulbul:v2 name as a choice).
  let voiceSpeaker = '';
  if (typeof body.voice_speaker !== 'string' || !SARVAM_V3_SPEAKERS.includes(body.voice_speaker)) {
    fields.push({ field: 'voice_speaker', message: 'Choose a voice from the list.' });
  } else {
    voiceSpeaker = body.voice_speaker;
  }

  // ── pace ──
  let pace = 1.0;
  const rawPace = body.pace;
  if (typeof rawPace !== 'number' || !Number.isFinite(rawPace) || rawPace < 0.8 || rawPace > 1.2) {
    fields.push({ field: 'pace', message: 'Speaking pace must be between 0.8 and 1.2.' });
  } else {
    pace = rawPace;
  }

  if (fields.length) {
    return res.status(400).json({ error: 'Please fix the highlighted items.', fields });
  }

  try {
    // Partial-section merge (this page's defining wrinkle — see the header
    // comment): spread the CURRENT personality/voice objects first, so
    // custom_instructions and enabled/did/provider/sarvam_voice_id survive
    // untouched, then override only the fields this page owns. `greeting` is a
    // full replace (a disabled language's stray key must actually disappear).
    const next = {
      ...(current || {}),
      greeting: greetingOut,
      personality: {
        ...((current && current.personality) || {}),
        display_name: displayName,
        style,
        response_length: responseLength,
      },
      voice: {
        ...((current && current.voice) || {}),
        sarvam_speaker: voiceSpeaker,
        pace,
      },
    };

    const { version, config } = await configService.writeTenantConfig(tenantId, next, 'portal', {
      actorUserId: req.portalUser.id, // INV-4
    });

    const readiness = await readinessSnapshot(tenantId);
    res.json({ section: projectReceptionist(config), version, readiness });
  } catch (err) {
    if (err.name === 'ConfigValidationError') {
      return res.status(422).json({ error: 'Those receptionist settings couldn’t be saved.', issues: err.issues });
    }
    if (/tenant not found/.test(err.message || '')) return res.status(404).json({ error: 'Tenant not found' });
    logger.error({ err: err.message }, 'portal receptionist POST failed');
    res.status(500).json({ error: 'Failed to save receptionist settings' });
  }
});

// ── Doctors (PORTAL-P3-S8) ───────────────────────────────────────────────────
// The first portal page whose data is NOT a tenant_configs section. Doctor
// schedules live in `tenant_entities` (type 'schedule') — the storage
// appointmentService reads on every availability check and every booking — so
// this surface edits live booking behavior, not a document. See doctorService for
// the full mapping and why archiving (not an `active` flag) is the deactivation
// primitive.
//
// Shape differences from the config pages, all forced by that storage:
//   • per-doctor CRUD instead of one whole-section POST (each doctor is a row),
//   • no `version` — there is no config document to version. The revision trail
//     that INV-4 rides on doesn't exist on tenant_entities either, so the acting
//     user is logged per write (doctorService) rather than stored on the row; no
//     DDL was added for it this session.
// `readiness` still rides on every write response, exactly like the config pages.

const DOCTOR_DAY_LABEL = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};
// getUTCDay() indexing, matching appointmentService's DAY_KEYS/DAY_NAMES pair —
// this is how a doctor's 'Mon' finds config.hours.mon.
const DOCTOR_DAY_KEY = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
};

// The clinic's opening window for one day key, or null when shut. Mirrors
// appointmentService.dayWindow (same union rules, same clinicDefaults fallback for
// an unusable entry) so the warnings below describe the intersection booking will
// ACTUALLY compute — a warning derived from different rules would be a lie.
function clinicWindow(hours, dayKey) {
  const entry = hours && hours[dayKey];
  const usable = (v) => v && typeof v === 'object' && (
    v.closed === true ||
    (typeof v.open === 'string' && typeof v.close === 'string' && v.open < v.close)
  );
  const day = usable(entry) ? entry : clinicDefaults.hours[dayKey];
  return day.closed === true ? null : { open: day.open, close: day.close };
}

// Quiet, non-blocking warnings for a doctor whose hours reach outside the clinic's
// (spec: allowed, surfaced, never silently clipped and never hard-blocked —
// checkAvailability offers the INTERSECTION, so those minutes are simply never
// offered). Archived and dayless doctors produce none: they aren't offered at all,
// so an hours warning would be noise.
function doctorWarnings(doctor, config) {
  if (doctor.archived || !doctor.days.length) return [];
  const hours = (config && config.hours) || clinicDefaults.hours;
  const closedDays = [];
  const clippedDays = [];

  for (const day of doctor.days) {
    const win = clinicWindow(hours, DOCTOR_DAY_KEY[day]);
    if (!win) { closedDays.push(DOCTOR_DAY_LABEL[day]); continue; }
    if (doctor.start < win.open || doctor.end > win.close) {
      clippedDays.push(`${DOCTOR_DAY_LABEL[day]} (${win.open}–${win.close})`);
    }
  }

  const out = [];
  if (closedDays.length) {
    out.push(`Your clinic is closed on ${closedDays.join(', ')} — patients won’t be offered these times.`);
  }
  if (clippedDays.length) {
    out.push(`Outside your clinic hours on ${clippedDays.join(', ')} — patients are only offered the overlapping times.`);
  }
  return out;
}

// Owner-facing projection: the stored doctor plus two DERIVED facts the page
// needs — whether they can be booked at all, and how their hours sit against the
// clinic's. Derived on read (not stored), so editing clinic hours on another page
// updates these the next time this one loads.
function projectDoctor(doctor, config) {
  return {
    ...doctor,
    bookable: !doctor.archived && doctor.days.length > 0,
    warnings: doctorWarnings(doctor, config),
  };
}

// The tenant's enabled languages — the set the doctor language toggles offer.
function enabledLanguages(config) {
  const l = (config && config.languages && config.languages.supported) || [];
  const out = l.filter((c) => LANG_CODES.includes(c));
  return out.length ? out : LANG_CODES.slice();
}

// Everything the page needs in one read: the doctors, plus the language set and
// the clinic hours summary the form renders against.
async function doctorsPayload(tenantId) {
  const config = await getConfigForSession(tenantId);
  const doctors = (await doctorService.listDoctors(tenantId))
    .map((d) => projectDoctor(d, config));
  return { doctors, languages: enabledLanguages(config) };
}

// Owner-friendly field validation, mirroring the config pages: we validate here
// with copy that names the fix, AND doctorService re-validates structurally (the
// gate that holds regardless of caller). Returns { fields, input }.
function validateDoctorBody(body, langs) {
  const fields = [];

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) fields.push({ field: 'name', message: 'Enter the doctor’s name as patients would ask for it.' });
  else if (name.length > 120) fields.push({ field: 'name', message: 'Doctor name must be 120 characters or fewer.' });

  const specialization = typeof body.specialization === 'string' ? body.specialization.trim() : '';
  if (specialization.length > 120) {
    fields.push({ field: 'specialization', message: 'Specialization must be 120 characters or fewer.' });
  }

  const rawDays = Array.isArray(body.days) ? body.days : [];
  const days = [];
  for (const d of rawDays) {
    if (!DOCTOR_DAY_LABEL[d]) {
      fields.push({ field: 'days', message: 'Pick the days this doctor works from Monday to Sunday.' });
      break;
    }
    if (!days.includes(d)) days.push(d);
  }

  const start = typeof body.start === 'string' ? body.start.trim() : '';
  const end = typeof body.end === 'string' ? body.end.trim() : '';
  if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
    fields.push({ field: 'hours', message: 'Set the hours this doctor sees patients, for example 10:00 to 17:00.' });
  } else if (start >= end) {
    fields.push({ field: 'hours', message: 'The finishing time must be later than the starting time.' });
  }

  const languages = (Array.isArray(body.languages) ? body.languages : []).filter((l) => langs.includes(l));

  return { fields, input: { name, specialization, days, start, end, languages } };
}

// Map a doctorService structural failure onto the page's field names. This only
// fires for rules the form doesn't model (chiefly the duplicate-name check, which
// needs the database) — never for shape errors the block above already caught.
function doctorIssueFields(err) {
  return err.issues.map((i) => ({
    field: i.path === 'start' || i.path === 'end' ? 'hours' : i.path,
    message: i.path === 'name' && /already exists/.test(i.message)
      ? 'You already have a doctor with this name. Use their full name, or archive the other one.'
      : i.message,
  }));
}

// GET the session tenant's doctors (INV-1: tenant from req.portalUser only; a
// crafted ?tenantId is inert by construction).
router.get('/api/doctors', requirePortalAuth, async (req, res) => {
  try {
    res.json(await doctorsPayload(req.portalUser.tenantId));
  } catch (err) {
    logger.error({ err: err.message }, 'portal doctors GET failed');
    res.status(500).json({ error: 'Failed to load doctors' });
  }
});

// POST a new doctor. Returns { doctor, doctors, readiness } — the full list rides
// along so the page never needs a second round-trip to stay correct.
router.post('/api/doctors', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const langs = enabledLanguages(config);
    const { fields, input } = validateDoctorBody(req.body || {}, langs);
    if (fields.length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields });

    const doctor = await doctorService.createDoctor(tenantId, input, {
      languages: langs,
      actorUserId: req.portalUser.id, // INV-4 (logged — tenant_entities has no actor column)
    });

    res.json({
      doctor: projectDoctor(doctor, config),
      ...(await doctorsPayload(tenantId)),
      readiness: await readinessSnapshot(tenantId),
    });
  } catch (err) {
    if (err.name === 'DoctorValidationError') {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: doctorIssueFields(err) });
    }
    logger.error({ err: err.message }, 'portal doctors POST failed');
    res.status(500).json({ error: 'Failed to add this doctor' });
  }
});

// PATCH an existing doctor — a full replace of the editable fields. An id from
// another tenant matches no row and 404s (INV-1).
router.patch('/api/doctors/:id', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const langs = enabledLanguages(config);
    const { fields, input } = validateDoctorBody(req.body || {}, langs);
    if (fields.length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields });

    const doctor = await doctorService.updateDoctor(tenantId, req.params.id, input, {
      languages: langs,
      actorUserId: req.portalUser.id,
    });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    res.json({
      doctor: projectDoctor(doctor, config),
      ...(await doctorsPayload(tenantId)),
      readiness: await readinessSnapshot(tenantId),
    });
  } catch (err) {
    if (err.name === 'DoctorValidationError') {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: doctorIssueFields(err) });
    }
    logger.error({ err: err.message }, 'portal doctor PATCH failed');
    res.status(500).json({ error: 'Failed to save this doctor' });
  }
});

// DELETE = "remove this doctor from my clinic", resolved by what the data allows:
// a doctor with appointments on the books is archived (history keeps naming
// someone the tenant can account for), one with none is deleted outright. Either
// way they stop being offered. `outcome` tells the page which happened so it can
// say so honestly.
router.delete('/api/doctors/:id', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const result = await doctorService.removeDoctor(tenantId, req.params.id, {
      actorUserId: req.portalUser.id,
    });
    if (!result) return res.status(404).json({ error: 'Doctor not found' });

    res.json({
      outcome: result.outcome,
      ...(await doctorsPayload(tenantId)),
      readiness: await readinessSnapshot(tenantId),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'portal doctor DELETE failed');
    res.status(500).json({ error: 'Failed to remove this doctor' });
  }
});

// POST restore — put an archived doctor back into booking.
router.post('/api/doctors/:id/restore', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const doctor = await doctorService.setArchived(tenantId, req.params.id, false, {
      actorUserId: req.portalUser.id,
    });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const config = await getConfigForSession(tenantId);
    res.json({
      doctor: projectDoctor(doctor, config),
      ...(await doctorsPayload(tenantId)),
      readiness: await readinessSnapshot(tenantId),
    });
  } catch (err) {
    if (err.name === 'DoctorValidationError') {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: doctorIssueFields(err) });
    }
    logger.error({ err: err.message }, 'portal doctor restore failed');
    res.status(500).json({ error: 'Failed to restore this doctor' });
  }
});

// ── FAQs (PORTAL-P4-S11) ─────────────────────────────────────────────────────
// The first portal page writing knowledge_chunks rather than a tenant_configs
// section. Closes the two amber KB readiness checks (kb.populated / kb.retrieval,
// spec §5.1) once ≥5 chunks exist and a canned retrieval query finds one — see
// validationService's kbMin default (5) and checkKbRetrieval.
//
// Shape mirrors Doctors, not the config pages: per-item CRUD (each FAQ is one
// knowledge_chunks row) rather than one whole-section POST, and no `version` —
// there is no config document here to version. faqService is the structural
// gate (no Zod schema behind this storage, same situation doctorService is in),
// so — like doctors — we validate here with owner-friendly copy AND let the
// service re-validate (belt and suspenders).
function faqIssueFields(err) {
  return err.issues.map((i) => ({ field: i.path, message: i.message }));
}

function validateFaqBody(body, langs) {
  const fields = [];

  const question = typeof body.question === 'string' ? body.question.replace(/\s+/g, ' ').trim() : '';
  if (!question) fields.push({ field: 'question', message: 'Enter the question a patient would ask.' });
  else if (question.length > faqService.MAX_QUESTION) {
    fields.push({ field: 'question', message: `Question must be ${faqService.MAX_QUESTION} characters or fewer.` });
  }

  const answer = typeof body.answer === 'string' ? body.answer.replace(/\s+/g, ' ').trim() : '';
  if (!answer) fields.push({ field: 'answer', message: 'Enter the answer your receptionist should give.' });
  else if (answer.length > faqService.MAX_ANSWER) {
    fields.push({ field: 'answer', message: `Answer must be ${faqService.MAX_ANSWER} characters or fewer.` });
  }

  let language = null;
  const rawLang = body.language;
  if (rawLang !== undefined && rawLang !== null && rawLang !== '') {
    if (!langs.includes(rawLang)) {
      fields.push({ field: 'language', message: 'Choose one of your clinic’s enabled languages, or leave it blank.' });
    } else language = rawLang;
  }

  return { fields, input: { question, answer, language } };
}

// Everything the page needs in one read, same shape faqsPayload returns after
// every write so the page never needs a second round-trip to stay correct.
async function faqsPayload(tenantId) {
  const config = await getConfigForSession(tenantId);
  const faqs = await faqService.listFaqs(tenantId);
  return { faqs, languages: enabledLanguages(config) };
}

// GET the session tenant's FAQs (INV-1: tenant from req.portalUser only; a
// crafted ?tenantId is inert by construction).
router.get('/api/faqs', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const payload = await faqsPayload(tenantId);
    res.json({ ...payload, readiness: await readinessSnapshot(tenantId) });
  } catch (err) {
    logger.error({ err: err.message }, 'portal faqs GET failed');
    res.status(500).json({ error: 'Failed to load FAQs' });
  }
});

// POST a new FAQ. Returns { faqs, languages, readiness } — the full list rides
// along so the page never needs a second round-trip to stay correct.
router.post('/api/faqs', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const langs = enabledLanguages(config);
    const { fields, input } = validateFaqBody(req.body || {}, langs);
    if (fields.length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields });

    await faqService.createFaq(tenantId, input, { languages: langs });

    const payload = await faqsPayload(tenantId);
    res.json({ ...payload, readiness: await readinessSnapshot(tenantId) });
  } catch (err) {
    if (err.name === 'FaqValidationError') {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: faqIssueFields(err) });
    }
    logger.error({ err: err.message }, 'portal faqs POST failed');
    res.status(500).json({ error: 'Failed to add this FAQ' });
  }
});

// PATCH an existing FAQ — a full replace of question/answer/language.
// Re-embeds when the Q/A text changed (faqService/knowledgeService decide
// that, not this route). An id from another tenant matches no row and 404s
// (INV-1).
router.patch('/api/faqs/:id', requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const config = await getConfigForSession(tenantId);
    const langs = enabledLanguages(config);
    const { fields, input } = validateFaqBody(req.body || {}, langs);
    if (fields.length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields });

    const faq = await faqService.updateFaq(tenantId, req.params.id, input, { languages: langs });
    if (!faq) return res.status(404).json({ error: 'FAQ not found' });

    const payload = await faqsPayload(tenantId);
    res.json({ ...payload, readiness: await readinessSnapshot(tenantId) });
  } catch (err) {
    if (err.name === 'FaqValidationError') {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: faqIssueFields(err) });
    }
    logger.error({ err: err.message }, 'portal faq PATCH failed');
    res.status(500).json({ error: 'Failed to save this FAQ' });
  }
});

// DELETE removes the chunk outright — unlike doctors there is no history that
// still names it, so there is no archive path to preserve.
router.delete('/api/faqs/:id', requirePortalAuth, async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  try {
    const removed = await faqService.deleteFaq(tenantId, req.params.id);
    if (!removed) return res.status(404).json({ error: 'FAQ not found' });

    const payload = await faqsPayload(tenantId);
    res.json({ ...payload, readiness: await readinessSnapshot(tenantId) });
  } catch (err) {
    logger.error({ err: err.message }, 'portal faq DELETE failed');
    res.status(500).json({ error: 'Failed to remove this FAQ' });
  }
});

// ── Test your receptionist (PORTAL-P5-S14) ───────────────────────────────────
// Runs ONE real turn — the real renderer + real brain, current config — with NO
// persistence (see testTurnService for the full isolation argument): no
// customer/conversation/message row is ever written. Storage-free by
// construction; the daily rate limit (20/day/tenant) is counted from
// turn_traces rows this route itself produces, so no new schema is needed.
//
// Correlation context: a fresh `test_` id per call — portal is authenticated,
// user-facing, and never adopts a header (same posture as admin's `adm_`).
const testTurnCorrelation = requestContext.middleware({ prefix: 'test', channel: 'test' });
const MAX_TEST_QUESTION = 500;

router.post('/api/test/turn', testTurnCorrelation, requirePortalAuth, express.json(), async (req, res) => {
  const tenantId = req.portalUser.tenantId;
  const body = req.body || {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';

  if (!question) return res.status(400).json({ error: 'Type a question to test.' });
  if (question.length > MAX_TEST_QUESTION) {
    return res.status(400).json({ error: `Keep the question to ${MAX_TEST_QUESTION} characters or fewer.` });
  }

  try {
    const result = await testTurnService.runTestTurn(tenantId, question);

    if (result.status === 'limited') {
      return res.status(429).json({
        error: 'You’ve used all 20 test messages for today. Try again tomorrow.',
        remaining: 0,
      });
    }
    if (result.status === 'quota_exceeded') {
      return res.status(503).json({
        quotaExceeded: true,
        error: 'Testing is temporarily unavailable (API limit reached). Your receptionist is unaffected.',
        remaining: result.remaining,
      });
    }
    res.json({ reply: result.reply, provenance: result.provenance, remaining: result.remaining });
  } catch (err) {
    logger.error({ err: err.message, tenantId }, 'portal test turn failed');
    res.status(500).json({ error: 'Something went wrong running the test. Try again.' });
  }
});

module.exports = router;
