const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const requestContext = require('../../src/core/requestContext');
const logger = require('../../src/infra/logging/logger');

const ID_RE = /^[a-z]{2,12}_[0-9a-f]{16}$/;

function buildRes() {
  const res = {
    _headers: {},
    setHeader(k, v) { res._headers[k] = v; },
  };
  return res;
}

describe('requestContext', () => {
  it('get() returns null outside any chain', () => {
    assert.equal(requestContext.get(), null);
  });

  it('runWith establishes context, including across awaits', async () => {
    await requestContext.runWith({ correlationId: 'wa_' + 'a'.repeat(16), channel: 'whatsapp' }, async () => {
      assert.equal(requestContext.get().correlationId, 'wa_' + 'a'.repeat(16));
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(requestContext.get().correlationId, 'wa_' + 'a'.repeat(16));
      assert.equal(requestContext.get().channel, 'whatsapp');
    });
    assert.equal(requestContext.get(), null);
  });

  it('newCorrelationId produces prefixed 16-hex ids', () => {
    const id = requestContext.newCorrelationId('wa');
    assert.match(id, /^wa_[0-9a-f]{16}$/);
    assert.notEqual(id, requestContext.newCorrelationId('wa'));
  });

  it('isValidCorrelationId accepts the shape, rejects junk', () => {
    assert.ok(requestContext.isValidCorrelationId('call_' + 'ab'.repeat(8)));
    assert.ok(!requestContext.isValidCorrelationId('call_short'));
    assert.ok(!requestContext.isValidCorrelationId('CALL_' + 'ab'.repeat(8)));
    assert.ok(!requestContext.isValidCorrelationId('x'.repeat(200)));
    assert.ok(!requestContext.isValidCorrelationId('wa_deadbeefdeadbeef\nInjected'));
    assert.ok(!requestContext.isValidCorrelationId(null));
    assert.ok(!requestContext.isValidCorrelationId(42));
  });

  describe('logger mixin', () => {
    it('stamps correlation_id inside a chain', () => {
      requestContext.runWith({ correlationId: 'wa_' + 'b'.repeat(16) }, () => {
        assert.deepEqual(logger._mixin(), { correlation_id: 'wa_' + 'b'.repeat(16) });
      });
    });

    it('stamps nothing outside a chain — not a fake id', () => {
      assert.deepEqual(logger._mixin(), {});
    });
  });

  describe('middleware', () => {
    it('untrusted (public edge): ignores a spoofed header, generates fresh', () => {
      const mw = requestContext.middleware({ prefix: 'wa', channel: 'whatsapp' });
      const spoof = 'call_' + 'ee'.repeat(8);
      const req = { headers: { 'x-correlation-id': spoof } };
      const res = buildRes();
      let inside = null;
      mw(req, res, () => { inside = requestContext.get(); });

      assert.match(inside.correlationId, /^wa_[0-9a-f]{16}$/);
      assert.notEqual(inside.correlationId, spoof);
      assert.equal(inside.channel, 'whatsapp');
      assert.equal(res._headers['X-Correlation-Id'], inside.correlationId);
    });

    it('trusted (HMAC-authed internal): adopts a well-formed header', () => {
      const mw = requestContext.middleware({ prefix: 'call', channel: 'voice', trusted: true });
      const supplied = 'call_' + 'cd'.repeat(8);
      const req = { headers: { 'x-correlation-id': supplied } };
      const res = buildRes();
      let inside = null;
      mw(req, res, () => { inside = requestContext.get(); });

      assert.equal(inside.correlationId, supplied);
      assert.equal(res._headers['X-Correlation-Id'], supplied);
    });

    it('trusted: a malformed header is rejected → fresh id', () => {
      const mw = requestContext.middleware({ prefix: 'call', channel: 'voice', trusted: true });
      const req = { headers: { 'x-correlation-id': 'not a valid id\r\nX-Evil: 1' } };
      const res = buildRes();
      let inside = null;
      mw(req, res, () => { inside = requestContext.get(); });

      assert.match(inside.correlationId, /^call_[0-9a-f]{16}$/);
      assert.equal(res._headers['X-Correlation-Id'], inside.correlationId);
    });

    it('trusted: no header → fresh id with the route prefix', () => {
      const mw = requestContext.middleware({ prefix: 'call', channel: 'voice', trusted: true });
      const req = { headers: {} };
      const res = buildRes();
      let inside = null;
      mw(req, res, () => { inside = requestContext.get(); });
      assert.match(inside.correlationId, /^call_[0-9a-f]{16}$/);
    });
  });

  it('the three wired surfaces use the pinned prefixes and trust', () => {
    // Wiring assertions live in the route files; this pins the id grammar the
    // grep workflow depends on.
    for (const prefix of ['wa', 'call', 'probe', 'adm']) {
      assert.match(requestContext.newCorrelationId(prefix), ID_RE);
    }
  });
});
