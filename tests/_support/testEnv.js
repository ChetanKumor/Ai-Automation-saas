'use strict';

// TEST-FLAKE-02 — the ONE place the test suite resolves its database.
//
// Loaded via `--require` from the `test` npm script, so it runs before ANY test
// module. That seam is not cosmetic: ~16 suites `require('src/db/db')` at module
// top and the pg Pool captures DATABASE_URL at import time (the PORTAL-P1-S1
// lazy-require lesson). A resolver that ran inside a test file would already be
// too late for those. `node --test` propagates execArgv to the per-file child
// processes, so each child loads this too.
//
// When TEST_DATABASE_URL is set we repoint DATABASE_URL at it for the whole test
// process tree. Everything downstream derives from DATABASE_URL and therefore
// follows with no per-file resolution logic:
//   • the 17 scratch-minting suites (`const ADMIN = process.env.DATABASE_URL`
//     → CREATE DATABASE → runner.genesis({connectionString}) → DROP),
//   • migrate.js makeClient()'s `|| process.env.DATABASE_URL` fallback,
//   • the app pool in src/db/db.js.
//
// dotenv never overwrites an already-set key, so the `require('dotenv').config()`
// at the top of each test file cannot undo this.
//
// Dev/prod runtime is untouched — nothing outside the test path loads this file.

require('dotenv').config({ quiet: true });

const local = process.env.TEST_DATABASE_URL;

// Recorded in our own env so the `node --test` children inherit it and stay
// quiet: the line below prints exactly once per suite run, from the parent.
const isFirstProcess = !process.env.ZYON_TEST_DB_ANNOUNCED;
process.env.ZYON_TEST_DB_ANNOUNCED = '1';

// host + database only — never the credentials.
function target(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch (_) {
    return '(unparseable connection string)';
  }
}

if (local) {
  process.env.DATABASE_URL = local;
  if (isFirstProcess) {
    console.log(`[tests] database: ${target(local)} — via TEST_DATABASE_URL`);
  }
} else if (isFirstProcess) {
  // No silent behavior change: without TEST_DATABASE_URL the suite still runs
  // against DATABASE_URL exactly as it always has, but says so loudly.
  const where = process.env.DATABASE_URL
    ? target(process.env.DATABASE_URL)
    : 'DATABASE_URL unset — DB suites will skip';
  console.warn(
    '\n!!! TESTS RUNNING AGAINST REMOTE DB — EXPECT NONDETERMINISM !!!\n' +
    `!!! target: ${where}\n` +
    '!!! set TEST_DATABASE_URL to a local Postgres (see .env.example)\n'
  );
}
