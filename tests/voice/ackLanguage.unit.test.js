'use strict';

// V1c — the SSE ack copy resolves through the SAME language boundary the
// greeting does.
//
// `VOICE_ACK_COPY` used to be keyed on the worker's namespace ('te-IN'). That
// worked, but only by coincidence: `effectiveLanguage` reaches `ackTextFor` from
// `customers.preferred_language`, which is what STT wrote, and STT happens to
// emit BCP-47. Anything arriving in the CONFIG namespace — a bare 'te', which is
// what `config.languages.default` holds and what the greeting path resolves to —
// missed the table entirely and fell through to English. Two tables keyed two
// ways in one file is how that stays true and stays invisible.
//
// The table is now keyed on config codes and every lookup goes through
// `configLang`, so this file and `configLang.unit.test.js` pin one convention
// between them. If a future change re-keys the table, these go red together.

require('dotenv').config();
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// No DB and no HTTP: the route module is required only for its two exported
// pure helpers. Nothing here opens a connection.
const internalVoice = require('../../src/routes/internalVoice');
const { LANG_CODES } = require('../../src/modules/config/schema');

const ackTextFor = internalVoice._ackTextFor;
const COPY = internalVoice._VOICE_ACK_COPY;

describe('voice ack copy — one language boundary (V1c)', () => {
  it('is keyed on the config namespace, covering every declared language', () => {
    assert.deepEqual(Object.keys(COPY).sort(), [...LANG_CODES].sort());
    for (const lang of LANG_CODES) {
      assert.equal(typeof COPY[lang], 'string');
      assert.ok(COPY[lang].length > 0, `${lang} ack copy is non-empty`);
    }
  });

  it('resolves the worker namespace to the same copy as the config one', () => {
    // THE REPOINT: 'te-IN' (what the column holds) and 'te' (what the config
    // holds) must select one line. Before V1c only the first of these worked.
    for (const [tagged, bare] of [['te-IN', 'te'], ['hi-IN', 'hi'], ['en-IN', 'en']]) {
      assert.equal(ackTextFor(tagged), COPY[bare], `${tagged} → ${bare}`);
      assert.equal(ackTextFor(bare), COPY[bare], `${bare} → ${bare}`);
      assert.equal(ackTextFor(tagged), ackTextFor(bare), 'both namespaces, one line');
    }
  });

  it('a tenant-default language now selects its own ack line, not English', () => {
    // This is the bug the repoint fixes rather than merely relocates: a bare
    // 'te' used to miss the table and be acknowledged in English mid-call.
    assert.equal(ackTextFor('te'), COPY.te);
    assert.notEqual(ackTextFor('te'), COPY.en);
    assert.equal(ackTextFor('hi'), COPY.hi);
    assert.notEqual(ackTextFor('hi'), COPY.en);
  });

  it('is case-insensitive and region-agnostic, like configLang', () => {
    assert.equal(ackTextFor('TE-IN'), COPY.te);
    assert.equal(ackTextFor('te_IN'), COPY.te);
    assert.equal(ackTextFor('en-US'), COPY.en);
  });

  it('falls back to English for anything unresolvable — never undefined', () => {
    // An ack is spoken mid-turn: a missing string would be silence or a crash on
    // the turn path, so this fallback is deliberate and differs from the
    // greeting's (which falls back to the TENANT default, because at call start
    // there is a tenant default to fall back to and no turn in flight).
    for (const bad of [null, undefined, '', 'ta-IN', 'zzz', 42, {}]) {
      assert.equal(ackTextFor(bad), COPY.en, `${String(bad)} → English`);
    }
  });
});
