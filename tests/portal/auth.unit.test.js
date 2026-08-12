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

    // Flip the FIRST char of the hash segment → must not verify.
    //
    // The guard inspects the character it REWRITES. It used to read
    // `segment[segment.length - 1]` while writing index 0, and those are not the
    // same character: the segment is base64 of a 64-byte hash, so it is 88 chars
    // ending '==', the ternary never selected 'B', and every "flip" wrote a
    // literal 'A'. On the 1-in-64 draws whose segment already began with 'A'
    // that reproduced the segment byte for byte — nothing was tampered with,
    // verifyPassword correctly returned true, and this test went red at ~1.6% of
    // runs naming the innocent module (Issue 40).
    //
    // The tamper must land on a DATA character and not on the padding. Flipping
    // the literal last char yields a different STRING that decodes to the SAME
    // 64 bytes — node's base64 decoder ignores what follows '=' — so it would
    // tamper with nothing while looking like it had, and this test would be red
    // on every run instead of one in sixty-four.
    const flip = parts.slice();
    const original = flip[5];
    flip[5] = (original[0] === 'A' ? 'B' : 'A') + original.slice(1);
    // The tamper is asserted, not assumed. A run where the segment came back
    // unchanged never exercised the case this test is named for, whichever way
    // the assertion below then happened to land.
    assert.notEqual(flip[5], original, 'the tamper must actually change the hash segment');
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
