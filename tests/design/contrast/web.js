'use strict';

/* ============================================================================
 * MARKETING CONTRAST INSTRUMENT — the web/ BINDING of the contrast engine, and
 * the driver that runs it.
 *
 * `tests/design/contrast/core.js` is the engine. It knows no URL, no route
 * list, no readiness gate and no playback state machine. This file is
 * everything the marketing site adds to it, and — unlike the portal, whose
 * driving half lives in `scripts/portal/shoot.js` — the driving half is HERE,
 * so that the gates and the surface they gate cannot drift into two files.
 *
 *   node tests/design/contrast/web.js --enumerate       the nine routes, probed
 *   node tests/design/contrast/web.js --build           rebuild, then sweep
 *   node tests/design/contrast/web.js --runs=5          determinism proof
 *   node tests/design/contrast/web.js --only=/specimen  one route, all its cells
 *   node tests/design/contrast/web.js --prove-interlock
 *   node tests/design/contrast/web.js --allow-dev-server   override G0
 *
 * NOTHING HERE MEASURES A SECOND TIME WHAT core.js ALREADY MEASURES. Not one
 * ratio is computed in this file. It collects raw rows over CDP and hands them
 * to `core.judge`, exactly as `shoot.js --contrast` does for the portal.
 *
 * ── WHY A BUILD-ID INTERLOCK COMES FIRST ──────────────────────────────────
 * `next start` serves a build, not a working tree, and it does not notice one
 * changing underneath it. That is not a theory: measured on this machine, with
 * a server started on build `4YgyE87fx1jhek9Fn7Vkp` and `next build` then run
 * WITHOUT restarting it, the server kept serving `4YgyE87fx1jhek9Fn7Vkp` while
 * `.next/BUILD_ID` on disk read `Xeaq2Ybs0OXwOabDCgVau`. Every byte the sweep
 * would have measured belonged to the previous build.
 *
 * The failure that makes this urgent is not carelessness, it is reaping.
 * `taskkill` is not on PATH in this environment, so a harness that fails to
 * reap falls back to `child.kill()`, and a server started through `npm run
 * start` is a process TREE whose leaf survives. The orphan then holds the port,
 * the next run's server never binds, and the sweep measures a build nobody
 * remembers making — which reports a PASS for code that is not on disk.
 *
 * Six gates, and a signature is not emitted unless all six hold:
 *
 *   G0  no `next dev` owns this project's `.next`. A dev server CLEARS the
 *       directory at startup, rewrites it on demand, and writes no `BUILD_ID`
 *       at all — measured here twice, mid-sweep. This is a FAIL-FAST gate, not
 *       a correctness one: `--allow-dev-server` overrides it, and G3/G4 still
 *       hold, so an overridden run that is clobbered refuses instead of
 *       emitting a wrong signature. It never kills the dev server: that is
 *       someone's running work.
 *   G1  a build this driver ran MOVED `.next/BUILD_ID`. Next derives it
 *       randomly per build, so an unchanged id means the build did not happen.
 *   G2  the port is FREE before we start. This instrument never adopts a
 *       server it did not spawn — an adopted server is exactly the orphan
 *       above, and asking it politely which build it is on is asking the
 *       suspect for an alibi.
 *   G3  every swept document's OWN build id equals `.next/BUILD_ID` read at
 *       that moment. This is the gate the measurement above trips.
 *   G4  `.next/BUILD_ID` has not moved between the first gate and the last
 *       row — a rebuild racing the sweep would otherwise split one signature
 *       across two builds.
 *   G5  `--ink-faint` resolved to ONE value within a media state. It is a
 *       `:root` token; two values means a page overrides it and the D-016
 *       contract cannot be judged run-wide. Pages with no stylesheet of ours
 *       resolve NOTHING and are excluded — a missing token is not a second
 *       value of one.
 *
 * The id is read from the RSC flight payload (`"b":"…"` inside `self.__next_f`)
 * and NOT from a `/_next/static/<id>/` href: app-router chunk URLs do not carry
 * it, and hunting for one that does is how a previous session convinced itself
 * a stale server was fresh.
 *
 * ── THE MATRIX, AND WHAT IS DEGENERATE IN IT ──────────────────────────────
 * routes x languages x media. Every axis is DERIVED from the running site
 * rather than authored here, because an authored axis is a claim about the
 * site that the site can quietly stop honouring:
 *
 *   routes     `.next/prerender-manifest.json`. Nine, and the two that are not
 *              `text/html` are separated by their served Content-Type, not by
 *              a hardcoded list.
 *   languages  `[data-lang-option]` in the live DOM. A route with no selector
 *              has no language axis — the cell is degenerate and collapses to
 *              one pass, because there is nothing on the page a language could
 *              change. `hi` is NOT offered: `conversation/index.ts` builds
 *              LANGUAGES from LANGS, and LANGS holds `en` and `te` only.
 *   media      three emulated states, all four features set explicitly every
 *              time so a previous cell's emulation cannot leak into the next.
 *
 * ── THE TWO THINGS THAT MAKE A MARKETING SWEEP NON-DETERMINISTIC ──────────
 * Both are handled before a row is collected, and neither is handled by
 * sleeping longer:
 *
 *   1. SCROLL REVEAL. `useScrollReveal` adds `.reveal-hidden` (opacity 0) to
 *      every Reveal on mount and removes it only when an IntersectionObserver
 *      fires. At a 1280x900 viewport that means everything below the fold is at
 *      opacity 0 forever — and `core.sweepPage` skips a row at opacity 0, so a
 *      naive sweep of `/` measures the fold and calls it the page. The driver
 *      walks the whole document with `behavior: "instant"` (which overrides the
 *      `scroll-behavior: smooth` at globals.css:313 — a plain `scrollTo` does
 *      not, and reads a mid-flight scrollY), returns to the top, and then
 *      COUNTS the elements still carrying `.reveal-hidden`. That count is
 *      reported per cell: an instrument that cannot see part of a page must say
 *      so rather than return fewer rows.
 *
 *   2. PLAYBACK. HERO-1's conversation walks six turns over 13.2 seconds and
 *      every intermediate frame is a different set of glyphs at a different
 *      recency scale. Rows are collected at ONE defined state — `complete`,
 *      the settled end — reached by clicking the control and polling
 *      `[data-playback]` until it reports it. Never on a timer, never
 *      mid-emergence.
 *
 * ── THE D-016 CONTRACT, READ FROM THE PAGE ────────────────────────────────
 * `--ink-faint` is NON-TEXT ONLY. On this surface the token has TWO values —
 * `#A8A199` normally and `#857F79` under `prefers-contrast: more`
 * (globals.css:446) — so the contract hex is resolved per cell from
 * `getComputedStyle(document.documentElement)`. Passing core's portal default
 * into a high-contrast cell would compare against a colour that surface is not
 * using and pass the contract everywhere by accident.
 *
 * ── THE SIGNATURE ─────────────────────────────────────────────────────────
 * Same invariant as the portal: `core.signature()` reduces a run to its
 * distinct SHAPES and hashes them; row counts are reported but are not the
 * invariant. Each cell carries its own signature, and the run carries one over
 * every row — that is the number five consecutive runs must agree on.
 * ========================================================================== */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const core = require('./core');

/* ──────────────────────────────────────────────────────────────────────────
 * Where things are.
 * ────────────────────────────────────────────────────────────────────────── */

const REPO = path.join(__dirname, '..', '..', '..');
const WEB_DIR = path.join(REPO, 'web');
const NEXT_DIR = path.join(WEB_DIR, '.next');
const BUILD_ID_FILE = path.join(NEXT_DIR, 'BUILD_ID');
const PRERENDER_MANIFEST = path.join(NEXT_DIR, 'prerender-manifest.json');
const NEXT_BIN = path.join(WEB_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');

const PORT = Number(process.env.WEB_CONTRAST_PORT || 3141);
const DEVPORT = Number(process.env.WEB_CONTRAST_DEVPORT || 9345);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TASKKILL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');

/** One viewport, deliberately. The brief's matrix has no width axis, and the
 *  one width-conditional colour rule on the whole surface —
 *  `Problem.module.css` `.enq { opacity: 1 }` below 480px — moves contrast UP
 *  (9.34:1 against 4.88:1 at .82), so 1280 is the conservative point to stand
 *  on rather than the convenient one. Anything else a width axis would find is
 *  unmeasured here, and that is a scope boundary, not a claim. */
const VIEWPORT = { width: 1280, height: 900 };

/* ──────────────────────────────────────────────────────────────────────────
 * The media axis. Every feature is set on every cell — an omitted feature
 * keeps whatever the previous `setEmulatedMedia` left, which turns a matrix
 * into a sequence-dependent one.
 * ────────────────────────────────────────────────────────────────────────── */

function features(motion, contrast) {
  return [
    { name: 'prefers-reduced-motion', value: motion },
    { name: 'prefers-contrast', value: contrast },
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'forced-colors', value: 'none' },
  ];
}

const MODES = Object.freeze({
  default: features('no-preference', 'no-preference'),
  'reduced-motion': features('reduce', 'no-preference'),
  'high-contrast': features('no-preference', 'more'),
});

const MODE_NAMES = Object.freeze(Object.keys(MODES));

/* ──────────────────────────────────────────────────────────────────────────
 * §5's partition. The one classification in this file, and it is structural.
 *
 * The recency ladder is three CSS-module classes on the turn element —
 * `stepActive`, `stepNear`, `stepFloor` (Conversation.module.css:216-228). The
 * hash suffix Next appends changes every build; the `Conversation_stepNear__`
 * prefix does not, which is what makes this stable across the very rebuild the
 * interlock above insists on.
 *
 * RECEDED is stepNear and stepFloor ONLY. stepActive is the turn the reader is
 * on and is held to the same floor as body copy — a failure there is a defect,
 * not a design intent, and folding it into the intent bucket would hide the one
 * case that matters most.
 *
 * `core.sweepPage`'s `sel` is an ancestor path of up to six segments carrying
 * the first two classes of each, so a glyph inside a receded turn — the label,
 * the timestamp, the paragraph, an emerged phrase span — carries the marker of
 * the turn it sits in. That is why the test asserts the shape of that path
 * rather than trusting the regex to be obviously right.
 * ────────────────────────────────────────────────────────────────────────── */

const RECEDED_RE = /Conversation_step(Near|Floor)__/;

/** 'receded' — a turn the design has deliberately pushed back. 'content' —
 *  body copy, controls, navigation: the set where a failure is a defect. */
function classify(row) {
  return RECEDED_RE.test((row && row.sel) || '') ? 'receded' : 'content';
}

function partition(rows) {
  const receded = [];
  const content = [];
  for (const r of rows) (classify(r) === 'receded' ? receded : content).push(r);
  return { receded, content };
}

/**
 * The floor of a bucket, and the row that sits on it.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL. "0 receded-turn failures" is an
 * ABSENCE, and an absence has two causes that look identical in a report: the
 * receded turns cleared their floor, or no receded turn was measured at all.
 * This repo has shipped the second kind twice — an S4 gate that went vacuous
 * when `hidden` moved off the element it tested, and a `hi` axis that would
 * have swept nothing. So every bucket reports how many rows it CONTAINED and
 * the worst ratio among them; a bucket of zero rows is then visibly a bucket of
 * zero rows rather than a pass.
 */
function floorOf(scored) {
  let worst = null;
  for (const r of scored) {
    if (typeof r.ratio !== 'number') continue;
    if (!worst || r.ratio < worst.ratio) worst = r;
  }
  return worst;
}

/** The worst row in a bucket, carrying whether the engine was willing to
 *  CERTIFY it. A `background-image` in the backdrop stack is not resolvable
 *  from computed style, so such a row is measured, reported, and excluded from
 *  the failure list — which means the tightest ratio in a bucket can belong to
 *  a row that certifies nothing. Recording the flag beside the number is the
 *  difference between "the floor is 5.45:1" and "the floor is 5.45:1 and we do
 *  not actually know what is behind it". */
function worstRecord(rows) {
  const w = floorOf(rows);
  if (!w) return null;
  return {
    ratio: w.ratio, floor: w.floor, color: w.color, sel: w.sel, text: w.text,
    page: w.page, mode: w.mode, lang: w.lang, certified: !w.imageBacked,
  };
}

function bucketStats(measured) {
  const split = partition(measured);
  return {
    recededRows: split.receded.length,
    contentRows: split.content.length,
    worstReceded: worstRecord(split.receded),
    worstContent: worstRecord(split.content),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * The baseline this surface is held to.
 *
 * Recorded IN THIS FILE rather than in a sibling `.txt` — the portal keeps its
 * signature body in `contrast/portal.signature.txt`, and the same split would
 * be right here, but this session's allowed file set is two files and a package
 * script. The invariant is identical either way: `webContrast.test.js`
 * re-hashes `signatureLines` on every `npm test`, so the body and the md5
 * cannot drift apart, and a live run that moves a SHAPE moves the md5.
 *
 * `rows`, `pairs`, `failures` and `rings` are recorded so a run that moves them
 * is NOTICED. They are not the invariant and must not be asserted: across five
 * S2 portal runs of an unchanged tree the row count read 2302 / 2325 / 2339 /
 * 2347 while the signature stayed byte-identical.
 * ────────────────────────────────────────────────────────────────────────── */

const WEB_BASELINE = Object.freeze({
  at: 'cb14223+S3c-2',               // HEAD plus F-F010's close. ONE rule pair in
                                     // legal.module.css moved every number below.
  // The build it was served from. Recorded, and deliberately NOT asserted: the
  // same signature has now been reproduced across three different build ids
  // (`R6hjrB7Zfi7Yk-_NSbawQ`, `I3WZI49rGcziBYeJx9MlB`, this one), which is what
  // establishes that it is a fact about the source rather than about one build.
  buildId: '43RRI7YH3unK7AbTSr49Y',

  /** All nine, from `.next/prerender-manifest.json`. */
  routeList: Object.freeze([
    '/', '/_not-found', '/acceptable-use', '/data-deletion', '/privacy',
    '/robots.txt', '/sitemap.xml', '/specimen', '/terms',
  ]),
  /** The seven the design system actually paints. */
  htmlRoutes: Object.freeze([
    '/', '/_not-found', '/acceptable-use', '/data-deletion', '/privacy',
    '/specimen', '/terms',
  ]),
  /** Served as text/plain and application/xml. Chrome renders them with its
   *  own stylesheet, so a ratio measured there is a fact about Chrome. Swept
   *  anyway, and reported, because "we did not look" and "there was nothing to
   *  see" must not be the same entry. */
  textRoutes: Object.freeze(['/robots.txt', '/sitemap.xml']),
  /** The two that mount the player, and so the only two with a language axis. */
  languageRoutes: Object.freeze(['/', '/specimen']),
  /** From `[data-lang-option]` in the live DOM. `hi` is not offered. */
  languages: Object.freeze(['en', 'te']),
  modes: MODE_NAMES,
  viewport: Object.freeze([VIEWPORT.width, VIEWPORT.height]),
  /** `--ink-faint`, resolved from the live page per media state. */
  inkFaint: Object.freeze({
    default: '#A8A199',
    'reduced-motion': '#A8A199',
    'high-contrast': '#857F79',
  }),

  cells: 33,                    // 2x2x3 language-bearing + 7x1x3 degenerate
  rows: 5452,                   // glyph rows measured
  recededRows: 612,             // …of which sat inside a stepNear/stepFloor turn
  contentRows: 4840,            // …body copy, controls, navigation
  pairs: 61,                    // distinct colour/backdrop/band/opacity. Was 62:
                                // the `@op0.8 :hover` key went with F-F010 and
                                // NOTHING replaced it. The hover resolves to
                                // --ink-strong on --ground now, and the body
                                // copy on those same four pages was already
                                // sitting in that key.
  failures: 6,                  // threshold failures, 2 distinct shapes. Was 36.
  recededFailures: 0,           // §5 set one — EMPTY, out of 612 rows measured
  contentFailures: 6,           // §5 set two — /specimen's own printed
                                // counterexample, and nothing else on the site.
  failingRoutes: Object.freeze(['/specimen']),
  /* `knownDefect` WAS HERE, AND IS GONE — S3c-2 CLOSED F-F010 rather than
   * re-describing it. It named the 30-row `@op0.8 :hover` shape on the four
   * legal routes so the assertion letting it through had to name a SHAPE
   * rather than wave four routes past, and that was the right way to carry an
   * open defect. It is the wrong way to carry a closed one: an exemption that
   * outlives the thing it excuses keeps reading as a live decision, which is
   * exactly why S3c-1 deleted `sidebar-nav-icon` from PORTAL_EXEMPT instead of
   * relaxing it. The mechanism it recorded is not lost — the argument moved to
   * legal.module.css:269, where the next person reaching for `opacity` on a
   * hover is actually standing. The SHAPE is also pinned without a browser now:
   * webContrast.test.js refuses any `@op… :hover` line in this signature. The
   * MECHANISM is not yet pinned — see the note that closes that file. */
  worstRecededRatio: 7.31,      // --ink-soft on --ground, against a 4.5 floor
  contract: 6,                  // D-016 --ink-faint as a glyph colour
  undeterminable: 6,            // background-image in the backdrop stack
  rings: 549,                   // focus indicators, walked in real tab order
  ringFailures: 0,              // below SC 1.4.11's 3:1

  signatureLines: Object.freeze([
    "FAIL      2.21:1 needs 4.5  rgb(168, 161, 153) on rgb(242,238,232)",
    "FAIL      3.42:1 needs 4.5  rgb(133, 127, 121) on rgb(242,238,232)",
    "CONTRACT  --ink-faint resolved as a glyph colour  rgb(133, 127, 121) on rgb(242,238,232)  3.42:1",
    "CONTRACT  --ink-faint resolved as a glyph colour  rgb(168, 161, 153) on rgb(242,238,232)  2.21:1",
    "UNDET     background-image in the backdrop stack  rgb(143, 163, 173) on rgb(32,44,51)",
    "RING      PASS 15.79  [outline 15.79 vs outer backdrop  2px solid rgb(23, 21, 15) @ 2px]",
    "RING      PASS 17.22  [glow 1.00 vs outer backdrop  0px 0px 0px 2px rgb(250, 248, 245) | glow 17.22 vs outer backdrop  0px 0px 0px 4px rgb(23, 21, 15)]",
    "RING      PASS 17.22  [outline 17.22 vs outer backdrop  2px solid rgb(23, 21, 15) @ 2px]",
    "RING      PASS 17.95  [outline 17.95 vs outer backdrop  1px auto rgb(16, 16, 16) @ 1px]",
    "RING      PASS 18.25  [glow 1.06 vs outer backdrop  0px 0px 0px 2px rgb(250, 248, 245) | glow 18.25 vs outer backdrop  0px 0px 0px 4px rgb(23, 21, 15)]",
  ]),
  signatureMd5: '2bc2998236c8422a7407f6ffaf85d394',
});

/** md5 of a signature body built from `lines`, LF-joined and LF-terminated —
 *  identical to what `core.signature()` hashes, and normalised for the same
 *  reason the migration runner normalises its checksums: this repo checks out
 *  CRLF on Windows and LF elsewhere. */
function hashLines(lines) {
  const body = lines.join('\n') + '\n';
  return crypto.createHash('md5').update(body, 'utf8').digest('hex');
}

/* ──────────────────────────────────────────────────────────────────────────
 * BUILD-ID INTERLOCK.
 * ────────────────────────────────────────────────────────────────────────── */

class Refusal extends Error {
  constructor(gate, message) {
    super('INTERLOCK ' + gate + ' — REFUSED: ' + message);
    this.gate = gate;
    this.refusal = true;
  }
}

function buildIdOnDisk() {
  if (!fs.existsSync(BUILD_ID_FILE)) return null;
  const id = fs.readFileSync(BUILD_ID_FILE, 'utf8').trim();
  return id || null;
}

/** The build id a SERVED document declares.
 *
 *  It lives in the RSC flight payload, which reaches the browser inside a
 *  JavaScript string literal — so in the raw HTML the quotes are backslashed
 *  and in `self.__next_f` they are not. Both forms are accepted here because
 *  this same function reads the id out of a Node `fetch` of the raw bytes and
 *  out of an in-page evaluation. */
const SERVED_ID_RE = /\\?"b\\?":\\?"([A-Za-z0-9_-]+)/;

function servedBuildIdFrom(text) {
  const m = typeof text === 'string' ? text.match(SERVED_ID_RE) : null;
  return m ? m[1] : null;
}

/** Read the id from the live document. Returns null for a document with no
 *  flight payload at all — robots.txt and sitemap.xml are served as text, and
 *  a text document cannot be asked which build produced it. Those routes are
 *  covered by the run-level probe of `/` instead, which is stated rather than
 *  glossed because it is a real hole in per-page coverage. */
const SERVED_ID_SOURCE = "(function(){"
  + "var f = self.__next_f;"
  + "if (!f || !f.length) return null;"
  + "for (var i = 0; i < f.length; i++) {"
  + "  var e = f[i];"
  + "  if (e && typeof e[1] === 'string') {"
  + "    var m = e[1].match(/\"b\":\"([A-Za-z0-9_-]+)\"/);"
  + "    if (m) return m[1];"
  + "  }"
  + "}"
  + "return null;"
  + "})()";

/**
 * Is a `next dev` running against this project?
 *
 * ⚠️ THIS IS NOT PARANOIA, IT IS A REPRODUCED FAILURE. `next dev` and
 * `next build`/`next start` share one `.next`, and a dev server CLEARS it at
 * startup and rewrites it on demand — including deleting `BUILD_ID`, which dev
 * mode does not write at all. Measured on this machine: a developer's
 * `npm run dev` in `web/` (VS Code terminal → npm → `next dev --port 3100`)
 * wiped `.next` twice under a running sweep, leaving `.next/server/app` holding
 * one route group and no `index.html`. G4 caught both, mid-run, three cells and
 * thirty cells in respectively.
 *
 * G4 catching it is correct but expensive: it throws away everything measured so
 * far. This gate turns the same fact into a refusal BEFORE a build is spent,
 * and it names the pid so the answer is "stop that, or wait for it" rather than
 * "something wiped my build".
 *
 * Windows-only by implementation (the query is WMI). Elsewhere it returns null
 * — UNKNOWN, reported as unknown, never as "clear". A gate that silently passes
 * where it cannot look is the vacuous-gate failure this repo keeps re-learning.
 */
/** The separator between pid and command line in the process listing.
 *
 *  ⚠️ NOT `\t`. PowerShell escapes with a BACKTICK, not a backslash, so a `"\t"`
 *  written into a PowerShell double-quoted string is the two characters
 *  backslash-t. Splitting the output on a real tab in Node then matched nothing,
 *  every line was skipped, and G0 reported "none" with a `next dev` running in
 *  front of it — a gate reporting clear because it could not read its own input.
 *  Caught by running it against the live machine; pinned below so it stays
 *  caught. */
const PROC_SEP = ' |~| ';

/**
 * Pure half of G0: turn a `pid<sep>commandline` listing into the dev servers
 * that own THIS project's `.next`.
 *
 * Scoped to this project's web directory on purpose. A `next dev` for some
 * other repository shares nothing with this `.next` and must not block a sweep
 * — a gate that refuses on somebody else's unrelated process gets switched off,
 * and a gate that is switched off is not a gate.
 */
function parseDevServers(stdout, webDir) {
  const web = String(webDir).toLowerCase().replace(/\//g, '\\');
  const hits = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const at = line.indexOf(PROC_SEP);
    if (at < 0) continue;
    const pid = line.slice(0, at).trim();
    const cmd = line.slice(at + PROC_SEP.length);
    if (!cmd || !/\bdev\b/i.test(cmd) || !/next/i.test(cmd)) continue;
    if (cmd.toLowerCase().replace(/\//g, '\\').indexOf(web) < 0) continue;
    hits.push({ pid, cmd: cmd.trim().slice(0, 160) });
  }
  return hits;
}

function devServerAgainstWeb() {
  if (process.platform !== 'win32') return null;
  const ps = path.join(process.env.SystemRoot || 'C:/Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(ps)) return null;
  const r = spawnSync(ps, ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='cmd.exe'\" | "
    + "ForEach-Object { $_.ProcessId.ToString() + '" + PROC_SEP + "' + $_.CommandLine }"],
  { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return parseDevServers(r.stdout, WEB_DIR);
}

async function portAnswers(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/', {
      signal: AbortSignal.timeout(2500),
    });
    return { up: true, body: await res.text() };
  } catch (_) {
    return { up: false, body: null };
  }
}

/** G0 + G1 + G2, run before a browser exists. Returns the id the run is pinned to. */
async function interlockBeforeStart(opts) {
  // G0 — nothing else may own .next. Checked FIRST, because it is the only gate
  // that can save a build from being spent on a directory something else is
  // about to clear.
  const dev = opts.devServers === undefined ? devServerAgainstWeb() : opts.devServers;
  if (dev && dev.length && !opts.allowDevServer) {
    throw new Refusal('G0', 'a `next dev` is running against this project and owns '
      + '.next:\n    ' + dev.map((d) => 'pid ' + d.pid + '  ' + d.cmd).join('\n    ')
      + '\n  `next dev` clears .next at startup, rewrites it on demand and writes no '
      + 'BUILD_ID, so a production build and a sweep cannot share the directory with it. '
      + 'Stop that dev server (or wait for it) and re-run. It is NOT killed here — it is '
      + "someone's running work."
      + '\n  `--allow-dev-server` proceeds anyway. G0 is a FAIL-FAST gate, not a '
      + 'correctness gate: it saves a build from being spent on a directory something '
      + 'else may clear. G3 and G4 still hold unconditionally, so an overridden run that '
      + 'does get clobbered refuses mid-sweep instead of emitting a wrong signature — it '
      + 'costs time, never truth.');
  }

  const before = opts.idBefore;
  const after = buildIdOnDisk();

  if (!after) {
    throw new Refusal('G1', 'web/.next/BUILD_ID is absent — there is no build to '
      + 'measure. A killed `next build` leaves .next partial: rebuild before sweeping.');
  }
  if (opts.built && before === after) {
    throw new Refusal('G1', 'a build ran and BUILD_ID did not move (' + after + '). '
      + 'Next derives it randomly per build, so an unchanged id means nothing was '
      + 'rebuilt — the sweep would measure the previous build.');
  }

  const probe = await portAnswers(opts.port);
  if (probe.up) {
    throw new Refusal('G2', 'something is already answering on port ' + opts.port
      + ' (its build id reads ' + (servedBuildIdFrom(probe.body) || 'unreadable')
      + ', disk reads ' + after + '). This instrument never adopts a server it did '
      + 'not spawn: an orphan surviving a failed reap is exactly what this gate is '
      + 'for. Kill it — `' + TASKKILL + ' /F /T /PID <pid>` — and re-run.');
  }
  return after;
}

/**
 * G3 (and G4) for one swept document.
 *
 * `diskIdNow` is a PARAMETER with a default rather than an unconditional read
 * of the filesystem, so the two gates can be exercised one at a time offline.
 * A function that reaches for the disk in the middle of a comparison can only
 * ever be tested in whatever state the disk happens to be in — which, the first
 * time it was written that way, made the G3 case raise G4 instead.
 */
function interlockServed(route, servedId, pinnedId, diskIdNow) {
  if (servedId === null) return { checked: false, why: 'no flight payload (text route)' };
  const disk = diskIdNow === undefined ? buildIdOnDisk() : diskIdNow;
  if (disk !== pinnedId) {
    throw new Refusal('G4', 'BUILD_ID moved mid-run: pinned ' + pinnedId
      + ', disk now ' + disk + '. A rebuild raced the sweep and the signature would '
      + 'span two builds.');
  }
  if (servedId !== pinnedId) {
    throw new Refusal('G3', route + ' was served by build ' + servedId
      + ' while .next/BUILD_ID reads ' + pinnedId + '. `next start` serves the build '
      + 'it booted on and does not notice a rebuild underneath it — this is a STALE '
      + 'SERVER, and every row measured from it belongs to a build that is not on '
      + 'disk. Restart the server.');
  }
  return { checked: true, id: servedId };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Route enumeration — derived, never authored.
 * ────────────────────────────────────────────────────────────────────────── */

function prerenderedRoutes() {
  if (!fs.existsSync(PRERENDER_MANIFEST)) {
    throw new Refusal('G1', 'web/.next/prerender-manifest.json is absent — build first.');
  }
  const manifest = JSON.parse(fs.readFileSync(PRERENDER_MANIFEST, 'utf8'));
  return Object.keys(manifest.routes || {}).sort();
}

/** What a route actually is, asked of the running server rather than assumed.
 *  `text/html` is the only content type this instrument's CSS reaches; anything
 *  else is rendered by the browser's own stylesheet and measuring it measures
 *  Chrome. */
async function probeRoute(base, route) {
  const res = await fetch(base + route, { redirect: 'manual' });
  const body = await res.text();
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  return {
    route,
    status: res.status,
    type,
    html: type === 'text/html',
    servedId: servedBuildIdFrom(body),
    bytes: body.length,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * A minimal CDP client. Same shape as scripts/portal/shoot.js — proven against
 * this Chrome, on this machine, over this protocol.
 * ────────────────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method) { this.listeners.forEach((l) => l(m)); }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
}

async function connectBrowser(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint never came up on ' + port);
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
  });
}

async function evalIn(cdp, sid, expression, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: !!awaitPromise }, sid);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error('in-page error: ' + ((e.exception && e.exception.description) || e.text));
  }
  return r.result && r.result.value;
}

async function pressTab(cdp, sid) {
  const k = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k), sid);
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k), sid);
}

/**
 * Tab once, then WAIT FOR THE RING TO STOP MOVING before reading it.
 *
 * ⚠️ THIS REPLACED A FIXED `sleep(180)`, AND THE FIXED SLEEP WAS A FLAKE.
 * `Button.module.css:61` declares `transition: all var(--ease-out) .18s` — in
 * the shorthand a lone time is the DURATION, so a focused `.btn` grows its
 * `box-shadow` ring over exactly 180 ms, and the read landed on that boundary.
 * It cost one cell in one of five otherwise byte-identical runs: `/`
 * [en/high-contrast] came back with 245 rows, 24 receded, 17 pairs, 0 failures
 * and 42 rings — every count identical — and a different signature, because one
 * `ringShape` was a half-grown shadow. Sleeping longer is not the fix either:
 * the number to sleep for is a property of whatever stylesheet is loaded, and
 * the next component to declare a 300 ms focus transition would silently
 * restore the flake.
 *
 * So: sample the focused element's indicator properties until two consecutive
 * reads agree. The first sample is deliberately taken AFTER a delay long enough
 * for the transition to have started — two equal reads taken before the style
 * recalc would agree on the RESTING value, which is the same trap running
 * backwards, and is exactly what `blurActive()`/`tagFocusables()` are split
 * apart to avoid.
 *
 * Returns the number of polls, so a cell that needed the cap is visible rather
 * than silently under-settled.
 */
async function tabToSettledRing(cdp, sid) {
  await pressTab(cdp, sid);
  await sleep(90);                 // past the recalc; the transition is running
  let previous = await evalIn(cdp, sid, FOCUS_FINGERPRINT_SOURCE);
  let polls = 1;
  const deadline = Date.now() + 1500;
  for (;;) {
    await sleep(70);
    const current = await evalIn(cdp, sid, FOCUS_FINGERPRINT_SOURCE);
    polls += 1;
    if (current === previous) return { polls, capped: false };
    previous = current;
    if (Date.now() > deadline) return { polls, capped: true };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * In-page probes. Plain concatenated source, no template literals: a backtick
 * inside one has silently broken a probe in this repo more than once, and
 * core.js avoids them for the same reason.
 * ────────────────────────────────────────────────────────────────────────── */

/** Walk the whole document so every IntersectionObserver fires, then return to
 *  the top and report what is STILL hidden. `behavior: "instant"` is required:
 *  globals.css:313 sets `scroll-behavior: smooth`, and a plain scrollTo under
 *  it returns a mid-flight scrollY that looks exactly like a layout shift. */
const REVEAL_PASS_SOURCE = "(async function(){"
  + "var doc = document.documentElement;"
  + "var h = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);"
  + "var vh = window.innerHeight || 900;"
  + "var step = Math.max(120, Math.floor(vh * 0.6));"
  + "for (var y = 0; y <= h; y += step) {"
  + "  window.scrollTo({ top: y, left: 0, behavior: 'instant' });"
  + "  await new Promise(function (r) { setTimeout(r, 90); });"
  + "}"
  + "window.scrollTo({ top: h, left: 0, behavior: 'instant' });"
  + "await new Promise(function (r) { setTimeout(r, 200); });"
  + "window.scrollTo({ top: 0, left: 0, behavior: 'instant' });"
  + "await new Promise(function (r) { setTimeout(r, 700); });"
  + "return {"
  + "  height: h,"
  + "  scrollY: Math.round(window.scrollY),"
  + "  stillHidden: document.querySelectorAll('.reveal-hidden').length,"
  + "  revealed: document.querySelectorAll('.reveal-visible').length"
  + "};"
  + "})()";

/** What this document offers, asked of the DOM. The language list is the one
 *  the reader is actually given — not a list this file believes in. */
const AFFORDANCES_SOURCE = "(function(){"
  + "var opts = [].slice.call(document.querySelectorAll('[data-lang-option]'));"
  + "var host = document.querySelector('[data-playback]');"
  + "var cs = getComputedStyle(document.documentElement);"
  + "return {"
  + "  langs: opts.map(function (o) { return o.getAttribute('data-lang-option'); }),"
  + "  selected: (function(){"
  + "    var s = document.querySelector('[data-conversation-lang]');"
  + "    return s ? s.getAttribute('data-conversation-lang') : null;"
  + "  })(),"
  + "  playback: host ? host.getAttribute('data-playback') : null,"
  + "  conversations: document.querySelectorAll('[data-conversation-region]').length,"
  + "  inkFaint: cs.getPropertyValue('--ink-faint').trim(),"
  + "  inkSoft: cs.getPropertyValue('--ink-soft').trim(),"
  + "  reducedSeen: window.matchMedia('(prefers-reduced-motion: reduce)').matches,"
  + "  contrastSeen: window.matchMedia('(prefers-contrast: more)').matches,"
  + "  fontsReady: !!(document.fonts && document.fonts.status === 'loaded')"
  + "};"
  + "})()";

/**
 * Click one language option. It does NOT report the resulting language, and
 * that is deliberate: `data-conversation-lang` is rendered from React state, so
 * reading it in the same evaluation as the `click()` returns the language the
 * shell was on BEFORE — the commit has not happened yet. The first version of
 * this returned that value and the caller's verification failed every time,
 * correctly, on a switch that was in fact working. Verification is a SEPARATE
 * evaluation, after a settle. Same shape as the blur/rest split, same reason.
 */
function selectLangSource(code) {
  return "(function(){"
    + "var b = document.querySelector('[data-lang-option=" + JSON.stringify(code) + "]');"
    + "if (!b) return { ok: false, why: 'no such option' };"
    + "b.click();"
    + "return { ok: true };"
    + "})()";
}

const CURRENT_LANG_SOURCE = "(function(){"
  + "var s = document.querySelector('[data-conversation-lang]');"
  + "return s ? s.getAttribute('data-conversation-lang') : null;"
  + "})()";

/** Click the one control and let the sequence run. Nothing is timed here: the
 *  driver polls `data-playback` until it reads `complete`. */
const START_PLAYBACK_SOURCE = "(function(){"
  + "var host = document.querySelector('[data-playback]');"
  + "if (!host) return { ok: false, why: 'no player' };"
  + "var btn = host.querySelector('button[data-state]');"
  + "if (!btn) return { ok: false, why: 'no control' };"
  + "if (host.getAttribute('data-playback') === 'complete') return { ok: true, already: true };"
  + "btn.click();"
  + "return { ok: true, total: Number(host.getAttribute('data-playback-total')) || null };"
  + "})()";

/**
 * A fingerprint of everything on the focused element that a focus indicator is
 * made of. Polled until it stops changing — see `tabToSettledRing`.
 *
 * Every property `core.readFocusRing` reads is in here, so "the fingerprint has
 * stopped moving" means "the ring has stopped moving" and not "something else
 * has".
 */
const FOCUS_FINGERPRINT_SOURCE = "(function(){"
  + "var el = document.activeElement;"
  + "if (!el || el === document.body || el === document.documentElement) return null;"
  + "var cs = getComputedStyle(el);"
  + "return [cs.outlineColor, cs.outlineStyle, cs.outlineWidth, cs.outlineOffset,"
  + "        cs.boxShadow, cs.borderTopColor, cs.borderTopWidth,"
  + "        cs.backgroundColor, cs.color].join('|');"
  + "})()";

const PLAYBACK_STATE_SOURCE = "(function(){"
  + "var host = document.querySelector('[data-playback]');"
  + "if (!host) return null;"
  + "return {"
  + "  state: host.getAttribute('data-playback'),"
  + "  index: Number(host.getAttribute('data-playback-index')),"
  + "  reduced: host.getAttribute('data-playback-reduced'),"
  + "  total: Number(host.getAttribute('data-playback-total'))"
  + "};"
  + "})()";

/* ──────────────────────────────────────────────────────────────────────────
 * One cell of the matrix.
 * ────────────────────────────────────────────────────────────────────────── */

async function sweepCell(cdp, opts) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await cdp.send('Emulation.setEmulatedMedia',
      { media: 'screen', features: MODES[opts.mode] }, sessionId);
    // rAF is the playback clock. A target the compositor thinks is hidden
    // throttles it, and the sequence would then never reach `complete`.
    try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId); }
    catch (_) { /* older protocol — the target is foreground anyway */ }

    const loaded = new Promise((res) => {
      cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
    });
    await cdp.send('Page.navigate', { url: opts.url }, sessionId);
    await loaded;

    // G3 — before a single row is collected.
    const servedId = await evalIn(cdp, sessionId, SERVED_ID_SOURCE);
    const idCheck = interlockServed(opts.route, servedId, opts.pinnedId);

    // Fonts, then the hero's own entrance: .chatStage is `fadeUp .9s … .5s
    // forwards`, so 1.4s from paint, and a glyph measured under a running
    // scale(.98) reports a size band it does not hold at rest.
    await evalIn(cdp, sessionId,
      "(document.fonts ? document.fonts.ready.then(function(){return true;}) : true)", true);
    await sleep(1600);

    const reveal = await evalIn(cdp, sessionId, REVEAL_PASS_SOURCE, true);
    let aff = await evalIn(cdp, sessionId, AFFORDANCES_SOURCE);

    // The language is SELECTED, and the selection is verified. A click that did
    // not land leaves the page on its initial language ("te" on both players),
    // and the cell would then be labelled `en` while measuring Telugu — a
    // mislabelled measurement, which is worse than a missing one.
    if (opts.lang) {
      const offered = (aff && aff.langs) || [];
      if (offered.indexOf(opts.lang) < 0) {
        throw new Error('cell asks for "' + opts.lang + '" on ' + opts.route
          + ' but the live DOM offers [' + offered.join(', ') + ']');
      }
      const sel = await evalIn(cdp, sessionId, selectLangSource(opts.lang));
      if (!sel || !sel.ok) {
        throw new Error('no [data-lang-option="' + opts.lang + '"] to click on ' + opts.route);
      }
      await sleep(300);
      const now = await evalIn(cdp, sessionId, CURRENT_LANG_SOURCE);
      if (now !== opts.lang) {
        throw new Error('selecting "' + opts.lang + '" on ' + opts.route
          + ' left the shell on "' + now + '"');
      }
    }

    let playback = null;
    if (aff && aff.playback) {
      const started = await evalIn(cdp, sessionId, START_PLAYBACK_SOURCE);
      const deadline = Date.now() + 45000;
      let last = null;
      for (;;) {
        last = await evalIn(cdp, sessionId, PLAYBACK_STATE_SOURCE);
        if (last && last.state === 'complete') break;
        if (Date.now() > deadline) {
          throw new Error('playback never reached `complete` on ' + opts.route
            + ' [' + opts.mode + '/' + opts.lang + '] — last state '
            + JSON.stringify(last) + '. Rows measured mid-emergence are not a '
            + 'measurement, so this refuses rather than sweeping.');
        }
        await sleep(250);
      }
      // Past --dur-enter (500ms) and the card's own draw: `complete` is the
      // state the machine reports, settled is what the pixels are.
      await sleep(900);
      playback = { started, final: last };
    }

    // Re-read the affordances AFTER the page has settled into the state that is
    // about to be measured, so the report describes the measured frame.
    aff = await evalIn(cdp, sessionId, AFFORDANCES_SOURCE);

    const rows = (await evalIn(cdp, sessionId, core.TEXT_SWEEP_SOURCE)) || [];

    // Focus indicators. Separate evaluations with a settle between, or the rest
    // style read is the transition START — i.e. the focused value.
    await evalIn(cdp, sessionId, core.BLUR_SOURCE);
    // Past the longest transition any focusable declares (.3s on the nav bar),
    // not merely past the shortest. A rest style read too early IS the focused
    // style, and the two files this engine serves have both been bitten by it.
    await sleep(420);
    const rest = (await evalIn(cdp, sessionId, core.TAG_FOCUSABLES_SOURCE)) || [];
    const restBy = new Map(rest.map((r) => [String(r.i), r]));
    const rings = [];
    const seen = new Set();
    let cappedRings = 0;
    for (let t = 0; t < Math.min(rest.length + 2, 60); t++) {
      const settle = await tabToSettledRing(cdp, sessionId);
      if (settle.capped) cappedRings += 1;
      const ring = await evalIn(cdp, sessionId, core.READ_RING_SOURCE);
      if (!ring) continue;
      const key = ring.i === null || ring.i === undefined ? ring.sel : String(ring.i);
      if (seen.has(key)) break; // tab order wrapped
      seen.add(key);
      rings.push(core.judgeRing(ring, restBy.get(String(ring.i))));
    }

    // A ring that hit the settle cap was read while something was still moving.
    // It is surfaced rather than swallowed: an instrument that quietly gives up
    // on settling is back to the fixed sleep this replaced.
    if (cappedRings) {
      throw new Error(cappedRings + ' focus indicator(s) on ' + opts.route
        + ' [' + opts.mode + '/' + opts.lang + '] never stopped changing within 1.5s. '
        + 'A ring read mid-transition is not a measurement.');
    }

    return { rows, rings, focusables: rest.length, reveal, aff, playback, idCheck };
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * The matrix, and one run of it.
 * ────────────────────────────────────────────────────────────────────────── */

function cellName(route, lang, mode) {
  return route + ' [' + (lang || '-') + '/' + mode + ']';
}

async function runMatrix(cdp, ctx) {
  const cells = [];
  const allRows = [];
  const allRings = [];

  for (const probe of ctx.routes) {
    if (!probe.html && !ctx.includeText) continue;
    const langs = probe.langs && probe.langs.length ? probe.langs : [null];
    for (const lang of langs) {
      for (const mode of MODE_NAMES) {
        const got = await sweepCell(cdp, {
          url: ctx.base + probe.route,
          route: probe.route,
          lang, mode,
          pinnedId: ctx.pinnedId,
        });
        // What the PAGE resolved, or null. `/robots.txt` and `/sitemap.xml`
        // carry no stylesheet of ours, so `--ink-faint` resolves to the empty
        // string there — which is "this page has no such token", not "this page
        // uses the default". Collapsing the two made the uniformity check below
        // refuse a matrix that was perfectly consistent, because a text route's
        // FALLBACK looked like a second value of the token.
        const inkFaintResolved = (got.aff && got.aff.inkFaint) || null;
        const inkFaint = inkFaintResolved || core.INK_FAINT;
        for (const r of got.rows) { r.page = probe.route; r.mode = mode; r.lang = lang || '-'; allRows.push(r); }
        for (const r of got.rings) { r.page = probe.route; r.mode = mode; r.lang = lang || '-'; allRings.push(r); }
        const verdict = core.judge(got.rows, { inkFaint });
        const ringFail = got.rings.filter((r) => !r.pass).length;
        const sig = core.signature({
          failures: verdict.failures,
          contract: verdict.contract,
          undeterminable: verdict.undeterminable,
          rings: got.rings,
        });
        const split = partition(verdict.failures);
        const bucket = bucketStats(verdict.measured);
        cells.push(Object.assign({
          route: probe.route, lang: lang || '-', mode,
          html: probe.html,
          inkFaint,
          inkFaintResolved,
          rows: got.rows.length,
          pairs: verdict.pairs,
          failures: verdict.failures.length,
          recededFailures: split.receded.length,
          contentFailures: split.content.length,
          contract: verdict.contract.length,
          undeterminable: verdict.undeterminable.length,
          rings: got.rings.length,
          ringFailures: ringFail,
          revealStillHidden: got.reveal ? got.reveal.stillHidden : null,
          revealVisible: got.reveal ? got.reveal.revealed : null,
          playbackState: got.playback ? got.playback.final.state : null,
          playbackTotal: got.playback ? got.playback.final.total : null,
          langNow: got.aff ? got.aff.selected : null,
          reducedSeen: got.aff ? got.aff.reducedSeen : null,
          contrastSeen: got.aff ? got.aff.contrastSeen : null,
          idChecked: got.idCheck.checked,
          signatureMd5: sig.md5,
          signatureLines: sig.lines,
        }, bucket));
        if (ctx.log) {
          ctx.log('  ' + cellName(probe.route, lang, mode).padEnd(38)
            + String(got.rows.length).padStart(5) + ' rows ('
            + String(bucket.recededRows).padStart(3) + ' receded) '
            + String(verdict.pairs).padStart(3) + ' pairs '
            + String(verdict.failures.length).padStart(4) + ' fail ('
            + String(split.receded.length) + 'r/' + String(split.content.length) + 'c) '
            + String(verdict.contract.length).padStart(2) + ' contract '
            + String(got.rings.length).padStart(3) + ' rings '
            + String(ringFail).padStart(2) + ' ring-fail  '
            + 'worst r' + (bucket.worstReceded ? bucket.worstReceded.ratio.toFixed(2) : '  n/a')
            + '/c' + (bucket.worstContent ? bucket.worstContent.ratio.toFixed(2) : ' n/a')
            + '  ' + sig.md5.slice(0, 8));
        }
      }
    }
  }

  // The run-wide verdict. The contract hex is per-cell (two values on this
  // surface), so violations are taken from the cells rather than recomputed
  // once with a single hex that would be wrong for a third of them.
  const contractAll = [];
  const failuresAll = [];
  const undetAll = [];
  const measuredAll = [];
  const byMode = new Map();
  for (const mode of MODE_NAMES) byMode.set(mode, []);
  for (const r of allRows) byMode.get(r.mode).push(r);
  for (const mode of MODE_NAMES) {
    const rowsOfMode = byMode.get(mode);
    if (!rowsOfMode.length) continue;
    // `--ink-faint` is a ROOT token, so every cell in a media state must have
    // resolved it to the same hex. Checked rather than assumed: taking the
    // first cell's value while a second disagreed would judge part of the
    // matrix against a colour that part of the surface is not using, which is
    // the exact failure resolving it per cell exists to prevent.
    const hexes = [...new Set(cells
      .filter((c) => c.mode === mode && c.inkFaintResolved)
      .map((c) => c.inkFaintResolved))];
    if (hexes.length > 1) {
      throw new Refusal('G5', '--ink-faint resolved to ' + hexes.join(' and ')
        + ' within the "' + mode + '" media state. It is a :root token; two values '
        + 'means a page is overriding it and the contract cannot be judged run-wide.');
    }
    const hex = hexes[0] || core.INK_FAINT;
    const v = core.judge(rowsOfMode, { inkFaint: hex });
    failuresAll.push(...v.failures);
    contractAll.push(...v.contract);
    undetAll.push(...v.undeterminable);
    measuredAll.push(...v.measured);
  }
  const signature = core.signature({
    failures: failuresAll, contract: contractAll,
    undeterminable: undetAll, rings: allRings,
  });
  const split = partition(failuresAll);
  const bucket = bucketStats(measuredAll);

  return {
    cells,
    bucket,
    rows: measuredAll.length,
    pairs: core.uniquePairs(measuredAll),
    failures: failuresAll,
    receded: split.receded,
    content: split.content,
    contract: contractAll,
    undeterminable: undetAll,
    rings: allRings,
    ringFailures: allRings.filter((r) => !r.pass),
    signature,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Process management. `next start` is spawned as a DIRECT node child so that
 * killing it kills the server rather than an npm wrapper whose leaf survives —
 * the orphan G2 exists to catch. Reaped twice: once by signal, once by
 * taskkill at its absolute path, because taskkill is not on PATH here and a
 * bare `taskkill` is the reap that silently does not happen.
 * ────────────────────────────────────────────────────────────────────────── */

function startServer(port, log) {
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(port)], {
    cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.transcript = '';
  child.stdout.on('data', (d) => { child.transcript += d; });
  child.stderr.on('data', (d) => { child.transcript += d; });
  child.on('exit', (code, signal) => {
    child.died = { code, signal };
    if (log) log('  next start exited (code ' + code + ', signal ' + signal + ')');
  });
  return child;
}

/** Probe with retries. A production `next start` does not watch `.next`, but a
 *  build replacing every file underneath it is not a quiet event, and one
 *  refused connection is not evidence of anything. */
async function probeRouteRetrying(base, route, tries) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return await probeRoute(base, route); }
    catch (e) { last = e; await sleep(700); }
  }
  throw last;
}

function reap(child, log) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch (_) { /* already gone */ }
  try {
    spawnSync(TASKKILL, ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } catch (_) {
    if (log) log('  taskkill unavailable at ' + TASKKILL + ' — check for an orphan on the port');
  }
}

async function waitForServer(port, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const probe = await portAnswers(port);
    if (probe.up) return probe;
    await sleep(400);
  }
  throw new Error('next start never answered on port ' + port);
}

function runBuild(log) {
  if (log) log('building web/ …');
  const r = spawnSync(process.execPath, [NEXT_BIN, 'build'], {
    cwd: WEB_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error('next build failed (' + r.status + ')\n' + (r.stdout || '') + (r.stderr || ''));
  }
  return r.stdout || '';
}

/* ──────────────────────────────────────────────────────────────────────────
 * The CLI.
 * ────────────────────────────────────────────────────────────────────────── */

/* `--name value` AND `--name=value`. The second form is not a nicety: Git Bash
 * rewrites a bare argument that looks like a POSIX path, so `--only /privacy`
 * arrives as `--only C:/Program Files/Git/privacy` and silently selects nothing.
 * `--only=/privacy` is left alone. */
function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

async function main() {
  const log = (...a) => console.log(...a);
  const port = Number(arg('--port', PORT));
  const runs = Number(arg('--runs', '1'));
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error('--runs must be a positive integer, got ' + JSON.stringify(arg('--runs', '1'))
      + '. A NaN here would run zero sweeps and then report the last one.');
  }
  const only = arg('--only', null);
  const includeText = !flag('--no-text');
  // Outside the repo by default. This report is evidence for one session, not
  // an artefact the tree should carry, and a stray untracked JSON beside
  // package.json is how a working tree stops being readable.
  const out = arg('--out', path.join(os.tmpdir(), 'web-contrast.json'));

  // G0 BEFORE the build, not after it. A dev server owning .next makes the
  // build pointless, and spending two and a half minutes to find that out is
  // two and a half minutes of the wrong answer.
  const dev = devServerAgainstWeb();
  log('');
  log('── BUILD-ID INTERLOCK ─────────────────────────────────────');
  log('  G0 next dev     :', dev === null
    ? 'UNKNOWN (cannot enumerate processes on this platform)'
    : (dev.length ? dev.length + ' running' : 'none'));
  const allowDevServer = flag('--allow-dev-server');
  if (dev && dev.length) {
    await interlockBeforeStart({ devServers: dev, port, allowDevServer });
    log('  G0 OVERRIDDEN   : --allow-dev-server. G3/G4 still hold; a wipe now costs the run, not the truth.');
  }

  const idBefore = buildIdOnDisk();
  let built = false;
  if (flag('--build') || flag('--prove-interlock')) {
    runBuild(log);
    built = true;
  }

  log('  BUILD_ID before :', idBefore || '(none)');
  log('  BUILD_ID after  :', buildIdOnDisk() || '(none)');
  const pinnedId = await interlockBeforeStart({
    idBefore, built, port, devServers: dev, allowDevServer,
  });
  log('  G1 build moved  :', built ? 'yes (' + idBefore + ' -> ' + pinnedId + ')' : 'n/a (no build this run)');
  log('  G2 port ' + port + '    : free');
  log('  pinned to       :', pinnedId);

  let server = null;
  let chrome = null;
  const udd = path.join(os.tmpdir(), 'web-contrast-' + process.pid);
  try {
    server = startServer(port, log);
    await waitForServer(port, 60000);
    const base = 'http://127.0.0.1:' + port;
    log('  server          : up on ' + port + ' (pid ' + server.pid + ')');

    // ── §2 ENUMERATION ────────────────────────────────────────────────────
    const routeNames = prerenderedRoutes();
    const probes = [];
    for (const r of routeNames) probes.push(await probeRoute(base, r));
    log('');
    log('── PRERENDERED ROUTES (' + probes.length + ', from .next/prerender-manifest.json) ──');
    for (const p of probes) {
      log('  ' + p.route.padEnd(18) + String(p.status).padEnd(5) + p.type.padEnd(26)
        + (p.servedId ? 'build ' + p.servedId : 'no flight payload'));
    }

    const stale = probes.filter((p) => p.servedId && p.servedId !== pinnedId);
    if (stale.length) {
      throw new Refusal('G3', stale.map((s) => s.route + ' served by ' + s.servedId).join(', ')
        + ' while .next/BUILD_ID reads ' + pinnedId + '.');
    }

    if (flag('--prove-interlock')) {
      log('');
      log('── INTERLOCK DEMONSTRATION ────────────────────────────────');
      log('  rebuilding WITHOUT restarting the server …');
      runBuild(log);
      const nowOnDisk = buildIdOnDisk();
      log('  BUILD_ID on disk now :', nowOnDisk, '(was ' + pinnedId + ')');
      let after;
      try {
        after = await probeRouteRetrying(base, '/', 8);
      } catch (e) {
        // A server that DIES under a rebuild is a different outcome from one
        // that keeps serving a stale build, and it is a weaker guarantee: it
        // happens to be safe here, but nothing makes it reliable. Reported as
        // what it is rather than counted as the interlock working.
        log('  / could not be fetched: ' + (e.message || e));
        log('  server exit          : ' + JSON.stringify(server.died || null));
        log('  server transcript    :');
        log('    ' + String(server.transcript || '').trim().split('\n').join('\n    '));
        throw e;
      }
      log('  / still served by    :', after.servedId);
      log('  server alive         :', server.died ? 'NO — ' + JSON.stringify(server.died) : 'yes');
      try {
        interlockServed('/', after.servedId, nowOnDisk);
        log('  !! NO REFUSAL — the interlock did not fire. That is a defect in the');
        log('     interlock, not a clean bill of health.');
        process.exitCode = 1;
      } catch (e) {
        log('');
        log('  ' + e.message.split('\n').join('\n  '));
        log('');
        log('  Interlock fires. No signature emitted.');
      }
      return;
    }

    // ── §3 MATRIX ─────────────────────────────────────────────────────────
    chrome = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=' + DEVPORT, '--user-data-dir=' + udd,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      'about:blank',
    ], { stdio: 'ignore' });
    const cdp = new CDP(await openWs(await connectBrowser(DEVPORT)));

    // The language axis, asked of each page once.
    for (const p of probes) {
      p.langs = [];
      if (!p.html) continue;
      const probeCell = await sweepCellAffordances(cdp, base + p.route);
      p.langs = probeCell.langs;
      p.playback = probeCell.playback;
      p.conversations = probeCell.conversations;
    }

    log('');
    log('── LANGUAGE AXIS (from [data-lang-option] in the live DOM) ─');
    for (const p of probes) {
      if (!p.html) { log('  ' + p.route.padEnd(18) + 'not text/html — no authored CSS'); continue; }
      log('  ' + p.route.padEnd(18)
        + (p.langs.length ? p.langs.join(', ') : 'no selector — DEGENERATE, collapses to one pass')
        + (p.playback ? '   player: ' + p.playback : '')
        + (p.conversations ? '   conversations: ' + p.conversations : ''));
    }

    if (flag('--enumerate')) {
      const langBearing = probes.filter((p) => p.langs && p.langs.length);
      log('');
      log('  matrix: ' + langBearing.length + ' route(s) x ' + WEB_BASELINE.languages.length
        + ' language(s) x ' + MODE_NAMES.length + ' media state(s)'
        + ' + ' + (probes.length - langBearing.length) + ' degenerate route(s) x '
        + MODE_NAMES.length + ' = '
        + (langBearing.length * WEB_BASELINE.languages.length * MODE_NAMES.length
           + (probes.length - langBearing.length) * MODE_NAMES.length) + ' cells');
      return;
    }

    // `--only` names routes, and a route name starts with `/` — which Git Bash
    // rewrites into a Windows path before node ever sees it (`--only=/privacy`
    // arrives as `--only=E:/Git/privacy`, and `MSYS_NO_PATHCONV=1` is the only
    // way to stop it at the shell). Normalising to the LAST segment makes the
    // flag mean the same thing from either shell: `/privacy`, `privacy` and the
    // mangled form all select the same route, and `/` survives as `/`.
    const wanted = only
      ? only.split(',').map((s) => {
        const seg = s.trim().split('/').filter(Boolean).pop();
        return seg ? '/' + seg : '/';
      })
      : null;
    const selected = wanted ? probes.filter((p) => wanted.includes(p.route)) : probes;
    if (wanted && !selected.length) {
      throw new Error('--only matched no route. Asked for ' + JSON.stringify(wanted)
        + '; the site has ' + probes.map((p) => p.route).join(', '));
    }

    const results = [];
    for (let n = 1; n <= runs; n++) {
      log('');
      log('── RUN ' + n + ' of ' + runs + ' ────────────────────────────────────────────');
      const res = await runMatrix(cdp, {
        base, routes: selected, pinnedId, includeText, log,
      });
      results.push(res);
      log('');
      log('  cells                 : ' + res.cells.length);
      log('  glyph rows            : ' + res.rows
        + '  (' + res.bucket.recededRows + ' in receded turns, '
        + res.bucket.contentRows + ' body copy / controls / nav)');
      log('  worst receded ratio   : '
        + (res.bucket.worstReceded
          ? res.bucket.worstReceded.ratio + ':1 (floor ' + res.bucket.worstReceded.floor + ')  '
            + res.bucket.worstReceded.color + '  "' + (res.bucket.worstReceded.text || '') + '"'
          : 'NO RECEDED ROWS MEASURED — the receded bucket is empty, not clean'));
      log('  worst content ratio   : '
        + (res.bucket.worstContent
          ? res.bucket.worstContent.ratio + ':1 (floor ' + res.bucket.worstContent.floor + ')  '
            + res.bucket.worstContent.color + '  "' + (res.bucket.worstContent.text || '') + '"'
            + (res.bucket.worstContent.certified ? '' : '  [UNCERTIFIED — background-image behind it]')
          : 'none measured'));
      log('  unique colour/backdrop: ' + res.pairs);
      log('  threshold failures    : ' + res.failures.length
        + '  (' + res.receded.length + ' receded-turn, ' + res.content.length + ' content)');
      log('  D-016 contract        : ' + res.contract.length);
      log('  undeterminable        : ' + res.undeterminable.length);
      log('  focus indicators      : ' + res.rings.length + ' measured, '
        + res.ringFailures.length + ' below 3:1');
      log('  SIGNATURE             : ' + res.signature.md5);
    }

    // G4, last.
    const idAfter = buildIdOnDisk();
    if (idAfter !== pinnedId) {
      throw new Refusal('G4', 'BUILD_ID moved during the run: ' + pinnedId + ' -> ' + idAfter);
    }

    const md5s = results.map((r) => r.signature.md5);
    log('');
    log('── DETERMINISM ────────────────────────────────────────────');
    results.forEach((r, i) => {
      log('  run ' + (i + 1) + '  ' + r.signature.md5
        + '  rows ' + String(r.rows).padStart(5)
        + '  pairs ' + String(r.pairs).padStart(3)
        + '  fail ' + String(r.failures.length).padStart(4)
        + '  rings ' + String(r.rings.length).padStart(4));
    });
    log('  ' + (new Set(md5s).size === 1
      ? 'IDENTICAL across ' + runs + ' run(s).'
      : 'DIVERGED — ' + new Set(md5s).size + ' distinct signatures.'));

    const last = results[results.length - 1];
    fs.writeFileSync(out, JSON.stringify({
      at: new Date().toISOString(),
      buildId: pinnedId,
      viewport: VIEWPORT,
      runs: md5s,
      cells: last.cells,
      bucket: last.bucket,
      rows: last.rows,
      pairs: last.pairs,
      failures: last.failures,
      receded: last.receded,
      content: last.content,
      contract: last.contract,
      undeterminable: last.undeterminable,
      rings: last.rings,
      signature: last.signature.lines,
      signatureMd5: last.signature.md5,
    }, null, 2));
    log('');
    log('report →', out);
  } finally {
    if (chrome) { try { chrome.kill(); } catch (_) { /* gone */ } reap(chrome, log); }
    reap(server, log);
    await sleep(600);
    const leftover = await portAnswers(port);
    if (leftover.up) {
      console.error('WARNING: port ' + port + ' is still answering after the reap — '
        + 'an orphan survived. G2 will refuse the next run until it is killed.');
    }
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

/** A cheap one-page visit that only asks what the page offers. Used to build
 *  the language axis before the matrix runs, so a route with no selector is
 *  never swept three times over an axis it does not have. */
async function sweepCellAffordances(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    const loaded = new Promise((res) => {
      cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
    });
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    await sleep(900);
    return (await evalIn(cdp, sessionId, AFFORDANCES_SOURCE)) || { langs: [] };
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Re-export. Named explicitly — a spread would let the surface drift silently,
 * and a missing TEXT_SWEEP_SOURCE reaches CDP as the string "undefined" and
 * comes back as an in-page error forty seconds into a sweep.
 * ────────────────────────────────────────────────────────────────────────── */

const RE_EXPORTED = [
  'parseColor', 'compositeOver', 'relativeLuminance', 'contrastRatio',
  'isLargeText', 'parseBoxShadow',
  'judge', 'judgeRing', 'uniquePairs', 'signature',
  'buildSource', 'sweepPage', 'blurActive', 'tagFocusables', 'readFocusRing',
  'TEXT_SWEEP_SOURCE', 'BLUR_SOURCE', 'TAG_FOCUSABLES_SOURCE', 'READ_RING_SOURCE',
  'INK_FAINT', 'AA_BODY', 'AA_LARGE', 'AA_NON_TEXT',
];

const surface = {};
for (const name of RE_EXPORTED) {
  if (core[name] === undefined) {
    throw new Error('contrast core no longer exports ' + name
      + ' — tests/design/contrast/web.js imports it by that name');
  }
  surface[name] = core[name];
}

module.exports = Object.assign(surface, {
  core,
  WEB_BASELINE,
  WEB_DIR,
  BUILD_ID_FILE,
  PRERENDER_MANIFEST,
  MODES,
  MODE_NAMES,
  VIEWPORT,
  RECEDED_RE,
  classify,
  partition,
  hashLines,
  buildIdOnDisk,
  servedBuildIdFrom,
  SERVED_ID_RE,
  prerenderedRoutes,
  parseDevServers,
  PROC_SEP,
  interlockServed,
  interlockBeforeStart,
  Refusal,
});

if (require.main === module) {
  main().catch((e) => {
    console.error('');
    console.error(e.refusal ? e.message : (e.stack || String(e)));
    console.error('');
    console.error('No signature emitted.');
    process.exit(1);
  });
}
