'use strict';

// HERO-1 phase 4 — the hero conversation now exists in two languages, and a
// selector offers both. This file pins the half of that which is data.
//
// WHY IT SHELLS OUT TO NODE. The partition assertions below are only worth
// anything if they run the REAL splitPhrases, and cadence.ts is TypeScript while
// the root suite is plain CommonJS with no loader. Regexing a .ts file as text
// would pass because it matched a string rather than because the code does what
// it says. Node 22 can strip types on its own, so the honest version is a child
// process that imports the actual module and hands back JSON. No dependency, and
// no second copy of splitPhrases to drift from the one that ships.
//
// index.ts is NOT reachable that way — it imports its JSON without an import
// attribute, which Next's bundler resolves and plain Node does not. So
// getConversation is covered by `next build` (which executes it for both
// languages while prerendering /specimen) rather than from here, and this file
// covers everything downstream of the data it returns.
//
// THE SILENT GATE, which shapes every assertion here: splitPhrases skips a
// malformed offset with `continue` and its output stays LOSSLESS in every
// failure case — a stray offset, a backwards one, a duplicate, one past the end.
// So "the phrases concatenate back to the text" is a green that was never
// capable of red. What a wrong offsets array actually changes is the phrase
// COUNT and the phrase BOUNDARIES, so those are what is asserted, per phrase, as
// exact lengths. Losslessness is checked too, but as a sanity rail, not as the
// gate.
//
// ONE test() block, for the reason conversationProvenance.test.js states in its
// own header: the suite total is a tracked number and a per-assertion block
// would move it every time a turn or a language is added.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'web', 'components', 'sections', 'conversation');

const meta = require(path.join(DIR, 'meta.json'));
const en = require(path.join(DIR, 'en.json'));

const IDS = ['t0', 't1', 't2', 't3', 't4', 't5'];

// §CONTENT, as approved. Total length per turn, and the length of every phrase
// in order — not merely how many there are, because a count alone would accept
// the right number of phrases split in the wrong places.
const EXPECTED = {
  t0: { len: 75, phrases: [36, 39] },
  t1: { len: 102, phrases: [8, 68, 26] },
  t2: { len: 28, phrases: [28] },
  t3: { len: 94, phrases: [8, 34, 37, 15] },
  t4: { len: 22, phrases: [22] },
  t5: { len: 17, phrases: [17] },
};

// Every language that has a data file. Derived from the directory rather than
// listed here, so a language added without a CPS fails instead of going unseen.
// meta.json is four characters and does not match.
const LANG_FILES = fs
  .readdirSync(DIR)
  .filter((f) => /^[a-z]{2}\.json$/.test(f))
  .map((f) => f.slice(0, 2))
  .sort();

// Invisible characters that would be indistinguishable on screen and would break
// a byte comparison: the joiners, the soft hyphen, NBSP, the BOM, the bidi and
// line/paragraph separators, and the invisible-operator block.
//
// CODEPOINTS, not a character class. Two of these — U+2028 and U+2029 — are
// JavaScript line terminators, so a regex literal holding them does not parse:
// the file fails to load and every assertion below it silently never runs. That
// is the same class of failure this list exists to catch, one level up.
// U+2014 is deliberately absent: three em dashes are punctuation in t1 and t3.
const INVISIBLE = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // ZWSP, ZWNJ, ZWJ, LRM, RLM
  0x00ad, 0x00a0, 0xfeff, //                 soft hyphen, NBSP, BOM
  0x2028, 0x2029, //                         line and paragraph separators
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // the bidi overrides
]);

/** The offending codepoint, named, or null. Named rather than merely detected:
 *  "contains an invisible character" sends the reader back to the file with
 *  nothing to look for. */
function invisibleIn(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    // 2060-206F is the invisible-operator and deprecated-format block.
    if (INVISIBLE.has(c) || (c >= 0x2060 && c <= 0x206f)) {
      return 'U+' + c.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return null;
}

const dump = (s) =>
  [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join(' ');

/** cadence.ts, imported for real, in a child that can strip its types. */
function probeCadence() {
  const cadence = pathToFileURL(path.join(DIR, 'cadence.ts')).href;
  const src = [
    'import { readFileSync } from "node:fs";',
    'import { splitPhrases, buildTimeline, CPS } from ' + JSON.stringify(cadence) + ';',
    'const read = (p) => JSON.parse(readFileSync(p, "utf8"));',
    'const DIR = ' + JSON.stringify(DIR) + ';',
    'const META = read(DIR + "/meta.json");',
    'const out = { cps: CPS, langs: {}, throws: {} };',
    'for (const code of ' + JSON.stringify(LANG_FILES) + ') {',
    '  const strings = read(DIR + "/" + code + ".json");',
    '  const turns = META.map((m) => ({ ...m, ...strings[m.id], lang: code }));',
    '  const tl = buildTimeline(turns, code);',
    '  out.langs[code] = {',
    '    parts: turns.map((t) => splitPhrases(t)),',
    '    total: tl.total,',
    '    counts: tl.counts,',
    '  };',
    '}',
    'const hi = META.map((m) => ({ ...m, text: "x", source: "translated", lang: "hi" }));',
    'try {',
    '  buildTimeline(hi, "hi");',
    '  out.throws.buildTimeline = null;',
    '} catch (e) {',
    '  out.throws.buildTimeline = e.message;',
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');

  const stdout = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', src],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return JSON.parse(stdout);
}

test('the hero conversation offers two languages, and every offered language partitions and plays', () => {
  // 1 — the two languages are the two that exist. Hindi is phase 4b and must
  // not have appeared quietly.
  assert.deepEqual(LANG_FILES, ['en', 'te'], 'the set of language data files changed');

  // 2 — en.json describes the same six turns as meta.json, in the same order.
  // Asserted before anything indexes en[id], so a missing turn names itself
  // rather than surfacing as "cannot read properties of undefined".
  assert.deepEqual(Object.keys(en), IDS, 'en.json ids drifted from the canonical turn order');
  assert.deepEqual(meta.map((m) => m.id), IDS, 'meta.json ids drifted');

  // 3 — provenance. Every English turn is a TRANSLATION, permanently. t0's text
  // is a gloss of the captured Telugu, and a gloss of a capture is not a
  // capture; nothing in English may ever claim otherwise.
  for (const id of IDS) {
    assert.equal(en[id].source, 'translated', `en.${id} must be graded translated`);
  }

  // 4 — the bytes. Lengths from §CONTENT, and no invisible character: a joiner
  // or a no-break space would be invisible on screen and would silently move
  // every offset after it.
  for (const id of IDS) {
    const text = en[id].text;
    assert.equal(text.length, EXPECTED[id].len, `en.${id} length changed\n  ${dump(text)}`);
    const bad = invisibleIn(text);
    assert.equal(
      bad,
      null,
      `en.${id} contains an invisible character ${bad}\n  ${dump(text)}`
    );
  }

  const probe = probeCadence();

  // 5 — THE PARTITION, from the real splitPhrases. Per-phrase lengths, in order.
  // This is the assertion a wrong offsets array fails; losslessness (6) is not.
  for (const id of IDS) {
    const parts = probe.langs.en.parts[IDS.indexOf(id)];
    assert.deepEqual(
      parts.map((p) => p.length),
      EXPECTED[id].phrases,
      `en.${id} splits into ${parts.length} phrase(s) of [${parts.map((p) => p.length)}], ` +
        `expected ${EXPECTED[id].phrases.length} of [${EXPECTED[id].phrases}]`
    );
  }

  // 6 — and no character is dropped or invented on the way. A rail, not a gate.
  for (const id of IDS) {
    const parts = probe.langs.en.parts[IDS.indexOf(id)];
    assert.equal(parts.join(''), en[id].text, `en.${id} phrases do not reconstruct the text`);
  }

  // 7 — every offered language PLAYS. A CPS entry and a timeline that builds, so
  // the selector cannot render a segment that throws when it is pressed.
  for (const code of LANG_FILES) {
    assert.equal(
      typeof probe.cps[code],
      'number',
      `no CPS for "${code}" — a language with strings but no cadence cannot be played`
    );
    assert.equal(probe.langs[code].counts.length, IDS.length, `${code} timeline lost a turn`);
    assert.ok(probe.langs[code].total > 0, `${code} timeline has no duration`);
  }

  // 8 — the two tracks walk at ONE pace. That is the whole reason en's CPS is 30
  // rather than a number about English: switching language mid-sequence must not
  // change how much of the conversation is left. Tolerance is 1% of Telugu.
  const teTotal = probe.langs.te.total;
  const enTotal = probe.langs.en.total;
  assert.ok(
    Math.abs(enTotal - teTotal) <= teTotal * 0.01,
    `cadence parity broken: te ${teTotal}ms vs en ${enTotal}ms`
  );

  // 9 — the two tracks have the SAME phrase rhythm, turn for turn. Equal totals
  // with different phrase counts would be the same length walked differently.
  assert.deepEqual(
    probe.langs.en.counts,
    probe.langs.te.counts,
    'en and te no longer emerge with the same phrase rhythm'
  );

  // 10 — Hindi still throws, by name. This is the seam phase 4b opens and it has
  // to stay loud: a CPS quietly defaulting to Telugu's would ship an unreviewed
  // language at the wrong pace and nothing would say so.
  assert.match(
    probe.throws.buildTimeline || '',
    /no CPS for "hi"/,
    'buildTimeline no longer throws for "hi"'
  );
});
