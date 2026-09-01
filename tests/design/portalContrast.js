'use strict';

/* ============================================================================
 * PORTAL CONTRAST INSTRUMENT — the PORTAL BINDING of the contrast engine.
 *
 * Not a test file (no `.test.js`), so `npm test` never loads it. It is required
 * by `tests/design/portalContrast.test.js`, which exercises the pure half
 * offline, and by `scripts/portal/shoot.js --contrast`, which drives the live
 * half over CDP against the real portal.
 *
 * ── WHAT MOVED, AND WHY ───────────────────────────────────────────────────
 * S6a extracted the measurement engine to `tests/design/contrast/core.js`. It
 * was bound to one surface: measuring a SECOND surface — web/, a future admin
 * panel — meant forking it, and a forked instrument is two instruments that
 * disagree the first time either is touched. The core knows no URL, no page
 * list, no readiness gate, and nothing about a Verbatim panel. It takes raw
 * rows and returns verdicts.
 *
 * The extraction was accepted on one test only: the portal signature md5 is
 * unchanged across it. See PORTAL_BASELINE below.
 *
 * ── WHERE THE REST OF THE DRIVER ACTUALLY LIVES ───────────────────────────
 * Honest map, because the split is NOT clean along file boundaries and a reader
 * who assumes it is will look in the wrong place:
 *
 *   tests/design/contrast/core.js   the engine — colour maths, the ancestor
 *                                   walk, the opacity walk, thresholds, the
 *                                   D-016 contract, signature emission
 *   THIS FILE                       the portal's binding of it: the baseline
 *                                   the portal is held to, and the public
 *                                   surface both callers import
 *   scripts/portal/shoot.js         the portal's URLs, its page list — fourteen
 *     :447-495 and :219-223         pages plus six STATE VARIANTS (S3d), which
 *                                   are the same pages entered as a different
 *                                   tenant or after one real click — its two
 *                                   viewports, and all three readiness
 *                                   gates — LOADED (#loadCard + the Verbatim
 *                                   panel's own fetch), WIZARD_READY (#wiz +
 *                                   loadReview), and the shell-wide
 *                                   `Portal.readinessOnce()` await
 *
 * Those gates belong beside this file rather than inside a browser driver, and
 * S6a's allowed file set did not include `scripts/portal/shoot.js`, so they
 * stayed put. They are named here so the next session moving them knows the
 * whole set and does not fix two of the three races.
 *
 * S3b-pre changed where two of them LIVE without changing what they mean. The
 * capture path had the same two races as the measuring path, so the Verbatim
 * clause and the `readinessOnce()` await were lifted out of the sweep into
 * `VERBATIM_PAINTED` and `READINESS_SETTLED` (`shoot.js:219-223`), which LOADED
 * and `sweepOnePage()` now both reference. That is why the reference above is
 * two spans rather than one, and it is deliberate: two copies of a gate is how
 * a gate drifts.
 *
 * ── THE PUBLIC SURFACE ────────────────────────────────────────────────────
 * Everything the engine exports is re-exported UNCHANGED. `shoot.js` and the
 * test file were not edited for the extraction and must not need to be: this
 * file is the stable import path, the core is free to be reorganised behind it.
 * The re-export is checked at load rather than spread, because a silently
 * missing `TEXT_SWEEP_SOURCE` would reach CDP as the string "undefined" and
 * come back as an in-page error forty seconds into a sweep.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const core = require('./contrast/core');

/* ──────────────────────────────────────────────────────────────────────────
 * The portal's baseline — the one surface fact this file owns.
 *
 * Measured by `node scripts/portal/shoot.js --contrast` over twenty page-states
 * at 1280 and 380. The signature is the distinct-shape reduction
 * (core.signature); the counts are recorded beside it but are NOT the invariant
 * — S2 saw the row count read 2302 / 2325 / 2339 / 2347 across five runs of an
 * unchanged tree while the signature stayed byte-identical. Compare the
 * signature. The counts are here so a run that moves them is noticed, not so a
 * run that moves them is failed.
 *
 * S3d's three consecutive sweeps of one tree were byte-identical on the
 * signature AND on every count AND on the state census — 5899 / 91 / 22 / 42 /
 * 4 / 1048 three times. That is a stronger result than S2's and it is not a
 * claim that the counts are now invariants: it is a measurement of this tree on
 * this machine, and the readiness gates S3b and S3b-pre added are the reason it
 * reads that way. Compare the signature.
 *
 * `portal.signature.txt` is the signature body itself, checked in so that the
 * live baseline is auditable — and re-hashable — without a browser, a database
 * or a Chrome. portalContrast.test.js re-hashes it on every `npm test`, which
 * is what stops the file and the md5 below from drifting apart.
 * ────────────────────────────────────────────────────────────────────────── */

const PORTAL_SIGNATURE_FILE = path.join(__dirname, 'contrast', 'portal.signature.txt');

const PORTAL_BASELINE = Object.freeze({
  at: 'fefb2fe+S4',                 // S4 is the AUTH SEAM: public/portal/login.html
                                    // rewritten onto the shared components, its inline
                                    // <style> extracted to login.css, and
                                    // public/admin/login.html moved onto these tokens.
                                    // Still nothing under src/.
                                    //
                                    // The ONE intended signature move in five sessions,
                                    // and it was PREDICTED before it was measured — 10
                                    // lines / b98ea30d, byte-identical to the prediction.
                                    // login.html declared its own `.field input`, the
                                    // only text input in the product that was not
                                    // `.input`, and its focus glow (0 0 0 3px --teal-100)
                                    // was the sole consumer of that value anywhere — so
                                    // it owned a RING line by itself. `.input:focus`
                                    // resolves to a shape the baseline ALREADY carried
                                    // (border 5.47/5.47 + the .16 glow at fill@1.03), so
                                    // the line is DELETED, not replaced: 11 -> 10.
                                    //
                                    // S3e, for history: S3d was FIXTURE and SWEEP only —
                                    // zero .css, and the five FAIL lines it left standing
                                    // were what that bought. S3e was the other half: two
                                    // .css files, four declarations, list empty again.
  pages: 20,                        // was 14. The same fourteen pages plus SIX
                                    // STATE VARIANTS: four are a different
                                    // tenant (Lotus Dental — one language,
                                    // handoff off, same-day booking off, one
                                    // payment method, two archived treatments)
                                    // and two are a real test turn, one against
                                    // a tenant with a config and one against
                                    // Palm Dental, which has no tenant_configs
                                    // row at all. See CONTRAST_PAGES.
  widths: Object.freeze([1280, 380]),
  rows: 4222 + 1669,                // 5891, UNMOVED ACROSS S4 — measured, not
                                    // assumed, and not decomposed: the login page
                                    // was rewritten and the TOTAL did not move, so
                                    // that page emits the same number of rows it
                                    // did before. Recorded as observed rather than
                                    // explained. The S3e derivation follows.
                                    // The 4222 are STILL UNMOVED — the
                                    // fourteen base pages measure exactly what
                                    // they measured at S3c-2, and S3e's two
                                    // .css edits did not touch one of them.
                                    // The state half went 1677 -> 1669. The
                                    // eight are the HOVER rows of the disabled
                                    // language selector: four Lotus page-states
                                    // at 1280, times label + chevron. Killing
                                    // the hover arm does not re-score them, it
                                    // DELETES them — a state row is emitted
                                    // only where the state changes something,
                                    // and a disabled control now answers a
                                    // pointer with nothing at all. Written as a
                                    // sum because the invariant worth keeping
                                    // is that the old half did not move.
  pairs: 86,                        // UNMOVED across S4 — the rewrite is made out
                                    // of colours the portal already paints, which
                                    // is what a reuse-only change should look like
                                    // in this number. History follows.
                                    // was 91 (and 79 before S3d). MINUS FIVE,
                                    // one per closed FAIL shape — the two
                                    // hover keys are gone with their rows, and
                                    // the three rest keys collapsed onto keys
                                    // the sweep already had: the repaired dot
                                    // now shares --ink-2-on-white with the
                                    // chips beside it, and the disabled pill
                                    // shares --field-muted-on---field-2 with
                                    // every enabled chevron. A repair that
                                    // ADDS a key would mean a new colour; five
                                    // fewer is the shape of a repair made out
                                    // of values the portal already paints.
  failures: 0,                      // UNMOVED across S4, which was the target the
                                    // brief set: the auth seam is rebuilt out of
                                    // pairs the portal already scores green, so
                                    // zero is a reuse result and not a repair one.
                                    // NOTE the reach of that zero — the notice on
                                    // login.html is `hidden` at rest and the sweep
                                    // visits the page at rest, so NEITHER notice arm
                                    // is in this number. Their pairs are computed
                                    // offline in docs/design/brand-values.md and are
                                    // certified on ABSENCE here, which is exactly
                                    // S3d's lesson. Closing it needs a login[error]
                                    // entry in CONTRAST_PAGES. Filed, not done.
                                    // History: 22 at S3d, and BOTH defects are closed.
                                    // This is not the S3c-2 zero returning:
                                    // that one was true about everything the
                                    // sweep could see, and this one is true
                                    // across 40% more measured rows, including
                                    // the disabled, unpressed and archived arms
                                    // S3d reached for the first time. What
                                    // closed them, MEASURED on the live portal:
                                    //   1.18 -> 7.75  the provenance separator,
                                    //     test.css:106, var(--line) -> --ink-2
                                    //     on the white bubble.
                                    //   3.64 -> 6.66  the disabled Verbatim
                                    //     language label, and
                                    //   2.13 -> 6.66  its chevron, both
                                    //     --field-muted on --field-2 once the
                                    //     blanket opacity: .55 became a colour
                                    //     (verbatim.css:200-227).
                                    //   2.07 x2        DELETED, not repaired:
                                    //     a disabled control has no hover, so
                                    //     there is no shape left to score.
                                    // The pinned list in portalContrast.test.js
                                    // is GONE, not zeroed — the assertion is
                                    // deepStrictEqual(FAIL, []) again.
  exempt: 42,                       // was 30, and this is the first session that
                                    // could CHECK it: the number was in this
                                    // constant and emitted by nothing, so it
                                    // could only be re-derived by re-running
                                    // judge() over raw rows the report does not
                                    // keep. shoot.js now prints it and writes it
                                    // into the report. The +12 is 2 nav-soon
                                    // icons on each of the 6 new page-states;
                                    // NOTHING was added to PORTAL_EXEMPT.
  contract: 0,                      // D-016 --ink-faint as a glyph colour. Still
                                    // zero across 40% more measured rows, and
                                    // now across the disabled, unpressed and
                                    // archived arms too — which is a stronger
                                    // statement of the same number.
                                    // --faint-strong (#857F79, S3c-2) is still
                                    // NOT a second contract value and is not
                                    // checked here: web/ derived it with a
                                    // ceiling under 4.5:1 so it can never be
                                    // text. The net that enforces that is in
                                    // portalContrast.test.js and covers both.
  undeterminable: 2 + 2,            // 4, UNMOVED. The `select#insuranceStance`
                                    // chevron, on the second pricing page-state.
                                    // Its hex is inside a data URI; see the
                                    // warning at pricing.css:210.
  rings: 1048,                      // UNMOVED, and so are all ten RING lines of
                                    // the signature, byte for byte. S3e touched
                                    // no focus indicator and the sweep says so.
                                    // (712 before S3d; the +336 came with the
                                    // six state variants, and brought one new
                                    // RING SHAPE — a 5.47/5.16 border pair
                                    // beside the existing 5.47/5.47 — which
                                    // PASSES.)
  ringFailures: 0,                  // below SC 1.4.11's 3:1
  signatureMd5: 'b98ea30d713cc15c578aeada1ec0127a',
});

/**
 * The checked-in signature body, CRLF-NORMALISED.
 *
 * Not a nicety. This repo runs `core.autocrlf=true` with no `.gitattributes`,
 * so the file is stored LF and checked out CRLF on Windows — the md5 below is
 * of the LF body `core.signature()` builds, and hashing the file as it lands on
 * disk would fail on every fresh clone while passing in the tree that wrote it.
 * Same normalisation the migration runner applies to its own checksums
 * (`src/db/migrate.js`), and for the same reason.
 */
function readPortalSignature() {
  return fs.readFileSync(PORTAL_SIGNATURE_FILE, 'utf8').replace(/\r\n/g, '\n');
}

/* ──────────────────────────────────────────────────────────────────────────
 * THE PORTAL'S SC 1.4.11 ALLOWLIST.
 *
 * S3b-3 taught the sweep to see SVG paint, and 339 of the portal's icons came
 * back below 3:1. SC 1.4.11 does not ask for 3:1 of all of them, and the two
 * entries below are the ones it does not ask for. They are a LIST, not a rule:
 * a heuristic such as "has a text sibling" would acquire and lose members every
 * time markup moved and would never say so, whereas a list that stops matching
 * shows up as a new FAIL line the moment the thing it named changes.
 *
 * Each entry narrows on ROLE and SELECTOR — what the thing IS — and not on its
 * colour. The reasons below are facts about the markup, so an exemption must
 * not quietly survive a re-hue, nor lapse because a token moved.
 *
 * Everything NOT on this list is scored, deliberately including the two
 * icon-only controls: `.phone-row__remove` and `.holiday__remove` carry no
 * adjacent label at all, so their icon IS the whole control, and
 * `.holiday__remove` in a past row (2.60:1 at opacity .68) is a real defect
 * that stays in the number.
 * ────────────────────────────────────────────────────────────────────────── */

const PORTAL_EXEMPT = Object.freeze([
  /* `sidebar-nav-icon` WAS HERE, AND IS GONE — S3c-1. It excused 288 icons that
   * measured 2.46:1 as --faint. They are --ink-2 now and measure 7.42:1, so the
   * entry excused nothing while still reading as a live decision, and an
   * exemption that stops matching does not announce itself: it would simply sit
   * here until a future re-hue quietly walked back under it and was silenced by
   * a judgement nobody had made about the colour it now had. Exemptions are
   * removed when the thing they excuse stops needing excusing. The reasoning it
   * carried is not lost — it is the argument in tokens.css for why the sidebar
   * icon takes the label's own colour. */
  Object.freeze({
    name: 'nav-soon-inactive',
    role: 'graphic',
    sel: /nav__item--soon > svg > /,
    why: 'The "Soon" rows are not navigable — they are rendered as a <span>, not '
      + 'an <a>, and carry no href and no handler.',
    sc: 'SC 1.4.11 exempts INACTIVE user interface components outright, without '
      + 'reference to what they are painted in.',
  }),
  Object.freeze({
    name: 'readiness-ring-track',
    role: 'graphic',
    sel: /> circle\.ring__track$/,
    why: 'The groove the progress arc is drawn into. It encodes no value — the '
      + 'arc does, and the same count is printed as text inside the ring.',
    sc: 'SC 1.4.11 does not apply to pure decoration; the track is the '
      + 'background of the indicator, not the indicator.',
  }),
]);

/* ──────────────────────────────────────────────────────────────────────────
 * Re-export. Named explicitly — a spread would let the surface drift silently.
 *
 * `judge` is the ONE exception, and it is a binding rather than a copy: it
 * calls the core's judge and adds the allowlist above, because the portal's
 * driver — scripts/portal/shoot.js:588 — calls `kit.judge(rows)` with no
 * options and cannot be edited from this session's file set. The exemptions are
 * a fact about the portal, so they belong here and not in a surface-agnostic
 * engine. portalContrast.test.js pins that this wrapper adds the list and
 * nothing else.
 * ────────────────────────────────────────────────────────────────────────── */

const RE_EXPORTED = [
  // colour maths
  'parseColor', 'compositeOver', 'relativeLuminance', 'contrastRatio',
  'isLargeText', 'parseBoxShadow',
  // verdicts
  'judge', 'judgeRing', 'uniquePairs', 'signature',
  // the in-page half, and the sources shoot.js evaluates over CDP
  'buildSource', 'sweepPage', 'blurActive', 'tagFocusables', 'readFocusRing',
  'TEXT_SWEEP_SOURCE', 'BLUR_SOURCE', 'TAG_FOCUSABLES_SOURCE', 'READ_RING_SOURCE',
  // the contract and the thresholds
  'INK_FAINT', 'AA_BODY', 'AA_LARGE', 'AA_NON_TEXT',
];

function judge(rows, opts) {
  return core.judge(rows, Object.assign({ exempt: PORTAL_EXEMPT }, opts));
}

const surface = {};
for (const name of RE_EXPORTED) {
  if (core[name] === undefined) {
    throw new Error(`contrast core no longer exports ${name} — portalContrast.js `
      + 'and scripts/portal/shoot.js both import it by that name');
  }
  surface[name] = core[name];
}

module.exports = Object.assign(surface, {
  judge,                            // the binding, not core.judge — see above
  core,
  PORTAL_BASELINE,
  PORTAL_EXEMPT,
  PORTAL_SIGNATURE_FILE,
  readPortalSignature,
});
