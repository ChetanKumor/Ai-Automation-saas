'use strict';

// Admin panel hardening primitives (Issue 18). No new dependencies; all state is
// in-process, so every guarantee here is SINGLE-INSTANCE — a second replica keeps
// its own limiter buckets and its own sessions (see server.js session store note).
// Recovery: a process restart clears the limiter; rotating SESSION_SECRET
// invalidates all sessions.

const crypto = require('crypto');

// ── Constant-time credential compare ─────────────────────────────────────────
// sha256 both sides first so the buffers are always 32 bytes: timingSafeEqual
// throws on length mismatch and length itself would otherwise leak. The hash is
// only a length-equaliser here (the password is not persisted), so a plain
// sha256 is sufficient — we are not storing this digest anywhere.
function safeEqual(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Minimal security headers ─────────────────────────────────────────────────
// Applied to panel pages + admin APIs. Deliberately small (no helmet dep):
//   - nosniff: stop MIME sniffing of our JSON/HTML/JS
//   - DENY framing: the panel is never meant to be embedded (clickjacking)
//   - no-referrer: don't leak admin URLs to any outbound navigation
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}

// ── Custom-header CSRF check ──────────────────────────────────────────────────
// sameSite=strict cookies are the PRIMARY CSRF control (a cross-site request
// never carries the session cookie). This custom-header requirement is defense
// in depth: a browser will not attach a custom header on a cross-origin request
// without a CORS preflight that we never grant, and simple <form> POSTs cannot
// set headers at all. Residual risk: a same-site XSS could forge it — that is an
// XSS problem, not a CSRF one, and out of scope for this gate.
const CSRF_HEADER = 'x-zyon-admin';
function requireAdminHeader(req, res, next) {
  if (req.get(CSRF_HEADER) === '1') return next();
  res.status(403).json({ error: 'Missing admin header' });
}

// ── In-memory per-IP rate limiter ────────────────────────────────────────────
// No timers (Issue 4's lesson: setInterval sweeps leak on shutdown). Buckets are
// pruned lazily on the request path once the map grows past a threshold. Keyed on
// the express-resolved req.ip — meaningful only once `trust proxy` is set in prod;
// in dev every localhost caller collapses to 127.0.0.1 (acceptable — dev only).
const PRUNE_THRESHOLD = 10_000;

function createRateLimiter({ max, windowMs, message }) {
  const hits = new Map(); // ip -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || 'unknown';

    let entry = hits.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    // Lazy prune: only sweep when the map is large, so the common path stays O(1).
    if (hits.size > PRUNE_THRESHOLD) {
      for (const [k, v] of hits) {
        if (now >= v.resetAt) hits.delete(k);
      }
    }

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests' });
    }
    next();
  };
}

module.exports = {
  safeEqual,
  securityHeaders,
  requireAdminHeader,
  createRateLimiter,
  CSRF_HEADER,
};
