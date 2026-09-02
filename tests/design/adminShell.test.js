'use strict';

// ── The admin shell is ONE file, and the four pages are held to it (A1) ─────
//
// No DB, no server, no browser: the shipped files, read off disk. Everything
// this file can prove statically it proves here; everything that needs a
// rendered page — alignment, horizontal overflow, tab order, the computed ring
// — is measured by `scripts/admin/measure.js`, which is committed for exactly
// that reason and is the instrument A2-A5 use.
//
// THE DEFECT THIS EXISTS TO STOP COMING BACK. Before A1 the nav was declared
// three times: once in /admin/style.css and twice more, verbatim, inside the
// <style> blocks of tenants.html and tenant-new.html, because S5 moved those
// two pages onto portal tokens and a page migrates whole or not at all. Three
// copies of one design is three chances to drift, and adminNav.test.js already
// exists because the MARKUP had drifted into three variants once. The CSS was
// one edit away from the same fate.
//
// FOUR test() blocks, deliberately no more, following the rule tokenDrift.test.js
// and adminNav.test.js both state: a per-page test would report one fault four
// times and say nothing extra.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { contrastRatio, parseColor, AA_BODY, AA_NON_TEXT } =
  require('./contrast/core.js');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN = path.join(ROOT, 'public', 'admin');
const read = (f) => fs.readFileSync(path.join(ADMIN, f), 'utf8');

// Every structural assertion below scans CSS for rules, and a rule is not a
// sentence about a rule. shell.css's own header explains why it may not write
// `var(--teal-500)`, and style.css's explains where the nav block went — both
// would trip a naive scan. Strip comments first, always.
const noCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
const noHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ');

// The pages, named below rather than counted. login.html is deliberately
// absent, as it is in adminNav.test.js: it is the signed-out door, has no nav,
// and moved onto tokens at S4 under its own rules.
const PAGES = [
  'tenants.html', 'tenant-new.html', 'tenant-detail.html', 'conversations.html',
];

// Measured at A1's Phase A and re-measured after the change. An id that
// disappears here is a JS handler that silently stopped binding, which is the
// failure mode this panel is most exposed to: every page drives itself from an
// inline <script> or a sibling .js addressing elements by id.
const EXPECTED_IDS = {
  'tenants.html': 1,
  'tenant-new.html': 6,
  'tenant-detail.html': 44,
  'conversations.html': 12,
};

describe('admin shell + page header (A1)', () => {
  it('is one stylesheet: shell.css last on all four, and no nav rule anywhere else', () => {
    for (const f of PAGES) {
      const html = read(f);
      const links = [...noHtmlComments(html).matchAll(/<link[^>]+href="([^"]+\.css)"/g)]
        .map((m) => m[1]);

      assert.ok(links.includes('/admin/shell.css'),
        `${f} must link /admin/shell.css`);
      assert.strictEqual(links[links.length - 1], '/admin/shell.css',
        `${f} must link /admin/shell.css LAST — it deliberately overrides `
        + 'tokens.css (.page-head*, .content) and style.css (body, nav, .container), '
        + 'and a reorder would hand those selectors back.');
      assert.ok(links.includes('/portal/fonts/fonts.css'),
        `${f} must link /portal/fonts/fonts.css — one type family across all four. `
        + 'It is fourteen @font-face rules and nothing else, so it adds no cascade '
        + 'surface and downloads nothing until a rule asks for the face.');

      // The whole point: no page carries nav CSS of its own any more.
      const inline = noCssComments(
        [...noHtmlComments(html).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'));
      assert.ok(!/(^|[\s,>])nav\s*(\{|a\b|\.brand)/m.test(inline),
        `${f} declares nav CSS in an inline <style>. The bar lives in `
        + '/admin/shell.css, once, for all four pages.');
    }

    const style = noCssComments(fs.readFileSync(path.join(ADMIN, 'style.css'), 'utf8'));
    assert.ok(!/(^|[\s,>])nav\s*(\{|a\b|\.brand)/m.test(style),
      '/admin/style.css must no longer declare the nav — it moved to shell.css '
      + 'at A1 and a second copy is how the three-way drift started.');

    // shell.css must survive on conversations.html and tenant-detail.html, which
    // carry no custom properties at all, so the only var() it may use is the one
    // it declares itself.
    const shell = noCssComments(fs.readFileSync(path.join(ADMIN, 'shell.css'), 'utf8'));
    const vars = [...shell.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    const foreign = [...new Set(vars)].filter((v) => v !== '--admin-rail');
    assert.deepStrictEqual(foreign, [],
      'shell.css may only reference --admin-rail, which it declares itself. '
      + 'conversations.html and tenant-detail.html load no custom properties, so any other var() '
      + `resolves to nothing there and the rule silently vanishes. Found: ${foreign}`);
    assert.match(shell, /--admin-rail:\s*920px/,
      'shell.css must declare the rail it derives the bar padding from');
  });

  it('gives all four a page header with a title and its own subtitle', () => {
    const subs = new Map();
    for (const f of PAGES) {
      const html = read(f);

      assert.match(html, /<div class="page-head">/,
        `${f} must carry a .page-head row`);
      const titles = [...html.matchAll(/<h1 class="page-head__title"[^>]*>([^<]+)<\/h1>/g)];
      assert.ok(titles.length >= 1,
        `${f} must carry an <h1 class="page-head__title">`);

      const found = [...html.matchAll(/<p class="page-head__sub">([\s\S]*?)<\/p>/g)]
        .map((m) => m[1].trim());
      assert.ok(found.length >= 1, `${f} must carry a .page-head__sub`);
      for (const s of found) {
        assert.ok(s.length > 20,
          `${f}'s subtitle is too short to say anything: ${JSON.stringify(s)}`);
        assert.ok(/[.!]$/.test(s),
          `${f}'s subtitle must be a sentence, ending in a full stop: ${JSON.stringify(s)}`);
      }
      subs.set(f, found[0]);
    }

    // Four pages, four different sentences. A copied subtitle is worse than
    // none: it tells the operator this page is the same as the last one.
    const seen = new Map();
    for (const [f, s] of subs) {
      if (seen.has(s)) {
        assert.fail(`${f} and ${seen.get(s)} share a subtitle. Each page says `
          + 'what IT is, or says nothing.');
      }
      seen.set(s, f);
    }
  });

  it('keeps every preservation contract A1 was bound by', () => {
    // 1. Every id, on every page. tenant-detail's 44 above all: it drives a
    //    21kB script entirely by getElementById.
    for (const f of PAGES) {
      const n = (read(f).match(/\sid="[^"]*"/g) || []).length;
      assert.strictEqual(n, EXPECTED_IDS[f],
        `${f} has ${n} ids, expected ${EXPECTED_IDS[f]}. Every one of them is a `
        + 'handler binding site; moving an element is fine, losing its id is not.');
    }

    // 2. The four expressions scripts/portal/shoot.js:2553-2560 evaluates against
    //    tenant-detail.html. TWO of them pin an INLINE style.display, not a
    //    class — converting either toggle to a class would leave the shot green
    //    and blind. The lifecycle buttons moved into .page-head__actions at A1
    //    and neither toggle was touched.
    const detail = read('tenant-detail.html');
    const detailJs = fs.readFileSync(path.join(ADMIN, 'tenant-detail.js'), 'utf8');
    for (const id of ['ownerCreateBtn', 'ownerEmail', 'ownerResult', 'detail']) {
      assert.ok(new RegExp(`id="${id}"`).test(detail),
        `tenant-detail.html must keep #${id} — scripts/portal/shoot.js asserts on it`);
    }
    assert.match(detailJs, /\$\('detail'\)\.style\.display = 'block'/,
      "tenant-detail.js must set #detail's display as an inline style to the "
      + "literal 'block'. shoot.js:2553 waits on `.style.display==='block'`; a "
      + 'class toggle satisfies the page and never satisfies that gate.');
    assert.match(detailJs, /\$\('ownerResult'\)\.style\.display = 'block'/,
      "#ownerResult must be revealed by inline style.display — shoot.js:2560 "
      + 'reads its COMPUTED display and waits for it to leave none.');
    for (const id of ['lcValidate', 'lcActivate', 'lcPause']) {
      assert.ok(new RegExp(`<button id="${id}"[^>]*>`).test(detail),
        `tenant-detail.html must keep #${id}`);
    }
    // They moved INTO the header's action slot. That was the point.
    const head = detail.match(/<div class="page-head__actions">([\s\S]*?)<\/div>/);
    assert.ok(head && /lcValidate/.test(head[1]) && /lcActivate/.test(head[1])
      && /lcPause/.test(head[1]),
      'the lifecycle controls are this page\'s primary actions and belong in '
      + '.page-head__actions, not in a card below the fold');

    // 3. tenant-new's five form controls, and the field that must stay absent.
    const tnew = read('tenant-new.html');
    for (const name of ['business_name', 'phone_number_id', 'wa_token', 'waba_id', 'ai_enabled']) {
      assert.ok(new RegExp(`name="${name}"`).test(tnew),
        `tenant-new.html must keep name="${name}"`);
    }
    // The page carries a deliberate COMMENT naming this field and saying why it
    // is absent, so the check is for a CONTROL, matching tests/admin/
    // tenantCreate.test.js:102-105 rather than duplicating it loosely.
    const tnewMarkup = noHtmlComments(tnew);
    assert.ok(!/name=["']ai_prompt["']/.test(tnewMarkup),
      'tenant-new.html must not grow an ai_prompt control (Issue 34): a non-null '
      + 'tenants.ai_prompt short-circuits the config read and silently inerts '
      + 'every setting the owner later saves in the portal.');
    assert.ok(!/<textarea[^>]*ai_prompt/.test(tnewMarkup),
      'tenant-new.html must not carry an ai_prompt textarea');

    // 4. The transport contracts. app.js carries the CSRF header and the 401
    //    redirect for every page; logout is a GET on an <a href> and must not
    //    become a button or a form.
    const appJs = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');
    assert.match(appJs, /'X-Zyon-Admin': '1'/,
      'adminFetch must keep the CSRF header the mutating admin routes require');
    assert.match(appJs, /res\.status === 401[\s\S]*?window\.location\.href = '\/admin'/,
      'adminFetch must keep the 401 -> /admin redirect');
    for (const f of PAGES) {
      assert.match(read(f), /<a href="\/admin\/logout">Logout<\/a>/,
        `${f}'s Logout must stay a GET on an <a href> — not a button, not a form`);
      assert.ok(read(f).includes('/admin/app.js'),
        `${f} must load /admin/app.js`);
    }

    // 5. Badge class literals live in JS maps. If a CSS rename ever happens the
    //    maps move with it; today nothing renamed, so every literal a map emits
    //    must still resolve to a rule in style.css.
    const styleCss = fs.readFileSync(path.join(ADMIN, 'style.css'), 'utf8');
    const emitted = new Set();
    for (const f of [...PAGES, 'conversations.js', 'tenant-detail.js']) {
      const src = fs.readFileSync(path.join(ADMIN, f), 'utf8');
      for (const m of src.matchAll(/'(badge-[a-z]+)'/g)) emitted.add(m[1]);
    }
    assert.ok(emitted.size >= 3, 'expected the badge maps to still emit class names');
    for (const cls of emitted) {
      assert.ok(styleCss.includes('.' + cls),
        `JS emits "${cls}" but /admin/style.css declares no .${cls} rule. A badge `
        + 'class rename must move the string literals in the JS maps with it.');
    }
  });

  it('clears every contrast floor the shell introduces', () => {
    // COMPUTED, not measured: these are the literals as authored in shell.css,
    // put through the same core.js the portal's live sweep uses. The rendered
    // page is measured separately by scripts/admin/measure.js.
    //
    // The bar ground moved #1a1a2e -> #17150f at A1 and every pair on it
    // improved. The old navy's numbers are in docs/design/brand-values.md.
    const INK = '#17150f';      // bar ground, the product's ink
    const PAPER = '#faf8f5';    // page ground on all four
    const CARD = '#ffffff';

    const PAIRS = [
      // [label, foreground, background, floor]
      ['brand on the bar',            '#ffffff', INK,   AA_BODY],
      ['idle nav item on the bar',    '#cfc9c1', INK,   AA_BODY],
      ['hover / current nav item',    '#ffffff', INK,   AA_BODY],
      ['current-page underline',      '#14b8a6', INK,   AA_NON_TEXT],
      ['nav focus ring',              '#14b8a6', INK,   AA_NON_TEXT],
      ['bar against the page ground', INK,       PAPER, AA_NON_TEXT],
      ['page title',                  '#17150f', PAPER, AA_BODY],
      ['page subtitle',               '#57524a', PAPER, AA_BODY],
      ['shared focus ring on paper',  '#0f766e', PAPER, AA_NON_TEXT],
      ['shared focus ring on a card', '#0f766e', CARD,  AA_NON_TEXT],
    ];

    const failures = [];
    for (const [label, fg, bg, floor] of PAIRS) {
      const r = contrastRatio(parseColor(fg), parseColor(bg));
      if (!(r >= floor)) {
        failures.push(`${label}: ${fg} on ${bg} = ${r.toFixed(2)}, floor ${floor}`);
      }
    }
    assert.deepStrictEqual(failures, [],
      'shell.css introduces a colour pair under its floor:\n  ' + failures.join('\n  '));

    // Two numbers pinned so a later edit cannot quietly walk them down.
    // 3.33 is what --teal-700 would measure on the ink bar: over the SC 1.4.11
    // floor, but only just, and it is why the nav overrides the ring to
    // --teal-500 at 7.33 rather than inheriting the shared one.
    assert.ok(contrastRatio(parseColor('#14b8a6'), parseColor(INK)) > 7,
      'the nav ring must stay well clear of the floor, not just over it');
    assert.ok(contrastRatio(parseColor('#0f766e'), parseColor(INK)) < 3.5,
      'if --teal-700 ever clears comfortably on the bar the nav override can go; '
      + 'until then this records why it exists');

    // --faint-strong measures 3.73 on paper and is NOT a legal subtitle colour.
    // Recorded so nobody reaches for it as a "quieter" subtitle later.
    assert.ok(contrastRatio(parseColor('#857f79'), parseColor(PAPER)) < AA_BODY,
      '--faint-strong is under AA body on this ground — the subtitle uses '
      + '--muted (#57524a) at 7.31 and must keep doing so');
  });
});
