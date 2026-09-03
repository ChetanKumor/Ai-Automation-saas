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

    // ── the acting operator rides the context (ADMIN-S3b C4, D-022) ──

    it('an actor resolver puts the platform user id on the context', () => {
      const actorId = '11111111-2222-3333-4444-555555555555';
      const seen = [];
      const mw = requestContext.middleware({
        prefix: 'adm', channel: 'admin',
        actor: (req) => { seen.push(req); return req.session.platformUserId; },
      });
      const req = { headers: {}, session: { admin: true, platformUserId: actorId } };
      const res = buildRes();
      let inside = null;
      mw(req, res, () => { inside = requestContext.get(); });

      assert.equal(inside.platformUserId, actorId, "the id reaches get() without a route signature change");
      assert.deepEqual(seen, [req], "the resolver is handed the request, not the session");
      // The two existing fields are untouched — C4 adds, it does not redefine.
      assert.match(inside.correlationId, /^adm_[0-9a-f]{16}$/);
      assert.equal(inside.channel, 'admin');
    });

    it('surfaces with no actor resolver carry null, and are otherwise unmoved', () => {
      // The webhook and voice edges have no session at all; a reader must never
      // have to tell "no actor" apart from "field not set".
      for (const [prefix, channel] of [['wa', 'whatsapp'], ['call', 'voice']]) {
        const mw = requestContext.middleware({ prefix, channel });
        const res = buildRes();
        let inside = null;
        mw({ headers: {} }, res, () => { inside = requestContext.get(); });

        assert.ok('platformUserId' in inside, `${channel}: the field is present`);
        assert.equal(inside.platformUserId, null, `${channel}: and it is null, not undefined`);
        assert.match(inside.correlationId, new RegExp(`^${prefix}_[0-9a-f]{16}$`));
        assert.equal(inside.channel, channel);
      }
    });

    it('the actor is NOT stamped on log lines — the mixin still emits correlation_id alone', () => {
      // Ruled deliberately (ADMIN-S3b A1): reaching this value means calling
      // get(). Extending the pino mixin would put an operator id on every line
      // of every admin request, which is a different decision than attribution
      // and was not this session's to make. Pinned so a later session that adds
      // it has to do so on purpose, against a red test, rather than assuming it
      // was always there.
      const mw = requestContext.middleware({
        prefix: 'adm', channel: 'admin', actor: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
      let stamped = null;
      let inside = null;
      mw({ headers: {}, session: {} }, buildRes(), () => {
        inside = requestContext.get();
        stamped = logger._mixin();
      });

      assert.ok(inside.platformUserId, 'the actor IS on the context');
      assert.deepEqual(Object.keys(stamped), ['correlation_id'],
        'but the log line carries correlation_id and nothing else');
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
