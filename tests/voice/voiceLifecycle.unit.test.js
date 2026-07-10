require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const hmac = require('../../src/utils/hmac');

// No-DB suite: HMAC auth + request validation for the PR7 internal voice
// endpoints. Every assertion here exercises a path that short-circuits BEFORE
// any database access (401 auth failures, 400 missing/invalid fields), so it
// runs green without Postgres. DB-backed behavior (identity resolution,
// turn-from-session, event parity) lives in voiceLifecycle.integration.test.js.

const SECRET = 'lifecycle-unit-secret';
let server;
let baseUrl;

async function post(path, body, { sign = true } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  headers['x-internal-signature'] = sign ? hmac.sign(raw, SECRET) : 'sha256=deadbeef';
  const res = await fetch(`${baseUrl}/internal/voice${path}`, { method: 'POST', headers, body: raw });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe('internal voice endpoints — auth + validation (no DB)', () => {
  before(async () => {
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    const app = express();
    app.use('/internal/voice', require('../../src/routes/internalVoice'));
    await new Promise((r) => { server = app.listen(0, r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  // ── HMAC auth (shared middleware) ──────────────────────────────────────────
  it('call/start rejects a bad HMAC signature (401)', async () => {
    const res = await post('/call/start', { tenant_id: 'T', caller_id: '+919000000001' }, { sign: false });
    assert.equal(res.status, 401);
  });

  it('call/end rejects a bad HMAC signature (401)', async () => {
    const res = await post('/call/end', { call_session_id: 'x', status: 'completed' }, { sign: false });
    assert.equal(res.status, 401);
  });

  it('turn rejects a bad HMAC signature (401)', async () => {
    const res = await post('/turn', { call_session_id: 'x', transcript: 'hi' }, { sign: false });
    assert.equal(res.status, 401);
  });

  // ── Correlation id (Issue 21) — trusted internal edge ──────────────────────
  // These ride the 400 short-circuit paths (authenticated, no DB) to prove the
  // real route stack adopts/echoes X-Correlation-Id behind HMAC.
  it('adopts a well-formed X-Correlation-Id from the (HMAC-authed) worker', async () => {
    const supplied = 'call_' + 'ab'.repeat(8);
    const raw = JSON.stringify({ status: 'completed' });
    const res = await fetch(`${baseUrl}/internal/voice/call/end`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': hmac.sign(raw, SECRET),
        'x-correlation-id': supplied,
      },
      body: raw,
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('x-correlation-id'), supplied);
  });

  it('generates a fresh call_ id when the header is malformed or absent', async () => {
    const raw = JSON.stringify({ status: 'completed' });
    for (const extra of [{}, { 'x-correlation-id': 'garbage!!' }]) {
      const res = await fetch(`${baseUrl}/internal/voice/call/end`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-signature': hmac.sign(raw, SECRET),
          ...extra,
        },
        body: raw,
      });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('x-correlation-id'), /^call_[0-9a-f]{16}$/);
    }
  });

  it('an unauthenticated request gets no correlation header (id sits behind HMAC)', async () => {
    const raw = JSON.stringify({ call_session_id: 'x', status: 'completed' });
    const res = await fetch(`${baseUrl}/internal/voice/call/end`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': 'sha256=deadbeef',
        'x-correlation-id': 'call_' + 'ab'.repeat(8),
      },
      body: raw,
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-correlation-id'), null);
  });

  // ── Validation (authenticated, but short-circuits before DB) ───────────────
  it('call/start with missing caller_id → 400', async () => {
    const res = await post('/call/start', { tenant_id: 'T' });
    assert.equal(res.status, 400);
  });

  it('call/start with missing tenant_id → 400', async () => {
    const res = await post('/call/start', { caller_id: '+919000000001' });
    assert.equal(res.status, 400);
  });

  it('call/end with an invalid status → 400', async () => {
    const res = await post('/call/end', { call_session_id: 'x', status: 'bogus' });
    assert.equal(res.status, 400);
  });

  it('call/end with missing call_session_id → 400', async () => {
    const res = await post('/call/end', { status: 'completed' });
    assert.equal(res.status, 400);
  });

  it('call/end with a non-numeric duration_seconds → 400', async () => {
    const res = await post('/call/end', { call_session_id: 'x', status: 'completed', duration_seconds: 'abc' });
    assert.equal(res.status, 400);
  });

  it('call/end with a negative duration_seconds → 400', async () => {
    const res = await post('/call/end', { call_session_id: 'x', status: 'completed', duration_seconds: -5 });
    assert.equal(res.status, 400);
  });

  it('call/end with missing duration_seconds → 400', async () => {
    const res = await post('/call/end', { call_session_id: 'x', status: 'completed' });
    assert.equal(res.status, 400);
  });

  it('turn with missing call_session_id → 400', async () => {
    const res = await post('/turn', { transcript: 'hello' });
    assert.equal(res.status, 400);
  });

  it('turn with missing transcript → 400', async () => {
    const res = await post('/turn', { call_session_id: 'x' });
    assert.equal(res.status, 400);
  });
});
