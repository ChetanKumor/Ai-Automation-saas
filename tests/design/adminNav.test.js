'use strict';

// ── The admin nav is five copies of one block (S5) ──────────────────────────
//
// No DB, no server, no browser: the shipped files. The panel has no nav
// COMPONENT — every page carries hand-written markup — so the only thing that
// can hold five copies in agreement is a test that reads all five and compares
// them to each other.
//
// This is the defect it exists to stop coming back, measured at S5's Phase A:
// the nav had drifted into THREE variants. Appointments and Workflow appeared
// on 4 of 10 pages; the brand link landed on tenants.html, which was one of the
// six that did NOT offer them — so an operator who clicked the brand from
// Appointments lost the link they had just used, and the panel's own landing
// page was the one that offered the least. Tenants was never a nav item at all.
//
// THREE test() blocks, following tokenDrift.test.js's rule: a per-page test
// would report the same fault five times and say nothing extra. It was TWO
// until ADMIN-S5 added the registry-keying block below, which is a different
// concern from either of the first two and names a different fault when it
// fails. The block count and the page count are independent numbers that now
// happen to be different again; adding a PAGE must still not add a block.
//
// ⚠ THE HEADER BELOW SAID "NINE" AND THE ARRAY SAID FOUR. A1 really did hold
// nine pages; ADMIN-S1 then deleted five of them, taking PAGES to four, and the
// prose was never corrected — so a comment claiming a nine-way comparison sat
// above a four-way one for three sessions. Corrected at ADMIN-S4, which takes
// it to FIVE: `traces.html` (Issue 27) enters PAGES, CURRENT and
// EXPECTED_HREFS as added entries, with no assertion weakened.
//
// A1 MADE IT NINE, and here is what that meant at the time.
// `tenant-detail.html` was the last holdout: it still carried
// the pre-S5 five-link block — no Tenants, no Appointments, no Workflow — so an
// operator on a tenant could not get back to the tenant list except through the
// brand. It now carries the canonical block and is in PAGES, and this test is
// then the nine-way comparison its title claimed. Its measured
// symptom is worth keeping: with three fewer items in a space-between bar, its
// item spacing was 254.80px at 1440 against every other page's ~116. The bar no
// longer uses space-between at all — see /admin/shell.css.
//
// What is NOT asserted here, on purpose:
//   • CSS. The block is markup; how it is painted is /admin/shell.css's
//     business now, and tests/design/adminShell.test.js is where that is gated.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'public', 'admin');

// The pages this file does NOT hold to the canonical block, NAMED one by one
// with the reason, never matched by a pattern. A pattern is the same hole in
// a new shape: `/login/` would silently exempt a future sso-login.html or
// login-v2.html from every assertion here, and nobody would be told. Each
// entry must also still EXIST on disk — a stale exclusion exempts nothing
// today and silently exempts whatever takes that name tomorrow.
const EXCLUDED = {
  'login.html': 'the signed-out door: no <nav>, and not a nav destination',
};

// Every page that carries the canonical block. Derived from disk and checked
// against it by the third block below — this array is a claim, not a source.
const PAGES = [
  'tenants.html', 'tenant-new.html', 'tenant-detail.html', 'conversations.html',
  'traces.html',
];

// aria-current marks a page that IS a nav destination. tenant-new.html and
// tenant-detail.html are not, so they carry none: marking a link the operator
// is not on would be a false claim to a screen reader.
const CURRENT = {
  'tenants.html': '/admin/tenants.html',
  'conversations.html': '/admin/conversations.html',
  'traces.html': '/admin/traces.html',
};

const EXPECTED_HREFS = [
  '/admin/tenants.html',        // the brand
  '/admin/tenants.html',
  '/admin/conversations.html',
  '/admin/traces.html',
  '/admin/logout',
];

function navOf(file) {
  const html = fs.readFileSync(path.join(DIR, file), 'utf8');
  const m = html.match(/[ \t]*<nav>[\s\S]*?<\/nav>/);
  assert.ok(m, `${file} has no <nav> block`);
  return m[0];
}

// Reads the SIBLING design test's PAGES literal without executing it. It must
// not be `require`d: both files are node:test files, so requiring one from the
// other would register its suites a second time and move the suite's own
// count. Fails loudly on zero matches and on more than one declaration — a
// parser that quietly returned [] would make the cross-file check vacuous,
// which is precisely the shape of the defect it exists to close (F-A034).
function pagesDeclaredIn(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const decls = src.split('\nconst PAGES = [').length - 1;
  assert.strictEqual(decls, 1,
    `${file} must declare 'const PAGES = [' exactly once; found ${decls}`);
  const body = src.match(/\nconst PAGES = \[([\s\S]*?)\];/)[1];
  const names = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(names.length > 0, `parsed zero page names out of ${file}'s PAGES`);
  for (const n of names) {
    assert.match(n, /\.html$/, `${file}'s PAGES holds ${JSON.stringify(n)},`
      + ' which is not a page. A reader that silently drops the entries it did'
      + ' not expect compares less than it claims to.');
  }
  return names.sort();
}

describe('admin nav parity (S5)', () => {
  it('is one identical block on every page but the aria-current attribute', () => {
    const stripped = new Map();
    for (const f of PAGES) {
      // Removing aria-current is what makes the comparison meaningful: it is
      // the ONE attribute that is supposed to differ, so a block that differs
      // in anything else fails here rather than hiding behind it.
      stripped.set(f, navOf(f).replace(/ aria-current="page"/g, ''));
    }
    const [first, ...rest] = PAGES;
    for (const f of rest) {
      assert.strictEqual(stripped.get(f), stripped.get(first),
        `${f}'s nav differs from ${first}'s by more than aria-current. ` +
        'The panel has no nav component; all copies must be edited together.');
    }

    // And the block is the one we meant, not merely five copies of a wrong one.
    const hrefs = [...navOf(first).matchAll(/<a href="([^"]+)"/g)].map((x) => x[1]);
    assert.deepStrictEqual(hrefs, EXPECTED_HREFS,
      'the canonical nav must offer Tenants, Conversations and Logout, ' +
      'behind a brand link to Tenants');
    assert.ok(/class="brand">Veprio Admin</.test(navOf(first)),
      'the brand reads "Veprio Admin" — "WhatsApp CRM" is a retired product name');
  });

  it('marks the current page, and only on pages that are a nav destination', () => {
    for (const f of PAGES) {
      const nav = navOf(f);
      const marks = [...nav.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((x) => x[1]);
      const want = CURRENT[f];
      if (!want) {
        assert.deepStrictEqual(marks, [],
          `${f} is not a nav destination, so no link may claim aria-current`);
        continue;
      }
      assert.deepStrictEqual(marks, [want],
        `${f} must mark exactly its own nav link with aria-current="page"`);
    }
  });

  // ── The registries are keyed to disk and to each other (F-A034, S5) ──────
  //
  // ADMIN-S4 red-checked its traces.html registry addition by deleting the
  // entry from PAGES, and both design tests stayed GREEN. CURRENT and
  // EXPECTED_HREFS are only ever read THROUGH PAGES, so an entry PAGES does
  // not list is never looked at, and dropping a page from PAGES silently drops
  // it from every assertion above. These registries had been the guard that a
  // page satisfies the shell contract for five sessions, and in that direction
  // they were decorative.
  //
  // So PAGES is no longer a literal anyone has to believe: the page set is
  // DERIVED from the .html files in public/admin/ and PAGES is held to it. It
  // is held to adminShell.test.js's PAGES as well, because each agreeing with
  // disk is only as strong as the two EXCLUDED lists agreeing, and neither
  // file can see the other's from where it stands.
  it('keys PAGES to disk, CURRENT to EXPECTED_HREFS, and PAGES to adminShell', () => {
    const html = fs.readdirSync(DIR).filter((f) => f.endsWith('.html')).sort();
    assert.ok(html.length > 0,
      'read zero .html files out of public/admin — the derivation is broken, '
      + 'not the registry, and a derivation that yields nothing must not pass');

    for (const [name, why] of Object.entries(EXCLUDED)) {
      assert.ok(html.includes(name),
        `EXCLUDED names ${name} (${why}) but public/admin holds no such file. `
        + 'A stale exclusion exempts nothing today and silently exempts whatever '
        + 'takes that name tomorrow.');
    }

    const expected = html.filter((f) => !(f in EXCLUDED));
    assert.deepStrictEqual([...PAGES].sort(), expected,
      'PAGES must be EXACTLY the .html files in public/admin minus the named '
      + 'exclusions. A page on disk that PAGES does not list is a page no '
      + 'assertion in this file covers, and it ships looking checked.');

    // F-A034 proper: a CURRENT key that PAGES does not list is never read.
    for (const k of Object.keys(CURRENT)) {
      assert.ok(PAGES.includes(k),
        `CURRENT names ${k}, which PAGES does not list, so nothing ever reads it`);
    }

    // And CURRENT's key set IS the set of nav destinations, which
    // EXPECTED_HREFS states independently. Two registries, one fact.
    const destinations = [...new Set(EXPECTED_HREFS
      .filter((h) => h.endsWith('.html'))
      .map((h) => path.basename(h)))].sort();
    assert.deepStrictEqual(Object.keys(CURRENT).sort(), destinations,
      'a page the nav LINKS to is exactly a page that must mark itself with '
      + 'aria-current when the operator is on it. CURRENT and EXPECTED_HREFS '
      + 'state that one set twice and must be edited together.');

    assert.deepStrictEqual([...PAGES].sort(), pagesDeclaredIn('adminShell.test.js'),
      'adminNav.test.js and adminShell.test.js must cover the same pages. Each '
      + 'agreeing with disk is only as strong as their two EXCLUDED lists '
      + 'agreeing, which is what this compares.');
  });
});
