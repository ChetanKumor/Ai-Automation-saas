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

module.exports = router;
