'use strict';

// Route-level tests for the Issue 26 conversations admin API. Real routes over
// HTTP against a throwaway scratch DB (same genesis pattern as tenantDetail /
// configService.integration), with an authenticated session. Read-only surface:
// list (filters + cursor pagination) and thread detail (messages + call_sessions).
// Skips when DATABASE_URL is unset.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon_test_conv_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirrors tenantDetail.test.js) ──────────────────────────────
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
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], body: json, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('connect.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }

describe('conversations admin API (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, app, server, cookie;
  const OLD_PW = process.env.ADMIN_PASSWORD;

  before(async () => {
    await sweep();
    scratchName = 'zyon_test_conv_' + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    process.env.DATABASE_URL = scratchCs;
    process.env.ADMIN_PASSWORD = 'correct-horse';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');

    const express = require('express');
    const session = require('express-session');
    app = express();
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
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  // ── Fixture builders ─────────────────────────────────────────────────────────
  let seq = 0;
  async function newTenant(name = 'T') {
    const { rows } = await db.query(
      `INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id`, [name]);
    return rows[0].id;
  }
  async function newCustomer(tenantId, { name = null } = {}) {
    const phone = '9199' + String(1000000 + (seq++)).padStart(8, '0');
    const { rows } = await db.query(
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1, $2, $3) RETURNING id, phone`,
      [tenantId, phone, name]);
    return rows[0];
  }
  async function newConversation(tenantId, customerId, { status = 'open', channel = 'whatsapp', updatedAt = null } = {}) {
    const { rows } = await db.query(
      `INSERT INTO conversations (tenant_id, customer_id, status, channel, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW())) RETURNING id`,
      [tenantId, customerId, status, channel, updatedAt]);
    return rows[0].id;
  }
  async function newMessage(convId, tenantId, customerId, o = {}) {
    const { rows } = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, channel, direction, sender, content, msg_type, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, NOW())) RETURNING id`,
      [tenantId, convId, customerId,
       o.channel || 'whatsapp', o.direction || 'inbound', o.sender || 'customer',
       o.content == null ? 'hello' : o.content, o.msg_type || 'text', o.createdAt || null]);
    return rows[0].id;
  }
  async function newCall(tenantId, customerId, convId, o = {}) {
    const { rows } = await db.query(
      `INSERT INTO call_sessions (tenant_id, customer_id, conversation_id, provider, direction, status,
                                  language_detected, started_at, ended_at, duration_seconds)
       VALUES ($1,$2,$3,'noop',$4,$5,$6, NOW(), NOW(), $7) RETURNING id`,
      [tenantId, customerId, convId, o.direction || 'inbound', o.status || 'completed',
       o.language || 'hi', o.duration == null ? 42 : o.duration]);
    return rows[0].id;
  }

  const L = (qs = '') => '/admin/api/conversations' + (qs ? '?' + qs : '');

  // ── Auth ─────────────────────────────────────────────────────────────────────
  it('GET list → 401 unauthenticated', async () => {
    const res = await req(server, { method: 'GET', path: L() });
    assert.equal(res.status, 401);
  });
  it('GET detail → 401 unauthenticated', async () => {
    const res = await req(server, { method: 'GET', path: '/admin/api/conversations/00000000-0000-0000-0000-0000000000aa' });
    assert.equal(res.status, 401);
  });

  // ── Filter validation ────────────────────────────────────────────────────────
  it('bad status filter → 400', async () => {
    const res = await req(server, { method: 'GET', path: L('status=garbage'), cookie });
    assert.equal(res.status, 400);
  });
  it('bad channel filter → 400', async () => {
    const res = await req(server, { method: 'GET', path: L('channel=telepathy'), cookie });
    assert.equal(res.status, 400);
  });
  it('bad cursor → 400', async () => {
    const res = await req(server, { method: 'GET', path: L('before=not-a-cursor'), cookie });
    assert.equal(res.status, 400);
  });

  // ── Unknown / malformed id ───────────────────────────────────────────────────
  it('malformed conversation id → 404', async () => {
    const res = await req(server, { method: 'GET', path: '/admin/api/conversations/not-a-uuid', cookie });
    assert.equal(res.status, 404);
  });
  it('well-formed absent id → 404', async () => {
    const res = await req(server, { method: 'GET', path: '/admin/api/conversations/00000000-0000-0000-0000-0000000000ff', cookie });
    assert.equal(res.status, 404);
  });

  // ── Deleted/unknown tenant filter → empty, not error ─────────────────────────
  it('unknown tenant filter → empty result, not error', async () => {
    const res = await req(server, { method: 'GET', path: L('tenant_id=00000000-0000-0000-0000-0000000000ee'), cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, []);
    assert.equal(res.body.next_before, null);
  });

  // ── Pagination: two pages, no overlap/gap, stable ordering ───────────────────
  it('cursor pagination walks the whole set with no overlap or gap', async () => {
    const t = await newTenant('Pager');
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const cust = await newCustomer(t, { name: 'C' + i });
      const conv = await newConversation(t, cust.id, {
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), // t0 < t1 < t2
      });
      await newMessage(conv, t, cust.id, { content: 'm' + i });
      ids.push(conv);
    }
    // Newest-first global order: [ids[2], ids[1], ids[0]]
    const p1 = await req(server, { method: 'GET', path: L(`tenant_id=${t}&limit=2`), cookie });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.rows.length, 2);
    assert.deepEqual(p1.body.rows.map((r) => r.id), [ids[2], ids[1]]);
    assert.ok(p1.body.next_before, 'next cursor present');

    const p2 = await req(server, { method: 'GET', path: L(`tenant_id=${t}&limit=2&before=${encodeURIComponent(p1.body.next_before)}`), cookie });
    assert.equal(p2.body.rows.length, 1);
    assert.deepEqual(p2.body.rows.map((r) => r.id), [ids[0]]);
    assert.equal(p2.body.next_before, null, 'no more pages');

    const seen = [...p1.body.rows, ...p2.body.rows].map((r) => r.id);
    assert.equal(new Set(seen).size, 3, 'no overlap across pages');
  });

  // ── Tenant filter narrows ────────────────────────────────────────────────────
  it('tenant filter narrows to that tenant only', async () => {
    const a = await newTenant('A'); const b = await newTenant('B');
    const ca = await newCustomer(a); const cb = await newCustomer(b);
    const convA = await newConversation(a, ca.id); await newMessage(convA, a, ca.id);
    const convB = await newConversation(b, cb.id); await newMessage(convB, b, cb.id);

    const res = await req(server, { method: 'GET', path: L(`tenant_id=${a}`), cookie });
    assert.ok(res.body.rows.every((r) => r.tenant_id === a));
    assert.ok(res.body.rows.some((r) => r.id === convA));
    assert.ok(!res.body.rows.some((r) => r.id === convB));
  });

  // ── Channel filter narrows (per-message channel) ─────────────────────────────
  it('channel filter selects conversations having a message on that channel', async () => {
    const t = await newTenant('Chan');
    const cWa = await newCustomer(t); const cVo = await newCustomer(t); const cMix = await newCustomer(t);
    const convWa = await newConversation(t, cWa.id); await newMessage(convWa, t, cWa.id, { channel: 'whatsapp' });
    const convVo = await newConversation(t, cVo.id); await newMessage(convVo, t, cVo.id, { channel: 'voice' });
    const convMix = await newConversation(t, cMix.id);
    await newMessage(convMix, t, cMix.id, { channel: 'whatsapp' });
    await newMessage(convMix, t, cMix.id, { channel: 'voice' });

    const voice = await req(server, { method: 'GET', path: L(`tenant_id=${t}&channel=voice`), cookie });
    const vids = voice.body.rows.map((r) => r.id);
    assert.ok(vids.includes(convVo) && vids.includes(convMix), 'voice + mixed match voice filter');
    assert.ok(!vids.includes(convWa), 'pure-WA excluded from voice filter');

    const wa = await req(server, { method: 'GET', path: L(`tenant_id=${t}&channel=whatsapp`), cookie });
    const wids = wa.body.rows.map((r) => r.id);
    assert.ok(wids.includes(convWa) && wids.includes(convMix));
    assert.ok(!wids.includes(convVo));

    // The mixed conversation reports both channels in its row.
    const mixRow = wa.body.rows.find((r) => r.id === convMix);
    assert.deepEqual([...mixRow.channels].sort(), ['voice', 'whatsapp']);
  });

  // ── Status filter narrows ────────────────────────────────────────────────────
  it('status filter narrows correctly', async () => {
    const t = await newTenant('Stat');
    const c1 = await newCustomer(t); const c2 = await newCustomer(t);
    const open = await newConversation(t, c1.id, { status: 'open' });
    const closed = await newConversation(t, c2.id, { status: 'closed' });

    const res = await req(server, { method: 'GET', path: L(`tenant_id=${t}&status=closed`), cookie });
    const ids = res.body.rows.map((r) => r.id);
    assert.ok(ids.includes(closed) && !ids.includes(open));
  });

  // ── Preview truncation + non-text placeholder ────────────────────────────────
  it('list preview truncates long text and collapses non-text to its type', async () => {
    const t = await newTenant('Prev');
    const cLong = await newCustomer(t);
    const long = 'x'.repeat(200);
    const convLong = await newConversation(t, cLong.id, { updatedAt: new Date(Date.UTC(2026, 1, 1, 0, 1)).toISOString() });
    await newMessage(convLong, t, cLong.id, { content: long });

    const cImg = await newCustomer(t);
    const convImg = await newConversation(t, cImg.id, { updatedAt: new Date(Date.UTC(2026, 1, 1, 0, 2)).toISOString() });
    await newMessage(convImg, t, cImg.id, { msg_type: 'image', content: 'https://cdn.example/secret.jpg', createdAt: new Date(Date.UTC(2026, 1, 1, 0, 2)).toISOString() });

    const res = await req(server, { method: 'GET', path: L(`tenant_id=${t}`), cookie });
    const rowLong = res.body.rows.find((r) => r.id === convLong);
    assert.ok(rowLong.preview.length <= 81, 'truncated to ~80 chars + ellipsis');
    assert.ok(rowLong.preview.endsWith('…'));

    const rowImg = res.body.rows.find((r) => r.id === convImg);
    assert.equal(rowImg.preview, '[image]', 'non-text collapses to its type, never the payload');
    assert.ok(!rowImg.preview.includes('secret'));
  });

  // ── Customer display fallback ────────────────────────────────────────────────
  it('customer with no name falls back to phone identifier, never "undefined"', async () => {
    const t = await newTenant('NoName');
    const cust = await newCustomer(t, { name: null });
    const conv = await newConversation(t, cust.id); await newMessage(conv, t, cust.id);
    const res = await req(server, { method: 'GET', path: L(`tenant_id=${t}`), cookie });
    const row = res.body.rows.find((r) => r.id === conv);
    assert.equal(row.customer_display, cust.phone);
  });

  // ── Detail: ordering + call_sessions for voice, absent for pure-WA ───────────
  it('detail returns messages in ascending order with call_sessions for a voice thread', async () => {
    const t = await newTenant('Voice');
    const cust = await newCustomer(t, { name: 'Kavya' });
    const conv = await newConversation(t, cust.id);
    await newMessage(conv, t, cust.id, { channel: 'voice', content: 'first',  createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0)).toISOString() });
    await newMessage(conv, t, cust.id, { channel: 'voice', content: 'second', direction: 'outbound', sender: 'ai', createdAt: new Date(Date.UTC(2026, 2, 1, 0, 1)).toISOString() });
    const callId = await newCall(t, cust.id, conv, { language: 'te', duration: 30 });

    const res = await req(server, { method: 'GET', path: '/admin/api/conversations/' + conv, cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.customer_display, 'Kavya');
    assert.deepEqual(res.body.messages.map((m) => m.content), ['first', 'second']);
    assert.equal(res.body.call_sessions.length, 1);
    assert.equal(res.body.call_sessions[0].id, callId);
    assert.equal(res.body.call_sessions[0].language_detected, 'te');
    assert.equal(res.body.call_sessions[0].duration_seconds, 30);
  });

  it('detail for a pure-WhatsApp thread has no call_sessions', async () => {
    const t = await newTenant('PureWA');
    const cust = await newCustomer(t);
    const conv = await newConversation(t, cust.id);
    await newMessage(conv, t, cust.id, { channel: 'whatsapp' });
    const res = await req(server, { method: 'GET', path: '/admin/api/conversations/' + conv, cookie });
    assert.equal(res.body.call_sessions.length, 0);
  });

  it('detail for a conversation with zero messages renders empty, not a crash', async () => {
    const t = await newTenant('Empty');
    const cust = await newCustomer(t);
    const conv = await newConversation(t, cust.id);
    const res = await req(server, { method: 'GET', path: '/admin/api/conversations/' + conv, cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages, []);
    assert.equal(res.body.message_count, 0);
  });
});
