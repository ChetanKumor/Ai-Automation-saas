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

const { configLang, speakableLang, LANG_CODES } = require('../../src/modules/config/schema');

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

// ── The other direction (Issue 38) ──────────────────────────────────────────
//
// /call/start resolves the greeting in the CONFIG namespace and the voice worker
// synthesises in the SPEAKABLE one — the same namespace the SSE `done` event
// already emits (internalVoice.js:510) and the one Sarvam TTS's
// target_language_code takes. So the brain has to emit 'te-IN', and it is this
// function that produces it.
//
// It lives beside configLang for the reason schema.js:22 states about itself: the
// claim to be the one place that knows two namespaces exist is only true if the
// inverse is here too. The alternative was a lookup table in voice-agent/agent.py,
// which would be a second convention for the same fact, maintained in a second
// language, on the far side of an HTTP boundary.

describe('speakableLang — config → worker namespace', () => {
  it('maps every declared config code to its speakable form', () => {
    assert.equal(speakableLang('te'), 'te-IN');
    assert.equal(speakableLang('hi'), 'hi-IN');
    assert.equal(speakableLang('en'), 'en-IN');
  });

  it('covers every LANG_CODES member — no code can be added without a mapping', () => {
    // A language added to LANG_CODES but not to the speakable table would resolve
    // for the greeting TEXT and then return null for its synthesis, silently
    // putting the worker back on its env default. That is this change's own bug
    // class, so it is asserted rather than assumed.
    for (const code of LANG_CODES) {
      assert.equal(typeof speakableLang(code), 'string', `'${code}' has no speakable form`);
      assert.match(speakableLang(code), /^[a-z]{2}-[A-Z]{2}$/, `'${code}' must map to a BCP-47 tag`);
    }
  });

  it('round-trips with configLang in both directions', () => {
    // The two functions are one boundary, not two conventions: whatever the
    // column or the config holds, both readers must agree on the language.
    for (const code of LANG_CODES) {
      assert.equal(configLang(speakableLang(code)), code);
    }
    for (const tag of ['te-IN', 'hi-IN', 'en-IN']) {
      assert.equal(speakableLang(configLang(tag)), tag);
    }
  });

  it('accepts the worker namespace too, and normalises it', () => {
    // The input is sometimes already BCP-47 (the stored preferred_language), and
    // sometimes a variant of it. All of them must answer the one form the TTS
    // plugin takes, not be passed through as-is.
    assert.equal(speakableLang('te-IN'), 'te-IN');
    assert.equal(speakableLang('TE-in'), 'te-IN');
    assert.equal(speakableLang('  hi-IN  '), 'hi-IN');
    assert.equal(speakableLang('en_IN'), 'en-IN');
    assert.equal(speakableLang('en-US'), 'en-IN', 'Sarvam speaks en-IN; en-US is not passed through');
    assert.equal(speakableLang('hi-Deva-IN'), 'hi-IN');
  });

  it('returns null — never a language — for anything undeclared', () => {
    // Same fail-closed contract as configLang: the caller must fall back
    // deliberately. Null reaches the worker as a null `language`, which leaves it
    // on its own prior/default chain — it must never arrive as an English tag.
    for (const bad of ['ta', 'ta-IN', 'mr', 'fr', 'zzz', '', '   ', '-IN', '123']) {
      assert.equal(speakableLang(bad), null, `'${bad}' must not resolve`);
    }
    assert.notEqual(speakableLang('ta-IN'), 'en-IN');
  });

  it('returns null for non-strings and never throws', () => {
    // It sits on the call-bridge path, behind an unvalidated column (A-010).
    for (const bad of [null, undefined, 0, 1, {}, [], true, NaN, () => 'te']) {
      assert.equal(speakableLang(bad), null, `${String(bad)} must not resolve`);
    }
    for (const hostile of [Object.create(null), Symbol('te'), 123n,
      { toString() { throw new Error('boom'); } }]) {
      assert.doesNotThrow(() => speakableLang(hostile));
      assert.equal(speakableLang(hostile), null);
    }
  });

  it('does not resolve object-prototype keys', () => {
    // The table is a plain object indexed by configLang's output. configLang can
    // only return a LANG_CODES member or null, but asserting it means a future
    // looser normaliser cannot turn 'constructor' into a language.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      assert.equal(speakableLang(key), null, `'${key}' must not resolve`);
    }
  });
});
