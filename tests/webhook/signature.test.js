const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const APP_SECRET = 'test-secret-key-for-hmac';

function makeSignature(body, secret = APP_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function buildRes() {
  const res = {
    _status: null,
    sendStatus(code) { res._status = code; },
  };
  return res;
}

describe('Webhook signature verification', () => {
  const originalEnv = process.env.META_APP_SECRET;
  let verifySignature;

  before(() => {
    process.env.META_APP_SECRET = APP_SECRET;
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    }
    const routes = require('../../src/modules/channels/whatsapp/routes');
    verifySignature = routes._verifySignature;
  });

  after(() => {
    if (originalEnv) {
      process.env.META_APP_SECRET = originalEnv;
    } else {
      delete process.env.META_APP_SECRET;
    }
  });

  it('valid HMAC → calls next (200 path)', () => {
    const body = { entry: [{ changes: [] }] };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = makeSignature(raw);
    const req = { headers: { 'x-hub-signature-256': sig }, body: raw };
    const res = buildRes();
    let nextCalled = false;

    verifySignature(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled, 'next() should be called for valid signature');
    assert.deepStrictEqual(req.body, body, 'body should be parsed to JSON');
  });

  it('wrong HMAC → 401, next NOT called', () => {
    const body = { entry: [] };
    const raw = Buffer.from(JSON.stringify(body));
    const req = { headers: { 'x-hub-signature-256': 'sha256=deadbeef' + 'a'.repeat(56) }, body: raw };
    const res = buildRes();
    let nextCalled = false;

    verifySignature(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });

  it('missing header → 401', () => {
    const body = { test: true };
    const raw = Buffer.from(JSON.stringify(body));
    const req = { headers: {}, body: raw };
    const res = buildRes();
    let nextCalled = false;

    verifySignature(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });

  it('short/length-mismatched signature → 401 (no crash)', () => {
    const body = { test: true };
    const raw = Buffer.from(JSON.stringify(body));
    const req = { headers: { 'x-hub-signature-256': 'sha256=abc' }, body: raw };
    const res = buildRes();
    let nextCalled = false;

    verifySignature(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401, 'short signature should return 401');
    assert.ok(!nextCalled);
  });

  it('tampered body → 401', () => {
    const original = { amount: 100 };
    const raw = Buffer.from(JSON.stringify(original));
    const sig = makeSignature(raw);

    const tampered = Buffer.from(JSON.stringify({ amount: 999 }));
    const req = { headers: { 'x-hub-signature-256': sig }, body: tampered };
    const res = buildRes();
    let nextCalled = false;

    verifySignature(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });

  // ── Correlation id (Issue 21) — public edge, over the real route stack ─────
  describe('correlation id on the webhook edge', () => {
    const express = require('express');
    let server, baseUrl;

    before(async () => {
      const app = express();
      app.use('/webhook', express.raw({ type: 'application/json' }),
        require('../../src/modules/channels/whatsapp/routes'));
      await new Promise((r) => { server = app.listen(0, r); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      if (server) await new Promise((r) => server.close(r));
    });

    it('ACK carries a fresh wa_ id; a spoofed X-Correlation-Id is ignored', async () => {
      // A status-only delivery: valid signature, ACKed 200, no message pipeline.
      const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [] } }] }] });
      const spoof = 'call_' + 'ee'.repeat(8);
      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': makeSignature(raw),
          'x-correlation-id': spoof,
        },
        body: raw,
      });
      assert.equal(res.status, 200);
      const id = res.headers.get('x-correlation-id');
      assert.match(id, /^wa_[0-9a-f]{16}$/, 'public edge must always generate fresh');
      assert.notEqual(id, spoof);
    });
  });
});
