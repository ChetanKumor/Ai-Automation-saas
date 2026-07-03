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
