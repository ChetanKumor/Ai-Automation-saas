'use strict';

// The offline half of the portal contrast instrument (tests/design/portalContrast.js).
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

const kit = require('./portalContrast');
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
  const notFaint = judge([{ color: 'rgb(148, 163, 184)', bg: { r: 255, g: 255, b: 255 }, px: 13, weight: 400, role: 'text' }]);
  assert.strictEqual(notFaint.contract.length, 0, 'and must not fire on a different failing colour');
  assert.strictEqual(notFaint.failures.length, 1, '--faint is a threshold failure, not a contract one');

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

  const FAINT = /#a8a199\b|rgba?\(\s*168\s*,\s*161\s*,\s*153\s*[,)]/i;
  const TEXT_PROP = /(^|[;{])\s*(color|-webkit-text-fill-color)\s*:\s*([^;}]+)/gi;
  const offences = [];
  for (const [name, css] of sheets) {
    // Custom properties in THIS sheet whose value is the faint hex; a
    // `color: var(--x)` that reaches one of them is the same offence written
    // one hop away.
    const aliases = new Set();
    const decl = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi;
    let d;
    while ((d = decl.exec(css)) !== null) if (FAINT.test(d[2])) aliases.add(d[1]);

    let c;
    TEXT_PROP.lastIndex = 0;
    while ((c = TEXT_PROP.exec(css)) !== null) {
      const value = c[3].trim();
      const direct = FAINT.test(value);
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
});
