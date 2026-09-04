'use strict';

/* ============================================================================
 * THE SEAM THAT KEEPS `npm test` OFF THE COMPANY'S DATABASE.
 *
 * `tests/_support/testEnv.js` is a `--require` preload on the `test` script. It
 * assigns `process.env.DATABASE_URL = process.env.TEST_DATABASE_URL` before any
 * test module loads, and everything downstream derives from DATABASE_URL: the
 * scratch-minting suites (`CREATE DATABASE` → genesis → `DROP DATABASE`), the pg
 * Pool in `src/db/db.js`, `migrate.js`'s `makeClient()` fallback, and every
 * harness the suite spawns with `env: process.env`.
 *
 * On this machine `.env`'s DATABASE_URL is production Neon. That one assignment
 * is therefore the whole of the difference between a suite run and a series of
 * CREATE/DROP DATABASE pairs on the live company — and until this file, NOTHING
 * asserted it.
 *
 * ── WHY AN UNTESTED SEAM IS WORSE THAN A WRONG ONE ─────────────────────────
 * It was believed rather than measured, and the belief went the wrong way in
 * three documents: ADMIN-S6 filed that every `npm test` already minted scratch
 * databases on production Neon, its commit message said so, and `state.md`
 * carried it into the next brief. Measurement at ADMIN-S7R showed the child had
 * been dialling `localhost:5432/saas_crm_test` the whole time. The claim was
 * false — but the reason it survived three readings is that a seam nothing tests
 * can be wrong in EITHER direction and read exactly the same. This file removes
 * that: from here on the question is answered by a run, not by a reading.
 *
 * The direction that costs something is the other one. If the preload is dropped
 * from `package.json`, if `TEST_DATABASE_URL` goes unset, or if the assignment
 * is removed, these two tests go red BEFORE any suite reaches a CREATE DATABASE.
 *
 * ── IT FAILS, IT DOES NOT SKIP ─────────────────────────────────────────────
 * Every condition below is a real misconfiguration, so each one is named and
 * failed rather than skipped past. A skip here would restore exactly the
 * property being removed — a gate that reports success without looking — and
 * this repository has paid for those (F-A020, F-A039, F-A043). The messages say
 * which variable to set.
 *
 * ── THE HOST CHECK IS NOT A REGEX, AND IS NOT NEW CODE ─────────────────────
 * `resolveDbTarget` and `assertLocalHost` are REUSED from
 * `scripts/seed-turn-traces.js`, for the reason that script gives: the assertion
 * has to be about the host pg would really dial. A substring match over the URL
 * text passes `…?options=host%3Dlocalhost` and rejects a unix socket path. Both
 * functions are already unit-tested at
 * `tests/admin/tracePageContract.integration.test.js:271-273`; this file points
 * them at the suite's own environment instead of at a literal.
 *
 * ── RED-CHECKED BY REVERTING THE REPOINT ───────────────────────────────────
 * Both tests were shown red with `process.env.DATABASE_URL = local;` deleted
 * from `tests/_support/testEnv.js`, which is precisely the failure they exist to
 * catch. A guard that cannot be made to fail is the vacuous gate this repository
 * has already bought twice.
 *
 * ── NO CREDENTIALS IN A FAILURE MESSAGE ────────────────────────────────────
 * Same rule `testEnv.js:34` states for its own announce line: host and database
 * only. Nothing here prints a connection string, which is why the comparison
 * below is an `assert.ok` on a boolean rather than an `assert.equal` on two URLs.
 * ========================================================================== */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const seed = require('../../scripts/seed-turn-traces.js');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = 'tests/_support/testEnv.js';

/**
 * `die()` inside the seed script's guards calls `process.exit`, which would take
 * the whole runner with it. Copied in shape from
 * `tracePageContract.integration.test.js:253-278`, which stubs the same two
 * functions the same way.
 */
function withExitAsThrow(fn) {
  const realExit = process.exit;
  const realErr = console.error;
  const said = [];
  process.exit = (code) => { throw new Error('EXIT:' + code); };
  console.error = (m) => said.push(String(m));
  try {
    return fn(said);
  } finally {
    process.exit = realExit;
    console.error = realErr;
  }
}

describe('the test suite database seam', () => {
  it('resolves DATABASE_URL to a LOCAL host, parsed by pg\'s own parser', () => {
    assert.ok(process.env.DATABASE_URL,
      `DATABASE_URL is unset inside the suite. ${PRELOAD} resolves it and every `
      + 'scratch-minting suite derives from it, so unset means the preload did not run.');

    const outcome = withExitAsThrow((said) => {
      const target = seed.resolveDbTarget();
      try {
        seed.assertLocalHost(target, false);
        return { target, refused: false, said };
      } catch (_) {
        return { target, refused: true, said };
      }
    });

    assert.ok(!outcome.refused,
      `THE SUITE IS POINTED AT A NON-LOCAL DATABASE.\n`
      + `  host     : ${outcome.target.host}\n`
      + `  database : ${outcome.target.database}\n`
      + '  Every scratch-minting suite runs CREATE DATABASE and DROP DATABASE on that\n'
      + `  host, and every harness the suite spawns inherits it. Set TEST_DATABASE_URL\n`
      + `  to a local Postgres; ${PRELOAD} repoints DATABASE_URL at it for the whole\n`
      + '  test process tree.'
      + (outcome.said.length ? `\n  ${outcome.said.join('\n  ')}` : ''));
  });

  it('was REPOINTED by the preload, and is not local only by luck', () => {
    const script = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test;
    assert.ok(script.includes(PRELOAD),
      `the \`test\` script no longer preloads ${PRELOAD}:\n    ${script}\n`
      + '  That preload is the only thing that repoints DATABASE_URL away from whatever\n'
      + '  .env names, and it has to run before any test module because src/db/db.js\n'
      + '  captures DATABASE_URL when the pg Pool is built at import time.');

    assert.ok(process.env.TEST_DATABASE_URL,
      'TEST_DATABASE_URL is unset, so the preload had nothing to repoint to and this\n'
      + '  suite is running against DATABASE_URL exactly as .env gives it. That is the\n'
      + '  configuration this file exists to refuse. Set TEST_DATABASE_URL to a local\n'
      + '  Postgres (see .env.example). This FAILS rather than skips on purpose: a gate\n'
      + '  that cannot run must say so rather than pass.');

    // Booleans, never the URLs: a failure message must not carry credentials.
    assert.ok(process.env.DATABASE_URL === process.env.TEST_DATABASE_URL,
      `DATABASE_URL is not TEST_DATABASE_URL, so the repoint in ${PRELOAD} did not\n`
      + '  happen. The suite may still be pointed somewhere local, but if it is, it is\n'
      + '  local by accident: the seam is broken and the next machine with a remote\n'
      + '  DATABASE_URL will mint scratch databases on it.');
  });
});
