'use strict';

/* ============================================================================
 * THE PORTAL CONTRAST GATE — the live half, in `npm test`.
 *
 * ── WHAT WAS WRONG, PRECISELY ─────────────────────────────────────────────
 * Until S3b-3 the only thing `npm test` checked about the portal's contrast
 * baseline was `portalContrast.test.js:299`: it hashed the checked-in
 * `contrast/portal.signature.txt` and compared that hash to
 * `PORTAL_BASELINE.signatureMd5`. Both sides are static. The file cannot drift
 * from the constant beside it — and that is ALL it can say.
 *
 * What it cannot say is whether either one still describes the portal. It
 * didn't. S3b flipped the portal's ground to warm paper at `b403938` and S3b-2
 * finished the flip at `3f5b8ec`; the live signature moved `1c51c92a` ->
 * `cd8dff4b` -> `20009581`, the checked-in file stayed at `1c51c92a`, and the
 * suite stayed green across both commits. Two sessions shipped a visual change
 * with a contrast gate that agreed with itself about a ground that no longer
 * existed. That is the same failure mode as D-016's "532 pairs measured, zero
 * failures" — a number nobody can re-run — arriving by a slower route.
 *
 * So this block runs the sweep. Every `npm test`, against the portal as it
 * actually renders, and compares THAT to the checked-in body.
 *
 * ── WHY IT SHELLS OUT ─────────────────────────────────────────────────────
 * `scripts/portal/shoot.js --contrast` already owns everything the live half
 * needs: a throwaway scratch database minted by `runner.genesis`, a seeded
 * tenant, the real `/portal` router on an ephemeral port, a session cookie,
 * headless Chrome over CDP, the fourteen-page list, both viewports and all
 * three readiness gates. Re-implementing any of that here would be a second
 * instrument, and two instruments disagree the first time either is touched.
 * It is INVOKED, never edited: this file drives the tool the founder drives.
 *
 * The signature is then recomputed in-process from the report the run writes,
 * with `core.signature()` — the same function that produced the checked-in
 * body — so the comparison is between two runs of one algorithm, never between
 * a measurement and a transcription of one.
 *
 * ── WHY IT FAILS RATHER THAN SKIPS ────────────────────────────────────────
 * No Chrome, no DATABASE_URL, no ADMIN_PASSWORD: this test FAILS and names
 * which one. It does not skip. A skip here would restore exactly the property
 * being removed — a gate that reports success without looking — and this repo
 * has already paid for two of those (`shootD5a.js:589`'s `.card` gate, born
 * vacuous; S4's `profileCard.hidden`, made vacuous by `0881e75`). The cost of
 * that choice is real and is the founder's to weigh: see WALL TIME below.
 *
 * ── WALL TIME ─────────────────────────────────────────────────────────────
 * One sweep is 14 pages x 2 viewports and takes ~225 s on this machine against
 * a local Postgres. `npm test` without it is ~268 s. The runner executes test
 * FILES concurrently, so the two overlap and the suite does not simply add the
 * two together — the measured before/after is in the session report. If that
 * cost is not wanted on every commit the seam is this file, not the engine:
 * it is one `test()` in one file and moving it behind an npm script would take
 * a line. That is a decision about how often the portal is measured, and it is
 * not made here.
 *
 * ── ONE test() BLOCK, DELIBERATELY ────────────────────────────────────────
 * Same house rule `tokenDrift.test.js:10-14` and `heroDisclosure.test.js:32-34`
 * state in their own headers: the suite total is a tracked number, so a design
 * test grows by ASSERTION, never by block.
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const kit = require('../portalContrast');
const core = require('./core');

const ROOT = path.join(__dirname, '..', '..', '..');
const SHOOT = path.join(ROOT, 'scripts', 'portal', 'shoot.js');
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** ~225 s is the measured sweep; this is the hang bound, not the expectation. */
const SWEEP_TIMEOUT_MS = 15 * 60 * 1000;

/** The lines one body has and the other does not, both ways round. */
function lineDiff(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    gone: expected.filter((l) => !a.has(l)),
    added: actual.filter((l) => !e.has(l)),
  };
}

test('the portal contrast baseline is RE-MEASURED on the live portal, not recited', () => {
  // ── prerequisites, each named, none of them silently skipped ───────────
  const missing = [];
  if (!fs.existsSync(SHOOT)) missing.push(`the sweep driver is not at ${SHOOT}`);
  if (!fs.existsSync(CHROME)) {
    missing.push(`no Chrome at ${CHROME} — set CHROME_PATH to one that exists`);
  }
  if (!process.env.DATABASE_URL) {
    missing.push('DATABASE_URL is unset — the sweep mints a scratch database from it '
      + '(tests/_support/testEnv.js repoints it at TEST_DATABASE_URL for the suite)');
  }
  if (!process.env.ADMIN_PASSWORD) {
    missing.push('ADMIN_PASSWORD is unset — the sweep signs into /admin for one of its pages');
  }
  assert.deepStrictEqual(missing, [],
    'the live contrast sweep cannot run, and a gate that cannot run must say so rather '
    + 'than pass:\n  - ' + missing.join('\n  - '));

  // ── the run ────────────────────────────────────────────────────────────
  const out = path.join(os.tmpdir(),
    `portal-contrast-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const run = spawnSync(process.execPath, [SHOOT, '--contrast', '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SWEEP_TIMEOUT_MS,
    // The scratch DB, the port and the Chrome profile all come from the child's
    // own env. Inherited as-is so the sweep measures against the same database
    // the rest of the suite does.
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

  try {
    const tail = (s) => String(s || '').split('\n').slice(-25).join('\n');
    if (run.error && run.error.code === 'ETIMEDOUT') {
      assert.fail(`the contrast sweep did not finish inside ${SWEEP_TIMEOUT_MS / 1000}s\n`
        + tail(run.stdout));
    }
    assert.strictEqual(run.status, 0,
      `scripts/portal/shoot.js --contrast exited ${run.status}\n`
      + tail(run.stdout) + '\n' + tail(run.stderr));
    assert.ok(fs.existsSync(out), `the sweep exited 0 but wrote no report to ${out}`);

    const report = JSON.parse(fs.readFileSync(out, 'utf8'));

    // ── the comparison ───────────────────────────────────────────────────
    // Recomputed with core.signature() from the run's own report, which is the
    // shape that function documents as its input and the shape the checked-in
    // body was built from. Nothing is transcribed.
    const live = core.signature(report);
    const checkedIn = kit.readPortalSignature();
    const checkedInLines = checkedIn.trim().split('\n');

    if (live.body !== checkedIn) {
      const { gone, added } = lineDiff(checkedInLines, live.lines);
      assert.fail(
        'the live portal no longer matches tests/design/contrast/portal.signature.txt.\n'
        + `  checked in : ${crypto.createHash('md5').update(checkedIn, 'utf8').digest('hex')}`
        + ` (${checkedInLines.length} lines)\n`
        + `  measured   : ${live.md5} (${live.lines.length} lines)\n`
        + (gone.length ? '\n  IN THE BASELINE, NOT ON THE PORTAL:\n    ' + gone.join('\n    ') : '')
        + (added.length ? '\n\n  ON THE PORTAL, NOT IN THE BASELINE:\n    ' + added.join('\n    ') : '')
        + '\n\nIf the change was intended, re-measure and check the new body in:\n'
        + '  node scripts/portal/shoot.js --contrast --out <file>\n'
        + 'then write core.signature(<file>).body to portal.signature.txt and move\n'
        + 'PORTAL_BASELINE.signatureMd5 in tests/design/portalContrast.js to match.\n'
        + 'Do not edit the file by hand: it is the output of a measurement.'
      );
    }

    // The static half still holds too, and is asserted here rather than trusted
    // from the other file: this run has just proved the BODY describes the live
    // portal, so proving the constant describes the body closes the loop the
    // static test could only close on itself.
    assert.strictEqual(live.md5, kit.PORTAL_BASELINE.signatureMd5,
      'PORTAL_BASELINE.signatureMd5 does not match the signature just measured');

    // ── the counts: reported, never asserted ─────────────────────────────
    // S2 measured five sweeps of one unchanged tree at 2302 / 2325 / 2339 /
    // 2347 rows with a byte-identical signature. The shape is the invariant;
    // the counts are recorded so a run that moves them is NOTICED. Printing is
    // what "noticed" means here — failing on them would make this gate flake.
    const drift = [];
    const seen = {
      rows: report.rows,
      pairs: report.pairs,
      failures: report.failures.length,
      contract: report.contract.length,
      undeterminable: report.undeterminable.length,
      rings: report.rings.length,
      ringFailures: report.rings.filter((r) => !r.pass).length,
    };
    for (const [k, v] of Object.entries(seen)) {
      if (kit.PORTAL_BASELINE[k] !== undefined && kit.PORTAL_BASELINE[k] !== v) {
        drift.push(`${k}: ${kit.PORTAL_BASELINE[k]} -> ${v}`);
      }
    }
    if (drift.length) {
      console.log('  [portal contrast] signature unmoved; counts moved: ' + drift.join(', '));
    }

    // Two things are NOT counts and DO fail: a D-016 contract violation is a
    // written rule, and a focus indicator under 3:1 is SC 1.4.11. Both are zero
    // in the baseline, and neither can be reached by a readiness race.
    assert.strictEqual(seen.contract, 0,
      'D-016: --ink-faint resolved as a glyph colour on the live portal');
    assert.strictEqual(seen.ringFailures, 0,
      'SC 1.4.11: a focus indicator on the live portal is below 3:1');
  } finally {
    try { fs.unlinkSync(out); } catch (_) { /* the run may not have written it */ }
  }
});
