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
 *   scripts/portal/shoot.js         the portal's URLs, its fourteen-page list,
 *     :447-495 and :219-223         its two viewports, and all three readiness
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
 * Measured by `node scripts/portal/shoot.js --contrast` over fourteen pages at
 * 1280 and 380. The signature is the distinct-shape reduction (core.signature);
 * the counts are recorded beside it but are NOT the invariant — S2 saw the row
 * count read 2302 / 2325 / 2339 / 2347 across five runs of an unchanged tree
 * while the signature stayed byte-identical. Compare the signature. The counts
 * are here so a run that moves them is noticed, not so a run that moves them is
 * failed.
 *
 * `portal.signature.txt` is the signature body itself, checked in so that the
 * live baseline is auditable — and re-hashable — without a browser, a database
 * or a Chrome. portalContrast.test.js re-hashes it on every `npm test`, which
 * is what stops the file and the md5 below from drifting apart.
 * ────────────────────────────────────────────────────────────────────────── */

const PORTAL_SIGNATURE_FILE = path.join(__dirname, 'contrast', 'portal.signature.txt');

const PORTAL_BASELINE = Object.freeze({
  at: 'ecb049b',                    // the commit the sweep below was taken on
  pages: 14,
  widths: Object.freeze([1280, 380]),
  rows: 2347,                       // glyph rows measured
  pairs: 47,                        // distinct colour/backdrop/band/opacity
  failures: 558,                    // threshold failures, 13 distinct shapes
  contract: 0,                      // D-016 --ink-faint as a glyph colour
  undeterminable: 2,                // background-image in the backdrop stack
  rings: 712,                       // focus indicators measured
  ringFailures: 0,                  // below SC 1.4.11's 3:1
  signatureMd5: '1c51c92ad7586e239e6cb0e2de5a057b',
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
 * Re-export. Named explicitly — a spread would let the surface drift silently.
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

const surface = {};
for (const name of RE_EXPORTED) {
  if (core[name] === undefined) {
    throw new Error(`contrast core no longer exports ${name} — portalContrast.js `
      + 'and scripts/portal/shoot.js both import it by that name');
  }
  surface[name] = core[name];
}

module.exports = Object.assign(surface, {
  core,
  PORTAL_BASELINE,
  PORTAL_SIGNATURE_FILE,
  readPortalSignature,
});
