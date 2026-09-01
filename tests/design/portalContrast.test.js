'use strict';

// The offline half of the portal contrast instrument.
//
// Two files under test, since S6a split them: tests/design/contrast/core.js is
// the surface-agnostic measurement engine, and tests/design/portalContrast.js is
// the portal's binding of it — the baseline the portal is held to, plus the
// public surface scripts/portal/shoot.js imports. The split exists because the
// engine was bound to one surface and a second surface would have had to fork
// it. These blocks test the engine THROUGH the binding, and separately pin that
// the binding really is a re-export rather than a copy that can drift.
//
// WHAT THIS FILE IS FOR. The instrument's live half needs Chrome, a Postgres
// scratch DB and a signed-in portal, so it runs from `node scripts/portal/
// shoot.js --contrast` and not from `npm test`. That is exactly the shape of
// tooling that rots: D-016 closes on "532 colour/backdrop pairs measured on the
// live DOM, zero failures" and the harness that produced that number is gone
// from this repository and from this machine, so the claim can no longer be
// re-run by anybody. Everything in the instrument that CAN be pinned without a
// browser is pinned here, so the arithmetic the live run reports is arithmetic
// the suite has already checked.
//
// WHAT IT CAN AND CANNOT SEE, stated plainly. It exercises the colour maths,
// the thresholds, the D-016 contract rule and the focus-ring scoring against
// hand-computed inputs, and it scans the portal's stylesheets as text. It
// CANNOT see a rendered page: not one composited backdrop, not one accumulated
// ancestor opacity, not one glyph. Those are measured by the live sweep, whose
// current numbers are recorded in docs/os/state.md.
//
// TWO test() blocks, deliberately no more, following the rule tokenDrift.test.js
// and heroDisclosure.test.js state in their own headers: the suite total is a
// tracked number, and a per-assertion block would move it every time an
// assertion is added. The split is by subject, not by size — the first block is
// the instrument, the second is the D-016 contract the instrument enforces.
//
// No dependency — the module under test plus readFileSync, same as every other
// test here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const kit = require('./portalContrast');
const core = require('./contrast/core');
const ROOT = path.join(__dirname, '..', '..');
const PORTAL = path.join(ROOT, 'public', 'portal');

const {
  parseColor, compositeOver, contrastRatio, isLargeText, parseBoxShadow,
  judge, judgeRing, INK_FAINT, AA_BODY, AA_LARGE, AA_NON_TEXT,
} = kit;

const near = (actual, expected, tol, what) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `${what}: got ${actual}, expected ${expected} ±${tol}`
);

/* ========================================================================== */

test('the contrast instrument computes what WCAG says, on the values it will meet', () => {
  // ── the two fixed points of the scale ──────────────────────────────────
  near(contrastRatio(parseColor('#ffffff'), parseColor('#000000')), 21, 0.001, 'white on black');
  near(contrastRatio(parseColor('#0f172a'), parseColor('#0f172a')), 1, 0.001, 'a colour on itself');

  // ── parsing what getComputedStyle actually hands back ──────────────────
  // Chrome serialises to rgb()/rgba(); stylesheets are authored in hex. Both
  // reach this parser, and `transparent` reaches it constantly during the
  // backdrop walk, where treating it as opaque black would invert every
  // verdict on the page.
  assert.deepStrictEqual(parseColor('rgb(15, 118, 110)'), { r: 15, g: 118, b: 110, a: 1 });
  assert.deepStrictEqual(parseColor('rgba(15, 118, 110, 0.16)'), { r: 15, g: 118, b: 110, a: 0.16 });
  assert.deepStrictEqual(parseColor('rgb(15 118 110 / 0.5)'), { r: 15, g: 118, b: 110, a: 0.5 });
  assert.deepStrictEqual(parseColor('#0f766e'), { r: 15, g: 118, b: 110, a: 1 });
  assert.deepStrictEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepStrictEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.strictEqual(parseColor('linear-gradient(red, blue)'), null, 'unparseable must be null, never a guess');
  assert.strictEqual(parseColor(''), null);
  assert.strictEqual(parseColor(null), null);

  // ── source-over compositing, the operation the whole instrument turns on ──
  // 50% black over white is 127.5 on every channel, not 0 and not 255. This is
  // the step web/app/(marketing)/specimen/tokens.ts:145-148 deliberately does
  // not take (it resolves alpha over white regardless of the true backdrop),
  // and it is the difference between measuring the portal and guessing at it.
  const half = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  near(half.r, 127.5, 0.001, 'half-alpha black over white');
  near(half.a, 1, 0.001, 'compositing onto an opaque layer yields an opaque layer');
  const none = compositeOver({ r: 0, g: 0, b: 0, a: 0 }, { r: 246, g: 248, b: 250, a: 1 });
  assert.deepStrictEqual(
    [none.r, none.g, none.b], [246, 248, 250],
    'a fully transparent layer must leave the backdrop exactly as it was'
  );

  // ── the large-text boundary ────────────────────────────────────────────
  // Computed font-size does not move under transform: scale(), so the sweep
  // feeds this an already-scaled px value. The boundary itself is WCAG's.
  assert.strictEqual(isLargeText(24, 400), true, '24px is large at any weight');
  assert.strictEqual(isLargeText(23.9, 400), false);
  assert.strictEqual(isLargeText(18.66, 700), true, '18.66px is large at bold');
  assert.strictEqual(isLargeText(18.66, 600), false, '...and not at 600');
  assert.strictEqual(isLargeText(18.65, 700), false);

  // ── box-shadow, because that is how the portal draws two of its rings ──
  const glow = parseBoxShadow('rgba(15, 118, 110, 0.16) 0px 0px 0px 3px');
  assert.strictEqual(glow.length, 1);
  assert.strictEqual(glow[0].spread, 3, 'the .input:focus glow is a 3px spread');
  assert.deepStrictEqual(parseColor(glow[0].color), { r: 15, g: 118, b: 110, a: 0.16 });
  assert.strictEqual(parseBoxShadow('none').length, 0);
  assert.strictEqual(
    parseBoxShadow('rgb(0,0,0) 0px 1px 2px 0px, rgb(255,0,0) 0px 0px 0px 2px inset').length, 2,
    'multi-layer shadows must split on the top-level comma, not inside rgb()'
  );
  assert.strictEqual(parseBoxShadow('rgb(255,0,0) 0px 0px 0px 2px inset')[0].inset, true);

  // ── judge(): the floor is selected by the row, never by the caller ─────
  const white = { r: 255, g: 255, b: 255 };
  const body = judge([{ color: 'rgb(148, 163, 184)', bg: white, px: 13, weight: 400, role: 'text' }]);
  assert.strictEqual(body.measured[0].floor, AA_BODY);
  assert.strictEqual(body.measured[0].pass, false, '--faint on white is 2.56:1 and is not body text');
  near(body.measured[0].ratio, 2.56, 0.01, '--faint on --card');
  assert.strictEqual(body.failures.length, 1);

  const large = judge([{ color: 'rgb(148, 163, 184)', bg: white, px: 24, weight: 400, role: 'text' }]);
  assert.strictEqual(large.measured[0].floor, AA_LARGE);
  assert.strictEqual(large.measured[0].pass, false, '2.56:1 fails 3:1 too — the floor moved, the verdict did not');

  const ok = judge([{ color: 'rgb(15, 118, 110)', bg: white, px: 14, weight: 400, role: 'text' }]);
  near(ok.measured[0].ratio, 5.47, 0.01, '--teal-700 on --card');
  assert.strictEqual(ok.failures.length, 0);

  // ── the ancestor-opacity trap, which is the one that would ship a defect ──
  // The same declared colour on the same backdrop, twice, differing only in the
  // opacity accumulated from ancestors. A probe that reads getComputedStyle
  // (el).color and stops there scores both as the first.
  const opaque = judge([{ color: 'rgb(100, 116, 139)', bg: white, px: 13, weight: 400, opacity: 1, role: 'text' }]);
  const washed = judge([{ color: 'rgb(100, 116, 139)', bg: white, px: 13, weight: 400, opacity: 0.62, role: 'text' }]);
  assert.strictEqual(opaque.measured[0].pass, true, '--muted on white is 4.76:1');
  assert.strictEqual(washed.measured[0].pass, false);
  assert.ok(
    washed.measured[0].ratio < opaque.measured[0].ratio,
    `ancestor opacity must wash the glyph toward the page: ${washed.measured[0].ratio} !< ${opaque.measured[0].ratio}`
  );

  // ── a backdrop the instrument cannot resolve must not certify anything ──
  // background-image is not recoverable from computed style. Reporting it as a
  // pass would be the exact failure mode this file exists to prevent.
  const img = judge([{ color: 'rgb(255,255,255)', bg: white, px: 13, weight: 400, role: 'text', imageBacked: true }]);
  assert.strictEqual(img.undeterminable.length, 1);
  assert.strictEqual(img.failures.length, 0, 'an unresolvable backdrop is withheld, not failed');
  assert.match(img.undeterminable[0].why, /background-image/);

  // ── focus indicators are a separate instrument at a separate floor ─────
  // Modelled on the portal's own two rings: the global :focus-visible outline
  // (tokens.css:227) and the .input:focus border+glow (tokens.css:1014).
  const outlined = judgeRing({
    page: 'x', sel: 'button.btn', label: 'Save',
    outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(15, 118, 110)', outlineOffset: '2px',
    boxShadow: 'none', borderColor: 'rgb(226, 232, 240)', borderWidth: '0px',
    background: 'rgb(255, 255, 255)',
    outerBackdrop: { r: 255, g: 255, b: 255 }, innerBackdrop: { r: 255, g: 255, b: 255 },
  }, { restBorderColor: 'rgb(226, 232, 240)', restBackground: 'rgb(255, 255, 255)' });
  assert.strictEqual(outlined.pass, true);
  near(outlined.best, 5.47, 0.01, '2px --teal-700 outline on a white card');
  assert.strictEqual(outlined.indicators[0].kind, 'outline');

  // A glow alone cannot carry a ring: rgba(15,118,110,.16) over the app ground
  // is 1.25:1, and 1.4.11 wants 3. Also pins that a fill change is REPORTED
  // rather than counted as an indicator.
  const glowOnly = judgeRing({
    page: 'x', sel: 'input.input', label: '',
    outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0,0,0)', outlineOffset: '0px',
    boxShadow: 'rgba(15, 118, 110, 0.16) 0px 0px 0px 3px',
    borderColor: 'rgb(226, 232, 240)', borderWidth: '1px',
    background: 'rgb(255, 255, 255)',
    outerBackdrop: { r: 246, g: 248, b: 250 }, innerBackdrop: { r: 255, g: 255, b: 255 },
  }, { restBorderColor: 'rgb(226, 232, 240)', restBackground: 'rgb(251, 252, 254)' });
  assert.strictEqual(glowOnly.pass, false, 'a 16%-alpha glow is not a focus indicator');
  near(glowOnly.best, 1.25, 0.01, 'the .input:focus glow over the app ground');
  assert.strictEqual(glowOnly.fillChanged, true, '#fbfcfe -> #ffffff is a fill change');
  near(glowOnly.fillRatio, 1.03, 0.01, '...and an imperceptible one');
  assert.strictEqual(AA_NON_TEXT, 3, 'SC 1.4.11 floor');

  // ── the extraction is a re-export, not a second copy ───────────────────
  // S6a moved the engine to contrast/core.js so a second surface can reuse it
  // instead of forking it. A fork is exactly what this pins against: identity,
  // not deep-equality, so re-inlining any of these into portalContrast.js —
  // where it would drift the first time either file is touched — fails here.
  for (const name of ['parseColor', 'compositeOver', 'contrastRatio', 'isLargeText',
    'parseBoxShadow', 'judgeRing', 'uniquePairs', 'signature',
    'buildSource', 'sweepPage', 'blurActive', 'tagFocusables', 'readFocusRing']) {
    assert.strictEqual(kit[name], core[name], `${name} must BE the core's, not a copy of it`);
  }
  // `judge` is the one BINDING rather than a re-export, because the portal's
  // SC 1.4.11 allowlist is a fact about the portal and `shoot.js:588` calls
  // `kit.judge(rows)` with no options. A binding is a place a fork can hide, so
  // it is pinned to add the list and NOTHING else: same verdicts on rows the
  // list does not touch, byte for byte.
  assert.notStrictEqual(kit.judge, core.judge, 'kit.judge binds the portal allowlist');
  const untouched = [
    { color: 'rgb(148, 163, 184)', bg: { r: 255, g: 255, b: 255 }, px: 13, weight: 400, role: 'text' },
    { color: '#A8A199', bg: { r: 12, g: 20, b: 32 }, px: 13, weight: 400, role: 'text' },
    { color: 'rgb(15, 118, 110)', bg: { r: 250, g: 248, b: 245 }, px: 13, weight: 400, role: 'text' },
  ];
  assert.deepStrictEqual(
    kit.signature(kit.judge(untouched)).lines,
    kit.signature(core.judge(untouched)).lines,
    'the binding must not change a verdict its allowlist does not name'
  );
  for (const name of ['TEXT_SWEEP_SOURCE', 'BLUR_SOURCE', 'TAG_FOCUSABLES_SOURCE', 'READ_RING_SOURCE']) {
    assert.strictEqual(kit[name], core[name]);
    assert.ok(kit[name].length > 500, `${name} must be real serialised source, not "undefined"`);
  }
  // The core must not have learnt about the portal on the way out: it is handed
  // its gates and its rows, and knows no URL, no page and no panel. Comment
  // lines are stripped first and deliberately so — the header has to be able to
  // SAY "this file does not know what a Verbatim panel is" without that sentence
  // tripping the check that makes the claim true.
  const coreSrc = fs.readFileSync(path.join(__dirname, 'contrast', 'core.js'), 'utf8');
  const coreCode = coreSrc.split('\n').filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
  assert.ok(coreCode.includes('function sweepPage'), 'the comment strip must leave the code behind');
  // ('index.html' survives, in `location.pathname.split('/').pop() || 'index.html'`
  //  — a label for a row measured at a directory root, not a page the core knows.)
  for (const surfaceWord of ['loadCard', 'erbatim', 'vpLive', 'wizReview', 'readinessOnce',
    'getElementById', 'localhost', '127.0.0.1', 'portal']) {
    assert.ok(!coreCode.includes(surfaceWord),
      `contrast/core.js must be surface-agnostic; its code names "${surfaceWord}"`);
  }

  // ── signature(): shapes, never counts ──────────────────────────────────
  // The invariant a refactor of the engine is judged on. S2 measured five
  // sweeps of one unchanged tree at 2302/2325/2339/2347 rows — readiness races,
  // since closed — and the distinct-shape signature was byte-identical across
  // all five. So multiplicity must not reach the hash, and shape must.
  const rowA = { color: 'rgb(148, 163, 184)', bg: { r: 255, g: 255, b: 255 }, px: 13, weight: 400, role: 'text' };
  const rowB = { color: 'rgb(100, 116, 139)', bg: { r: 237, g: 242, b: 247 }, px: 13, weight: 400, role: 'text' };
  const one = kit.signature(judge([rowA, rowB]));
  const many = kit.signature(judge([rowA, rowB, rowA, rowA, rowB]));
  assert.strictEqual(many.md5, one.md5, 'multiplicity must not move the signature');
  assert.strictEqual(kit.signature(judge([rowB, rowA])).md5, one.md5, 'nor must row order');
  assert.strictEqual(one.lines.length, 2, 'two distinct failing pairs, five rows');
  const moved = kit.signature(judge([rowA, { ...rowB, bg: { r: 12, g: 20, b: 32 } }]));
  assert.notStrictEqual(moved.md5, one.md5, 'a different backdrop IS a different shape');
  // Every verdict channel reaches the hash: a contract violation and an
  // unresolvable backdrop each move it on their own, or the signature would
  // certify a run in which only those two changed.
  assert.notStrictEqual(
    kit.signature(judge([rowA, rowB, { ...rowA, color: INK_FAINT }])).md5, one.md5,
    'a D-016 contract violation must move the signature'
  );
  assert.notStrictEqual(
    kit.signature(judge([rowA, rowB, { ...rowA, imageBacked: true }])).md5, one.md5,
    'an undeterminable backdrop must move the signature'
  );
  assert.notStrictEqual(
    kit.signature({ failures: [], contract: [], undeterminable: [], rings: [outlined] }).md5,
    kit.signature({ failures: [], contract: [], undeterminable: [], rings: [glowOnly] }).md5,
    'focus indicators are part of the signature — their ratios run through the same backdrop walk'
  );
  assert.strictEqual(kit.signature({}).md5, kit.signature({ failures: [] }).md5, 'an empty run has one signature');
});

/* ========================================================================== */

test('D-016: --ink-faint is non-text only, and no portal stylesheet paints a glyph with it', () => {
  // ── the contract is anchored to the decision, not to this file ─────────
  // If D-016 is ever superseded, this reads the superseding text and fails,
  // rather than going on enforcing a rule the company has retired.
  const decisions = fs.readFileSync(path.join(ROOT, 'docs', 'os', 'decisions.md'), 'utf8');
  assert.match(
    decisions,
    /--ink-faint \(#A8A199, 2\.41:1\) is NON-TEXT ONLY, by written contract/,
    'D-016 no longer states the contract this test enforces'
  );
  assert.strictEqual(INK_FAINT, '#A8A199');

  // ── and the number in that sentence is re-derived, not trusted ─────────
  // 2.41:1 is D-016's own figure for #A8A199 on the paper ground. It is
  // recomputed here from the hexes so a palette edit cannot leave the decision
  // record asserting a ratio that no longer holds.
  near(contrastRatio(parseColor('#A8A199'), parseColor('#FAF8F5')), 2.41, 0.005, '--ink-faint on paper');
  near(contrastRatio(parseColor('#A8A199'), parseColor('#ffffff')), 2.55, 0.005, '--ink-faint on a white card');
  assert.ok(2.41 < AA_LARGE, '--ink-faint clears no text floor, not even the large one');

  // ── the contract is not a threshold, and judge() must not treat it as one ──
  // The portal already owns a ground on which #A8A199 clears not just 3:1 but
  // 4.5:1 — `--field: #0c1420`, the ink panel behind Verbatim, where it reads
  // 7.24:1. A threshold-only gate would wave --ink-faint onto that panel as
  // ordinary body text. The contract does not, and that is the whole reason it
  // is written as a contract.
  near(contrastRatio(parseColor('#A8A199'), parseColor('#0c1420')), 7.24, 0.01, '--ink-faint on --field');
  const onField = judge([{ color: '#A8A199', bg: { r: 12, g: 20, b: 32 }, px: 13, weight: 400, role: 'text' }]);
  assert.strictEqual(onField.measured[0].floor, AA_BODY);
  assert.strictEqual(onField.measured[0].pass, true, 'this arrangement clears 4.5:1 on the numbers');
  assert.strictEqual(onField.failures.length, 0);
  assert.strictEqual(onField.contract.length, 1, '...and is still a contract violation');
  assert.match(onField.contract[0].why, /--ink-faint resolved as a glyph colour/);

  // rgb() and hex are the same colour; the live sweep only ever sees rgb().
  const asRgb = judge([{ color: 'rgb(168, 161, 153)', bg: { r: 255, g: 255, b: 255 }, px: 13, weight: 400, role: 'text' }]);
  assert.strictEqual(asRgb.contract.length, 1, 'the contract must survive serialisation to rgb()');
  // #94a3b8 was the portal's own --faint until S3c-1 and is now only
  // --field-muted. It still fails 4.5:1 on white, and it must still fail as a
  // THRESHOLD failure and not a contract one — the contract is about one
  // specific hex, never about "a colour that looks faint".
  const notFaint = judge([{ color: 'rgb(148, 163, 184)', bg: { r: 255, g: 255, b: 255 }, px: 13, weight: 400, role: 'text' }]);
  assert.strictEqual(notFaint.contract.length, 0, 'and must not fire on a different failing colour');
  assert.strictEqual(notFaint.failures.length, 1, '#94a3b8 is a threshold failure, not a contract one');

  // ── SC 1.4.11: the allowlist, and what it is NOT allowed to do ────────
  // S3b-3 taught the sweep to see SVG paint and 339 icons came back under 3:1.
  // Two of those groups are outside the criterion, and they are exempted by a
  // LIST rather than by a rule. A suppression mechanism nobody has watched
  // suppress anything is not a mechanism, so each entry is exercised on a row
  // it must silence AND on a near-miss it must not.
  //
  // It was three until S3c-1. `sidebar-nav-icon` excused 288 icons painted in
  // --faint at 2.46:1; those icons take --ink-2 now and measure 7.42:1, so the
  // entry was excusing nothing. It was REMOVED rather than left: a lapsed
  // exemption is invisible — it keeps looking like a live decision and would
  // silently re-activate under any future re-hue that walked back under it.
  const EXEMPT = kit.PORTAL_EXEMPT;
  assert.strictEqual(EXEMPT.length, 2, 'two entries; a third is a decision, not an edit');
  for (const e of EXEMPT) {
    assert.ok(e.name && e.why && e.sc, `exemption ${e.name} must carry its own reason`);
    assert.match(e.sc, /SC 1[.]4[.]11/, `exemption ${e.name} must name the clause it rests on`);
    // Every entry is role-scoped to `graphic`. This is the hard limit on the
    // whole mechanism: no arrangement of this list can silence a TEXT glyph, so
    // the 4.5:1 body floor is not reachable from here at all.
    assert.strictEqual(e.role, 'graphic',
      `exemption ${e.name} must be graphic-only — the allowlist may not reach body text`);
  }
  const g = (sel, over) => ({
    role: 'graphic', sel, color: 'rgb(148, 163, 184)', state: 'rest',
    bg: { r: 251, g: 250, b: 247 }, px: 0, weight: 400, opacity: 1, ...over,
  });
  const only = (rows) => kit.judge(rows);
  const cases = [
    ['nav-soon-inactive',
      g('nav#nav > div.nav__grp > span.nav__item.nav__item--soon > svg > path'),
      g('nav#nav > div.nav__grp > span.nav__item > svg > path')],
    ['readiness-ring-track',
      g('section#readinessCard > div.readiness > div.ring > svg > circle.ring__track'),
      g('section#readinessCard > div.readiness > div.ring > svg > circle.ring__arc')],
  ];
  for (const [name, hit, miss] of cases) {
    const silenced = only([hit]);
    assert.strictEqual(silenced.failures.length, 0, `${name} must silence its own shape`);
    assert.strictEqual(silenced.exempt.length, 1);
    assert.strictEqual(silenced.exempt[0].exemptedBy, name);
    // Still MEASURED. 'we did not look' and 'we looked and chose not to fail it'
    // are different entries, and only the second one is a decision.
    assert.strictEqual(silenced.measured.length, 1, `${name} must still measure what it exempts`);
    const scored = only([miss]);
    assert.strictEqual(scored.exempt.length, 0, `${name} must not reach ${miss.sel}`);
    assert.strictEqual(scored.failures.length, 1);
  }
  // The two icon-only controls are deliberately NOT on the list: their icon is
  // the whole control, so SC 1.4.11's 'required to understand the content' is
  // exactly what they are. .holiday__remove in a past row MEASURED 2.60:1 —
  // past tense since S3c-1 deleted the `opacity: .68` that caused it, and the
  // live portal no longer produces this row. The shape is kept here anyway:
  // this is an assertion about the ENGINE's refusal to exempt an icon-only
  // control, and it must not evaporate because one caller stopped generating
  // the input. A regression test that only exists while the bug does is not
  // one.
  const holiday = g('div#holidays > div.holiday-row.holiday-row--past > button.holiday__remove > svg > path',
    { color: 'rgb(100, 116, 139)', bg: { r: 253, g: 252, b: 250 }, opacity: 0.68 });
  assert.strictEqual(only([holiday]).exempt.length, 0, '.holiday__remove is not exempt');
  assert.strictEqual(only([holiday]).failures.length, 1, '.holiday__remove is a real defect');
  // And the mechanism refuses to be used badly: an entry with no reason, and an
  // entry that narrows on nothing, both throw rather than quietly suppressing.
  assert.throws(() => core.judge([holiday], { exempt: [{ role: 'graphic' }] }),
    /needs [{] name, why, sc [}]/, 'an unjustified exemption must be impossible');
  assert.throws(() => core.judge([holiday],
    { exempt: [{ name: 'x', why: 'y', sc: 'SC 1.4.11' }] }),
    /narrows on nothing/, 'an exemption that names no shape must be impossible');

  // ── the live baseline, re-hashable without a browser ──────────────────
  // The live sweep needs Chrome, a scratch Postgres and a signed-in portal, so
  // its verdict cannot run here. Its SIGNATURE can: contrast/portal.signature.txt
  // is the distinct-shape reduction of the run recorded in PORTAL_BASELINE,
  // checked in verbatim, and re-hashed on every `npm test`. That is what keeps
  // the file and the md5 beside it from drifting apart — the failure mode that
  // left D-016's own "532 pairs" as a number nobody can re-run.
  const sig = kit.readPortalSignature();
  assert.strictEqual(
    crypto.createHash('md5').update(sig, 'utf8').digest('hex'),
    kit.PORTAL_BASELINE.signatureMd5,
    'portal.signature.txt no longer hashes to PORTAL_BASELINE.signatureMd5'
  );
  const sigLines = sig.trim().split('\n');
  /* ── NO FAILING SHAPE, AND THIS ZERO IS A DIFFERENT ONE (S3e) ────────────
   * 20 at S3b-3, 2 at S3c-1, zero at S3c-2, FIVE at S3d, zero again here.
   * The zeroes are not the same claim and the difference is the whole point.
   *
   * S3c-2's zero was true about every row the sweep could reach, and the
   * sweep could not reach the off arm of a single control: fourteen pages and
   * ONE maximal tenant, every toggle on, every language on, every optional
   * field filled. S3d seeded the other arm and five failing shapes walked out
   * of it — a portal that had measured zero across three sessions of closing
   * failures. It left them standing on purpose: a session that measures and
   * then fixes inside the same commit leaves nobody able to say what the
   * instrument was worth.
   *
   * S3e is the fix, and this zero is the S3d zero plus the twenty page-states
   * S3d added — the disabled, unpressed, archived and no-config arms included.
   * Two defects, four declarations, MEASURED:
   *
   *   1.18 -> 7.75  the `·` between the provenance chips under a test reply.
   *                 test.css:106 painted it var(--line) = rgba(23,21,15,.08)
   *                 on the white bubble. It is a glyph in the text flow, so it
   *                 is scored at 4.5 (SC 1.4.3) and not at 3; --ink-2 clears
   *                 both, and is the only step below the primary that D-016
   *                 leaves legal for text.
   *   3.64 -> 6.66  the Verbatim language label, and
   *   2.13 -> 6.66  its chevron, on a clinic with ONE language.
   *                 verbatim.css dropped the whole pill to `opacity: .55` with
   *                 no colour compensation; it now drops the border and takes
   *                 --field-muted, which is the .btn:disabled gesture
   *                 (tokens.css:929-943) translated to the ink ground.
   *   2.07 x2       GONE, not repaired. A disabled <button> still matches
   *                 :hover in Chrome, so the hover fill was landing under the
   *                 fade and making the pair worse. The hover arm now negates
   *                 on [disabled], so the state changes nothing and the sweep
   *                 emits no row for it at all — rows 5899 -> 5891.
   *
   * Back to an empty list, and empty is the strong form: every failing shape
   * is a regression on the day it arrives, and it prints the SHAPE rather than
   * `1 !== 0`, which is why this is still deepStrictEqual and not a count.
   * ---------------------------------------------------------------------- */
  assert.deepStrictEqual(sigLines.filter((l) => l.startsWith('FAIL ')), [],
    'a colour/backdrop pair on the live portal is below its WCAG floor');
  assert.strictEqual(sigLines.filter((l) => l.startsWith('CONTRACT ')).length, 0,
    'D-016: zero --ink-faint glyphs on the live portal, measured');
  assert.strictEqual(kit.PORTAL_BASELINE.contract, 0);
  assert.strictEqual(kit.PORTAL_BASELINE.ringFailures, 0, 'SC 1.4.11: no ring below 3:1');
  assert.ok(sigLines.every((l) => /^(FAIL|CONTRACT|UNDET|RING) /.test(l)),
    'the signature body carries only verdict lines — anything else is not hashable evidence');
  // Not one FAIL line may be #A8A199: the contract is enforced by judge(), and a
  // faint glyph reaching the live portal would show up here as a threshold
  // failure even on a ground where it clears 4.5:1 and the contract fires alone.
  assert.ok(!/#a8a199|rgb\(\s*168,\s*161,\s*153\s*\)/i.test(sig),
    '--ink-faint appears in the measured portal baseline');

  // ── the static net ────────────────────────────────────────────────────
  // The live sweep is the real instrument, but it needs a browser and a
  // database. This runs in CI on every commit: it reads every portal
  // stylesheet — including the <style> blocks login.html and wizard.html carry
  // inline — and fails if #A8A199 is ever the value of a text-colour
  // declaration, whether written directly or reached through a custom property
  // defined as that hex.
  const sheets = [];
  for (const f of fs.readdirSync(PORTAL)) {
    const full = path.join(PORTAL, f);
    if (f.endsWith('.css')) { sheets.push([f, fs.readFileSync(full, 'utf8')]); continue; }
    if (!f.endsWith('.html')) continue;
    const html = fs.readFileSync(full, 'utf8');
    const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    let n = 0;
    while ((m = re.exec(html)) !== null) sheets.push([`${f} <style ${++n}>`, m[1]]);
  }
  assert.ok(sheets.length >= 15, `expected the portal's stylesheets, found ${sheets.length}`);

  /* ── BOTH non-text steps, in ONE net (S3c-2) ─────────────────────────────
   * --faint is decoration at 2.55:1 on --card; --faint-strong is meaningful
   * state at 3.96:1. Neither may ever be a glyph, and the SECOND is the one
   * that needs a guard, because 3.96:1 looks like it might be legible and is
   * still most of a step under AA. web/ gave that value a deliberate CEILING
   * under 4.5:1 for exactly this reason (globals.css:432-438): a high-contrast
   * non-text token that passed AA for text would invite the first glyph, and
   * the contract would be a comment rather than a fact. This is the fact.
   *
   * One predicate rather than two nets. The alias hop, the sheet list and the
   * offence report are the expensive, easy-to-get-wrong parts, and a second
   * copy of them is how the two would come to disagree. */
  const FAINT = /#a8a199\b|rgba?\(\s*168\s*,\s*161\s*,\s*153\s*[,)]/i;
  const FAINT_STRONG = /#857f79\b|rgba?\(\s*133\s*,\s*127\s*,\s*121\s*[,)]/i;
  const NON_TEXT = (v) => FAINT.test(v) || FAINT_STRONG.test(v);
  const TEXT_PROP = /(^|[;{])\s*(color|-webkit-text-fill-color)\s*:\s*([^;}]+)/gi;
  /* ── THE ALIAS SET IS COLLECTED ACROSS ALL SHEETS, NOT PER SHEET ──────────
   * It was per sheet, and that made this net blind to the only shape the
   * offence can actually take in this portal. `--faint` is declared once, in
   * tokens.css; every consumer of it is in ANOTHER file. So a per-sheet scan
   * looked for `color: var(--faint)` only in the one file that never contains
   * a consumer, and would have passed a glyph painted faint in any of the
   * other fourteen.
   *
   * FALSIFIED, not reasoned. S3c-1 appended `.probe { color: var(--faint) }`
   * to knows.css with --faint already at #A8A199, and this assertion stayed
   * GREEN. It reds now. The blind spot could not have been found before this
   * session: until --faint took the contract's own hex the portal contained no
   * #A8A199 at all, so the check was passing by ABSENCE and nothing it did or
   * failed to do made any difference to the result.
   *
   * One flat set across the directory is the right model: the portal declares
   * its tokens in exactly one `:root` in one file (pinned by tokenDrift's
   * EXPECTED_ROOT_BLOCKS) and none of these sheets imports another. */
  const aliases = new Set();
  {
    const decl = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi;
    for (const [, css] of sheets) {
      let d;
      decl.lastIndex = 0;
      while ((d = decl.exec(css)) !== null) if (NON_TEXT(d[2])) aliases.add(d[1]);
    }
  }
  // The alias hop is now the ONLY shape this offence can take, so the hop must
  // exist. If --faint ever stops resolving to the contract's hex, this net
  // silently narrows back to direct-hex use and stops being a net at all.
  assert.ok(aliases.has('--faint'),
    "the portal no longer defines --faint as #A8A199 — D-016's static net has "
    + 'quietly narrowed to direct hex use; re-point it at whatever name now '
    + 'carries the non-text ink, or delete it and say why');
  assert.ok(aliases.has('--faint-strong'),
    'the portal no longer defines --faint-strong as #857F79 — the SC 1.4.11 '
    + 'state step has lost its hop, and the net above narrows to direct-hex '
    + 'use for it exactly as it would for --faint');

  const offences = [];
  for (const [name, css] of sheets) {
    let c;
    TEXT_PROP.lastIndex = 0;
    while ((c = TEXT_PROP.exec(css)) !== null) {
      const value = c[3].trim();
      const direct = NON_TEXT(value);
      const viaVar = [...aliases].some((a) => value.includes('var(' + a));
      if (direct || viaVar) {
        offences.push(`${name}: ${c[2]}: ${value}${viaVar && !direct ? '  (via ' + [...aliases].join(', ') + ')' : ''}`);
      }
    }
  }
  assert.deepStrictEqual(
    offences, [],
    'D-016: --ink-faint is NON-TEXT ONLY and must never be a glyph colour in the portal'
  );

  /* ══ NO GLYPH ON THE LIGHT GROUND IS FADED BY `opacity` (S3c-1) ═══════════
   *
   * The durable half of what that session bought. Its colour work can be read
   * off the signature; this cannot, and it is the part most likely to be
   * undone by accident, because `opacity: .8` reads as a styling choice rather
   * than as an accessibility decision.
   *
   * WHY IT IS A RULE AND NOT A MEASUREMENT. Fading a colour toward its
   * backdrop reduces contrast BY CONSTRUCTION — F-F010's finding, and the
   * portal's own `.holiday-row--past` at 1.77:1. Two consequences make the
   * per-instance number useless as a guard:
   *
   *   1. A fade's ratio depends on the INK it fades, so it is re-scored by
   *      every palette change. `.ts__a:hover` sat at a passing 5.09:1 for
   *      months and the two-step collapse would have taken it to 4.11:1 — a
   *      new failure produced by a change that touched no rule near it.
   *   2. At .68 no ink can pass. The best any colour reaches on that row's
   *      backdrops is 3.47:1; the primary ink itself only gets to 6.30:1
   *      where it needs 4.5:1 of headroom to survive the next re-hue.
   *
   * So the mechanism is refused outright, and the five permitted uses are
   * named. Same shape as PORTAL_EXEMPT above and for the same reason: a
   * heuristic ("skip disabled-looking rules") would gain and lose members
   * silently, while a list that stops matching shows up here immediately.
   *
   * The sweep CANNOT express this: it reports failures, not passing rows, so
   * a fade that still passes — every one of the five deleted, on the day
   * before it was deleted — is invisible to it. Reading the stylesheets is
   * not a weaker version of the live check; it is the only place the rule is
   * checkable at all. */
  const FADE_ALLOWED = [
    { name: 'inactive-component',
      ok: (d) => d.ctx.some((s) => /:disabled|\[disabled\]/.test(s)),
      why: 'WCAG 1.4.3 and 1.4.11 both exempt INACTIVE user interface components '
        + 'outright, without reference to ratio. A disabled control is the one '
        + 'place fading toward the backdrop is honest — it says "not available" '
        + 'for the icon and the label in a single gesture.' },
    { name: 'keyframe-step',
      ok: (d) => /^@keyframes\b/.test(d.ctx[0] || ''),
      why: 'An animation frame is not a resting value. Contrast is judged on '
        + 'what the element settles to, and every one of these returns to 1.' },
    { name: 'undrawn-dot',
      ok: (d) => d.ctx.some((s) => /\.think-dot\b/.test(s)),
      why: 'The reduced-motion resting value for a 5px dot that has no text and '
        + 'no icon in it — a --faint FILL, which is exactly what D-016 leaves '
        + '--ink-faint for. There is no glyph here to fade.' },
    { name: 'ink-field-press',
      ok: (d) => d.file === 'verbatim.css' && d.ctx.some((s) => /\.is-press\b/.test(s)),
      why: 'A transient pointer-down state that returns to 1 — the same category '
        + 'as keyframe-step above, and judged the same way: contrast is scored on '
        + 'what an element SETTLES to. It kept a second reason until S3c-2, that '
        + 'the ink ground had open failures of its own; that is no longer true '
        + 'and would now be an excuse rather than a reason, so it is gone. What '
        + 'survives is measured: on --field, .82 takes --field-ink to 10.73:1 and '
        + '--field-muted to 5.22:1, so even the transient frame clears 4.5:1.' },
  ];
  const fades = [];
  for (const [name, css] of sheets) {
    if (!name.endsWith('.css')) continue;   // inline <style> blocks carry none
    const src = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const stack = [];
    let sel = '';
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') { stack.push(sel.trim().replace(/\s+/g, ' ')); sel = ''; i += 1; continue; }
      if (ch === '}') { stack.pop(); sel = ''; i += 1; continue; }
      if (ch === ';') { sel = ''; i += 1; continue; }
      const m = /^opacity\s*:\s*(0?\.\d+|0)\s*(?=[;}])/.exec(src.slice(i));
      if (m && (i === 0 || /[;{}\s]/.test(src[i - 1]))) {
        const value = parseFloat(m[1]);
        if (value > 0 && value < 1) fades.push({ file: name, value, ctx: stack.slice() });
        i += m[0].length; sel = ''; continue;
      }
      sel += ch; i += 1;
    }
  }
  // The scanner has to actually find things, or this assertion is the vacuous
  // kind this repo keeps paying for. SEVEN permitted fades exist today, down
  // from eight: S3e deleted `.vp__sel[disabled] .vp__sel-in { opacity: .55 }`
  // and replaced it with a colour. That fade was covered by the
  // `inactive-component` permission below and was breaking nothing — the
  // entry survives on the three other disabled controls — but the pill it
  // faded is the panel's statement that the clinic speaks one language, and
  // the permission's own reasoning ("a control nobody needs to read") did not
  // describe it. The floor moves with the deletion rather than being left
  // slack: a floor below the true count stops noticing the parser breaking.
  assert.ok(fades.length >= 7,
    `the opacity scanner found ${fades.length} fades — it has stopped parsing`);
  const unpermitted = fades
    .filter((d) => !FADE_ALLOWED.some((r) => r.ok(d)))
    .map((d) => `${d.file}: opacity: ${d.value} on \`${d.ctx.join(' | ')}\``);
  assert.deepStrictEqual(unpermitted, [],
    'S3c-1: a glyph on the portal\'s light ground is faded by `opacity`. Fading '
    + 'reduces contrast by construction and no ink survives it below ~.8 — give '
    + 'the element a dimmed COLOUR at full opacity, or add a named entry to '
    + 'FADE_ALLOWED saying which WCAG clause covers it.');
  // Each permission must still cover something. One that matches nothing is a
  // lapsed exemption, and this session deleted `sidebar-nav-icon` for exactly
  // that: it keeps reading as a live decision while excusing nothing at all.
  for (const r of FADE_ALLOWED) {
    assert.ok(fades.some((d) => r.ok(d)),
      `FADE_ALLOWED entry "${r.name}" matches no declaration — remove it rather `
      + 'than leaving an exemption that will silently re-activate');
  }
});
