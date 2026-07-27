'use strict';

// Issue 34 — the admin create route must not birth legacy-prompt tenants.
//
// A non-null `tenants.ai_prompt` makes `configForPrompt` return before reading
// the config document at all (aiService.js:466-467), so every field the owner
// later saves in the portal is silently inert. `provisioningService.js:226`
// already creates tenants with `ai_prompt: null` ("born on the renderer"); this
// closes the one ordinary path that still set the trap.
//
// Two seams, both covered here because closing only one is undone by anybody
// who rebuilds the other:
//   • the FORM (public/admin/tenant-new.html) no longer offers the field, and
//   • the ROUTE (POST /admin/api/tenants) no longer honours the parameter.
//
// The form assertion is a plain file read and runs everywhere. The route tests
// go over real HTTP against a throwaway scratch DB, mirroring
// tenantDetail.test.js, and skip when DATABASE_URL is unset.
//
// NOT covered here, deliberately: `scripts/update-prompt.js`. Setting a legacy
// prompt is still a supported operation — this issue removed the accident, not
// the capability. The precedence chain in aiService is untouched and stays
// covered by tests/prompts/promptPrecedence.unit.test.js.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
// Own prefix so this file's sweep never drops a sibling suite's scratch DB
// (node --test runs files concurrently) — same convention as createOwner.test.js.
const PREFIX = 'zyon_tnew_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_tnew\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror tenantDetail.test.js) ───────────────────────────────
function req(server, { method = 'GET', path: p = '/', headers = {}, body, cookie } = {}) {
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
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], body: json, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function mutate(server, opts) {
  return req(server, Object.assign({}, opts, { headers: Object.assign({ 'X-Zyon-Admin': '1' }, opts.headers || {}) }));
}
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

// ── The form ────────────────────────────────────────────────────────────────
// No DB, no server: the shipped file itself. If someone re-adds the textarea,
// this goes red whether or not the route is still closed.
describe('admin tenant-create form (Issue 34)', () => {
  const FORM = path.join(__dirname, '../../public/admin/tenant-new.html');
  const html = fs.readFileSync(FORM, 'utf8');

  it('offers no AI-prompt input', () => {
    assert.ok(!/<textarea[^>]*name=["']ai_prompt["']/.test(html),
      'tenant-new.html must not carry an ai_prompt textarea');
    assert.ok(!/name=["']ai_prompt["']/.test(html),
      'tenant-new.html must not carry any ai_prompt form control');
  });

  it('does not send ai_prompt in the create payload', () => {
    // The handler builds the POST body; an `ai_prompt:` key anywhere in it would
    // mean the field is still being read off the form.
    assert.ok(!/ai_prompt\s*:/.test(html),
      'the submit handler must not put ai_prompt on the request body');
  });
});

// ── The route ───────────────────────────────────────────────────────────────
describe('POST /admin/api/tenants (Issue 34)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, app, server, cookie;
  const OLD_PW = process.env.ADMIN_PASSWORD;
  const OLD_DB = process.env.DATABASE_URL;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind the pooled db module to the scratch DB BEFORE first require, so
    // adminRoutes → db/tenantService inherit it.
    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');

    const express = require('express');
    const session = require('express-session');
    app = express();
    // POST /api/tenants carries no inline express.json() — it relies on the
    // global parser at server.js:51. Mount it here or req.body is undefined and
    // every create 500s for a reason that has nothing to do with this issue.
    app.use(express.json());
    app.use(session({
      secret: 'test-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    delete require.cache[require.resolve('../../src/admin/adminRoutes')];
    app.use('/admin', require('../../src/admin/adminRoutes'));
    server = await listen(app);

    const login = await req(server, { method: 'POST', path: '/admin/login', body: { password: 'correct-horse' } });
    cookie = sid(login.setCookie);
    assert.ok(cookie, 'expected an authenticated session cookie');
  });

  after(async () => {
    if (server) server.close();
    process.env.ADMIN_PASSWORD = OLD_PW;
    process.env.DATABASE_URL = OLD_DB;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  const create = (body) => mutate(server, { method: 'POST', path: '/admin/api/tenants', cookie, body });

  it('creates a tenant, and it is born on the renderer (ai_prompt NULL)', async () => {
    const res = await create({ business_name: 'Renderer Clinic' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id, 'expected the created tenant id back');

    const { rows } = await db.query('SELECT business_name, ai_prompt FROM tenants WHERE id=$1', [res.body.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].business_name, 'Renderer Clinic');
    // The whole point of the issue: matches provisioningService.js:226.
    assert.equal(rows[0].ai_prompt, null);
  });

  it('refuses a supplied ai_prompt instead of quietly honouring it', async () => {
    const res = await create({
      business_name: 'Legacy Attempt Clinic',
      ai_prompt: 'You are the receptionist for Legacy Attempt Clinic.',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ai_prompt is not accepted here/);
    // Names the surviving deliberate path, so the operator is redirected, not just refused.
    assert.match(res.body.error, /scripts\/update-prompt\.js/);

    // And nothing was written — a rejected create must not leave a tenant behind.
    const { rows } = await db.query('SELECT id FROM tenants WHERE business_name=$1', ['Legacy Attempt Clinic']);
    assert.equal(rows.length, 0, 'no tenant may be created when ai_prompt is refused');
  });

  it('still accepts a null ai_prompt, so a cached copy of the old form keeps working', async () => {
    // The pre-Issue-34 form posted `ai_prompt: null` whenever the textarea was
    // left empty. A browser that has not refetched the page still posts it, and
    // refusing an empty value would break creation for a caller who supplied
    // nothing. Empty is not the hazard; text is.
    const res = await create({ business_name: 'Cached Form Clinic', ai_prompt: null });
    assert.equal(res.status, 201);

    const { rows } = await db.query('SELECT ai_prompt FROM tenants WHERE id=$1', [res.body.id]);
    assert.equal(rows[0].ai_prompt, null);
  });
});
