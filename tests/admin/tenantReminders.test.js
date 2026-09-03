'use strict';

// ── The reminders pair's :id guard (ADMIN-S3a C2, tested at ADMIN-S3c) ───────
//
// `PATCH` and `GET /admin/api/tenants/:id/reminders` are the sole writer and
// sole reader, anywhere in the codebase, of `tenants.reminders_enabled` and
// `tenants.reminder_hours_before` — the two columns `reminderCron` gates on
// before sending real patient-facing WhatsApp messages. ADMIN-S2 nearly deleted
// them as orphans (F-A010); ADMIN-S3a mounted `requireUuidPathParam` on both.
// Neither route had a test at either point, because both sessions' file lists
// stopped short of one. This is that test.
//
// WHAT IT PINS. A malformed `:id` is answered 404 by the guard, not carried
// into the query where Postgres raises 22P02 and Express's default handler
// renders a 500 HTML page carrying the SQL error text. 404 rather than 400 is
// the file's own existing convention for a malformed `:id` — see the sibling
// `/api/tenants/:id/config` routes — and it is what makes a malformed id, an
// absent tenant and a foreign tenant one indistinguishable answer.
//
// NO DATABASE ON THE ROUTE PATH. The guard runs ahead of the handler, so a
// malformed id never reaches `db.query`. The LOGIN path does reach it as of
// ADMIN-S3b: a successful ADMIN_PASSWORD comparison resolves the bootstrap
// platform_users row (D-022), so this file needs a migrated DATABASE_URL even
// though the routes under test still touch nothing. The app below is
// `adminRoutes` on a bare express app with a session — never `server.js`, which
// schedules `reminderCron` and would send real messages.
//
// NAMED TRAP (F-A016). This app mounts no global `express.json()`, and the
// PATCH route carries no parser of its own — it depends on `server.js:51`. A
// WELL-FORMED id on that route therefore 500s here with "Cannot destructure
// property 'enabled' of 'req.body'", which is pre-existing and is NOT this
// route's bug. That is why every case below uses a malformed id: the guard
// answers before `req.body` is ever read. See tests/admin/tenantCreate.test.js
// for the mount that works around it.

process.env.LOG_LEVEL = 'silent';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function req(server, { method = 'GET', path = '/', headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (cookie) h['Cookie'] = cookie;
    const r = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers: h },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch (_) { json = null; }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

// The mutating admin API requires the CSRF header (Issue 18).
const mutate = (server, opts) => req(server, Object.assign({}, opts, {
  headers: Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {}),
}));

function login(server) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ password: 'correct-horse' });
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/admin/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const c = (res.headers['set-cookie'] || []).find((s) => s.startsWith('connect.sid='));
        resolve(c ? c.split(';')[0] : null);
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

describe('reminders pair — malformed :id is refused by the guard, not the database', () => {
  let server;
  let cookie;
  const OLD_PW = process.env.ADMIN_PASSWORD;
  const OLD_KEY = process.env.ENCRYPTION_KEY;

  before(async () => {
    process.env.ADMIN_PASSWORD = 'correct-horse';
    // adminRoutes → encryption.js reads a 32-byte hex key at module load.
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use(session({
      secret: 'test-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    // Fresh require so this suite gets its own in-memory rate-limiter buckets.
    delete require.cache[require.resolve('../../src/admin/adminRoutes')];
    app.use('/admin', require('../../src/admin/adminRoutes'));

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    cookie = await login(server);
    assert.ok(cookie, 'expected an authenticated session cookie');
  });

  after(() => {
    if (server) server.close();
    process.env.ADMIN_PASSWORD = OLD_PW;
    process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  it('PATCH /api/tenants/:id/reminders — malformed id → 404, never a 500', async () => {
    const r = await mutate(server, {
      method: 'PATCH', path: '/admin/api/tenants/not-a-uuid/reminders', cookie,
    });
    assert.equal(r.status, 404,
      'a malformed :id must be answered by requireUuidPathParam. A 500 here means '
      + 'the guard is no longer mounted and the id reached the UPDATE, where '
      + 'Postgres raises 22P02 and the default handler renders the SQL error as HTML.');
    assert.deepEqual(r.body, { error: 'Tenant not found' },
      'the guard answers in the route\'s own 404 shape, so a malformed id is '
      + 'indistinguishable from an absent tenant');
  });

  it('GET /api/tenants/:id/reminders — malformed id → 404, never a 500', async () => {
    const r = await req(server, {
      path: '/admin/api/tenants/not-a-uuid/reminders', cookie,
    });
    assert.equal(r.status, 404,
      'the read half of the pair carries the same guard as the write half. They '
      + 'are the only reader and writer of the two columns reminderCron gates on, '
      + 'and they move together or not at all (F-A010).');
    assert.deepEqual(r.body, { error: 'Tenant not found' },
      'same 404 body as the PATCH, and as an absent tenant');
  });
});
