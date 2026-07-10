'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const security = require('../../src/admin/security');

// ── Shared test helpers ──────────────────────────────────────────────────────
// Central request helper so the new header requirement is expressed in ONE place
// (Issue 18: "update test helpers centrally, not per-test copy-paste"). Any
// mutating admin-API call in a test goes through `mutate()`, which attaches the
// CSRF header; `req()` is the raw escape hatch for negative/GET cases.
function req(server, { method = 'GET', path = '/', headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const h = Object.assign({}, headers);
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) h['Cookie'] = cookie;

    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = null; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: res.headers['set-cookie'] || [],
          body: json,
          raw: data,
        });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Mutating admin-API call: same as req() but always carries the CSRF header.
function mutate(server, opts) {
  return req(server, Object.assign({}, opts, {
    headers: Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {}),
  }));
}

// Extract the connect.sid session cookie value (for cross-request identity).
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}

// Build a fresh admin app per test (isolated in-memory limiter + session store).
// `prod` simulates Railway: NODE_ENV=production + trust proxy so `secure` cookies
// are emitted when we forward X-Forwarded-Proto: https.
function buildAdminApp({ prod = false } = {}) {
  const express = require('express');
  const session = require('express-session');
  const app = express();
  if (prod) app.set('trust proxy', 1);
  app.use(session({
    secret: 'test-secret-abcdefghijklmnopqrstuvwx',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: prod,
      maxAge: 12 * 60 * 60 * 1000,
    },
  }));
  // Fresh require each build so module-level limiter state doesn't bleed between
  // tests (delete from cache so the new app gets its own buckets).
  delete require.cache[require.resolve('../../src/admin/adminRoutes')];
  app.use('/admin', require('../../src/admin/adminRoutes'));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const OLD_PW = process.env.ADMIN_PASSWORD;
const OLD_KEY = process.env.ENCRYPTION_KEY;
before(() => {
  process.env.ADMIN_PASSWORD = 'correct-horse';
  // adminRoutes → encryption.js reads a 32-byte hex key at module load.
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});
after(() => {
  process.env.ADMIN_PASSWORD = OLD_PW;
  process.env.ENCRYPTION_KEY = OLD_KEY;
});

// ── Timing-safe compare ──────────────────────────────────────────────────────
describe('safeEqual', () => {
  it('routes the comparison through crypto.timingSafeEqual', () => {
    const spy = mock.method(crypto, 'timingSafeEqual');
    security.safeEqual('abc', 'abc');
    assert.equal(spy.mock.callCount(), 1);
    // Equal-length (sha256) buffers passed → no throw.
    const [a, b] = spy.mock.calls[0].arguments;
    assert.equal(a.length, 32);
    assert.equal(b.length, 32);
    spy.mock.restore();
  });

  it('true only for exact match, regardless of length', () => {
    assert.equal(security.safeEqual('secret', 'secret'), true);
    assert.equal(security.safeEqual('secret', 'Secret'), false);
    assert.equal(security.safeEqual('short', 'a-much-longer-password'), false);
    assert.equal(security.safeEqual(undefined, 'x'), false);
  });
});

// ── Login: generic failure + delay ───────────────────────────────────────────
describe('POST /admin/login', () => {
  it('wrong password → 401 generic error with a constant delay', async () => {
    const server = await listen(buildAdminApp());
    const t0 = Date.now();
    const res = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'nope' } });
    const elapsed = Date.now() - t0;
    server.close();

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid credentials'); // no enumeration signal
    assert.ok(!/password/i.test(res.body.error));
    assert.ok(elapsed >= 250, `expected ~300ms delay, got ${elapsed}ms`);
  });

  it('correct password → 200 and sets an authenticated session cookie', async () => {
    const server = await listen(buildAdminApp());
    const res = await mutate(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    server.close();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(sid(res.setCookie), 'expected a session cookie');
  });

  it('regenerates the session id on login (fixation defense)', async () => {
    const server = await listen(buildAdminApp());
    // First login → session A.
    const first = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    const sidA = sid(first.setCookie);
    assert.ok(sidA);
    // Re-login carrying session A → must get a DIFFERENT id back.
    const second = await req(server, {
      method: 'POST', path: '/admin/login', body: { password: 'correct-horse' }, cookie: sidA,
    });
    const sidB = sid(second.setCookie);
    server.close();
    assert.ok(sidB, 'regeneration should emit a new Set-Cookie');
    assert.notEqual(sidA, sidB, 'session id must change across login');
  });
});

// ── Login rate limiting ──────────────────────────────────────────────────────
describe('login rate limiting', () => {
  it('6th attempt in the window → 429', async () => {
    const server = await listen(buildAdminApp());
    let last;
    for (let i = 0; i < 6; i++) {
      last = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'nope' } });
    }
    server.close();
    assert.equal(last.status, 429);
    assert.ok(last.headers['retry-after'], 'expected Retry-After header');
  });
});

// ── Cookie flags ─────────────────────────────────────────────────────────────
describe('session cookie flags', () => {
  it('dev login: HttpOnly + SameSite=Strict, not Secure', async () => {
    const server = await listen(buildAdminApp());
    const res = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    server.close();
    const c = res.setCookie.find((s) => s.startsWith('connect.sid='));
    assert.ok(c, 'expected a session cookie');
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Strict/i);
    assert.ok(!/Secure/i.test(c), 'Secure must be off in dev');
  });

  it('prod (trust proxy + X-Forwarded-Proto https): Secure is set', async () => {
    const server = await listen(buildAdminApp({ prod: true }));
    const res = await req(server, {
      method: 'POST', path: '/admin/login',
      headers: { 'X-Forwarded-Proto': 'https' },
      body: { password: 'correct-horse' },
    });
    server.close();
    const c = res.setCookie.find((s) => s.startsWith('connect.sid='));
    assert.ok(c, 'expected a session cookie under prod');
    assert.match(c, /Secure/i);
  });
});

// ── CSRF custom-header requirement ───────────────────────────────────────────
describe('CSRF header on mutating admin APIs', () => {
  async function authedCookie(server) {
    const res = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    return sid(res.setCookie);
  }

  it('mutating call without X-Zyon-Admin → 403 (before any handler work)', async () => {
    const server = await listen(buildAdminApp());
    const cookie = await authedCookie(server);
    const res = await req(server, {
      method: 'POST', path: '/admin/api/cache/invalidate', cookie, body: {},
    });
    server.close();
    assert.equal(res.status, 403);
  });

  it('mutating call with X-Zyon-Admin → 200', async () => {
    const server = await listen(buildAdminApp());
    const cookie = await authedCookie(server);
    const res = await mutate(server, {
      method: 'POST', path: '/admin/api/cache/invalidate', cookie, body: {},
    });
    server.close();
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'all');
  });

  it('read-only GET is unaffected by the header requirement', async () => {
    // /admin/logout is an authenticated-agnostic GET; it must not require the header.
    const server = await listen(buildAdminApp());
    const res = await req(server, { method: 'GET', path: '/admin/logout' });
    server.close();
    assert.equal(res.status, 302); // redirect to /admin, no 403
  });
});

// ── Security headers ─────────────────────────────────────────────────────────
describe('security headers', () => {
  it('present on a panel page response', async () => {
    const server = await listen(buildAdminApp());
    const res = await req(server, { method: 'GET', path: '/admin/' });
    server.close();
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });

  it('present on an admin API response (401 path)', async () => {
    const server = await listen(buildAdminApp());
    const res = await req(server, { method: 'GET', path: '/admin/api/tenants' });
    server.close();
    assert.equal(res.status, 401); // unauthenticated
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });
});

// ── Correlation id (Issue 21) — admin is a public edge: always fresh ─────────
describe('correlation id on admin responses', () => {
  it('every admin response carries a fresh adm_ id; a supplied header is ignored', async () => {
    const server = await listen(buildAdminApp());
    const spoof = 'call_' + 'ee'.repeat(8);
    const res = await req(server, {
      method: 'GET', path: '/admin/api/tenants',
      headers: { 'X-Correlation-Id': spoof },
    });
    server.close();
    assert.match(res.headers['x-correlation-id'], /^adm_[0-9a-f]{16}$/);
    assert.notEqual(res.headers['x-correlation-id'], spoof);
  });
});
