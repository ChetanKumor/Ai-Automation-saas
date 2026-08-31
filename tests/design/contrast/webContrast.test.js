'use strict';

/* ============================================================================
 * THE MARKETING CONTRAST INSTRUMENT, tested offline.
 *
 * `tests/design/contrast/web.js` has two halves. The live half needs Chrome, a
 * production build and a `next start`, so it cannot run in `npm test`. The pure
 * half — the build-id interlock's verdicts, the receded/content partition, the
 * D-016 contract, and the signature of the recorded baseline — can, and does,
 * on every commit.
 *
 * THE DIVISION OF LABOUR, stated once so a later reader does not look for the
 * wrong guarantee here:
 *
 *   tests/design/portalContrast.test.js  owns the ENGINE — the colour maths,
 *     the thresholds, judge(), judgeRing(), the signature's algebra. None of it
 *     is re-tested here; the engine is one file and testing it twice is how two
 *     copies of a rule start disagreeing.
 *   THIS FILE                            owns the MARKETING BINDING — what
 *     web.js adds: six interlock gates, a partition, a two-valued token, a
 *     recorded baseline, and a static net over web/'s stylesheets.
 *
 * WHY THE BASELINE LIVES IN web.js AND NOT IN A .txt. The portal keeps its
 * signature body in `contrast/portal.signature.txt` and re-hashes the file.
 * This session's allowed file set was two files, so the body is an array in
 * `WEB_BASELINE.signatureLines` and is re-hashed the same way. The invariant is
 * identical: the body and the md5 beside it cannot drift apart, because one is
 * computed from the other here.
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const kit = require('./web');
const core = require('./core');

const ROOT = path.join(__dirname, '..', '..', '..');
const WEB = path.join(ROOT, 'web');

const { WEB_BASELINE, classify, partition, hashLines, MODES, MODE_NAMES } = kit;

/* ========================================================================== */

test('the marketing binding re-exports the ENGINE, and does not re-implement it', () => {
  // Same discipline as portalContrast.js: named, not spread, and identity-
  // checked. A silently missing TEXT_SWEEP_SOURCE reaches CDP as the string
  // "undefined" and comes back as an in-page error forty seconds into a sweep,
  // which is a bad place to learn that an export was renamed.
  for (const name of ['parseColor', 'compositeOver', 'contrastRatio', 'isLargeText',
    'parseBoxShadow', 'judge', 'judgeRing', 'uniquePairs', 'signature',
    'INK_FAINT', 'AA_BODY', 'AA_LARGE', 'AA_NON_TEXT']) {
    assert.strictEqual(kit[name], core[name], `${name} must BE the core's, not a copy of it`);
  }
  for (const name of ['TEXT_SWEEP_SOURCE', 'BLUR_SOURCE', 'TAG_FOCUSABLES_SOURCE', 'READ_RING_SOURCE']) {
    assert.strictEqual(kit[name], core[name]);
    assert.ok(kit[name].length > 500, `${name} must be real serialised source, not "undefined"`);
  }

  // The driver must compute no ratio of its own — two instruments that both
  // know what 4.5 means are two instruments that will disagree.
  //
  // This looks for DEFINITIONS and for the sRGB coefficients, not for mentions.
  // The first version of this assertion stripped comments and strings before
  // searching, and the strip itself was the bug: `//` inside `'http://127.0.0.1'`
  // is eaten by the line-comment rule, which leaves an unterminated quote and
  // makes every later match nonsense. Nothing below needs the source sanitised,
  // because none of these strings can appear in prose or in a re-export list.
  const src = fs.readFileSync(path.join(__dirname, 'web.js'), 'utf8');
  assert.ok(!/function\s+(relativeLuminance|contrastRatio|parseColor|isLargeText|judge|judgeRing)\s*\(/
    .test(src), 'web.js must not DEFINE any engine function — it re-exports them');
  for (const coefficient of ['0.2126', '0.7152', '0.0722', '1.055', '0.03928']) {
    assert.ok(!src.includes(coefficient),
      `web.js must not do colour arithmetic — found the sRGB coefficient ${coefficient}`);
  }

  // Three media states, and every state names all four features. An omitted
  // feature keeps whatever the previous setEmulatedMedia left, which turns a
  // matrix into a sequence-dependent one.
  assert.deepStrictEqual(MODE_NAMES, ['default', 'reduced-motion', 'high-contrast']);
  const names = (m) => MODES[m].map((f) => f.name).sort();
  for (const m of MODE_NAMES) {
    assert.deepStrictEqual(names(m),
      ['forced-colors', 'prefers-color-scheme', 'prefers-contrast', 'prefers-reduced-motion'],
      `${m} must pin every feature, not just the one it varies`);
  }
  const valueOf = (m, f) => MODES[m].find((x) => x.name === f).value;
  assert.strictEqual(valueOf('default', 'prefers-reduced-motion'), 'no-preference');
  assert.strictEqual(valueOf('reduced-motion', 'prefers-reduced-motion'), 'reduce');
  assert.strictEqual(valueOf('high-contrast', 'prefers-contrast'), 'more');
  assert.strictEqual(valueOf('reduced-motion', 'prefers-contrast'), 'no-preference',
    'the two accommodations are separate axes and must not be measured together');
});

/* ========================================================================== */

test('the build-id interlock refuses a stale server, and says which gate', () => {
  const { servedBuildIdFrom, interlockServed, Refusal } = kit;

  // The id reaches the browser inside a JavaScript string literal, so the raw
  // HTML carries backslashed quotes and `self.__next_f` carries plain ones.
  // Both forms are real and both are parsed — this is the exact byte shape
  // measured on the live server, not a plausible reconstruction.
  assert.strictEqual(
    servedBuildIdFrom('__next_f.push([1,"0:{\\"P\\":null,\\"b\\":\\"4YgyE87fx1jhek9Fn7Vkp\\",\\"p\\"'),
    '4YgyE87fx1jhek9Fn7Vkp', 'the escaped form, as served in HTML');
  assert.strictEqual(servedBuildIdFrom('{"P":null,"b":"Xeaq2Ybs0OXwOabDCgVau","p":""}'),
    'Xeaq2Ybs0OXwOabDCgVau', 'the plain form, as read from __next_f');
  assert.strictEqual(servedBuildIdFrom('robots.txt has no flight payload'), null,
    'no payload must be null, never a guess');
  assert.strictEqual(servedBuildIdFrom(null), null);

  // G3 — the gate that actually fired. Measured on this machine: a server
  // started on 4YgyE87fx1jhek9Fn7Vkp kept serving it after `next build` wrote
  // Xeaq2Ybs0OXwOabDCgVau to disk, so `next start` is NOT self-invalidating and
  // a sweep that trusts the working tree measures the previous build.
  const OLD = '4YgyE87fx1jhek9Fn7Vkp';
  const NEW = 'Xeaq2Ybs0OXwOabDCgVau';
  assert.throws(
    () => interlockServed('/', OLD, NEW, NEW),
    (e) => e.refusal === true && e.gate === 'G3' && /STALE SERVER/.test(e.message),
    'a served id that differs from BUILD_ID must refuse, naming G3'
  );

  // G4 is a DIFFERENT gate and must not be mistaken for G3: here the served id
  // agrees with what the run pinned, and it is the DISK that moved — a rebuild
  // racing the sweep, which would split one signature across two builds.
  assert.throws(
    () => interlockServed('/', OLD, OLD, NEW),
    (e) => e.refusal === true && e.gate === 'G4' && /moved mid-run/.test(e.message),
    'a disk id that moved under the run must refuse, naming G4'
  );

  // The agreeing case is the only one that proceeds, and it reports that it
  // CHECKED — an unchecked page and a checked one must not look alike.
  assert.deepStrictEqual(interlockServed('/', 'abc123', 'abc123', 'abc123'),
    { checked: true, id: 'abc123' });

  // A text route carries no payload. It is skipped EXPLICITLY, with the reason
  // recorded, rather than silently passing as though it had been verified.
  const skipped = interlockServed('/robots.txt', null, 'abc123', 'abc123');
  assert.strictEqual(skipped.checked, false);
  assert.match(skipped.why, /no flight payload/);

  assert.ok(new Refusal('G2', 'x') instanceof Error, 'a refusal is an Error, so it cannot be ignored');
  assert.match(new Refusal('G2', 'x').message, /^INTERLOCK G2 — REFUSED: /);

  // ── G0: a `next dev` owning .next ──────────────────────────────────────
  // `next dev` clears .next at startup, rewrites it on demand, and writes no
  // BUILD_ID. It cannot share the directory with a production build. Measured:
  // a developer's `npm run dev` in web/ wiped .next twice under a running
  // sweep, and G4 caught both mid-run — G0 turns the same fact into a refusal
  // before a build is spent.
  //
  // The listing below is REAL, captured from Win32_Process on this machine,
  // doubled backslash and all. It is here because the first version of this
  // gate used `"\t"` as its separator — and PowerShell escapes with a BACKTICK,
  // so that was the two characters backslash-t, every line failed to split, and
  // G0 printed "none" with the dev server running in front of it. A gate that
  // cannot read its own input reports clear.
  const { parseDevServers, PROC_SEP } = kit;
  const S = PROC_SEP;
  assert.notStrictEqual(S, '\t', 'the separator must not be a tab — PowerShell will not emit one');
  const listing = [
    '7744' + S + '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs/node_modules/npm/bin/npm-cli.js" run dev',
    '7212' + S + '"node"   "E:\\saas-crm\\web\\node_modules\\.bin\\\\..\\next\\dist\\bin\\next" dev --port 3100',
    '14788' + S + 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c next dev --port 3100',
    '17340' + S + '"C:\\Program Files\\nodejs\\node.exe" E:\\saas-crm\\web\\node_modules\\next\\dist\\bin\\next start --port 3141',
    '9001' + S + '"node" "D:\\other-project\\node_modules\\next\\dist\\bin\\next" dev --port 4000',
  ].join('\r\n');

  const found = parseDevServers(listing, 'E:\\saas-crm\\web');
  assert.deepStrictEqual(found.map((d) => d.pid), ['7212'],
    'exactly the dev server that owns THIS .next: not the npm wrapper (which never '
    + 'names the directory), not the `next start` this instrument spawned, and not a '
    + 'dev server for another repository');

  // Forward slashes are normalised, because a command line can carry either.
  assert.strictEqual(parseDevServers(listing, 'E:/saas-crm/web').length, 1);
  // And a clean machine is an empty list, never a null that reads as "unknown".
  assert.deepStrictEqual(parseDevServers('', 'E:\\saas-crm\\web'), []);
});

/* ========================================================================== */

test('the nine prerendered routes, and which of them have a language axis', () => {
  // ── DERIVED FROM SOURCE, so this assertion is build-independent ────────
  // The driver derives routes from `.next/prerender-manifest.json`, which is
  // right for a sweep and wrong for `npm test`: that file only exists after a
  // production build, and a `next dev` on this project replaces it with an
  // empty one (measured — see G0). A suite that reds because somebody started a
  // dev server is a suite people learn to ignore. So the recorded list is
  // checked against `web/app` itself, which is always there.
  const derived = new Set(['/_not-found']); // Next emits this for every app
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A (group) is an organisational segment and contributes no path.
        walk(full, /^\(.*\)$/.test(entry.name) ? prefix : prefix + '/' + entry.name);
        continue;
      }
      if (entry.name === 'page.tsx') derived.add(prefix || '/');
      if (entry.name === 'robots.ts') derived.add('/robots.txt');
      if (entry.name === 'sitemap.ts') derived.add('/sitemap.xml');
    }
  }(path.join(WEB, 'app'), ''));
  assert.deepStrictEqual([...derived].sort(), [...WEB_BASELINE.routeList],
    'web/app no longer produces the nine routes the baseline was measured over');

  // And when a PRODUCTION build happens to be present, cross-check it against
  // the same list. A dev build's manifest carries zero routes; that case is
  // skipped, and the skip asserts WHY, so it cannot quietly swallow a populated
  // manifest that disagrees.
  if (fs.existsSync(kit.PRERENDER_MANIFEST)) {
    const built = kit.prerenderedRoutes();
    if (built.length) {
      assert.deepStrictEqual(built, [...WEB_BASELINE.routeList],
        'the built site no longer prerenders the routes the baseline was measured over');
    } else {
      assert.strictEqual(built.length, 0,
        'a manifest with no routes is a dev build, not a disagreement');
    }
  } else {
    assert.throws(() => kit.prerenderedRoutes(),
      (e) => e.refusal === true && /build first/.test(e.message),
      'with no manifest at all, the DRIVER must refuse — an empty route list is not an empty site');
  }

  assert.strictEqual(WEB_BASELINE.routeList.length, 9);
  assert.strictEqual(WEB_BASELINE.htmlRoutes.length + WEB_BASELINE.textRoutes.length, 9);
  assert.deepStrictEqual([...WEB_BASELINE.textRoutes], ['/robots.txt', '/sitemap.xml'],
    'the two routes the browser renders with its own stylesheet, not ours');

  // The language axis is real on exactly the two routes that mount the player,
  // and `hi` is not on it. That is not an omission this test tolerates — it is
  // the state of the source: conversation/index.ts builds LANGUAGES from LANGS,
  // and LANGS is `{ en, te }`. getConversation("hi") type-checks and throws.
  assert.deepStrictEqual([...WEB_BASELINE.languages], ['en', 'te']);
  assert.deepStrictEqual([...WEB_BASELINE.languageRoutes], ['/', '/specimen']);
  const index = fs.readFileSync(
    path.join(WEB, 'components', 'sections', 'conversation', 'index.ts'), 'utf8');
  assert.match(index, /const LANGS[^=]*=\s*\{\s*en:\s*EN,\s*te:\s*TE\s*\}/,
    'LANGS moved — the language axis in WEB_BASELINE is now a claim about nothing');
  assert.ok(!fs.existsSync(path.join(WEB, 'components', 'sections', 'conversation', 'hi.json')),
    'hi.json exists: the `hi` column of the brief\'s matrix is no longer unreachable, '
    + 'and the baseline must be re-measured with it');

  // Everything else is degenerate on the language axis and collapses to one
  // pass. Cells = 2 routes x 2 langs x 3 modes + 7 routes x 1 x 3 modes.
  const expected = WEB_BASELINE.languageRoutes.length * WEB_BASELINE.languages.length * 3
    + (9 - WEB_BASELINE.languageRoutes.length) * 3;
  assert.strictEqual(WEB_BASELINE.cells, expected, 'the matrix is not the shape it claims');
  assert.strictEqual(WEB_BASELINE.cells, 33);
});

/* ========================================================================== */

test('receded turns and content are partitioned structurally, not by taste', () => {
  // Real selectors, captured from the live sweep. The class hash Next appends
  // (`__tf0as`) changes on every build, which is exactly why the classifier
  // matches the stable `Conversation_stepFloor__` prefix and this test pins the
  // prefix rather than the whole name.
  const recededLabel = 'div.Conversation_host__I3FAU > div.Conversation_fade__Pj6uR > '
    + 'div.Conversation_region__sddxK.Conversation_live__gkozR > '
    + 'div.Conversation_turn__53wvy.Conversation_stepFloor__tf0as > '
    + 'div.Conversation_head__x_YEb > span.Conversation_label__xBrZg';
  const recededNear = recededLabel.replace('stepFloor__tf0as', 'stepNear__Mcpnw');
  const activeTurn = recededLabel.replace('stepFloor__tf0as', 'stepActive__EuKRO');
  const bodyCopy = 'section.Problem_problem__0359C > div.wrap > div.Problem_enquiries__ES6VF > '
    + 'div.Problem_enq__XdEtj.reveal-visible > div.Problem_enqTop__YaQqk > '
    + 'span.Problem_enqTime__znvpw';

  assert.strictEqual(classify({ sel: recededLabel }), 'receded');
  assert.strictEqual(classify({ sel: recededNear }), 'receded');
  assert.strictEqual(classify({ sel: bodyCopy }), 'content');
  assert.strictEqual(classify({ sel: '' }), 'content');
  assert.strictEqual(classify({}), 'content');

  // THE ONE THAT MATTERS. The ACTIVE turn is the turn the reader is on. It is
  // held to the body floor like any other copy, and folding it into the
  // design-intent bucket would hide the single failure that would matter most.
  assert.strictEqual(classify({ sel: activeTurn }), 'content',
    'stepActive is not receded — it is the turn being read');

  const split = partition([{ sel: recededLabel }, { sel: bodyCopy }, { sel: activeTurn }]);
  assert.strictEqual(split.receded.length, 1);
  assert.strictEqual(split.content.length, 2);

  // And the partition must be blind to the failure's severity — it splits on
  // WHERE a glyph is, never on how badly it scored.
  assert.strictEqual(classify({ sel: recededLabel, ratio: 1.01 }), 'receded');
});

/* ========================================================================== */

test('D-016 on marketing: --ink-faint is non-text only, in both of its values', () => {
  const { judge, contrastRatio, parseColor, INK_FAINT, AA_LARGE } = kit;

  // Anchored to the decision, not to this file. If D-016 is superseded this
  // reads the superseding text and fails, rather than going on enforcing a rule
  // the company has retired.
  const decisions = fs.readFileSync(path.join(ROOT, 'docs', 'os', 'decisions.md'), 'utf8');
  assert.match(decisions, /--ink-faint \(#A8A199, 2\.41:1\) is NON-TEXT ONLY, by written contract/,
    'D-016 no longer states the contract this test enforces');
  assert.strictEqual(INK_FAINT, '#A8A199');

  // ── THE TOKEN HAS TWO VALUES ON THIS SURFACE, AND THAT IS THE TRAP ──────
  // globals.css declares #A8A199 at the root and #857F79 under
  // `prefers-contrast: more`. The driver resolves the hex from the live page
  // per cell for exactly this reason. Here is what NOT doing so would cost:
  const hiContrastGlyph = [{
    color: 'rgb(133, 127, 121)',           // #857F79, measured on /specimen
    bg: { r: 242, g: 238, b: 232 },        // --ground-sunk
    px: 15, weight: 400, role: 'text',
  }];
  assert.strictEqual(judge(hiContrastGlyph).contract.length, 0,
    'with the default hex, a high-contrast --ink-faint glyph is INVISIBLE to the contract');
  assert.strictEqual(judge(hiContrastGlyph, { inkFaint: '#857F79' }).contract.length, 1,
    'resolved per cell, the same glyph is caught');
  assert.strictEqual(WEB_BASELINE.inkFaint.default, '#A8A199');
  assert.strictEqual(WEB_BASELINE.inkFaint['high-contrast'], '#857F79');

  // Both values are re-derived rather than trusted. globals.css:432 records
  // 2.41/2.21/2.55 -> 3.73/3.42/3.96 on ground / sunk / raised.
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.006,
    `${what}: ${a.toFixed(3)} vs ${b}`);
  near(contrastRatio(parseColor('#A8A199'), parseColor('#FAF8F5')), 2.41, 'faint on --ground');
  near(contrastRatio(parseColor('#A8A199'), parseColor('#F2EEE8')), 2.21, 'faint on --ground-sunk');
  near(contrastRatio(parseColor('#857F79'), parseColor('#F2EEE8')), 3.42, 'faint/hc on --ground-sunk');
  near(contrastRatio(parseColor('#857F79'), parseColor('#FFFFFF')), 3.96, 'faint/hc on --ground-raised');
  assert.ok(3.96 < 4.5,
    'the high-contrast value stops SHORT of the text floor on purpose — a value that '
    + 'passed AA would invite the first glyph and the contract would become a comment');
  assert.ok(2.41 < AA_LARGE, 'the base value clears no text floor, not even the large one');

  // ── THE STATIC NET ─────────────────────────────────────────────────────
  // Every stylesheet under web/, scanned for a text-colour declaration that
  // reaches --ink-faint — by name, by either hex, or one hop through a local
  // custom property. The live sweep is the real instrument; this runs on every
  // commit without a browser.
  const sheets = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.css')) {
        sheets.push([path.relative(WEB, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]);
      }
    }
  }(WEB));
  assert.ok(sheets.length >= 20, `expected web/'s stylesheets, found ${sheets.length}`);

  const FAINT = /#a8a199\b|#857f79\b|rgba?\(\s*168\s*,\s*161\s*,\s*153\s*[,)]|rgba?\(\s*133\s*,\s*127\s*,\s*121\s*[,)]/i;
  const TEXT_PROP = /(^|[;{])\s*(color|-webkit-text-fill-color)\s*:\s*([^;}]+)/gi;
  const offences = [];
  for (const [name, css] of sheets) {
    const aliases = new Set(['--ink-faint']);
    const decl = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi;
    let d;
    while ((d = decl.exec(css)) !== null) if (FAINT.test(d[2])) aliases.add(d[1]);
    let c;
    TEXT_PROP.lastIndex = 0;
    while ((c = TEXT_PROP.exec(css)) !== null) {
      const value = c[3].trim();
      if (FAINT.test(value) || [...aliases].some((a) => value.includes('var(' + a))) {
        offences.push(`${name}: ${c[2]}: ${value}`);
      }
    }
  }

  // EXACTLY ONE, and it is the page that documents the contract demonstrating
  // what breaking it looks like. `.faintBad` is deliberate: /specimen prints the
  // same string in --ink-faint and --ink-soft side by side and labels the first
  // WRONG. The assertion is an equality, not a ceiling — a second offence
  // anywhere on the surface fails, and this one moving fails too.
  assert.deepStrictEqual(offences, [
    'app/(marketing)/specimen/specimen.module.css: color: var(--ink-faint)',
  ], 'D-016: --ink-faint is NON-TEXT ONLY everywhere on web/ except /specimen\'s own demonstration');
});

/* ========================================================================== */

test('the recorded baseline re-hashes, and its two failure sets are what it says', () => {
  const lines = [...WEB_BASELINE.signatureLines];

  assert.strictEqual(hashLines(lines), WEB_BASELINE.signatureMd5,
    'WEB_BASELINE.signatureLines no longer hashes to signatureMd5');
  assert.ok(lines.every((l) => /^(FAIL|CONTRACT|UNDET|RING) /.test(l)),
    'the signature body carries only verdict lines — anything else is not hashable evidence');

  // ── SET ONE: receded turns. It is EMPTY, and the emptiness is a measurement.
  // 612 rows were collected inside stepNear/stepFloor turns across the matrix
  // and the worst of them reads 7.31:1 against a 4.5 floor — the --ink-soft
  // value Conversation.tsx:94 claims for the whole ladder, reproduced on the
  // live DOM. Recency here is carried by SCALE, not by ink, so nothing recedes
  // below the floor and there is no founder ruling to make.
  assert.strictEqual(WEB_BASELINE.recededFailures, 0);
  assert.ok(WEB_BASELINE.recededRows > 500,
    'zero receded failures out of zero receded rows is not a pass — it is a vacuous gate');
  assert.strictEqual(WEB_BASELINE.worstRecededRatio, 7.31);
  assert.ok(WEB_BASELINE.worstRecededRatio >= 4.5);

  // ── SET TWO: body copy, controls, navigation. THIRTY-SIX failures, and the
  // whole of the assertion is that they are these three SHAPES and no others.
  //
  // Until S3b-3 this read `failingRoutes === ['/specimen']`, and it was true:
  // the only thing failing on marketing was /specimen's own printed
  // counterexample. Teaching the sweep :hover found a real one — 30 rows of it,
  // across the four legal routes — so the route set moved to five and that
  // assertion could not be kept.
  //
  // It is NOT replaced by "the legal routes may fail". Those four pages carry
  // the compliance copy, and an exemption written at ROUTE granularity would
  // swallow the next real defect on exactly the pages that can least afford
  // one. It is replaced by a pin on the exact signature line, so a 31st
  // failure, or a different shape on any route, adds a line here and reds.
  assert.strictEqual(WEB_BASELINE.contentFailures, 36);
  assert.strictEqual(WEB_BASELINE.contentFailures, WEB_BASELINE.failures);
  assert.deepStrictEqual([...WEB_BASELINE.failingRoutes],
    ['/acceptable-use', '/data-deletion', '/privacy', '/specimen', '/terms'],
    'recorded, not the gate — the gate is the shape pin below');

  // The gate. Three shapes, exactly, in order.
  const fails = lines.filter((l) => l.startsWith('FAIL '));
  assert.deepStrictEqual(fails, [
    'FAIL      2.21:1 needs 4.5  rgb(168, 161, 153) on rgb(242,238,232)',
    'FAIL      3.42:1 needs 4.5  rgb(133, 127, 121) on rgb(242,238,232)',
    WEB_BASELINE.knownDefect.shape,
  ], 'marketing fails in exactly three shapes: --ink-faint in both its values on '
    + "/specimen's own counterexample, and F-F010");

  // F-F010, named where the number is, because a count nobody can attribute is
  // how a defect becomes a baseline. The MECHANISM is the point: `opacity: 0.8`
  // on `.content a:hover` cannot preserve contrast — fading a colour toward its
  // backdrop reduces the ratio by construction, whatever the colour is. The fix
  // is a DARKER hover colour, never a faded one. Same species as --faint under
  // the portal's `.holiday-row--past { opacity: .68 }`, which reads 1.77:1.
  assert.strictEqual(WEB_BASELINE.knownDefect.id, 'F-F010');
  assert.strictEqual(WEB_BASELINE.knownDefect.count, 30);
  assert.match(WEB_BASELINE.knownDefect.site, /legal[.]module[.]css/);
  assert.match(WEB_BASELINE.knownDefect.shape, /^FAIL[ ]+3[.]57:1 needs 4[.]5 /);
  assert.match(WEB_BASELINE.knownDefect.shape, /@op0[.]8 :hover/,
    'F-F010 is an opacity-on-hover defect; a shape without @op is a different bug');
  assert.strictEqual(WEB_BASELINE.failures - WEB_BASELINE.knownDefect.count, 6,
    "every failure on marketing is either /specimen's counterexample or F-F010");
  assert.strictEqual(lines.filter((l) => l.startsWith('CONTRACT ')).length, 2);

  // SC 1.4.11. 549 focus indicators walked in real tab order, none under 3:1.
  assert.strictEqual(WEB_BASELINE.ringFailures, 0);
  assert.ok(WEB_BASELINE.rings > 500);
  // `RING` lines are column-padded, so a `startsWith('RING FAIL')` would be a
  // test that can never fire. Match the verdict where it actually sits.
  const ringLines = lines.filter((l) => l.startsWith('RING '));
  assert.ok(ringLines.length >= 5, 'the baseline records the distinct ring shapes it saw');
  assert.ok(ringLines.every((l) => /^RING\s+PASS\s/.test(l)),
    'a RING line that is not PASS is an SC 1.4.11 failure hiding in the baseline');

  // A backdrop the engine refused to certify is reported, never scored: one
  // background-image stack on the FinalCta frame, in each of the six `/` cells.
  assert.strictEqual(WEB_BASELINE.undeterminable, 6);
  assert.strictEqual(lines.filter((l) => l.startsWith('UNDET ')).length, 1);

  // The counts are recorded so a run that moves them is NOTICED, not failed:
  // across five S2 portal runs of an unchanged tree the row count read 2302 /
  // 2325 / 2339 / 2347 while the signature stayed byte-identical. The signature
  // is the invariant. This asserts they are present and sane, nothing more.
  assert.ok(WEB_BASELINE.rows > 4000);
  assert.strictEqual(WEB_BASELINE.rows, WEB_BASELINE.recededRows + WEB_BASELINE.contentRows);
});
