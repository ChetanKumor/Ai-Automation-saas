'use strict';

// F2 — the Test page's composer locked after one message.
//
// `sendQuestion` disables the composer on entry as its double-submit guard.
// Its `finally` then re-enabled only `if (!input.disabled)` — a condition that
// is false on every path, because the same function had set that flag true a
// few lines earlier. So the composer was disabled once and
// never released, with 19 messages still on the counter. Present since the
// page's first commit (8b7c093); D5a touched this file but not either block.
//
// ── Why these are SOURCE assertions ──────────────────────────────────────────
// test.js is a browser IIFE with no exports, and this repo has no DOM library
// in its dependency tree (no jsdom, no happy-dom, and no test uses one), so the
// only in-suite instrument is source text — the precedent set by
// portalShadowNotice.unit.test.js and portalOnboarding.integration.test.js.
// These pin the SHAPE of the fix, not its behaviour. The behavioural proof is
// the CDP run against a real portal and a real brain: 20 consecutive sends with
// the composer usable after each, the cap guard firing at 0 with its reason,
// and sends 21-22 refused client-side.
//
// What the shape assertions are actually worth: this bug was invisible to
// source reading for six weeks *because* the wrong flag reads plausibly. So the
// value here is not "the code says the right words" — it is the third test,
// which fails if anyone answers a future report of this symptom by adding a
// SECOND re-enable site instead of fixing the one that exists.

process.env.LOG_LEVEL = 'silent';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/portal/test.js'), 'utf8');

// Comments are stripped before matching — this fix's own comments quote the old
// broken condition verbatim, so an unstripped search would match the very thing
// the tests exist to forbid.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

// The `finally` block of sendQuestion — the single release point.
const FINALLY = (CODE.match(/\}\s*finally\s*\{([\s\S]*?)\n\s{4}\}/) || [])[1];

describe('Test page composer (F2)', () => {
  it('releases the composer on a flag the send path did not itself set', () => {
    assert.ok(FINALLY, 'sendQuestion has no finally block — the release point is gone');
    assert.match(FINALLY, /if\s*\(\s*!exhausted\s*\)/,
      'the re-enable must be conditioned on the daily-cap flag');
    assert.doesNotMatch(FINALLY, /input\.disabled\s*\)/,
      'the re-enable must not read input.disabled — sendQuestion sets it true on entry, ' +
      'so any condition on it is unreachable (this was the bug)');
  });

  it('sets the cap flag where the cap is detected, so both halves read one fact', () => {
    const capBranch = (CODE.match(/if\s*\(\s*n\s*<=\s*0\s*\)\s*\{([\s\S]*?)\n\s{4}\}/) || [])[1];
    assert.ok(capBranch, 'updateRemaining no longer has an n <= 0 branch');
    assert.match(capBranch, /exhausted\s*=\s*true/,
      'the cap branch must set the same flag the release point reads');
    assert.match(capBranch, /input\.disabled\s*=\s*true/,
      'the cap branch must still disable the composer');
  });

  it('has exactly one path that re-enables the composer', () => {
    const enables = (CODE.match(/input\.disabled\s*=\s*false/g) || []).length;
    assert.equal(enables, 1,
      'a second re-enable site masks the first bug rather than fixing it — ' +
      `found ${enables}`);
  });

  it('keeps the double-submit guard, which is the only one on this path', () => {
    assert.match(CODE, /if\s*\(sending\)\s*return;/, 'the re-entry guard is gone');
    assert.match(CODE, /sending\s*=\s*true;/, 'the busy flag is never set');
    const send = (CODE.match(/async function sendQuestion[\s\S]*?\n\s{2}\}/) || [''])[0];
    assert.match(send, /sendBtn\.disabled\s*=\s*true/,
      'Send must still be disabled while a turn is in flight');
  });
});
