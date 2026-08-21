'use strict';

// The indexing rule is written TWICE. This file is the thing that notices when
// the two copies stop agreeing.
//
// WHY THERE ARE TWO. `web/next.config.js` decides whether to emit the
// `X-Robots-Tag: noindex, nofollow, noarchive` response header. It is CommonJS,
// loaded by the Next CLI before any TypeScript is compiled, so it cannot import
// `indexingAllowed` from `web/lib/siteConfig.ts` — the module that the
// `<meta name="robots">` tag, `/robots.txt` and `/sitemap.xml` all read. The
// duplication is forced by the loader, not chosen. Both files say so in prose,
// and both say "change it in BOTH places".
//
// WHY THAT IS WORTH A TEST. Nothing failed if they drifted. A one-character
// edit to either — dropping the `.trim()`, comparing against "1", inverting the
// default — produces a build whose HEADER and whose META TAG disagree about
// whether the site may be indexed, with no error anywhere. That is this site
// asserting two contradictory things about itself, which is the same class of
// defect as shipping a placeholder: a statement that is not true. And it fails
// in the direction that is not recoverable — a preview that leaks into a search
// index stays there for weeks after the address is taken down.
//
// HOW IT WORKS, and why it is not a string compare. The two rules are written
// differently on purpose (`next.config.js` inlines the trim; `siteConfig.ts`
// routes through `envOrNull`), so comparing the source text would fail on a
// harmless rewording and pass on a semantic change to the shared helper. This
// extracts each rule's EXPRESSION and evaluates BOTH against the same matrix of
// environment values, then compares verdicts. Drift is measured as behaviour.
//
// NOT VACUOUS. Every extraction is anchored and throws if its anchor is gone,
// so a refactor that moves either rule turns this red rather than quietly
// checking nothing. And the second test pins the truth table itself, so the two
// files agreeing on a WRONG rule — both flipped to `!== "true"` — is caught too;
// agreement alone is not the property being protected.
//
// TWO bare test() calls, for the reason heroDisclosure.test.js gives: the suite
// total is a tracked number and a per-assertion block would move it every time
// an assertion is added.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const NEXT_CONFIG = path.join(ROOT, 'web', 'next.config.js');
const SITE_CONFIG = path.join(ROOT, 'web', 'lib', 'siteConfig.ts');

/** This repo checks out CRLF on Windows and LF elsewhere. Every anchor below is
 *  written with `\n`, so normalise before matching or the pins miss silently on
 *  exactly one platform — the failure mode `schema_migrations` normalises its
 *  checksums to avoid, and one this repo has been bitten by before. */
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Pull a single anchored expression out of a source file. Throws — loudly, and
 *  naming the file and the anchor — when the anchor is absent, because a pin
 *  that silently matches nothing is worse than no pin. */
function extract(source, file, anchor, re) {
  const m = source.match(re);
  assert.ok(
    m,
    `indexingFlagParity: could not find ${anchor} in ${path.relative(ROOT, file)}.\n` +
      'The rule moved or was rewritten. This test cannot compare what it cannot\n' +
      'find, so it fails rather than passing vacuously. Re-anchor it — do not\n' +
      'delete it: the drift it guards against is silent by construction.'
  );
  return m[1].trim();
}

/**
 * The two rules, as evaluable expressions.
 *
 *   next.config.js  const indexingAllowed = <EXPR>;
 *   siteConfig.ts   export const indexingAllowed: boolean = <EXPR>;
 *                   (plus `envOrNull`, which its EXPR calls)
 *
 * Read fresh inside each test so a fix applied between runs is actually read.
 */
function readRules() {
  const nextSrc = read(NEXT_CONFIG);
  const siteSrc = read(SITE_CONFIG);

  const headerExpr = extract(
    nextSrc,
    NEXT_CONFIG,
    'the `const indexingAllowed = …` declaration',
    /\bconst\s+indexingAllowed\s*=\s*([\s\S]*?);\n/
  );

  const metaExpr = extract(
    siteSrc,
    SITE_CONFIG,
    'the `export const indexingAllowed: boolean = …` declaration',
    /\bexport\s+const\s+indexingAllowed\s*:\s*boolean\s*=\s*([\s\S]*?);\n/
  );

  // `metaExpr` calls this. Taken from the file rather than reimplemented here,
  // so a change to the helper's semantics — which would move the meta tag,
  // robots.txt and sitemap.xml together — is seen by this test too.
  const envOrNull = extract(
    siteSrc,
    SITE_CONFIG,
    'the `envOrNull` helper',
    /\n(function envOrNull\(raw: string \| undefined\): string \| null \{[\s\S]*?\n\})/
  );

  return {
    headerExpr,
    metaExpr,
    // Strip the TS type annotations `envOrNull` carries; the body is plain JS.
    envOrNullJs: envOrNull
      .replace(/\(raw: string \| undefined\): string \| null/, '(raw)')
      .replace(/: string \| null/g, ''),
  };
}

/** Evaluate an expression with NEXT_PUBLIC_ALLOW_INDEXING set to `value`
 *  (`undefined` = the variable is absent from the environment entirely). */
function verdict(expr, prelude, value) {
  const env = {};
  if (value !== undefined) env.NEXT_PUBLIC_ALLOW_INDEXING = value;
  const context = vm.createContext({ process: { env } });
  return vm.runInContext(`${prelude}\n(${expr})`, context, { timeout: 1000 });
}

/**
 * The matrix. Every value the two files' own prose calls out by name — unset,
 * empty, "false", "1", "yes", a typo — plus the whitespace and casing cases
 * that separate the two implementations if either loses its trim or gains a
 * `.toLowerCase()`.
 */
const CASES = [
  ['unset', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['exactly true', 'true'],
  ['padded true', '  true  '],
  ['tab-padded true', '\ttrue\n'],
  ['TRUE', 'TRUE'],
  ['True', 'True'],
  ['false', 'false'],
  ['1', '1'],
  ['0', '0'],
  ['yes', 'yes'],
  ['no', 'no'],
  ['truthy typo', 'ture'],
  ['true with suffix', 'true!'],
  ['quoted true', '"true"'],
];

test('the X-Robots-Tag rule and the meta-robots rule agree on every input', () => {
  const { headerExpr, metaExpr, envOrNullJs } = readRules();

  // Guard against the degenerate pass: two rules that are the same because the
  // extraction collapsed them to the same string would prove nothing about the
  // duplication actually shipping.
  assert.notStrictEqual(
    headerExpr,
    metaExpr,
    'indexingFlagParity: the two extracted expressions are byte-identical.\n' +
      'That is not expected — next.config.js inlines the trim and siteConfig.ts\n' +
      'routes through envOrNull. Check the extraction, not the config.'
  );

  const disagreements = [];
  for (const [label, value] of CASES) {
    const header = verdict(headerExpr, '', value);
    const meta = verdict(metaExpr, envOrNullJs, value);
    assert.strictEqual(
      typeof header, 'boolean',
      `next.config.js's rule returned a non-boolean for ${label}`
    );
    assert.strictEqual(
      typeof meta, 'boolean',
      `siteConfig.ts's rule returned a non-boolean for ${label}`
    );
    if (header !== meta) {
      disagreements.push(
        `  NEXT_PUBLIC_ALLOW_INDEXING=${JSON.stringify(value)} (${label}): ` +
          `X-Robots-Tag header says indexable=${header}, ` +
          `<meta name="robots"> says indexable=${meta}`
      );
    }
  }

  assert.deepStrictEqual(
    disagreements,
    [],
    'The indexing rule has DRIFTED between its two copies.\n\n' +
      disagreements.join('\n') +
      '\n\nweb/next.config.js decides the X-Robots-Tag response header.\n' +
      'web/lib/siteConfig.ts decides the <meta name="robots"> tag, /robots.txt\n' +
      'and /sitemap.xml. next.config.js is CommonJS loaded before TypeScript is\n' +
      'compiled, so it cannot import the rule; the duplication is forced and both\n' +
      'files say to change BOTH. A build where these disagree ships a site that\n' +
      'contradicts itself about whether it may be indexed.'
  );
});

test('the shared indexing rule is the documented one — only exactly "true" enables', () => {
  const { headerExpr, metaExpr, envOrNullJs } = readRules();

  // Agreement alone is not the property. Both files flipped the same wrong way
  // would satisfy the test above and still ship a preview into Google. This
  // pins the rule itself, and its asymmetry: the SAFE verdict is the default,
  // so anything that is not an unambiguous "true" means not indexable.
  const ENABLES = new Set(['exactly true', 'padded true', 'tab-padded true']);

  for (const [label, value] of CASES) {
    const expected = ENABLES.has(label);
    for (const [where, expr, prelude] of [
      ['web/next.config.js (X-Robots-Tag)', headerExpr, ''],
      ['web/lib/siteConfig.ts (meta robots)', metaExpr, envOrNullJs],
    ]) {
      assert.strictEqual(
        verdict(expr, prelude, value),
        expected,
        `${where}: NEXT_PUBLIC_ALLOW_INDEXING=${JSON.stringify(value)} (${label}) ` +
          `should mean indexable=${expected}.\n` +
          'Only the exact string "true", after trimming, may enable indexing.\n' +
          'Unset, empty, "false", "1", "yes" and every typo mean NOT indexable —\n' +
          'a typo has to fail in the direction that is recoverable.'
      );
    }
  }
});
