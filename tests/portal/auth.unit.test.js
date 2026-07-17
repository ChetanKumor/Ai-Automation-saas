'use strict';

// Unit tests for portal password hashing (PORTAL-P1-S1). No DB — hashPassword /
// verifyPassword are pure. requirePortalAuth's tenant-scoping is exercised in
// portalAuth.integration.test.js against a real DB.

process.env.LOG_LEVEL = 'silent';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { hashPassword, verifyPassword } = require('../../src/portal/auth');

describe('portal password hashing', () => {
  it('round-trips: verify true for the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', stored), true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('s3cret-pass');
    assert.equal(verifyPassword('s3cret-Pass', stored), false); // case differs
    assert.equal(verifyPassword('', stored), false);
    assert.equal(verifyPassword('totally different', stored), false);
  });

  it('stored string is scrypt-encoded, self-describing, and never plaintext', () => {
    const stored = hashPassword('hunter2');
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!stored.includes('hunter2'), 'password must not appear in the stored string');
  });

  it('uses a fresh random salt per hash (same password → different strings)', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    assert.notEqual(a, b, 'salts must differ');
    // Both still verify against the shared password.
    assert.equal(verifyPassword('same-password', a), true);
    assert.equal(verifyPassword('same-password', b), true);
  });

  it('a tampered stored string fails closed', () => {
    const stored = hashPassword('original');
    const parts = stored.split('$');

    // Flip the last char of the hash segment → must not verify.
    const flip = parts.slice();
    const last = flip[5];
    flip[5] = (last[last.length - 1] === 'A' ? 'B' : 'A') + last.slice(1);
    assert.equal(verifyPassword('original', flip.join('$')), false);

    // Structurally broken variants all fail closed (never verify, never throw).
    assert.equal(verifyPassword('original', ''), false);
    assert.equal(verifyPassword('original', 'not-a-hash'), false);
    assert.equal(verifyPassword('original', 'scrypt$16384$8$1$onlyfoursegments'), false);
    assert.equal(verifyPassword('original', `scrypt$x$8$1$${parts[4]}$${parts[5]}`), false); // non-int N
    assert.equal(verifyPassword('original', `scrypt$16384$8$1$${parts[4]}$`), false);        // empty hash
    assert.equal(verifyPassword('original', null), false);
    assert.equal(verifyPassword('original', undefined), false);
  });

  it('routes the final compare through crypto.timingSafeEqual', () => {
    const stored = hashPassword('timing-check');
    const spy = mock.method(crypto, 'timingSafeEqual');
    try {
      verifyPassword('timing-check', stored);
      assert.equal(spy.mock.callCount(), 1, 'timingSafeEqual used exactly once on a valid verify');
      const [a, b] = spy.mock.calls[0].arguments;
      assert.equal(a.length, b.length, 'equal-length buffers → no length leak / throw');
    } finally {
      spy.mock.restore();
    }
  });
});
