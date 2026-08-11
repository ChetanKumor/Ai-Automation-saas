'use strict';

// configLang — the one place that knows the config and the worker speak two
// different language namespaces (V1c).
//
// The config document is keyed on bare codes (`te`); Sarvam STT emits BCP-47
// (`te-IN`), and voice-agent/agent.py:523-524 → delegate_turn →
// customerService.js:69-73 persists that verbatim into
// `customers.preferred_language`. So the column naming a caller's language holds
// a value `configSchema` would reject, and anything reading it to pick a
// per-language line has to cross the boundary.
//
// It is crossed HERE and nowhere else — no lookup table in the greeting path, no
// second convention in internalVoice.js. These tests are the contract for that.
//
// The suite is deliberately pedantic about the null case. `configLang` returning
// null must stay distinguishable from it returning 'en', because the caller's
// fallback for "unresolvable" is the TENANT DEFAULT, not English. A normaliser
// that helpfully defaulted to English would turn a Telugu clinic's unknown code
// into an English greeting — the exact silent failure this function exists to
// prevent.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { configLang, LANG_CODES } = require('../../src/modules/config/schema');

describe('configLang — config ⇄ worker language namespaces', () => {
  it('is the identity on every declared config code', () => {
    // The bare codes are what config.languages.default and the greeting/consent
    // record keys use; they must survive untouched.
    for (const code of LANG_CODES) {
      assert.equal(configLang(code), code, `config code '${code}' must map to itself`);
    }
    // Pinned literally too, so a change to LANG_CODES cannot make the loop vacuous.
    assert.deepEqual(LANG_CODES, ['te', 'hi', 'en']);
  });

  it('resolves the BCP-47 codes the voice worker actually emits', () => {
    // These three are not hypothetical: they are the keys the ack copy was
    // written against (internalVoice.js VOICE_ACK_COPY, pre-V1c) and the keys
    // voice-agent/agent.py's APOLOGIES table uses.
    assert.equal(configLang('te-IN'), 'te');
    assert.equal(configLang('hi-IN'), 'hi');
    assert.equal(configLang('en-IN'), 'en');
  });

  it('is case-insensitive, per BCP-47', () => {
    // Tags are case-insensitive by spec; nothing guarantees the casing a
    // third-party STT returns, and a wrong-case tag must not cost a language.
    assert.equal(configLang('TE-IN'), 'te');
    assert.equal(configLang('TE-in'), 'te');
    assert.equal(configLang('te-in'), 'te');
    assert.equal(configLang('Hi-IN'), 'hi');
    assert.equal(configLang('EN'), 'en');
  });

  it('drops any region/script subtag, not just -IN', () => {
    assert.equal(configLang('en-US'), 'en');
    assert.equal(configLang('en-GB'), 'en');
    assert.equal(configLang('hi-Deva-IN'), 'hi');
    assert.equal(configLang('te_IN'), 'te'); // underscore form, as some libs emit
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(configLang('  te-IN  '), 'te');
    assert.equal(configLang('\ten\n'), 'en');
  });

  it('returns null — never a language — for anything undeclared', () => {
    // Real languages this repo does not serve must fail closed exactly like
    // garbage does. Resolving 'ta' or 'mr' to something would be an invention.
    for (const bad of ['ta', 'ta-IN', 'mr', 'bn-IN', 'fr', 'zzz', 'xx-YY']) {
      assert.equal(configLang(bad), null, `'${bad}' is not a supported language`);
    }
  });

  it('returns null for junk, empties and non-strings', () => {
    // `customers.preferred_language` is written by an unvalidated path, so the
    // input genuinely is arbitrary — including whatever a failed STT call left.
    for (const bad of ['', '   ', '-', '-IN', 'null', 'undefined', '{}', '123', 'te IN']) {
      assert.equal(configLang(bad), null, `${JSON.stringify(bad)} must not resolve`);
    }
    for (const bad of [null, undefined, 0, 1, {}, [], ['te'], true, false, NaN, () => 'te']) {
      assert.equal(configLang(bad), null, `${String(bad)} must not resolve`);
    }
  });

  it('never throws, whatever it is handed', () => {
    // It sits on the call-bridge path. A throw here is a dropped call.
    const hostile = [
      Object.create(null),
      { toString() { throw new Error('boom'); } },
      Symbol('te'),
      123n,
    ];
    for (const value of hostile) {
      assert.doesNotThrow(() => configLang(value));
      assert.equal(configLang(value), null);
    }
  });

  it('null is distinguishable from a resolved language', () => {
    // The property the caller's fallback depends on: unresolvable must not be
    // silently English. Stated as its own assertion so deleting it is a choice.
    assert.equal(configLang('ta-IN'), null);
    assert.notEqual(configLang('ta-IN'), 'en');
  });
});
