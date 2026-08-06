'use strict';

// ============================================================
//  Portal owner auth (PORTAL-P1-S1)
//
//  Password hashing (scrypt, node:crypto — no new dependency) + the
//  requirePortalAuth middleware that is the single source of tenant scope for
//  every portal route.
//
//  This is a PARALLEL system to the admin auth (src/admin/security.js): the
//  admin panel is one cross-tenant operator behind a shared ADMIN_PASSWORD; the
//  portal is per-user accounts, each hard-scoped to exactly one tenant. They do
//  not share a cookie, a session, or a code path.
//
//  INV-1 (spec §3): tenant_id derives ONLY from the session's user row. No
//  portal route may read a tenant identifier from params, body, query, or
//  headers. requirePortalAuth is where that row is loaded and where
//  req.portalUser.tenantId is set — it is the only place tenant scope enters a
//  request.
// ============================================================

const crypto = require('crypto');
const logger = require('../infra/logging/logger');

// db is required lazily inside requirePortalAuth (below), NOT at module top:
// hashPassword / verifyPassword are pure and must be importable (e.g. by an
// account-seeding path or a test) without instantiating the pg Pool as a side
// effect — instantiating it early would bind the pool to whatever DATABASE_URL
// happened to be set at first import.

// scrypt work factors. N=16384 (default cost) keeps 128*N*r ≈ 16MB well under the
// generous maxmem below. Parameters are encoded INTO the stored string so a future
// bump verifies old hashes with their original factors (self-describing).
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
const MAXMEM = 128 * N * R * 2; // headroom over the 128*N*r requirement

// Stored format: `scrypt$N$r$p$<saltBase64>$<hashBase64>`. Self-describing so
// verify never has to assume the parameters a hash was produced with.
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Constant-time verify. Any structural problem in the stored string (wrong prefix,
// missing fields, non-integer params, empty hash, garbage base64) fails closed —
// a tampered or truncated hash must never verify. timingSafeEqual is fed
// equal-length buffers (we derive exactly expected.length bytes), so the compare
// itself never leaks via a length-mismatch throw.
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: n, r, p, maxmem: 128 * n * r * 2,
    });
  } catch (_) {
    return false; // e.g. maxmem exceeded for absurd stored params — treat as invalid
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ── Session epoch (F3-R1) ────────────────────────────────────────────────────
// passwordEpoch reduces a users row's password_changed_at to a JSON-safe number
// of milliseconds. Login stamps the result into the session; requirePortalAuth
// recomputes it from a fresh read and compares. Exported so the two sites can
// never drift into two conventions — the same discipline that keeps hashPassword
// the single hashing path.
//
// Both call sites take the value through node-pg's identical TIMESTAMPTZ → Date
// parse, so the millisecond truncation of a microsecond-precision column applies
// equally to both sides and can never make a matching pair compare unequal. A
// number (not a Date) is stored because the session is serialised to JSON, where
// a Date would come back as a string and invite a `===` that silently never
// matches — which would fail CLOSED, but by accident rather than by design.
function passwordEpoch(row) {
  if (!row || row.password_changed_at == null) return null;
  const t = new Date(row.password_changed_at).getTime();
  return Number.isFinite(t) ? t : null;
}

// STRICT: the session's epoch must be a number and must equal the row's.
//
// A session carrying NO epoch is REJECTED, never admitted. That is the whole
// point and it is not negotiable: sessions issued before migration 027 carry no
// epoch, and they are exactly the sessions a reset must be able to evict. A
// null-tolerant comparison would read as a migration accommodation and function
// as a permanent bypass — it would admit forever the pre-reset sessions this
// mechanism exists to kill, and hand a skeleton key to anyone able to strip a
// field from a session payload. The cost is one forced re-login at deploy for
// whoever is signed in; see migration 027's header.
function sessionEpochMatches(portalSession, row) {
  const claimed = portalSession && portalSession.pwAt;
  if (typeof claimed !== 'number') return false;
  const actual = passwordEpoch(row);
  return actual !== null && claimed === actual;
}

// requirePortalAuth — loads the session's user row and attaches req.portalUser.
// tenantId comes ONLY from this row (INV-1). The route handlers downstream must
// never read a tenant identifier from the request; this middleware is the sole
// entry point for tenant scope.
async function requirePortalAuth(req, res, next) {
  const db = require('../db/db');
  const portal = req.session && req.session.portal;
  const userId = portal && portal.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { rows } = await db.query(
      'SELECT id, tenant_id, role, active, password_changed_at FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];
    // A deleted or deactivated account invalidates a still-live session cookie.
    if (!user || user.active !== true) return res.status(401).json({ error: 'Unauthorized' });

    // An operator password reset moves password_changed_at, so every session
    // issued before it stops authenticating here, on its very next request.
    // Same generic 401 as every other failure — a distinct status or message
    // would tell a holder of a stale cookie that the account is real and that
    // its password was just rotated.
    if (!sessionEpochMatches(portal, user)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.portalUser = { id: user.id, tenantId: user.tenant_id, role: user.role };
    next();
  } catch (err) {
    logger.error({ err: err.message }, 'portal auth lookup failed');
    res.status(500).json({ error: 'Auth check failed' });
  }
}

module.exports = {
  hashPassword, verifyPassword, requirePortalAuth, passwordEpoch, sessionEpochMatches,
};
