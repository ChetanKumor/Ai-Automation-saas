'use strict';

// ── The admin nav is four copies of one block (S5) ──────────────────────────
//
// No DB, no server, no browser: the shipped files. The panel has no nav
// COMPONENT — every page carries hand-written markup — so the only thing that
// can hold four copies in agreement is a test that reads all four and compares
// them to each other.
//
// This is the defect it exists to stop coming back, measured at S5's Phase A:
// the nav had drifted into THREE variants. Appointments and Workflow appeared
// on 4 of 10 pages; the brand link landed on tenants.html, which was one of the
// six that did NOT offer them — so an operator who clicked the brand from
// Appointments lost the link they had just used, and the panel's own landing
// page was the one that offered the least. Tenants was never a nav item at all.
//
// TWO test() blocks, deliberately no more, following tokenDrift.test.js's rule:
// a per-page test would report the same fault four times and say nothing extra.
//
// A1 MADE IT NINE. `tenant-detail.html` was the last holdout: it still carried
// the pre-S5 five-link block — no Tenants, no Appointments, no Workflow — so an
// operator on a tenant could not get back to the tenant list except through the
// brand. It now carries the canonical block and is in PAGES, and this test is
// finally the nine-way comparison its title has always claimed. Its measured
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

// Every page that carries the canonical block. login.html is deliberately
// absent: it is the signed-out door and has no nav at all.
const PAGES = [
  'tenants.html', 'tenant-new.html', 'tenant-detail.html', 'conversations.html',
];

// aria-current marks a page that IS a nav destination. tenant-new.html and
// tenant-detail.html are not, so they carry none: marking a link the operator
// is not on would be a false claim to a screen reader.
const CURRENT = {
  'tenants.html': '/admin/tenants.html',
  'conversations.html': '/admin/conversations.html',
};

const EXPECTED_HREFS = [
  '/admin/tenants.html',        // the brand
  '/admin/tenants.html',
  '/admin/conversations.html',
  '/admin/logout',
];

function navOf(file) {
  const html = fs.readFileSync(path.join(DIR, file), 'utf8');
  const m = html.match(/[ \t]*<nav>[\s\S]*?<\/nav>/);
  assert.ok(m, `${file} has no <nav> block`);
  return m[0];
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

    // And the block is the one we meant, not merely four copies of a wrong one.
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
});
