'use strict';

// The hero conversation carries a per-turn provenance grade, and two of its six
// turns are REAL capture — t0 is Sarvam STT output on founder-recorded audio, t1
// is output of the same brain the live voice route runs. Both are stored in
// public/demo/fixture.json, which is the authority. This test is what stops those
// two strings from being quietly "improved" into authored copy while still
// claiming to be captured.
//
// It reads THE SAME BYTES the app reads. The language data is JSON precisely so
// that this can be true: the root suite is plain CommonJS with no TypeScript
// loader, so a .ts data file could only be pinned by regexing it as text — a
// check that passes because it matched a string rather than because the data is
// right. `require` of the identical file the component imports via
// resolveJsonModule is the honest version. scripts/portal/shootD4.js already
// reads this fixture from the root the same way.
//
// Deliberately ONE test() block, for the reason tokenDrift.test.js states in its
// own header: the suite total is a tracked number, and a per-assertion block
// would move it every time a turn or a language is added.
//
// No dependency — require + assert, same as every other test here.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'web', 'components', 'sections', 'conversation');

const fixture = require(path.join(ROOT, 'public', 'demo', 'fixture.json'));
const meta = require(path.join(DIR, 'meta.json'));
const te = require(path.join(DIR, 'te.json'));

const IDS = ['t0', 't1', 't2', 't3', 't4', 't5'];
const GRADES = ['captured', 'authored', 'translated'];

// Rendered Telugu is not evidence: two strings can look identical and differ by
// an invisible joiner. Report the scalars when they disagree.
const dump = (s) =>
  [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join(' ');

test('the hero conversation keeps its provenance grades, and the captured turns are the fixture', () => {
  // 5 — meta.json and te.json describe the same six turns, in the same order.
  // Without this, a deleted turn renders as nothing rather than failing.
  //
  // Asserted FIRST although it is fifth in the brief's list: every assertion
  // below indexes te[id], so a missing turn would otherwise surface as
  // "Cannot read properties of undefined" from whichever field access happened
  // to run first. Structure before fields — the failure should name the defect.
  assert.deepEqual(
    meta.map((m) => m.id),
    IDS,
    'meta.json ids drifted from the canonical turn order'
  );
  assert.deepEqual(
    Object.keys(te),
    IDS,
    'te.json ids drifted from meta.json / the canonical turn order'
  );

  // 1 + 2 — the point of this file. Byte-identical to the capture, not merely
  // similar to it. A one-codepoint edit fails here, which is the test working.
  for (const [id, i] of [['t0', 0], ['t1', 1]]) {
    assert.equal(
      te[id].text,
      fixture.call[i].text,
      `${id} is no longer the captured string in public/demo/fixture.json.\n` +
        `  te.json : ${dump(te[id].text)}\n` +
        `  fixture : ${dump(fixture.call[i].text)}`
    );
  }

  // 3 — and they must still CLAIM to be captured. This is the mutation a
  // careless future edit actually makes: change the text, then relabel it.
  assert.equal(te.t0.source, 'captured', 't0 must be graded captured');
  assert.equal(te.t1.source, 'captured', 't1 must be graded captured');

  // 4 — the other four are illustrative copy and must never claim otherwise.
  for (const id of ['t2', 't3', 't4', 't5']) {
    assert.equal(te[id].source, 'authored', `${id} must be graded authored`);
  }

  // 6 — every grade is one of the three legal ones. Guards against a typo or an
  // invented grade like "adapted" quietly weakening the record.
  for (const id of IDS) {
    assert.ok(
      GRADES.includes(te[id].source),
      `${id} has illegal source "${te[id].source}" — must be one of ${GRADES.join(', ')}`
    );
  }
});
