'use strict';

// V1c — the greeting instruction is suppressed for VOICE and only for voice.
//
// On a call the greeting no longer travels as an instruction: `/call/start`
// returns the text and the worker speaks it on join. Two properties have to hold
// together, and each fails in a different, quiet way:
//
//   • VOICE must carry NEITHER line. The greeting would be spoken twice; the
//     consent line would be spoken twice, and it is a legal-floor line, so the
//     duplicate is the worse of the two. The consent line rode inside the same
//     §3 block as the greeting, which is why suppressing "the greeting" had to
//     mean suppressing the block.
//
//   • WHATSAPP must be untouched. clinic.js is the SHARED renderer and every
//     edit to it is one keystroke away from silently changing what a WhatsApp
//     customer reads. The byte-for-byte guard is the committed snapshot set in
//     renderer.unit.test.js (clinic.{te,hi,en}.whatsapp.txt, unchanged by this
//     work); what this file adds is the reason those bytes are what they are.
//
// `pickLine` is exercised directly too. It is exported now because /call/start
// builds the spoken greeting from the same two per-language maps, and the two
// paths must resolve a missing entry identically — the fallback semantics used
// to be pinned only through a voice render that no longer exists.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { renderSystemPrompt } = require('../../src/modules/prompts');
const { clinicDefaults } = require('../../src/modules/config/configService');
const { pickLine } = require('../../src/modules/prompts/templates/clinic');

const clone = (o) => JSON.parse(JSON.stringify(o));
const cfg = (over = {}) => {
  const c = clone(clinicDefaults);
  for (const [k, v] of Object.entries(over)) {
    c[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...c[k], ...v } : v;
  }
  return c;
};

const LANGS = ['te', 'hi', 'en'];

describe('voice prompt — greeting instruction suppressed (V1c)', () => {
  it('carries no greeting instruction, in any language', () => {
    for (const lang of LANGS) {
      const out = renderSystemPrompt(cfg({ languages: { default: lang } }), { channel: 'voice' });
      // The instruction wording…
      assert.ok(!out.includes('Greet the caller with exactly'),
        `${lang}: the voice greeting instruction must be gone`);
      assert.ok(!out.includes('use this greeting verbatim'),
        `${lang}: the WhatsApp wording must not leak into voice either`);
      // …and the literal it used to carry. A reworded instruction that still
      // embedded the greeting would make the caller hear it twice just the same.
      for (const l of LANGS) {
        assert.ok(!out.includes(clinicDefaults.greeting[l]),
          `${lang}: the ${l} greeting literal must not appear in a voice prompt`);
      }
    }
  });

  it('carries no consent instruction even with recording_consent enabled', () => {
    for (const lang of LANGS) {
      const out = renderSystemPrompt(cfg({
        languages: { default: lang },
        recording_consent: { enabled: true },
      }), { channel: 'voice' });
      assert.ok(!out.includes('Then say exactly'), `${lang}: consent instruction gone`);
      for (const l of LANGS) {
        assert.ok(!out.includes(clinicDefaults.recording_consent.line[l]),
          `${lang}: the ${l} consent literal must not appear in a voice prompt`);
      }
    }
  });

  it('drops the whole section — no orphan blank block where §3 used to be', () => {
    // greetLines.join('\n') || null is what keeps an empty section out of the
    // `sections` array. If it ever renders as '' the prompt gains a stray blank
    // run between the facts and the tone line.
    const out = renderSystemPrompt(cfg({ recording_consent: { enabled: true } }), { channel: 'voice' });
    assert.ok(!/\n{3,}/.test(out), 'no triple newline — sections are joined by exactly one blank line');
  });

  it('WhatsApp still carries the greeting instruction and its literal', () => {
    // The else-arm is untouched. Without this, "suppressed for voice" could be
    // satisfied by deleting the feature outright.
    for (const lang of LANGS) {
      const out = renderSystemPrompt(cfg({ languages: { default: lang } }), { channel: 'whatsapp' });
      assert.ok(out.includes('use this greeting verbatim'), `${lang}: instruction present`);
      assert.ok(out.includes(clinicDefaults.greeting[lang]), `${lang}: literal present`);
    }
  });

  it('WhatsApp never gained the consent line (it was always voice-only)', () => {
    const out = renderSystemPrompt(cfg({ recording_consent: { enabled: true } }), { channel: 'whatsapp' });
    for (const l of LANGS) {
      assert.ok(!out.includes(clinicDefaults.recording_consent.line[l]));
    }
  });

  it('the voice prompt is exactly the WhatsApp-era voice prompt minus §3', () => {
    // Strongest available statement of "nothing else moved": re-render with the
    // greeting and consent maps emptied, which is the one config shape that made
    // the OLD renderer emit no §3 either. Voice output must be identical to what
    // the current renderer produces from a fully populated config — i.e. the only
    // difference the suppression makes is §3's absence.
    const populated = cfg({ recording_consent: { enabled: true } });
    const stripped = cfg({ recording_consent: { enabled: false } });
    stripped.greeting = {};
    stripped.recording_consent.line = {};

    assert.equal(
      renderSystemPrompt(populated, { channel: 'voice' }),
      renderSystemPrompt(stripped, { channel: 'voice' }),
      'a populated greeting/consent config must render the same voice prompt as an empty one');
  });
});

describe('pickLine — shared by the renderer and /call/start', () => {
  it('returns the requested language when present', () => {
    for (const lang of LANGS) {
      assert.equal(pickLine(clinicDefaults.greeting, lang, 'greeting', null),
        clinicDefaults.greeting[lang]);
    }
  });

  it('falls back to English, then to any line present, then null — and WARNs', () => {
    const warns = [];
    const onWarn = (event, detail) => warns.push([event, detail.used]);

    // en present → en
    assert.equal(pickLine({ en: 'E', hi: 'H' }, 'te', 'greeting', onWarn), 'E');
    // en absent → first available
    assert.equal(pickLine({ hi: 'H' }, 'te', 'greeting', onWarn), 'H');
    // nothing at all → null, and the caller decides what that means
    assert.equal(pickLine({}, 'te', 'greeting', onWarn), null);
    assert.equal(pickLine(null, 'te', 'greeting', onWarn), null);

    assert.deepEqual(warns, [
      ['greeting_line_fallback', 'en'],
      ['greeting_line_fallback', 'first-available'],
      ['greeting_line_fallback', 'first-available'],
      ['greeting_line_fallback', 'first-available'],
    ]);
  });

  it('applies the same fallback to the consent map', () => {
    // The consent line's fallback used to be pinned through a voice render.
    // That render is gone, so it is pinned here instead — it is a legal-floor
    // line and its resolution must not become untested by relocation.
    const warns = [];
    const line = { ...clinicDefaults.recording_consent.line };
    delete line.te;
    assert.equal(pickLine(line, 'te', 'consent', (e) => warns.push(e)),
      clinicDefaults.recording_consent.line.en);
    assert.deepEqual(warns, ['consent_line_fallback']);
  });

  it('an empty string is not a line', () => {
    // A blanked entry must fall back rather than produce an empty greeting that
    // reads as "configured to say nothing".
    assert.equal(pickLine({ te: '', en: 'E' }, 'te', 'greeting', null), 'E');
  });
});
