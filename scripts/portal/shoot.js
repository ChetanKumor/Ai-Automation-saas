'use strict';

/* ============================================================================
 * PORTAL-P1 screenshot evidence — dev tooling, not shipped runtime.
 *
 * S2 shots against a REAL, freshly-validated tenant:
 *   login (desktop + 380px)  ·  home/readiness (desktop + 380px)
 * S3 additions:
 *   • home shot doubles as the disabled Go-live + "N items need your attention"
 *     evidence (the seeded tenant has failing checks → blockers > 0);
 *   • an ADMIN "create owner account" shot driven through the real admin panel:
 *     type an email → click Create → the one-time temp password panel appears.
 *
 * It stands up a THROWAWAY scratch DB (genesis) so it never touches neondb,
 * seeds a tenant + owner + a real tenant_config, then runs the REAL
 * validationService.validateTenant — only the two network-bound checks
 * (kb.retrieval embedding, whatsapp.live Meta ping) are stubbed via opts.deps,
 * and turn.scripted is skipped (it would spend a live model turn). Everything the
 * ring shows is a genuine validation verdict.
 *
 * Rendering: the real /portal router + express.static('public'), driven over the
 * Chrome DevTools Protocol (Node global WebSocket — no new dependency). Mobile
 * uses Emulation.setDeviceMetricsOverride (a TRUE 380px layout viewport — the
 * correct fix for the DEMO-01 "headless --window-size ignores mobile" lesson),
 * and Chrome runs with reduced-motion so the ring/pulse settle deterministically.
 *
 * Usage:  node scripts/portal/shoot.js
 * Output: scripts/portal/shots/*.png
 * ========================================================================== */

require('dotenv').config();

// ── Offline Gemini SDK (PORTAL-P6-S18) ───────────────────────────────────────
// S18 drives the REAL go-live flow through the UI, and that path cannot skip a
// check (INV-3) — so `kb.retrieval` genuinely embeds its probe query, and the
// seeded FAQs genuinely embed on write. Stub the SDK in the module cache before
// anything requires it, so the whole script stays offline and free. This also
// removes the live embedding calls the FAQ seeding below has been making since
// S11. The per-shot aiService/knowledgeService stubs further down are unchanged
// and still do their own (narrower) job.
const GENAI_PATH = require.resolve('@google/generative-ai');
require(GENAI_PATH);
const STUB_VEC = Array(768).fill(0);
STUB_VEC[0] = 1; // unit vector — cosine distance to an identical stored vector is 0
require.cache[GENAI_PATH].exports = {
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        embedContent: async () => ({ embedding: { values: STUB_VEC } }),
        startChat: () => ({
          sendMessage: async () => ({
            response: { functionCalls: () => undefined, text: () => 'ok' },
          }),
        }),
      };
    }
  },
};

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { Client } = require('pg');

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) { console.error('DATABASE_URL required'); process.exit(1); }
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const OUT = path.join(__dirname, 'shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVPORT = 9333;

// S2: `node scripts/portal/shoot.js --contrast` measures instead of capturing.
// Same scratch DB, same seeded tenant, same session cookie — the instrument
// is worth nothing against a page that is not the page an owner sees.
const CONTRAST = process.argv.includes('--contrast');
const CONTRAST_OUT = (function () {
  const i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(OUT, 'contrast.json');
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }

/* ── The deadline on every CDP call (S3f, generalised S3g) ───────────────────
 *
 * `CDP.send` below resolves on a matching response id and NOTHING ELSE. A
 * response Chrome never sends therefore hung the run forever, with node idle
 * and a renderer spinning — observed live at 8294f8f: a run wedged on
 * s8-doctors-desktop for 33 minutes, node at 2.5s of CPU and flat while two
 * Chrome renderers held ~30% each, `/json/list` still answering and still
 * holding doctors.html open.
 *
 * S3f paid that debt for ONE call, `Page.captureScreenshot`, because
 * captureStable had just multiplied the exposure on it. That was the narrow
 * fix, and the comment there said so in as many words: "every call in this file
 * has it". It still did. This session moves the ceiling into `send` itself, so
 * the file has no unprotected CDP call left — a run that has lost its browser
 * now FAILS, with the method named, and the `finally` at the bottom drops the
 * scratch DB, which a hang never does.
 *
 * 90s is a CEILING, not a wait, and nothing waits on it in a healthy run: the
 * largest shot in the corpus is 2560x7202 device px and returns in low
 * single-digit seconds even on a loaded machine, and every other call in the
 * file answers in milliseconds. A frame that has not arrived in ninety seconds
 * is not slow, it is gone.
 *
 * ONE RETRY, AND ONLY FOR THE CALLS THAT CAN SURVIVE ONE. A wedged renderer
 * sometimes only ate one frame, which is why the retry exists — but a blanket
 * retry is a defect, not robustness: a `Runtime.evaluate` that clicked Save and
 * then timed out may well have clicked it, and re-issuing would click twice.
 * Nothing in the protocol tells the caller which half of that happened, so an
 * allowlist is the only honest answer. It holds pure reads and idempotent
 * setters and nothing else; `Runtime.evaluate`, `Page.navigate`,
 * `Target.createTarget` and `Page.addScriptToEvaluateOnNewDocument` are all
 * deliberately absent, and a method not named here fails on the first timeout.
 *
 * The timed-out entry is dropped from `pending` so a late reply is ignored
 * rather than resolving a promise nobody is holding any more. */
const CDP_DEADLINE_MS = 90000;

const CDP_RETRY_SAFE = new Set([
  'Page.captureScreenshot',             // pure read
  'Page.getLayoutMetrics',              // pure read
  'Target.getTargets',                  // pure read
  'Page.enable',                        // idempotent
  'Network.enable',                     // idempotent
  'Runtime.enable',                     // idempotent
  'Emulation.setDeviceMetricsOverride', // idempotent setter, same params
  'Network.setCookie',                  // idempotent setter, same name/value/url
]);

function withDeadline(promise, ms, what, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      rej(new Error(`CDP ${what} did not answer in ${ms / 1000}s`));
    }, ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ── Minimal CDP client over the browser WebSocket ────────────────────────────
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
  // The raw call: one id, one promise, no ceiling. Never call this directly —
  // `send` below is the guarded entry point, and it is what the whole file uses.
  raw(method, params, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    return { id, promise };
  }
  async send(method, params = {}, sessionId) {
    const attempt = () => {
      const { id, promise } = this.raw(method, params, sessionId);
      return withDeadline(promise, CDP_DEADLINE_MS, method, () => this.pending.delete(id));
    };
    try {
      return await attempt();
    } catch (e) {
      if (!CDP_RETRY_SAFE.has(method)) throw e;
      console.log('  ⚠', e.message, '- one retry');
      return attempt();
    }
  }
  on(fn) { this.listeners.push(fn); }
}

// 50 tries at 200ms is TEN SECONDS for Chrome to publish its DevTools endpoint,
// and ten seconds is a bet on this process being the only thing on the machine.
// It is not: `npm test` runs test FILES concurrently, so `portalLive.test.js`
// spawns this script while `webContrast.test.js` is driving a Chrome of its own,
// and one S3d `os:check` died here — the whole 20-page sweep lost, and the suite
// red, because a browser took longer than ten seconds to start under that load.
//
// 150 tries is thirty seconds, and it weakens nothing: an endpoint that answers
// at 900ms is still used at 900ms. This is a deadline, not a sleep — the same
// argument, and the same arithmetic, as `waitForSelector`'s ceiling above.
async function connectBrowser() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEVPORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
  });
}

// The ceiling was 60 tries — 9 seconds — and 9 seconds is a bet on the database
// being nearby. It is not: DATABASE_URL points at Neon in ap-southeast-1, and
// every gate below is waiting on a page that is waiting on a query that crosses
// the internet. Three consecutive runs died here inside one hour on gates that
// resolve in well under a second when the link is quiet — `.ring||.emp`,
// `profileReady` — losing a whole 54-shot run to a slow round trip rather than
// to anything about the portal.
//
// 200 tries is 30 seconds. It does NOT weaken a gate: a condition that becomes
// true at 400ms is still observed at 400ms, and this is a deadline, not a sleep.
// All it changes is how long the harness waits before declaring that a page
// never got there — and the message it prints when it does is unchanged.
async function waitForSelector(cdp, sid, expr, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: `!!(${expr})`, returnByValue: true }, sid);
    if (r.result && r.result.value) return;
    await sleep(150);
  }
  throw new Error('selector never appeared: ' + expr);
}

/* ── The settle every capture was missing (S3b-pre) ───────────────────────────
 *
 * Every `waitFor` in the capture block below is a PAGE gate: it fires when that
 * page's own script has painted that page's own data. TWO more renders land
 * after it, on fetches no page gate knows about, and until this session nothing
 * in `shoot()` waited for either — so all 54 captures raced them and a byte
 * size could not tell a regression from a run. Two identical runs at fd14d99
 * moved 23 of the 54.
 *
 *   • THE SHELL'S READINESS FETCH. `renderHeaderLifecycle` (shell.js:672) and
 *     `renderShadowNotice` (shell.js:739) both await one memoised promise, and
 *     between them they paint the header Go-live control and the full-width
 *     truth strip.
 *   • THE VERBATIM PANEL'S OWN FETCH, on the nine pages that host it
 *     (booking-rules, clinic-profile, doctors, faqs, hours, pricing,
 *     receptionist, safety, test). It paints the greeting and the fact rows into
 *     #vpLive on a ground no page gate observes.
 *
 * Neither shows up as a height change, which is exactly why this survived: all
 * 54 captures reported the SAME pixel dimensions on every run of this session,
 * before the repair and after it. Both renders land inside chrome that already
 * has its space reserved, so what moves is the picture, not the shape, and the
 * only thing that noticed was the byte size. s4-profile-desktop swung 126691
 * bytes between two identical runs at a constant 1280x1628, and s9-booking-error
 * 20119 at a constant 1280x1757. The two gates below stopped both dead: neither
 * has differed between two runs of a fixed tree since they were added.
 *
 * s9-booking-error is worth one more line, because the brief that commissioned
 * this repair blamed the truth strip for it and the strip cannot be the answer.
 * The strip is in NORMAL FLOW — `#truthStrip` sits at y=56 and is 40.94px tall,
 * and `.content` starts at 96.94 — so a shot that caught it late would be 41px
 * shorter, and every capture of that page measured 1280x1757. What settles it is
 * the other half of settleShell(): booking-rules.html hosts the Verbatim panel,
 * the panel is fixed-width chrome, and it is the only unsettled render on that
 * page that can move the picture without moving the page.
 *
 * Both expressions are S2's, reused rather than rewritten: `sweepOnePage()` has
 * awaited READINESS_SETTLED since the contrast instrument was built, and
 * VERBATIM_PAINTED is the second clause of its LOADED gate, lifted out so the
 * measuring path and the capture path settle on ONE definition of each. Two
 * copies of a gate is how a gate drifts.
 *
 * Two things worth writing down about the Verbatim clause:
 *   – `#verbatim` is INJECTED by verbatim.js, not static markup, so "no panel ⇒
 *     nothing to wait for" would be a lie if it were evaluated early. It is not:
 *     verbatim.js appends the panel synchronously in its module body
 *     (verbatim.js:453-502) and only then kicks off main(), and `shoot()` does
 *     not reach here until Page.loadEventFired. On a hosting page the element is
 *     therefore already present, and the branch is reached only by a page that
 *     genuinely has no panel.
 *   – #vpLive is filled by render(), which runs on success AND on failure
 *     (main() only bails on a 401, where the shell has already redirected). So
 *     the gate cannot hang on a fresh tenant with an empty config — which is
 *     what s11-faqs-empty and s14-test-limited shoot.
 *
 * HOME is the one asymmetry, and it is worth naming rather than hiding. shell.js
 * returns early at BOTH readinessOnce() call sites when activeId === 'home', so
 * awaiting it here starts a round trip Home would not otherwise make. It is
 * harmless — GET /portal/api/readiness is read-only and NEVER triggers a
 * validation run (routes.js:186-196), so it cannot disturb the S18 lifecycle
 * sequence, which depends on exactly which runs got persisted. And it is not the
 * load-bearing gate there: home.js renders through one function that dispatches
 * `portal:readiness` BEFORE it paints (home.js:898, then :900-901), and the
 * shell applies the strip synchronously in that listener — so Home's own gates
 * (`.ring||.emp`, `#checks .check`) already imply a settled strip, strictly
 * more than readinessOnce does. It is kept because a settle that is identical on
 * every page is a settle nobody has to re-derive per page.
 * ────────────────────────────────────────────────────────────────────────── */
const READINESS_SETTLED = '(window.Portal && window.Portal.readinessOnce)'
  + ' ? window.Portal.readinessOnce().then(function(){ return true; }, function(){ return true; })'
  + ' : true';

const VERBATIM_PAINTED = "(function(){"
  + "var vp=document.getElementById('verbatim');"
  + "if(!vp || getComputedStyle(vp).display==='none' || !vp.getClientRects().length) return true;"
  + "return !!vp.querySelector('#vpLive *');"
  + "})()";

async function settleShell(cdp, sid) {
  await cdp.send('Runtime.evaluate',
    { expression: READINESS_SETTLED, returnByValue: true, awaitPromise: true }, sid);
  await waitForSelector(cdp, sid, VERBATIM_PAINTED);
}

/* The OTHER thing that moved byte sizes, and the one no gate can settle: the
 * blinking text caret.
 *
 * login.html:67 carries `autofocus`, so the email field owns the caret from
 * first paint and it blinks on a ~750ms cycle for as long as the page is open.
 * Ten captures of that page 250ms apart produce exactly TWO hashes —
 * 63833 bytes with the caret drawn, 63816 without — and those are precisely the
 * two sizes login-desktop.png read on the two baseline runs. Every error shot
 * below inherits the same problem: a failed save focuses the first invalid
 * `.input` (pricing.js:119 and the same shape in every sibling page script),
 * which is the state those shots exist to document.
 *
 * A gate cannot fix this, because there is no moment to wait for — the page is
 * never at rest. Suppressing the caret is the only deterministic answer, and it
 * costs the evidence nothing: `caret-color` paints a 1px insertion bar and
 * nothing else, so the focus RING, the field's error state and every glyph are
 * untouched. The suppressed capture is byte-identical to the caret-off frame the
 * page already spends half its time in. Same category as
 * `--force-prefers-reduced-motion` on the Chrome command line above: a
 * capture-time normalisation owned by the instrument, not a change to the
 * product — which is why it is injected from here and not written into
 * tokens.css. */
const CARET_OFF = "(function(){"
  + "if(document.getElementById('shootCaretOff')) return;"
  + "var s=document.createElement('style'); s.id='shootCaretOff';"
  + "s.textContent='*{caret-color:transparent!important}';"
  + "document.head.appendChild(s);"
  + "})()";

/* And the third one, the least obvious of the four this session found: a
 * full-page capture is taken at whatever SCROLL OFFSET the interaction left the
 * page at, and `.side` is `position: fixed; inset: 0 auto 0 0` (tokens.css:276).
 *
 * A fixed element is painted ONCE under captureBeyondViewport, at the current
 * scroll offset — so the sidebar lands as a viewport-tall block starting at
 * `scrollY`, and two runs that stop the scroll a few pixels apart put that block
 * in two different places. On s10-safety-error the failing save calls
 * `firstEl.scrollIntoView({block:'center', behavior:'smooth'})` (pricing.js:120
 * and its siblings) and the capture caught it at two different offsets: the diff
 * mask is a solid rectangle exactly one viewport tall over the sidebar, every
 * text line in the content column re-rasterised at a different sub-pixel phase
 * (deviceScaleFactor 2 — half a CSS pixel is a whole device pixel), and the
 * sticky preview panel on the right IDENTICAL. 19496 bytes, alternating between
 * exactly two values across runs.
 *
 * Scroll position is not evidence in a whole-page shot: every pixel of the
 * document is captured either way, and the only thing the offset decides is
 * where the fixed chrome gets stamped. Pinning it to 0 is what the forty-odd
 * shots that never scroll already do, so this makes the scrolling ones agree
 * with them rather than inventing a new convention. It is written as a GATE, not
 * an assignment: the expression re-issues the scroll on every poll and only
 * reports true once the page reads back 0, which is also what defeats a smooth
 * scroll still in flight — a single scrollTo() would be read back mid-animation,
 * which looks exactly like a layout shift. */
/* ── The fourth capture-time normalisation: THE CLOCK (S3g) ──────────────────
 *
 * `captureBeyondViewport`'s raster race is closed (captureStable, :670). What
 * is left moving between two identical runs is the run's own clock, and S3f
 * named the twelve shots it moves. This is the shim for the half of that a
 * page-side freeze can actually reach — and the half it CANNOT is stated
 * below, because the distinction is the whole finding of this session.
 *
 * WHAT THE PAGE READS FROM ITS OWN CLOCK, exhaustively, at this commit:
 *   home.js:93-103    fmtAge  — `Date.now() - new Date(run.created_at)`
 *   hours.js:40-45    todayStr / isPast — de-emphasises a holiday whose date
 *                     is before today, `.holiday-row--past`
 *   verbatim.js:315   todayHours — `DAY_KEYS[new Date().getDay()]`, the panel's
 *                     "today" row
 * There is no `performance.now()` anywhere under public/; it is frozen anyway,
 * because a shim that covers a clock it did not enumerate is worth more than
 * one that has to be re-audited the next time a page starts measuring.
 *
 * WHAT THE PAGE READS FROM THE DATABASE, which this shim does NOT touch:
 *   home.js:78-86     fmtDate(run.created_at)      validation_runs.created_at
 *   history.js:30-33  formatWhen(r.created_at)     tenant_config_revisions
 *                                                  .created_at
 * Both columns are `TIMESTAMPTZ NOT NULL DEFAULT NOW()` (schema.sql), and NOW()
 * is the POSTGRES server's clock, resolved in the scratch DB at INSERT time by
 * the real services this script drives. Freezing `Date` in the renderer cannot
 * reach it: `new Date(iso)` must keep parsing an ISO string faithfully or every
 * date on every page becomes a lie. See the S3g note on the thirteen at :814.
 *
 * THE EPOCH IS NOT ARBITRARY. 2026-09-01T12:00:00Z is chosen so that freezing
 * changes NOTHING about what the corpus shows today:
 *   • Tuesday noon UTC is Tuesday in every zone from UTC-11 to UTC+12, so
 *     `todayHours()` names the same weekday this corpus was last shot on
 *     regardless of the machine's timezone — no Emulation.setTimezoneOverride
 *     needed, and none added.
 *   • It is after BOTH seeded holidays (2026-08-15 and 2026-01-26, :1605-1608
 *     — the comment there still says "one past and one upcoming" and both are
 *     now past), so every `.holiday-row--past` stays past. A date before
 *     2026-08-15 would flip one row's colour and could move the contrast
 *     signature, which is why the epoch is pinned rather than computed.
 *   • It is in the PAST relative to the rows the run writes, so fmtAge's
 *     `mins` goes negative and lands on `mins < 1` -> "just now" — which is
 *     what it already prints on a run-fresh row, now deterministically rather
 *     than by arithmetic that happens to round the same way.
 *
 * `new Date(...)` with arguments, `Date.parse`, `Date.UTC` and every prototype
 * method are the originals; only the ZERO-ARGUMENT reading of the wall clock is
 * replaced. It is installed with Page.addScriptToEvaluateOnNewDocument so it
 * runs BEFORE the page's own scripts — a Runtime.evaluate after load would be
 * too late for anything a module reads at parse time — and it is idempotent, so
 * a second install (or a retried CDP call) cannot double-wrap. */
const CLOCK_FROZEN_MS = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z, a Tuesday

const CLOCK_SHIM = "(function(){"
  + "if(window.__shootClockFrozen) return; window.__shootClockFrozen=true;"
  + "var T=" + CLOCK_FROZEN_MS + ", D=Date;"
  + "function S(){"
  + "  if(!(this instanceof S)) return new D(T).toString();"
  + "  return arguments.length===0 ? new D(T) : Reflect.construct(D, arguments);"
  + "}"
  + "S.prototype=D.prototype; S.now=function(){return T;};"
  + "S.parse=D.parse; S.UTC=D.UTC;"
  + "try{Object.defineProperty(S,'name',{value:'Date'});}catch(e){}"
  + "window.Date=S;"
  + "try{"
  + "  var P=window.performance;"
  + "  if(P){ P.now=function(){return 0;};"
  + "    try{Object.defineProperty(P,'timeOrigin',{get:function(){return T;}});}catch(e){} }"
  + "}catch(e){}"
  + "})()";

/* ── The quarantine: what a byte comparison of two runs must not judge ───────
 *
 * Five sessions have now compared two runs of this corpus by md5 and then spent
 * their time re-deriving which of the differences were the instrument and which
 * were the portal. This is that answer, written down once, printed at the end
 * of every run, and greppable — `node scripts/portal/shoot.js | sed -n
 * '/^quarantine/,$p'`.
 *
 * It is a REGISTRY, not a gate. Nothing here suppresses a shot or edits a
 * picture: the corpus is still 59 files and every one of them is whatever the
 * page painted. All it does is name, with the mechanism, the shots a byte
 * comparison cannot hold against the portal — so the next session compares 46
 * shots and reads a real result, instead of comparing 59 and reading noise.
 *
 * Measured over FIVE consecutive pairs, ten full runs, at this commit. Counts:
 * 12 / 13 / 12 / 12 / 12 shots moved of 59. Every single one is accounted for
 * below. ZERO unexplained movers in five pairs — which is the number that
 * matters, because captureStable (S3f) is what made it zero and this registry
 * is what makes it legible.
 *
 * `clock` and `entropy` are the thirteen content movers; the full derivation,
 * including why the frozen clock settles none of them, is in `shoot()` below.
 *
 * `displacement` is the OTHER artefact, and the brief that commissioned this
 * registry ruled it explicitly out of scope: a ±16-device-px column shift
 * decided ONCE PER PAGE LOAD, so both of captureStable's frames carry it and
 * that gate cannot see it. Its signature is unmistakable and is how every entry
 * below was classified rather than guessed: best vertical correlation at
 * exactly ±16 device px, the sidebar unshifted, the Verbatim panel identical —
 * the opposite of the panel artefact S3f closed.
 *
 * ONE NEW OBSERVATION, recorded because it is a lead and not chased because it
 * is out of scope: EVERY displacement ever observed has been on an `*-error`
 * shot. SIX of the eight error shots in the corpus across nine pairs
 * (s4-profile, s6-pricing, s8-doctors, s9-booking, s10-safety, s13-receptionist
 * — the last of which was predicted BY this class note and then turned up in
 * the red/green pair that tested it), and NEVER once on any of the 51
 * non-error shots. That is why the list is the observed set and the note says
 * to quarantine the class: the two not yet seen (s5-hours-error,
 * s11-faqs-error) are almost certainly not exempt, only unobserved. The error shots are exactly the ones whose
 * afterReady drives a failing save, and a failing save calls
 * `scrollIntoView({block:'center', behavior:'smooth'})` (pricing.js:120 and the
 * same shape in every sibling). SCROLL_HOME below re-issues the scroll until
 * the page reads back 0, so the offset at capture time is 0 either way — but a
 * smooth scroll that was still in flight when the layout was decided is the
 * obvious next place to look. The list is therefore the OBSERVED set and the
 * class is "any `*-error` shot", which is what the printout says.
 *
 * The 16-of-42 LCD-subpixel-to-grayscale AA flip S3f recorded is NOT here: it
 * flipped once and stayed flipped, so it is a state, not a coin, and it has not
 * moved in any of the ten runs behind this registry. */
const QUARANTINE = {
  clock: {
    why: 'a timestamp the run itself wrote — Postgres NOW(), unreachable from the page',
    shots: [
      'home-desktop', 'home-mobile',
      's17-history-desktop', 's17-history-mobile', 's17-history-detail',
      's17-history-restore-confirm',
      's18-live', 's18-paused', 's18-paused-mobile',
      's18-golive-blocked-after-mobile',
    ],
  },
  entropy: {
    why: 'a server-side value that is not a date at all — crypto, or a measured duration',
    shots: ['s3-admin-create-owner', 's14-test-reply', 's3d-test-no-config'],
  },
  displacement: {
    why: '±16 device-px column shift decided per page load — OUT OF SCOPE, see above',
    shots: [
      's4-profile-error', 's6-pricing-error', 's8-doctors-error',
      's9-booking-error', 's10-safety-error', 's13-receptionist-error',
    ],
    classNote: 'observed set — 6 of the 8 *-error shots; treat the whole class as quarantined',
  },
};

function printQuarantine() {
  const n = Object.values(QUARANTINE).reduce((a, g) => a + g.shots.length, 0);
  console.log(`quarantine — ${n} of 59 shots a byte comparison must not judge:`);
  for (const [name, g] of Object.entries(QUARANTINE)) {
    console.log(`  ${name} (${g.shots.length}) — ${g.why}`);
    console.log(`    ${g.shots.join(' ')}`);
    if (g.classNote) console.log(`    note: ${g.classNote}`);
  }
  console.log(`  the other ${59 - n} shots are expected byte-identical between two runs.`);
}

const SCROLL_HOME = "(function(){"
  + "var e=document.scrollingElement||document.documentElement;"
  + "if(window.scrollY!==0||e.scrollTop!==0){"
  + "  try{ window.scrollTo({top:0,left:0,behavior:'instant'}); }catch(_){ window.scrollTo(0,0); }"
  + "  return false;"
  + "}"
  + "return true;"
  + "})()";

/* ── captureStable — the frame the panel is actually in (S3f) ───────────
 *
 * The flake S3e recorded and could not close: 2–7 shots per run moved on a
 * bounded box that was always the Verbatim panel and nothing else. Re-measured
 * here over six consecutive runs of all 59 shots — 13 / 13 / 15 / 17 / 18
 * movers, eleven of which are the content movers named below, leaving
 * 2 / 2 / 4 / 6 / 7 flips.
 *
 * S3e called it "captured MID-PAINT" and blamed VERBATIM_PAINTED (:308) for
 * gating the fetch rather than the frame. That is the wrong layer, and the
 * pixels say so. Decoded at 2x, run D against run E of s6-pricing-desktop:
 *
 *   device x 1878–2096, y 136–351   run E paints rgb(12,20,32) — the panel's
 *                                    ink ground, --field — where run D paints
 *                                    the greeting bubble, rgb(20,28,42), and
 *                                    its glyphs
 *   device x 2097 → 2560            byte-identical in both, glyphs included
 *
 * THE DISCRIMINATING OBSERVATION IS THAT SECOND LINE. The Telugu of the SAME
 * greeting, on the SAME text line, is correctly shaped and pixel-identical on
 * the far side of x=2097 in the run that is missing its near side. A font that
 * had not arrived cannot draw the right half of a word; an unresolved fetch
 * cannot fill half a bubble. So the two candidates the brief named are both
 * dead:
 *
 *   • NOT the S2 fetch race (#loadCard.hidden before the Verbatim fetch).
 *     `#vpLive` is populated — VERBATIM_PAINTED already requires it — and its
 *     content is present and correct outside the missing rectangle.
 *   • NOT a font swap. Worth stating with a number, because it is a real
 *     window and the next session should not have to re-derive it: every face
 *     in public/portal/fonts is `font-display: swap` behind a `unicode-range`,
 *     nothing preloads the Telugu one, and the panel's Telugu greeting is the
 *     only Telugu on hours/pricing/safety/doctors/test — so the 124KB
 *     noto-telugu-600.woff2 request STARTS at `liveEl.innerHTML = html`
 *     (verbatim.js:794), which is the exact event VERBATIM_PAINTED fires on.
 *     Measured standalone against the real fonts.css, injecting the seeded
 *     greeting: status `loaded` and check() FALSE before the inject (the face
 *     has never been asked for), `loading` at +0/+30/+60ms, loaded and true by
 *     +120ms. The window is real and it is ~120ms, which the 1300ms settle
 *     above already covers by a factor of ten. It is not this.
 *
 * What it IS: the panel's own COMPOSITING LAYER read before it was rastered.
 * `.vp` is out of flow at every width — `position: sticky; height: 100vh` when
 * docked (verbatim.css:48-66), `position: fixed; inset: auto 0 0 0` as the
 * bottom sheet below 1024 (:667) — so it owns a layer, and
 * `captureBeyondViewport` expands the viewport under it and reads whatever
 * raster exists. Both presentations are the same fault:
 *
 *   desktop  one 256-device-px tile COLUMN missing. The boundary at x=2097 is
 *            the panel's layer origin (x=920 CSS = 1840 device) plus exactly
 *            one 256px tile.
 *   mobile   the WHOLE layer missing. In s14-test-mobile the sheet is not
 *            displaced, it is absent: run D paints the page's own white
 *            textarea through CSS y 776–820 where runs E and F paint the ink
 *            sheet and its greeting.
 *
 * No pre-capture gate can close this, which is why the 1300ms settle never
 * did: the invalidation happens INSIDE Page.captureScreenshot, after every
 * gate has passed. The true root fix is to stop asking the flag to re-lay-out
 * a viewport-sized out-of-flow box at all — size the emulated viewport to the
 * content and drop `captureBeyondViewport` — and that is measured out of
 * scope: `.side` and `.vp` paint EXACTLY one viewport tall today (checked at
 * 1180/1220 CSS on s6-pricing-desktop and s8-doctors-desktop) and would then
 * paint the full page, changing what ~30 shots show. The comment on `beyond`
 * below has said so since S3b and it is still true.
 *
 * So the settle is taken in the only currency the capture path has: THE FRAME
 * ITSELF. Capture, capture again, and accept the picture only once two
 * consecutive frames agree byte for byte. That is the same shape as
 * RING_SETTLED (:1216) — await the thing that completes, do not sleep and hope
 * — with the completion observed directly instead of inferred, because a
 * raster is not something the page can be asked about. The first capture is
 * what forces the expanded-viewport raster; the second reads it warm.
 *
 * It is NOT a retry-until-it-looks-right loop: it never inspects the picture,
 * only whether the compositor has stopped changing its mind. A page that is
 * genuinely never at rest (a caret, a live animation) would exhaust the budget
 * and THROW rather than write an arbitrary frame — CARET_OFF (:342) and
 * --force-prefers-reduced-motion are what make that a real invariant rather
 * than an aspiration. The twelve content movers do not trip it: they differ
 * BETWEEN runs, not between two frames milliseconds apart, because nothing
 * re-renders them once painted.
 *
 * WHERE IT LANDS, ten runs of all 59 shots. Six BEFORE (13 / 13 / 15 / 17 / 18
 * movers over five pairs) and ten after, of which the last six are the ones to
 * read — the first four are contaminated by two artefacts named below.
 *
 *   before   ten non-content shots ever moved. Nine were decoded; EIGHT are
 *            this artefact and nothing else. Desktop, the tile column at CSS
 *            (939, 68)-(1048.5, 175.5): s6-pricing-desktop, s6-pricing-error,
 *            s8-doctors-desktop, and s3d-pricing-archived-shown at the same
 *            column one card lower. Mobile, the whole sheet absent, a
 *            full-width band: s10-safety-mobile (y 1331.5-1463.5),
 *            s14-test-mobile (479.5-883.5), s4-profile-mobile (831.5-963.5),
 *            s5-hours-mobile (931.5-1063.5). The ninth, s14-test-reply, is the
 *            twelfth content mover above and was never a flake.
 *   after    ZERO occurrences in all ten runs. Every one of the eight is gone.
 *            The last six runs, five pairs, moved 0 / 0 / 1 / 1 / 0 shots
 *            beyond the twelve, and the one is s8-doctors-error under the
 *            16-device-px column displacement — the OTHER artefact, decided per
 *            page load and identical in every frame of that load, so this gate
 *            cannot and does not touch it. The two runs either side of it are
 *            byte-identical to each other across all 59.
 *
 * It is doing real work on every run, not standing idle: 23 and 24 of the 59
 * shots needed a third frame in two consecutive clean runs — i.e. the first
 * capture disagreed with the second about two shots in five.
 *
 * TWO THINGS IT DOES NOT FIX, both older than it and both named so the next
 * session does not attribute them here:
 *   • the 16-device-px column displacement (S3b; now registered in the
 *     quarantine at :495). Six shots showed it across the ten runs.
 *     Confirmed by correlation each time: best vertical
 *     shift exactly ±16 device px, the sidebar unshifted, and the Verbatim
 *     panel byte-identical — the opposite signature to this one.
 *   • an LCD-subpixel to GRAYSCALE antialiasing flip, which is new to this
 *     record. Between two runs, 16 of the 42 desktop shots changed only in a
 *     416 x 25 CSS box in the top bar; magnified, "Ctrl K" and the "SD" avatar
 *     carry colour fringing in one and clean grey edges in the other. Chrome
 *     turns LCD AA off for text on a layer it cannot prove opaque, so it is a
 *     compositing decision like the one above rather than a font or a race. It
 *     flipped ONCE and stayed flipped for every run after, so it is a state,
 *     not a coin.
 * ─────────────────────────────────────────────────────────────────────── */

/* The 90s ceiling and the one retry that used to live HERE are now on
 * `CDP.send` itself (:123-180), which is where the debt always belonged —
 * `Page.captureScreenshot` is on the retry allowlist, so this function keeps
 * exactly the protection S3f gave it and every other call in the file gained
 * the same. Nothing below waits on a raw promise any more. */
async function captureStable(cdp, sid, params, out) {
  const name = path.basename(out);
  const frame = () => cdp.send('Page.captureScreenshot', params, sid);
  let prev = null;
  for (let i = 1; i <= 8; i++) {
    const r = await frame();
    if (prev !== null && r.data === prev) return { data: r.data, tries: i };
    prev = r.data;
  }
  throw new Error('capture never repeated itself in 8 frames: ' + name);
}

async function shoot(cdp, { url, out, width, height, mobile, cookie, port, waitFor, afterReady }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  // Opt-in diagnostics (SHOOT_DEBUG=1) — console/exception/XHR visibility for
  // debugging a new shot's afterReady interaction. Found live: a click landing
  // on a not-yet-wired button produces NONE of these (no exception, no request)
  // — the tell that a waitFor condition resolved before the page's own async
  // init did, rather than a genuine app error.
  if (process.env.SHOOT_DEBUG) {
    await cdp.send('Runtime.enable', {}, sessionId);
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') {
        console.log('  [console]', out, m.params.type, (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        console.log('  [exception]', out, JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails));
      }
      if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/')) {
        console.log('  [response]', out, m.params.response.status, m.params.response.url);
      }
    });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: !!mobile }, sessionId);
  if (cookie) {
    await cdp.send('Network.setCookie',
      { name: cookie.name, value: cookie.value, url: `http://127.0.0.1:${port}/` }, sessionId);
  }
  // The clock, frozen BEFORE the document exists (CLOCK_SHIM above). Must
  // precede Page.navigate: a Runtime.evaluate after load is already too late
  // for anything a page reads while it parses.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM }, sessionId);

  const loaded = new Promise((res) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await waitForSelector(cdp, sessionId, waitFor);
  // Both shell-owned renders, BEFORE the interaction: an afterReady that clicks
  // Save on a page whose truth strip has not landed is clicking at coordinates
  // that are about to move, which is the same race one layer up.
  await settleShell(cdp, sessionId);
  // Optional interaction (e.g. fill a form + click) driven over CDP before capture.
  if (afterReady) await afterReady(cdp, sessionId);
  await cdp.send('Runtime.evaluate', { expression: CARET_OFF }, sessionId);
  await waitForSelector(cdp, sessionId, SCROLL_HOME);
  await sleep(1300); // ring fill (.9s) + fonts settle
  // Asserted a second time, after the settle: a focus() or a late render inside
  // that 1300ms can scroll the page again, and the offset that matters is the
  // one in force when the frame is rasterised, not the one 1300ms earlier.
  await waitForSelector(cdp, sessionId, SCROLL_HOME);

  // Opt-in geometry dump, the instrument that attributed the last defect below.
  // Everything a page could plausibly be doing differently at capture time, read
  // in the same turn as the frame: scroll, the rects of every structural box to
  // 0.01px, the font-loading verdict, the running-animation count, the device
  // pixel ratio and the visual viewport. It is what proved the DOM was NOT the
  // variable — fourteen consecutive loads of the same page returned this line
  // byte-identical while the captures split into two hashes.
  if (process.env.SHOOT_DEBUG) {
    const d = await cdp.send('Runtime.evaluate', { returnByValue: true, expression:
      "(function(){function r(s){var e=document.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();"
      + "return [Math.round(b.x*100)/100,Math.round(b.y*100)/100,Math.round(b.width*100)/100,Math.round(b.height*100)/100];}"
      + "return JSON.stringify({sy:window.scrollY,sx:window.scrollX,"
      + "st:(document.scrollingElement||document.documentElement).scrollTop,"
      + "dh:document.documentElement.scrollHeight,bh:document.body.scrollHeight,"
      + "side:r('.side'),main:r('.main'),content:r('.content'),head:r('.page-head'),"
      + "strip:r('#truthStrip'),ts:r('#truthStrip .ts'),vp:r('#verbatim'),app:r('.app'),"
      + "vpcls:(document.getElementById('verbatim')||{}).className||'',"
      + "appcls:(document.querySelector('.app')||{}).className||'',"
      + "bodycls:document.body.className,"
      + "fonts:document.fonts.status+'/'+document.fonts.size,"
      + "dpr:window.devicePixelRatio,"
      + "vv:window.visualViewport?[visualViewport.pageTop,visualViewport.offsetTop,visualViewport.scale,visualViewport.width,visualViewport.height]:null,"
      + "anim:(document.getAnimations?document.getAnimations().length:-1)});})()" }, sessionId);
    console.log('  [probe]', path.basename(out), d.result && d.result.value);
  }
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const size = metrics.cssContentSize || { width, height };
  const clipH = Math.ceil(size.height);
  const clipW = Math.ceil(size.width);

  /* The fourth defect, and the only one that was not the page's fault at all:
   * `captureBeyondViewport: true` does not always paint the same picture.
   *
   * Fourteen consecutive loads of test.html in ONE run, same tenant, same
   * cookie, same everything — and the geometry dump above came back
   * byte-identical on all fourteen: scrollY 0, `.content` at y=96.94, the strip
   * 40.94px tall, fonts `loaded/14`, zero running animations, dpr 2, the visual
   * viewport at 1280x900. The captures split 12/2 across two hashes, 340548 and
   * 327439 bytes. Correlating the two images puts the whole content column
   * **exactly 16 device pixels — 8 CSS px — lower in one than the other**, at a
   * layout that both pages agree is identical to a hundredth of a pixel. It is
   * the paint that moves, not the DOM.
   *
   * `--disable-partial-raster` does not touch it (18 loads, still split).
   * Dropping captureBeyondViewport does: eighteen consecutive loads, one hash,
   * and it is the hash of the state WITHOUT the 8px displacement — so the
   * majority reading was the wrong one, not merely a different one.
   *
   * The flag is only ever needed when the document is bigger than the emulated
   * viewport. Thirty-odd of these shots size their viewport to the page and are
   * exactly the content height, and for those the flag was doing nothing except
   * offering Chrome an opportunity to paint them wrong. Asking for it only when
   * it is load-bearing costs nothing and closes four shots outright
   * (s11-faqs-empty, s14-test-desktop, s14-test-limited, s18-golive-ready — all
   * 1280x900 on a 900px viewport).
   *
   * It does NOT close the shots that genuinely need the expansion, and this
   * paragraph has now been wrong in two directions, so it is written from the
   * measurement rather than from a sample.
   *
   * `beyond` is `clipH > height || clipW > width` — the CONTENT is taller (or
   * wider) than the emulated viewport. That is a PROPERTY OF EACH SHOT, not a
   * short list, and it is true of FORTY-FOUR of the 59, including every desktop
   * page long enough to scroll. It is printed on every line of a run's log now
   * (`grep -c " beyond"`) so nobody has to take this sentence on trust again.
   *
   * The first version of this note named three shots — s9-booking-error,
   * s13-receptionist-error, s15-knows-telugu-greeting — as "exactly the three
   * that still ask for the flag", with s4-profile-error a footnote "in the same
   * class". Both halves were false: those were three of the forty-four that
   * happened to flip across five particular runs, which is a sample, not a
   * property, and s6-pricing-error (1904 on 1200) was in the class and was not
   * named at all. S3e corrected the arithmetic and then over-corrected the
   * other way, leaving "eleven content movers, and everything on top of those
   * is a flip" without ever naming the eleven.
   *
   * THE THIRTEEN CONTENT MOVERS, BY NAME — S3f said twelve, and the count was
   * one short. Re-measured here over FIVE consecutive pairs (ten full runs of
   * all 59 shots) with the frozen clock in place. Eleven move in every pair,
   * every time. The other two are durations that only move across a rounding
   * boundary, and one of them was never on anybody's list.
   *
   *   THE ELEVEN — every pair, without exception
   *
   *   home-desktop, home-mobile
   *       Home prints the readiness run THIS RUN wrote — "Last checked 31 Aug
   *       2026, 12:08 AM" (fmtDate, home.js:78-86, rendered at :386).
   *       `validation_runs.created_at` is `TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   *       and that NOW() is POSTGRES's clock. fmtAge (home.js:93-103) beside it
   *       IS a Date.now() reading and the shim does settle it — but it renders
   *       only in the `run.stale` branch (home.js:377-386), which this shot is
   *       not in, so settling it changes nothing here.
   *   s17-history-desktop, s17-history-mobile, s17-history-detail,
   *   s17-history-restore-confirm
   *       the config revisions the S17 sequence creates and then lists
   *       (history.js:30-33), off `tenant_config_revisions.created_at` — the
   *       same DEFAULT NOW(), the same Postgres clock.
   *   s18-live, s18-paused, s18-paused-mobile,
   *   s18-golive-blocked-after-mobile
   *       the lifecycle transitions persist a validation run and the page then
   *       states when it happened. Same column, same clock.
   *   s3-admin-create-owner
   *       a server-generated one-time password. NOT A DATE AT ALL, and no clock
   *       shim of any kind can reach it — it is `crypto` entropy, and settling
   *       it would mean seeding the server's RNG.
   *
   *   THE TWO DURATIONS — a rounding boundary, not a pair
   *
   *   s14-test-reply, s3d-test-no-config
   *       both send a real test turn and print how long it took:
   *       `${(p.latency_ms / 1000).toFixed(1)}s` (test.js:84). S3f named the
   *       first as "the twelfth" and measured its 6 x 9 CSS px box at
   *       (481, 426.5). The second is new here and is the SAME defect on the
   *       S3d fixture variant: 131 differing device px in a 5.5 x 8 CSS px box
   *       at (415, 468.5) between runs 3 and 4, best vertical shift dy = 0, so
   *       it is a glyph and not a displacement. `latency_ms` is measured
   *       SERVER-side (src/infra/logging/turnMetrics.js), so like the password
   *       above it is not a date and a page-side clock cannot touch it.
   *       Neither moved in four of the five pairs, which is exactly why this
   *       one hid behind "flake" for four sessions.
   *
   * WHAT THE CLOCK SHIM ACTUALLY BOUGHT, stated plainly because the brief that
   * commissioned it expected more: ZERO of the thirteen. Every one of them is a
   * value the SERVER produced — Postgres's NOW() for the ten timestamps, node's
   * crypto for the password, a server-side stopwatch for the two durations —
   * and `new Date(iso)` must keep parsing an ISO string faithfully or every
   * date on every page becomes a lie. What the shim DOES close is the class
   * nobody had hit yet and everybody would have: `hours.js:40-45`'s
   * `.holiday-row--past` and `verbatim.js:315`'s "today" row, both of which
   * flip on a calendar boundary rather than on a run. Proven, not assumed —
   * moving the epoch to 2026-08-01 (before both seeded holidays at :1605-1608)
   * moves s5-hours-desktop by 15884 px in the holiday band at CSS y 1064-1107.5
   * and changes s5-hours-mobile's PAGE HEIGHT from 3894 to 3958, because the
   * "Past" chip takes its own grid row below 1024 (hours.css:206). At the
   * chosen epoch all three s5 shots are byte-identical across all five pairs.
   *
   * SETTLING THE TEN TIMESTAMPS NEEDS A DATABASE-SIDE PIN, and there is no
   * fixture file to edit: nothing seeds those rows. They are written by the
   * REAL services this script drives — validationService and
   * configService.writeTenantConfig — into the scratch DB, four of them (s17,
   * s18) by clicks inside `afterReady`, i.e. DURING the capture sequence and
   * not at seed time. So the pin is not a one-line seed change; it is a
   * decision about whether this instrument may rewrite the rows it photographs,
   * and it is deliberately NOT taken here.
   *
   * Sizing the viewport to the content would remove the flag everywhere, but
   * `.side` is `position: fixed` and would then paint down the whole page rather
   * than one viewport, which is a change to what ~30 shots show and a decision
   * above this repair's pay grade. Re-verified rather than repeated: `.side`
   * and `.vp` both stop dead at exactly one viewport height today — sampled at
   * CSS y 1180 and 1220 on s6-pricing-desktop and s8-doctors-desktop, both on a
   * 1200px viewport — so the ~30 figure is what it costs. */
  const beyond = clipH > height || clipW > width;

  const shot = await captureStable(cdp, sessionId, {
    format: 'png',
    captureBeyondViewport: beyond,
    clip: { x: 0, y: 0, width: size.width, height: clipH, scale: 1 },
  }, out);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  // `beyond` is printed because the block above makes a claim about how many
  // shots are in that class, and a claim about the instrument that the
  // instrument does not print is a claim nobody re-checks. Count it out of a
  // run's log rather than re-deriving it: `grep -c ' beyond' `.
  console.log('  ✓', path.basename(out),
    `(${Math.round(size.width)}×${Math.round(size.height)})`,
    beyond ? 'beyond' : 'in-viewport',
    shot.tries > 2 ? `[raster settled after ${shot.tries} frames]` : '');
}

// ── Contrast instrument (S2) ─────────────────────────────────────────────────
// The measuring half lives in tests/design/portalContrast.js so the colour
// arithmetic is unit-tested offline by tests/design/portalContrast.test.js and
// this file only drives it. Everything below collects RAW computed values; not
// one ratio is computed here.
const kit = require('../../tests/design/portalContrast');

// Per-page readiness. Ten of the fourteen base pages hide a shared #loadCard on a
// successful load and render their error INTO it on a failed one, so
// `loadCard.hidden` is a genuine data-dependent gate rather than a markup
// witness — which is the distinction the S4 gate above got wrong.
const LOADED = "(function(){"
  + "var c=document.getElementById('loadCard'); if(!c || !c.hidden) return false;"
  // Eight of these pages also host the Verbatim panel, which loads on its OWN
  // fetch and paints 18 more glyphs on the one dark ground in the product. The
  // loadCard gate alone let the sweep run before it, and clinic-profile then
  // measured 78 rows on one run and 96 on the next. The clause itself now lives
  // above as VERBATIM_PAINTED, because the capture path needs the same one and a
  // second copy of a gate is a gate that will drift.
  + "return " + VERBATIM_PAINTED + ";"
  + "})()";
const WIZARD_READY = "(function(){"
  + "var w=document.getElementById('wiz'); if(!w || w.hidden) return false;"
  + "var t=document.getElementById('wizTitle'); if(!t || !t.textContent.trim()) return false;"
  + "var rv=document.getElementById('wizReview');"
  + "if(rv && !rv.hidden) return !!rv.querySelector('.readiness, .checks');"
  + "var fw=document.getElementById('wizFrameWrap');"
  + "if(fw && !fw.hidden){ try {"
  + "  var d=document.getElementById('wizFrame').contentDocument;"
  + "  var lc=d && d.getElementById('loadCard');"
  + "  return !!lc && lc.hidden;"
  + "} catch(e) { return true; } }"
  + "return true;"
  + "})()";
const CONTRAST_PAGES = [
  { file: 'login.html', auth: false, gate: "document.getElementById('form')" },
  { file: 'index.html', gate: "document.querySelector('.ring')||document.querySelector('.emp')" },
  { file: 'clinic-profile.html', gate: LOADED },
  { file: 'hours.html', gate: LOADED },
  { file: 'doctors.html', gate: LOADED },
  { file: 'pricing.html', gate: LOADED },
  { file: 'faqs.html', gate: LOADED },
  { file: 'receptionist.html', gate: LOADED },
  { file: 'booking-rules.html', gate: LOADED },
  { file: 'safety.html', gate: LOADED },
  { file: 'knows.html', gate: LOADED },
  { file: 'history.html', gate: LOADED },
  { file: 'test.html', gate: "document.body.dataset.testReady === '1'" },
  // The wizard reveals #wiz before its step has finished rendering. On the
  // Review step that costs 45 glyphs: loadReview() is a separate fetch, and at
  // 380 the sweep measured 80 rows on two runs and 35 on a third, the delta
  // being the whole readiness pane. The iframe branch reuses the wizard's OWN
  // readiness rule for an embedded step (wizard.js:265-274, "#loadCard hidden
  // means the page has wired its submit listener") rather than inventing one.
  //
  // NOTE: this sweep does not descend into #wizFrame. Same-origin or not, a
  // document is its own tree and querySelectorAll does not cross it — the six
  // embedded step pages are swept directly, on their own rows above.
  { file: 'wizard.html', gate: WIZARD_READY },

  // ── STATE VARIANTS (S3d) ──────────────────────────────────────────────────
  // Six entries: the same pages as above, entered in states the maximal tenant
  // cannot be in. FOUR are a different TENANT rather than a different page —
  // `as: 'lotus'` swaps the session cookie for Lotus Dental's, whose saved config
  // IS the off arm (see the seeding block) — and two send a real test turn, one
  // of those against Palm Dental. Nothing is poked into the DOM to produce any of
  // them: the pages render what the database says.
  //
  // `after` is the one exception and it is not a poke either: it drives the
  // page's OWN control. "Show archived" is a checkbox an owner clicks, and
  // clicking it is the only way any owner has ever seen an archived row; a
  // fixture cannot express "the disclosure is open" because the disclosure is
  // not persisted. Same for the test turn: the reply bubble and its provenance
  // line exist only after a real turn, and `.starter` is the button the page
  // gives an owner to send one. Both are `.click()` on a real element, so the
  // page's own handlers run and the state is the state the product produces.
  //
  // `id` is what the report calls the row. Two entries share a `file`, and a
  // report that called them both `pricing.html` would make a failure on one
  // indistinguishable from a failure on the other. It is NOT in the signature —
  // core.signature() reduces to colour/backdrop shapes and never reads `page`
  // (failureShape/ringShape, core.js:1303-1325) — so naming these rows cannot
  // move the baseline by itself.
  { id: 'clinic-profile.html[one-language]', file: 'clinic-profile.html', as: 'lotus', gate: LOADED },
  { id: 'safety.html[handoff-off]', file: 'safety.html', as: 'lotus', gate: LOADED },
  { id: 'booking-rules.html[same-day-off]', file: 'booking-rules.html', as: 'lotus', gate: LOADED },
  {
    id: 'pricing.html[archived-shown]', file: 'pricing.html', as: 'lotus', gate: LOADED,
    after: {
      // The checkbox, not the rows. pricing.js:191-198 owns what `.tr--hidden`
      // means; reaching past it to unhide the rows directly would measure a
      // state the page never paints.
      click: "document.getElementById('showArchived')",
      until: "document.querySelector('.tr--archived') && "
        + "!document.querySelector('.tr--archived').classList.contains('tr--hidden')",
    },
  },
  {
    id: 'test.html[replied]', file: 'test.html', gate: "document.body.dataset.testReady === '1'",
    after: {
      click: "document.querySelector('.starter[data-q=\"What is the consultation fee?\"]')",
      until: "document.querySelector('.msg__prov')",
    },
  },
  {
    // The SAME turn against a tenant that has never saved a config. test.js:79-88
    // takes its other arm there: `config_version` is null, so the chips are
    // preceded by `.msg__prov-warn` — amber, full-width, carrying a link. It is
    // the one line on that page an owner is meant to act on, and neither
    // instrument has ever measured it. Palm Dental is the subject and had to be
    // seeded for it: it is the only tenant here with no `tenant_configs` row,
    // which is what `config_version: null` actually requires. See its comment
    // below for why Fresh Clinic — the obvious candidate — is not one.
    id: 'test.html[no-config]', file: 'test.html', as: 'palm',
    gate: "document.body.dataset.testReady === '1'",
    after: {
      click: "document.querySelector('.starter')",
      until: "document.querySelector('.msg__prov-warn')",
    },
  },
];
const CONTRAST_WIDTHS = [{ width: 1280, height: 900, mobile: false },
                         { width: 380, height: 820, mobile: true }];

/* ── THE STATE CENSUS (S3d) ────────────────────────────────────────────────
 * The sweep above is only ever as good as the states the seeded tenant enters.
 * Every ratio it reports is a ratio of something that was ON THE SCREEN; a
 * declaration guarding a state no fixture reaches is certified green on
 * ABSENCE, and neither the signature nor the 54-shot corpus says a word about
 * it. `.tr--archived` was styled, shipped, swept 24 times, and never once
 * rendered.
 *
 * So: before every sweep, ask the page which of the portal's own styled states
 * it is actually in. The probe list is DERIVED from the stylesheets rather than
 * written down — a hand list would go stale the first time a modifier is added
 * and would never say so, which is the same failure the exemption list at
 * portalContrast.js:174 is written to avoid.
 *
 * Three families, all mechanical:
 *   • every class token appearing in any `public/portal/*.css` selector;
 *   • every attribute / pseudo state those selectors key on (`:checked`,
 *     `[aria-pressed="true"]`, `[disabled]`, `[lang="te"]`, …);
 *   • the COMPLEMENT of each two-valued attribute state, which no stylesheet
 *     names because it is the default arm — `[aria-pressed="false"]` is the
 *     unpressed language chip, and nothing in the CSS mentions it.
 *
 * Counted twice per page: how many elements MATCH, and how many of those have
 * a client rect. Both are needed. A probe that matches nothing is a state the
 * fixture cannot reach at all; a probe that matches but is never visible is a
 * state the fixture reaches and then HIDES, which is the more common shape here
 * (`.tr--archived` behind "Show archived", the whole of `#loadCard`) and is
 * indistinguishable from the first in the report unless it is measured apart.
 * ------------------------------------------------------------------------- */

/** Class tokens + attribute/pseudo states, read out of the portal's own CSS. */
function censusProbes() {
  const dir = path.join(__dirname, '..', '..', 'public', 'portal');
  const classes = new Set();
  const compounds = new Set();

  // States a census can ask about. `:hover`, `:focus-visible`, `:active` are
  // deliberately absent — no static query can answer them, and the ring half of
  // the sweep is the instrument that already does.
  const STATE = /\[[^\]]*\]|:(?:checked|disabled|indeterminate|empty)\b/;
  // Everything a compound may carry that querySelectorAll cannot evaluate at
  // rest, stripped so the rest of the compound is still probeable.
  const UNQUERYABLE = /::?(?:hover|active|focus|focus-visible|focus-within|before|after|placeholder|-webkit-[a-z-]+|marker|selection)\b(?:\([^)]*\))?/g;

  /**
   * Every PREFIX of a selector that ends on a state-carrying compound, with its
   * combinators intact.
   *
   * The prefix, not the bare compound. `.switch input:checked + .switch__track`
   * carries its state on `input:checked` — and `input:checked` alone is answered
   * by any checked box in the portal, `#showArchived` on Pricing included. The
   * question the stylesheet is actually asking is about the checkbox inside a
   * `.switch`, and only `.switch input:checked` asks it.
   */
  function statePrefixes(sel) {
    const parts = [];                 // alternating compound / combinator
    let buf = '';
    let depth = 0;
    let i = 0;
    while (i < sel.length) {
      const ch = sel[i];
      if (ch === '[' || ch === '(') depth += 1;
      else if (ch === ']' || ch === ')') depth -= 1;
      if (depth === 0 && /[\s>+~]/.test(ch)) {
        let comb = '';
        while (i < sel.length && /[\s>+~]/.test(sel[i])) { if (sel[i] !== ' ') comb = sel[i]; i += 1; }
        if (buf) { parts.push(buf); parts.push(comb ? ' ' + comb + ' ' : ' '); buf = ''; }
        continue;
      }
      buf += ch;
      i += 1;
    }
    if (buf) parts.push(buf);

    const out = [];
    let prefix = '';
    for (const part of parts) {
      prefix += part;
      const isCombinator = /^[\s>+~]+$/.test(part);
      if (isCombinator) continue;
      const clean = part.replace(UNQUERYABLE, '').trim();
      if (!clean || !STATE.test(clean)) continue;
      if (/^:not\(/.test(clean)) continue;      // a negation measures an absence
      out.push(prefix.replace(UNQUERYABLE, '').trim());
    }
    return out;
  }

  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    let m;
    const blocks = /([^{}]+)\{/g;
    while ((m = blocks.exec(css))) {
      const list = m[1];
      if (/^\s*@/.test(list)) continue;           // at-rule preludes are not selectors
      for (const raw of list.split(',')) {
        const sel = raw.trim();
        if (!sel) continue;
        let c;
        const cls = /\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g;
        while ((c = cls.exec(sel))) classes.add(c[1]);
        // The compound is what carries the state. `.lang-toggle[aria-pressed="true"]`
        // and a bare `[aria-pressed="true"]` are DIFFERENT questions, and only the
        // first one is about the language chips: the bare probe is satisfied by any
        // pressed toggle anywhere in the portal, which is how a state can read as
        // covered while the element that owns the declaration has never rendered.
        for (const pre of statePrefixes(sel)) compounds.add(pre);
      }
    }
  }

  const probes = [...classes].sort().map((c) => '.' + c);
  for (const s of [...compounds].sort()) probes.push(s);

  // THE DEFAULT ARMS. A stylesheet names the arm that OVERRIDES; the other arm
  // is the base style and appears in no selector, which is exactly why a census
  // built only from the stylesheets would never think to look for it. Derived
  // per compound so the complement stays attached to the element that owns the
  // declaration: `.lang-toggle[aria-pressed="false"]` is the unpressed language
  // chip, and nothing else in the portal is.
  for (const s of compounds) {
    const flips = [
      s.replace('="true"', '="false"'),
      s.replace('="false"', '="true"'),
      /:checked/.test(s) ? s.replace(':checked', ':not(:checked)') : s,
      /:disabled/.test(s) ? s.replace(':disabled', ':enabled') : s,
      /^\[disabled\]$|\[disabled\]/.test(s) ? s.replace('[disabled]', ':not([disabled])') : s,
    ];
    for (const f of flips) if (f !== s && !compounds.has(f)) probes.push(f);
  }
  return [...new Set(probes)];
}

const CENSUS_PROBES = censusProbes();

/** One page's answer: `{ selector: [matched, visible] }`, zeroes omitted. */
function censusSource(probes) {
  return '(function(){var out={},P=' + JSON.stringify(probes) + ';'
    + 'for(var i=0;i<P.length;i++){var s=P[i],n=0,v=0;'
    + 'try{var els=document.querySelectorAll(s);n=els.length;'
    + 'for(var j=0;j<els.length;j++){if(els[j].getClientRects().length)v++;}}'
    + 'catch(e){n=-1;v=-1;}'
    + 'if(n!==0)out[s]=[n,v];}'
    + 'return out;})()';
}
const CENSUS_SOURCE = censusSource(CENSUS_PROBES);

/* ── RING_SETTLED — the repair for the S3c-1 flake (S3d) ────────────────────
 * S3c-1 saw one `os:check` in seven go red on a thirteenth signature line,
 * `RING      FAIL 0.00  [no indicator]`, with all twelve baseline lines
 * matching. Six other runs of the same tree gave 712 rings / 0 failing, the
 * report had already been unlinked by an unconditional `finally`, and the
 * finding was recorded as "a ring somewhere on the portal focused with no focus
 * style at all, and WHICH ring is not in the record". S3c-1a stopped deleting
 * the report so that the next occurrence would name the element.
 *
 * It fired again during S3d's `os:check` and the report survived. The element is
 * `select#insuranceStance` on pricing.html at 1280, and the row it left settles
 * the question outright:
 *
 *     flake  focused: border rgba(23,21,15,.08)  background rgb(253,252,250)
 *                     box-shadow rgba(0, 0, 0, 0) 0px 0px 0px 0px
 *     clean  focused: border rgb(15,118,110)     background rgb(255,255,255)
 *                     box-shadow rgba(15,118,110,.16) 0px 0px 0px 3px
 *
 * `rgba(0, 0, 0, 0) 0px 0px 0px 0px` is not "no ring". It is the value a
 * box-shadow interpolating FROM `none` holds at t=0 — every component at its
 * zero — and the border and the background are still at their resting values
 * beside it. The read landed at the start of the transition, not after it. So
 * the portal is fine, the ring is fine, and the instrument was reading too
 * early: `sleep(160)` is 40ms of margin over `--dur-1`, and a wall-clock sleep
 * buys nothing when the recalc has not run, which under `npm test` — where the
 * runner executes test FILES concurrently and the marketing sweep is driving its
 * own Chrome — is exactly what happens.
 *
 * So stop betting. `getAnimations()` flushes pending style and returns the
 * transitions actually running on the focused element; awaiting their `finished`
 * promises waits for precisely the thing the sleep was approximating. It costs
 * nothing in the common case — a settled element returns an empty list and
 * resolves immediately — and the 1200ms race is a hang bound, not an
 * expectation. A rejected `finished` (the transition was cancelled by another
 * style change) is swallowed on purpose: cancelled means superseded, and the
 * read that follows should see whatever superseded it. */
const RING_SETTLED = "(function(){"
  + "var el=document.activeElement;"
  + "if(!el||!el.getAnimations) return Promise.resolve(true);"
  + "var a=el.getAnimations({subtree:true});"
  + "if(!a.length) return Promise.resolve(true);"
  + "return Promise.race(["
  + "Promise.all(a.map(function(x){return x.finished.catch(function(){});})),"
  + "new Promise(function(r){setTimeout(r,1200);})"
  + "]).then(function(){return true;});"
  + "})()";

async function pressTab(cdp, sid) {
  const k = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k), sid);
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k), sid);
}

async function evalIn(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sid);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error('in-page error: ' + ((e.exception && e.exception.description) || e.text));
  }
  return r.result && r.result.value;
}

async function sweepOnePage(cdp, opts) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: !!opts.mobile,
    }, sessionId);
    if (opts.cookie) {
      await cdp.send('Network.setCookie',
        { name: opts.cookie.name, value: opts.cookie.value, url: `http://127.0.0.1:${opts.port}/` }, sessionId);
    }
    // The same frozen clock the capture path uses, for the same reason: the
    // contrast sweep reads COMPUTED STYLE, and `.holiday-row--past`
    // (hours.css:131-133) is a class the page decides from today's date. A
    // sweep whose element set depends on the day it ran is not an instrument.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM }, sessionId);
    const loaded = new Promise((res) => {
      cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) res(); });
    });
    await cdp.send('Page.navigate', { url: opts.url }, sessionId);
    await loaded;
    await waitForSelector(cdp, sessionId, opts.gate);
    // Every per-page gate above races the SHELL. The lifecycle strip and the
    // truth strip are painted from one /api/readiness fetch that no page gate
    // knows about: doctors.html at 380 measured 131 glyph rows on one run and
    // 127 on the next, the delta being exactly the two `.lc` strip glyphs.
    // Portal exposes that fetch as a memoised promise; await the real thing
    // rather than sleeping and hoping. login.html has no shell, hence the guard.
    // Hoisted to READINESS_SETTLED above so `shoot()` awaits the identical
    // expression — this line is unchanged in every byte that reaches the page.
    await cdp.send('Runtime.evaluate', {
      expression: READINESS_SETTLED,
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    // A state variant's own interaction (S3d). Placed AFTER the shell has
    // settled and BEFORE the settle sleep below, for the reason `shoot()` gives
    // at :335: a click dispatched while the truth strip is still landing is a
    // click at coordinates that are about to move. The click is dispatched on
    // the element the page itself renders, and the run then WAITS on a condition
    // the interaction makes true — never on a sleep, because a sleep that is
    // long enough on this machine is the mechanism behind every flake this
    // instrument has already paid for.
    if (opts.after) {
      await evalIn(cdp, sessionId,
        '(function(){var el=' + opts.after.click + ';'
        + 'if(!el) throw new Error("state variant: nothing matched " + '
        + JSON.stringify(opts.after.click) + ');'
        + 'el.click(); return true;})()');
      await waitForSelector(cdp, sessionId, opts.after.until);
    }

    // Trap 5: measure SETTLED. A glyph caught mid-transition composites at a
    // fractional opacity and reports a ratio it never holds at rest. Chrome is
    // already on --force-prefers-reduced-motion; this covers the fetch-driven
    // renders that follow the gate.
    await sleep(700);

    const rows = await evalIn(cdp, sessionId, kit.TEXT_SWEEP_SOURCE) || [];

    // The census reads the SAME settled DOM the rows above were measured from,
    // in the same turn — a state that appeared after the sweep is a state the
    // sweep did not measure, and recording it as covered would be the exact
    // false green this instrument exists to find.
    const census = await evalIn(cdp, sessionId, CENSUS_SOURCE) || {};

    // Focus indicators, walked in REAL tab order. A programmatic .focus() does
    // not reliably match :focus-visible on a button, and :focus-visible is what
    // the portal-wide ring at tokens.css:227 is keyed on.
    await evalIn(cdp, sessionId, kit.BLUR_SOURCE);
    await sleep(220); // past --dur-1: a rest style read in the same turn as the
                      // blur() returns the TRANSITION START, i.e. the focused value
    const rest = await evalIn(cdp, sessionId, kit.TAG_FOCUSABLES_SOURCE) || [];
    const restBy = new Map(rest.map((r) => [String(r.i), r]));
    const rings = [];
    const seen = new Set();
    for (let t = 0; t < Math.min(rest.length + 2, 60); t++) {
      await pressTab(cdp, sessionId);
      await sleep(160); // let the focus event land and the transitions be created
      // …then wait for them to FINISH, rather than betting that 160ms was enough.
      // See RING_SETTLED: this line is the S3c-1 flake's actual repair.
      await cdp.send('Runtime.evaluate', {
        expression: RING_SETTLED, returnByValue: true, awaitPromise: true,
      }, sessionId);
      const ring = await evalIn(cdp, sessionId, kit.READ_RING_SOURCE);
      if (!ring) continue;
      const key = ring.i === null || ring.i === undefined ? ring.sel : String(ring.i);
      if (seen.has(key)) break; // tab order wrapped
      seen.add(key);
      rings.push(kit.judgeRing(ring, restBy.get(String(ring.i))));
    }
    return { rows, rings, focusables: rest.length, census };
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

/**
 * `cookies` is the session map, not a session: a state variant is most often a
 * DIFFERENT TENANT, and swapping the cookie is how the sweep enters a state the
 * seeded maximal tenant cannot be in. `cookies.owner` is Sunrise Dental and is
 * what every unlabelled page still uses.
 */
async function runContrastSweep(cdp, base, cookies, port) {
  const allRows = [];
  const allRings = [];
  const seenProbes = new Map();   // probe -> { matched, visible, where: Set }
  console.log('contrast sweep (measure only — nothing is captured):');
  for (const page of CONTRAST_PAGES) {
    for (const vp of CONTRAST_WIDTHS) {
      const as = page.as || 'owner';
      if (page.auth !== false && !cookies[as]) {
        throw new Error(`contrast page ${page.id || page.file} asks for session "${as}", `
          + `and the sweep was handed ${Object.keys(cookies).join(', ')}`);
      }
      const got = await sweepOnePage(cdp, {
        url: `${base}/${page.file}`, gate: page.gate, port, after: page.after,
        cookie: page.auth === false ? null : cookies[as],
        width: vp.width, height: vp.height, mobile: vp.mobile,
      });
      const name = page.id || page.file;
      for (const r of got.rows) { r.page = name; r.vw = vp.width; allRows.push(r); }
      for (const r of got.rings) { r.page = name; r.vw = vp.width; allRings.push(r); }
      for (const [probe, [n, vis]] of Object.entries(got.census)) {
        if (!seenProbes.has(probe)) seenProbes.set(probe, { matched: 0, visible: 0, where: new Set() });
        const e = seenProbes.get(probe);
        e.matched += n; e.visible += vis;
        e.where.add(`${name}@${vp.width}`);
      }
      const v = kit.judge(got.rows);
      const ringFail = got.rings.filter((r) => !r.pass).length;
      console.log(`  ${name.padEnd(34)} ${String(vp.width).padStart(4)}  `
        + `${String(got.rows.length).padStart(4)} glyph rows  `
        + `${String(v.pairs).padStart(3)} pairs  `
        + `${String(v.failures.length).padStart(3)} fail  `
        + `${String(got.rings.length).padStart(3)} rings  `
        + `${String(ringFail).padStart(2)} ring-fail`);
    }
  }

  const verdict = kit.judge(allRows);
  const ringFails = allRings.filter((r) => !r.pass);

  console.log('');
  console.log('── TOTALS ─────────────────────────────────────────────────');
  console.log('  glyph rows measured   :', verdict.measured.length);
  console.log('  unique colour/backdrop:', verdict.pairs);
  console.log('  threshold failures    :', verdict.failures.length);
  // Recorded because PORTAL_BASELINE carries an `exempt` count and nothing
  // emitted it: the number could only be re-derived by re-running judge() over
  // raw rows the report does not keep, so it was the one baseline figure a
  // session could not check. An exemption is how a defect becomes a baseline;
  // it should be the easiest number here to read, not the hardest.
  console.log('  exempted (SC 1.4.11)  :', verdict.exempt.length);
  console.log('  D-016 contract        :', verdict.contract.length,
    '(--ink-faint as a glyph colour; MUST be 0)');
  console.log('  undeterminable        :', verdict.undeterminable.length);
  console.log('  focus indicators      :', allRings.length, 'measured,', ringFails.length, 'below 3:1');

  const byKey = new Map();
  for (const f of verdict.failures) {
    const k = f.color + ' on rgb(' + [f.bg.r, f.bg.g, f.bg.b].map(Math.round).join(',') + ')'
      + (f.large ? ' [large]' : '') + (f.opacity !== 1 ? ' @op' + f.opacity : '');
    if (!byKey.has(k)) byKey.set(k, { ratio: f.ratio, floor: f.floor, n: 0, ex: [] });
    const e = byKey.get(k);
    e.n += 1;
    if (e.ex.length < 3) e.ex.push(f.page + ' ' + f.vw + ' ' + f.sel + (f.text ? '  "' + f.text + '"' : ''));
  }
  if (byKey.size) {
    console.log('');
    console.log('── THRESHOLD FAILURES, by distinct pair ───────────────────');
    const sorted = [...byKey.entries()].sort((a, b) => a[1].ratio - b[1].ratio);
    for (const [k, e] of sorted) {
      console.log(`  ${e.ratio.toFixed(2)}:1  (needs ${e.floor})  x${e.n}  ${k}`);
      for (const x of e.ex) console.log('        ' + x);
    }
  }
  if (verdict.contract.length) {
    console.log('');
    console.log('── D-016 CONTRACT VIOLATIONS ──────────────────────────────');
    for (const c of verdict.contract) {
      console.log(`  ${c.page} ${c.vw}  ${c.sel}  ${c.ratio}:1  ${c.why}`);
    }
  }

  // Focus indicators are a separate instrument at a separate floor (SC 1.4.11,
  // 3:1). Reported in full for `.input` because tokens.css:995-998 makes two
  // claims about that rule that the rule does not keep.
  const inputRings = allRings.filter((r) => /input/.test(r.sel));
  const shown = new Set();
  console.log('');
  console.log('── FOCUS INDICATORS (SC 1.4.11, floor 3:1) ────────────────');
  for (const r of inputRings.concat(allRings)) {
    const k = r.sel + '|' + r.indicators.map((x) => x.kind + x.css).join('|') + '|' + r.fillChanged;
    if (shown.has(k)) continue;
    shown.add(k);
    if (shown.size > 24) break;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${String(r.best.toFixed ? r.best.toFixed(2) : r.best).padStart(5)}:1  ${r.page} ${r.vw}  ${r.sel}`);
    for (const ind of r.indicators) {
      console.log(`        ${ind.kind.padEnd(7)} ${ind.ratio}:1 vs ${ind.against}`
        + (ind.ratioOuter !== undefined ? ` / ${ind.ratioOuter}:1 vs outer` : '')
        + `   ${ind.css}`);
    }
    if (r.fillChanged) console.log(`        FILL CHANGED on focus (rest->focus contrast ${r.fillRatio}:1)`);
    if (!r.indicators.length) console.log('        no indicator found');
  }

  // ── THE STATE CENSUS ─────────────────────────────────────────────────────
  // Three buckets, and the distinction between the last two is the finding:
  //   RENDERED   the fixture reaches it AND it is on the screen — swept.
  //   HIDDEN     the fixture reaches it and the page hides it — in the DOM,
  //              measured by nothing, because the sweep skips zero-rect nodes.
  //   UNREACHED  no page in the corpus ever put it in the DOM at all.
  const unreached = [];
  const hidden = [];
  for (const probe of CENSUS_PROBES) {
    const e = seenProbes.get(probe);
    if (!e || e.matched <= 0) { unreached.push(probe); continue; }
    if (e.visible === 0) hidden.push(probe);
  }
  console.log('');
  console.log('── STATE CENSUS (probes derived from public/portal/*.css) ──');
  console.log('  probes                :', CENSUS_PROBES.length);
  console.log('  rendered somewhere    :', CENSUS_PROBES.length - unreached.length - hidden.length);
  console.log('  in the DOM, no rect   :', hidden.length);
  console.log('  never in any DOM      :', unreached.length);
  if (hidden.length) console.log('  HIDDEN   : ' + hidden.join(' '));
  if (unreached.length) console.log('  UNREACHED: ' + unreached.join(' '));

  fs.writeFileSync(CONTRAST_OUT, JSON.stringify({
    at: new Date().toISOString(),
    rows: verdict.measured.length,
    pairs: verdict.pairs,
    exempt: verdict.exempt.length,
    failures: verdict.failures,
    contract: verdict.contract,
    undeterminable: verdict.undeterminable,
    rings: allRings,
    // Not read by core.signature() — the signature is a reduction of what was
    // MEASURED, and the census is a statement about what was not. Carried in
    // the same report so one run answers both questions.
    census: {
      probes: CENSUS_PROBES.length,
      unreached,
      hidden,
      seen: Object.fromEntries([...seenProbes].map(([k, v]) =>
        [k, { matched: v.matched, visible: v.visible, where: [...v.where] }])),
    },
  }, null, 2));
  console.log('');
  console.log('report →', CONTRAST_OUT);

  if (verdict.contract.length) {
    throw new Error(`D-016 contract violated: --ink-faint resolved as a glyph colour on `
      + `${verdict.contract.length} element(s)`);
  }
  return { verdict, rings: allRings };
}
// ── HTTP login → session cookie ──────────────────────────────────────────────
// Generic over both auth surfaces: `path` + the cookie name we expect back.
function loginCookieVia(port, path, cookieName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const set = res.headers['set-cookie'] || [];
      const c = set.find((s) => s.startsWith(cookieName + '='));
      if (!c) return reject(new Error(`no ${cookieName} cookie (login ${res.statusCode})`));
      const kv = c.split(';')[0];
      const eq = kv.indexOf('=');
      resolve({ name: kv.slice(0, eq), value: kv.slice(eq + 1) });
    });
    r.on('error', reject);
    r.write(payload); r.end();
  });
}
const loginCookie = (port, email, password) =>
  loginCookieVia(port, '/portal/api/login', 'portal.sid', { email, password });
const adminLoginCookie = (port, password) =>
  loginCookieVia(port, '/admin/login', 'connect.sid', { password });

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const scratchName = 'zyon_shot_' + crypto.randomBytes(5).toString('hex');
  const scratchCs = swapDb(ADMIN, scratchName);

  const c0 = new Client({ connectionString: ADMIN, ssl: SSL });
  await c0.connect();
  await c0.query('CREATE DATABASE ' + scratchName);
  await c0.end();
  console.log('scratch DB:', scratchName);

  let server, chrome, ws, db;
  try {
    const runner = require('../../src/db/migrate');
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // Bind everything to the scratch DB before first require of db/services.
    process.env.DATABASE_URL = scratchCs;
    process.env.LOG_LEVEL = 'silent';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shoot-admin-pass';
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    db = require('../../src/db/db');
    const { hashPassword } = require('../../src/portal/auth');
    const configService = require('../../src/modules/config/configService');
    const validationService = require('../../src/modules/validation/validationService');
    const aiService = require('../../src/modules/ai/aiService');
    const knowledgeService = require('../../src/modules/knowledge/knowledgeService');

    // Seed: a clinic + owner. Config is clinicDefaults + a real escalation number
    // (numbers.e164 passes) but no FAQs yet (kb checks fail → an owner action item
    // with a page link) and no WhatsApp creds (operator "handled by Veprio").
    const email = 'owner@sunrisedental.test';
    const password = 'demo-portal-pass';
    const t = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Sunrise Dental']);
    const tenantId = t.rows[0].id;
    const ownerRow = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    const ownerUserId = ownerRow.rows[0].id;

    // Captured as a named var (not an inline literal) so the S17 history block
    // below can restore it verbatim as a later version, without disturbing what
    // every other page's shot documents about this tenant's live state.
    const seedConfig = {
      business: {
        display_name: 'Sunrise Dental',
        address: '2nd Floor, Pearl Plaza, Ameerpet, Hyderabad 500016',
        landmark: 'above HDFC Bank, opposite Ameerpet Metro',
        website: 'https://sunrisedental.in',
        phone_numbers: ['+919876543210', '+914023456789'],
      },
      languages: { supported: ['te', 'hi', 'en'], default: 'te' },
      notifications: { owner_numbers: ['+919000000001'] },
      // Safety & handoff (S10): the callback offer on, two staff numbers, and the
      // clinic's own emergency guidance + a give-out number — so the page shows a
      // filled state and the emergency block actually renders into the prompt.
      escalation: {
        enabled: true,
        phone_numbers: ['+919000000002', '+919000000003'],
        emergency_guidance: 'Come straight to the clinic — we keep an emergency slot free every hour, and someone is on the desk until 8pm.',
        emergency_number: '+919000000009',
      },
      // Hours: a short Wednesday + a closed Saturday (varied grid), plus two
      // holidays so the S5 shot shows both the closed-day render and the
      // past-date de-emphasis.
      //
      // "one past and one upcoming" is what this said, and it stopped being
      // true on 2026-08-15: BOTH dates are now behind us, so both rows render
      // `.holiday-row--past` and the shot has quietly lost its upcoming-holiday
      // case. Left as data rather than repaired, because moving a seeded date
      // changes what three shots show and this session photographs the corpus
      // rather than re-cutting it — but the comment may not go on asserting a
      // state the dates no longer produce. It is also why CLOCK_SHIM's epoch is
      // pinned AFTER 2026-08-15: an earlier freeze would flip both rows back.
      hours: {
        wed: { open: '09:00', close: '13:00' },
        sat: { closed: true },
        holidays: [
          { date: '2026-08-15', name: 'Independence Day' },
          { date: '2026-01-26', name: 'Republic Day' },
        ],
      },
      // Pricing (S6): real fees + a treatment list that exercises every row
      // variant — a "starts at" price, a duration, a note, and one ARCHIVED row
      // so the "Show archived (1)" toggle appears and the archived styling shows.
      pricing: {
        consultation_fee: 500,
        follow_up_fee: 300,
        emergency_fee: 1200,
        payment_methods: ['upi', 'cash', 'card'],
        insurance: { stance: 'selected_insurers', note: 'Star Health, HDFC Ergo, Niva Bupa' },
        treatments: [
          { name: 'Root canal', price: 4000, price_from: true, duration_minutes: 45 },
          { name: 'Teeth cleaning', price: 1500, duration_minutes: 30, notes: 'includes polishing' },
          { name: 'Tooth extraction', price: 2500, duration_minutes: 20 },
          { name: 'Dental crown', price: 6000, price_from: true },
          { name: 'Teeth whitening', price: 3500, archived: true },
        ],
      },
      // Booking rules (S9): non-default values on every enforced knob, so the
      // page's plain-English summary reads as a real sentence rather than the
      // defaults, plus two of the three policy texts (the third stays empty to
      // show the optional state).
      booking: {
        slot_minutes: 20,
        advance_days: 30,
        buffer_minutes: 120,
        allow_same_day: true,
        cancellation_policy: 'Please call at least 4 hours before your appointment. There is no cancellation charge.',
        walk_in_policy: 'Walk-ins are welcome before 11am; you may have to wait up to 30 minutes.',
      },
      // Receptionist (S13): a name, a real Telugu greeting (this tenant's default
      // language — proves the Noto Telugu render), a Professional tone, Concise
      // length, and a distinct voice/pace so the saved state is unmistakably real.
      personality: {
        display_name: 'Asha',
        style: 'formal',
        response_length: 'concise',
      },
      greeting: {
        te: 'నమస్తే! సన్‌రైజ్ డెంటల్‌కు స్వాగతం. నేను ఆశా, మీకు ఎలా సహాయపడగలను?',
        hi: 'नमस्ते! सनराइज़ डेंटल में आपका स्वागत है।',
        en: 'Hello! This is Sunrise Dental, how can I help you today?',
      },
      voice: { sarvam_speaker: 'ritu', pace: 1.05 },
    };
    await configService.writeTenantConfig(tenantId, seedConfig, 'shoot'); // v1 — Veprio baseline

    // History (S17): two real owner edits on top of the baseline, so the S17
    // shots below have an actual multi-version timeline — one that changed
    // pricing, one that changed hours, both attributed to the owner ("You").
    // MUST deepMerge onto the CURRENT live config (writeTenantConfig merges its
    // `input` onto clinicDefaults, not onto the live document) — a plain
    // partial here would silently reset every other seeded section back to
    // defaults and corrupt every shot below that reads this tenant's config.
    // The final write restores seedConfig verbatim as v4, so every OTHER
    // shot in this script keeps seeing exactly the state its own comment
    // documents — only the History shots see the intermediate versions.
    const afterSeed = await configService.getTenantConfig(tenantId);
    await configService.writeTenantConfig(tenantId,
      configService.deepMerge(afterSeed, { pricing: { consultation_fee: 600 } }),
      'portal', { actorUserId: ownerUserId }); // v2: "Pricing changed"
    const afterPricing = await configService.getTenantConfig(tenantId);
    // hours is a discriminated union per day ({closed:true} XOR {open,close}) —
    // deepMerge is key-additive and would UNION the two branches (the exact trap
    // configService.js documents), so this replaces the one day wholesale via a
    // shallow spread, same as the real hours.html route (routes.js:584).
    await configService.writeTenantConfig(tenantId,
      { ...afterPricing, hours: { ...afterPricing.hours, sat: { open: '10:00', close: '13:00' } } },
      'portal', { actorUserId: ownerUserId }); // v3: "Hours & holidays changed"
    await configService.writeTenantConfig(tenantId, seedConfig, 'portal', { actorUserId: ownerUserId }); // v4 (current) — restores the baseline; "Pricing, Hours & holidays changed" (reverting both)

    // Pre-existing bug found while wiring the S17 shots (unrelated to History):
    // home.js (added PORTAL-P6-S16) redirects Home to wizard.html whenever
    // onboarding.step is null — true for EVERY tenant this script seeds, since
    // none of them ever call POST /api/onboarding. shoot.js was never updated
    // in lockstep with S16 (only the separate scripts/portal/shootWizard.js
    // was), so the home-desktop/-mobile shots have been silently failing ever
    // since S16 shipped — confirmed by rerunning the pre-S17 script unmodified.
    // Scoped fix: a fully-configured demo tenant HAS finished onboarding in any
    // honest sense, so mark it complete (writeTenantConfigMeta — no version
    // bump, no revision, consistent with the history seeded above).
    await configService.writeTenantConfigMeta(tenantId, { onboarding_step: 6, onboarding_completed: true });

    // Doctors (S8): NOT a config section — these are tenant_entities rows, the
    // storage appointmentService books against. Seeded to exercise every card
    // state at once: a doctor whose Wednesday runs past the clinic's 13:00 close
    // (quiet warning), a clean doctor, one with no working days ("Not bookable"),
    // and one archived (the "No longer seeing patients" card).
    const seedDoctor = (data, type = 'schedule') => db.query(
      'INSERT INTO tenant_entities (tenant_id, type, data) VALUES ($1,$2,$3)',
      [tenantId, type, JSON.stringify(data)]);
    await seedDoctor({ doctor: 'Dr. Sharma', specialization: 'Endodontist', languages: ['te', 'en'],
      days: ['Mon', 'Wed', 'Fri'], start: '10:00', end: '17:00' });
    await seedDoctor({ doctor: 'Dr. Reddy', specialization: 'Orthodontist', languages: ['te', 'hi', 'en'],
      days: ['Tue', 'Thu'], start: '09:00', end: '13:00' });
    await seedDoctor({ doctor: 'Dr. Naidu', specialization: 'Oral surgeon', languages: ['te'],
      days: [], start: '10:00', end: '16:00' });
    await seedDoctor({ doctor: 'Dr. Kulkarni', specialization: 'Periodontist', languages: ['hi', 'en'],
      days: ['Mon', 'Thu'], start: '11:00', end: '15:00' }, 'schedule_archived');

    // FAQs (S11): 3 real Q/A pairs — enough to show a genuine loaded list, but
    // deliberately UNDER the 5-chunk kb.populated threshold so the readiness
    // narrative below (kb checks still an owner action item) stays true.
    const faqService = require('../../src/modules/knowledge/faqService');
    await faqService.createFaq(tenantId,
      { question: 'Do you accept insurance?', answer: 'Yes — we accept Star Health, HDFC Ergo, and Niva Bupa.' },
      { languages: ['te', 'hi', 'en'] });
    await faqService.createFaq(tenantId,
      { question: 'Where can I park?', answer: 'Free parking is available in the Pearl Plaza basement.' },
      { languages: ['te', 'hi', 'en'] });
    await faqService.createFaq(tenantId,
      { question: 'Do you see children?', answer: 'Yes, Dr. Reddy sees patients of all ages, including children.', language: 'en' },
      { languages: ['te', 'hi', 'en'] });

    const run = await validationService.validateTenant(tenantId, {
      skip: ['turn.scripted'],
      deps: { getRelevantChunks: async () => [], pingNumber: async () => 'stub' },
    });
    const passed = run.checks.filter((c) => c.severity !== 'fail').length;
    console.log(`validation run: ${passed}/${run.checks.length} checks not-failed, skipped ${run.skipped.length}`);

    // A SECOND clinic with NO owner yet — the subject of the admin create-owner shot.
    const meadow = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Meadow Physiotherapy']);
    const meadowId = meadow.rows[0].id;
    await configService.writeTenantConfig(meadowId, {
      business: { display_name: 'Meadow Physiotherapy' },
    }, 'shoot');

    // A THIRD clinic with an owner but zero FAQs — the empty-state shot (S11).
    // Kept separate from Sunrise Dental (which now has 3 real FAQs) rather than
    // clearing Sunrise's, so the "loaded list" and "empty state" shots are both
    // real, simultaneously-true states.
    const freshEmail = 'owner@freshclinic.test';
    const freshPassword = 'demo-portal-pass-2';
    const fresh = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Fresh Clinic']);
    const freshId = fresh.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [freshId, freshEmail, hashPassword(freshPassword), 'owner']);

    // A FOURTH clinic that is genuinely READY to go live (PORTAL-P6-S18) — the
    // subject of the go-live / live / paused shots. Its config disables the
    // channels whose checks need operator-provisioned credentials
    // (whatsapp/voice) and the booking toggle that gates doctor.schedule +
    // turn.scripted, so the FULL catalog passes without a single check being
    // skipped — which is the only kind of "ready" the portal can produce, since
    // the owner path has no skip power at all (INV-3).
    const readyEmail = 'owner@readyclinic.test';
    const readyPassword = 'demo-portal-pass-3';
    const ready = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, false) RETURNING id",
      ['Ready Dental']);
    const readyId = ready.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [readyId, readyEmail, hashPassword(readyPassword), 'owner']);
    await configService.writeTenantConfig(readyId, {
      business: { display_name: 'Ready Dental', address: 'Road No. 12, Banjara Hills, Hyderabad' },
      notifications: { owner_numbers: ['+919000000001'], on_booking: true, on_escalation: true },
      escalation: { enabled: true, phone_numbers: ['+919000000002'] },
      whatsapp: { enabled: false }, voice: { enabled: false }, tools: { booking: false },
    }, 'shoot');
    await configService.writeTenantConfigMeta(readyId, { onboarding_step: 6, onboarding_completed: true });
    for (let i = 0; i < 5; i += 1) { // ≥5 chunks clears kb.populated
      await faqService.createFaq(readyId,
        { question: `Ready Dental question ${i + 1}?`, answer: `Answer ${i + 1}: we are open 9am to 6pm on weekdays.` },
        { languages: ['te', 'hi', 'en'] });
    }

    // ── A FIFTH clinic: LOTUS DENTAL, the COMPLEMENT fixture (S3d) ────────────
    // Sunrise Dental is a maximal tenant — every toggle on, every language on,
    // every optional field filled. That is the right subject for a screenshot
    // and the wrong one for an instrument: a switch that is never off has an
    // off style nobody has ever measured, and both the contrast sweep and the
    // 54-shot corpus then certify it green on ABSENCE. The census added beside
    // the sweep found the arms in question and named them:
    //
    //   .switch input:not(:checked)          never in any DOM  (BOTH switches)
    //   .pay-toggle[aria-pressed="false"]    never in any DOM
    //   .lang-toggle[aria-pressed="false"]   rendered — but ONLY on doctors.html,
    //                                        whose `.lang-toggle` rules are a
    //                                        SECOND, independent copy in
    //                                        doctors.css. The clinic-profile.css
    //                                        block that owns the chip an owner
    //                                        actually turns a language off with
    //                                        has never rendered its unpressed arm.
    //   .tr--archived / .tr__tag             in the DOM, ZERO client rects — the
    //                                        rows are seeded archived and the
    //                                        page hides them behind "Show
    //                                        archived", so nothing measured them.
    //
    // So this tenant is the other arm of each, seeded rather than poked: a clinic
    // with ONE language, handoff off, same-day booking off, one payment method
    // and two archived treatments is a clinic the product can genuinely be, and
    // every state above follows from its saved config rather than from a line of
    // test code reaching into the DOM. Sunrise is left exactly as it was — every
    // shot and every comment above it still documents the state it claims.
    const lotusEmail = 'owner@lotusdental.test';
    const lotusPassword = 'demo-portal-pass-4';
    const lotus = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Lotus Dental']);
    const lotusId = lotus.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [lotusId, lotusEmail, hashPassword(lotusPassword), 'owner']);
    await configService.writeTenantConfig(lotusId, {
      business: {
        display_name: 'Lotus Dental',
        address: 'Shop 4, Kalyan Arcade, Kukatpally, Hyderabad 500072',
        phone_numbers: ['+919812345670'],
      },
      // ONE language on. Telugu is this clinic's only language, so Hindi and
      // English render as unpressed chips — clinic-profile.css:37-64's resting
      // arm, measured for the first time.
      languages: { supported: ['te'], default: 'te' },
      greeting: { te: 'నమస్తే! లోటస్ డెంటల్. మీకు ఎలా సహాయం చేయగలను?' },
      notifications: { owner_numbers: ['+919000000001'] },
      // Handoff OFF. The number stays saved — turning the offer off is not the
      // same as deleting the number, and an owner who flips it back expects to
      // find it — so the page below the switch is populated, exactly as it would
      // be for a real clinic that decided not to offer callbacks.
      escalation: { enabled: false, phone_numbers: ['+919000000004'] },
      hours: { sun: { closed: true } },
      // One payment method, so `upi` and `card` are unpressed chips.
      pricing: {
        consultation_fee: 400,
        payment_methods: ['cash'],
        treatments: [
          { name: 'Scaling', price: 1200, duration_minutes: 30 },
          { name: 'Braces consultation', price: 800, archived: true },
          { name: 'Wisdom tooth removal', price: 5500, price_from: true, archived: true },
        ],
      },
      // Same-day booking OFF — the second `.switch`, and the only other one in
      // the portal.
      booking: { allow_same_day: false, slot_minutes: 30, advance_days: 14 },
    }, 'shoot');
    await configService.writeTenantConfigMeta(lotusId, { onboarding_step: 6, onboarding_completed: true });

    // ── A SIXTH clinic: PALM DENTAL — an owner and NO CONFIG ROW ─────────────
    // Seeded for one line: `.msg__prov-warn`, the amber warning under a test
    // reply that tells an owner the answer came from defaults rather than from
    // their settings. It is the one thing on that line an owner is meant to act
    // on, and neither instrument had ever rendered it.
    //
    // It takes a tenant with no `tenant_configs` row at all, and this fixture had
    // none — the reason is worth recording because the comment on Fresh Clinic
    // above says otherwise. `writeTenantConfigMeta` is not a metadata write on
    // top of an existing document: configService.js:197-202 INSERTs the row at
    // version 1 when none exists. Fresh Clinic takes that call for its onboarding
    // meta, so it HAS a config at version 1 and its test replies take the chip
    // arm, not the warning arm. "Never configured" is true of Fresh Clinic's
    // CONTENT and false of its storage.
    //
    // Palm Dental is the real shape instead: the admin panel's create-owner flow
    // writes a tenant and a user and nothing else, so a clinic between
    // provisioning and its first save is exactly this — which is the situation
    // the warning was written for.
    const palmEmail = 'owner@palmdental.test';
    const palmPassword = 'demo-portal-pass-5';
    const palm = await db.query("INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id",
      ['Palm Dental']);
    const palmId = palm.rows[0].id;
    await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true)',
      [palmId, palmEmail, hashPassword(palmPassword), 'owner']);

    // Fresh Clinic has never had a validation run, so its Go-live control is
    // ENABLED (nothing has been checked — pressing it IS the check). That makes
    // it the honest subject for the "blocked" dialog shot below: the press runs
    // a real validation, which really fails, and really names the blockers.
    await configService.writeTenantConfigMeta(freshId, { onboarding_step: 6, onboarding_completed: true });

    // S14: "Test your receptionist" runs a REAL turn through the real renderer +
    // real brain — stub the model + RAG here (in-process, same seam the test
    // suite uses) so that shot costs zero live Gemini calls, embedding included.
    knowledgeService.getRelevantChunks = async () => [];
    aiService._setModelProvider(() => ({
      startChat: () => ({
        sendMessage: async () => ({
          response: {
            functionCalls: () => undefined,
            text: () => 'The consultation fee is five hundred rupees.',
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 },
            candidates: [{ finishReason: 'STOP' }],
          },
        }),
      }),
    }));

    // Real /portal + /admin routers + static serving (mirrors server.js for these
    // paths). Admin needs its session middleware mounted before the router.
    const express = require('express');
    const session = require('express-session');
    const app = express();
    app.use('/portal', require('../../src/portal/routes'));
    app.use(session({
      secret: 'shoot-secret-abcdefghijklmnopqrstuvwx',
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 3600 * 1000 },
    }));
    app.use('/admin', require('../../src/admin/adminRoutes'));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    console.log('server on', port);

    const cookie = await loginCookie(port, email, password);
    const freshCookie = await loginCookie(port, freshEmail, freshPassword);
    const readyCookie = await loginCookie(port, readyEmail, readyPassword);
    const lotusCookie = await loginCookie(port, lotusEmail, lotusPassword);
    const palmCookie = await loginCookie(port, palmEmail, palmPassword);
    const adminCookie = await adminLoginCookie(port, process.env.ADMIN_PASSWORD);

    // Launch Chrome (reduced motion → deterministic ring/pulse).
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-shot-'));
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${DEVPORT}`, `--user-data-dir=${udd}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--force-prefers-reduced-motion=reduce', 'about:blank',
    ], { stdio: 'ignore' });

    ws = await openWs(await connectBrowser());
    const cdp = new CDP(ws);

    const base = `http://127.0.0.1:${port}/portal`;

    if (CONTRAST) {
      await runContrastSweep(cdp, base,
        { owner: cookie, lotus: lotusCookie, palm: palmCookie }, port);
      return; // measure-only: the finally below still tears the scratch DB down
    }

    console.log('capturing:');
    await shoot(cdp, { url: `${base}/login.html`, out: path.join(OUT, 'login-desktop.png'),
      width: 1280, height: 860, port, waitFor: "document.getElementById('form')" });
    await shoot(cdp, { url: `${base}/login.html`, out: path.join(OUT, 'login-mobile.png'),
      width: 380, height: 820, mobile: true, port, waitFor: "document.getElementById('form')" });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 'home-desktop.png'),
      width: 1280, height: 900, cookie, port,
      waitFor: "document.querySelector('.ring')||document.querySelector('.emp')" });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 'home-mobile.png'),
      width: 380, height: 820, mobile: true, cookie, port,
      waitFor: "document.querySelector('.ring')||document.querySelector('.emp')" });

    // All three S4 shots need one precondition: the profile form REVEALED and
    // CARRYING the seeded tenant’s values. The gate used to read
    // `!profileCard.hidden`, and 0881e75 made that vacuous — it moved `hidden`
    // from #profileCard onto the #profileForm that now wraps it, and
    // Element.hidden reflects only its OWN attribute: it does NOT inherit from a
    // hidden ancestor. The gate has therefore been a constant `true` since first
    // paint. The two still shots got away with it on the 1300ms settle below;
    // the error shot did not, because its afterReady runs BEFORE that sleep and
    // was injecting into a form /api/config/identity had not filled yet — which
    // is why s4-profile-error.png has been failing outright at HEAD.
    // clinic-profile.js reveals at :218, strictly after fill() at :211, so
    // `!hidden` already implies filled; the value and phone-row terms are here so
    // that a future reveal-before-fill cannot quietly re-open the same hole.
    const profileReady =
      "(function(){var f=document.getElementById('profileForm');"
      + "return !!f && !f.hidden"
      + " && document.getElementById('display_name').value !== ''"
      + " && !!document.querySelector('.phone-row .input');})()";
    // S4: clinic profile — the first config-write page. Desktop + 380px show the
    // loaded form (the seeded tenant carries real identity values); the third shot
    // captures the field-level validation state (empty name + a malformed phone →
    // Save → inline errors that name the fix).
    await shoot(cdp, { url: `${base}/clinic-profile.html`, out: path.join(OUT, 's4-profile-desktop.png'),
      width: 1280, height: 1000, cookie, port,
      waitFor: profileReady });
    await shoot(cdp, { url: `${base}/clinic-profile.html`, out: path.join(OUT, 's4-profile-mobile.png'),
      width: 380, height: 900, mobile: true, cookie, port,
      waitFor: profileReady });
    await shoot(cdp, {
      url: `${base}/clinic-profile.html`, out: path.join(OUT, 's4-profile-error.png'),
      width: 1280, height: 1000, cookie, port,
      waitFor: profileReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('display_name').value='';"
            + "var ph=document.querySelector('.phone-row .input');"
            + "if(!ph){document.getElementById('addPhone').click();ph=document.querySelector('.phone-row .input');}"
            + "ph.value='not a phone';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S5: hours & holidays — the second config-write page. Desktop + 380px show the
    // loaded 7-day grid (Wednesday short, Saturday closed) + the holiday rows (one
    // past, de-emphasised). The third shot captures the validation state (Wednesday
    // close-before-open → Save → an inline per-row error that names the fix).
    const hoursReady = "document.getElementById('hoursForm') && !document.getElementById('hoursForm').hidden";
    await shoot(cdp, { url: `${base}/hours.html`, out: path.join(OUT, 's5-hours-desktop.png'),
      width: 1280, height: 1100, cookie, port, waitFor: hoursReady });
    await shoot(cdp, { url: `${base}/hours.html`, out: path.join(OUT, 's5-hours-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie, port, waitFor: hoursReady });
    await shoot(cdp, {
      url: `${base}/hours.html`, out: path.join(OUT, 's5-hours-error.png'),
      width: 1280, height: 1100, cookie, port, waitFor: hoursReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){var w=document.querySelector('.day[data-day=\"wed\"]');"
            + "w.querySelector('[data-role=\"open\"]').value='18:00';"
            + "w.querySelector('[data-role=\"close\"]').value='09:00';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.day.is-invalid')");
      },
    });

    // S6: pricing — the third config-write page. Desktop + 380px show the loaded
    // fees, the treatment rows (a "starts at" price, durations, a note) and the
    // payment/insurance card; the archived row sits behind "Show archived (1)".
    // The third shot captures two validation states at once: a non-integer fee and
    // a duplicate ACTIVE treatment name → Save → inline errors that name the fix.
    const pricingReady = "document.getElementById('pricingForm') && !document.getElementById('pricingForm').hidden";
    await shoot(cdp, { url: `${base}/pricing.html`, out: path.join(OUT, 's6-pricing-desktop.png'),
      width: 1280, height: 1200, cookie, port, waitFor: pricingReady });
    await shoot(cdp, { url: `${base}/pricing.html`, out: path.join(OUT, 's6-pricing-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie, port, waitFor: pricingReady });
    await shoot(cdp, {
      url: `${base}/pricing.html`, out: path.join(OUT, 's6-pricing-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: pricingReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('consultation_fee').value='12.5';"
            + "var rows=document.querySelectorAll('.tr');"
            + "rows[1].querySelector('.tr__name').value=rows[0].querySelector('.tr__name').value;"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.tr.is-invalid')");
      },
    });

    // S8: doctors — the first page that is NOT a config section (these rows drive
    // real bookings). Desktop + 380px show the loaded cards: a doctor carrying the
    // outside-clinic-hours warning, a clean one, one flagged "Not bookable", and
    // the archived card beneath. The third shot captures the validation state —
    // renaming a doctor to one that already exists → Save → the inline duplicate
    // error that names the fix.
    const doctorsReady = "document.querySelector('.doc') || !document.getElementById('emptyCard').hidden";
    await shoot(cdp, { url: `${base}/doctors.html`, out: path.join(OUT, 's8-doctors-desktop.png'),
      width: 1280, height: 1200, cookie, port, waitFor: doctorsReady });
    await shoot(cdp, { url: `${base}/doctors.html`, out: path.join(OUT, 's8-doctors-mobile.png'),
      width: 380, height: 1000, mobile: true, cookie, port, waitFor: doctorsReady });
    await shoot(cdp, {
      url: `${base}/doctors.html`, out: path.join(OUT, 's8-doctors-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: doctorsReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){var d=document.querySelectorAll('.doc');"
            + "var first=d[0].querySelector('.input').value;"
            + "d[1].querySelector('.input').value=first;"
            + "d[1].querySelector('[data-role=\"save\"]').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.doc .field.is-invalid')");
      },
    });

    // S9: booking rules — the first page whose every control changes enforced
    // behaviour (F-006). Desktop + 380px show the plain-English summary derived
    // from the saved rules, the four enforced settings, and the policy texts under
    // the heading that says they are recited, not enforced. The third shot is the
    // validation state that matters most: advance_days = 0, which looks like
    // "stop taking bookings" and is actually undefined — the error names the real
    // way to do that.
    const bookingReady = "document.getElementById('bookingForm') && !document.getElementById('bookingForm').hidden";
    await shoot(cdp, { url: `${base}/booking-rules.html`, out: path.join(OUT, 's9-booking-desktop.png'),
      width: 1280, height: 1200, cookie, port, waitFor: bookingReady });
    await shoot(cdp, { url: `${base}/booking-rules.html`, out: path.join(OUT, 's9-booking-mobile.png'),
      width: 380, height: 1100, mobile: true, cookie, port, waitFor: bookingReady });
    await shoot(cdp, {
      url: `${base}/booking-rules.html`, out: path.join(OUT, 's9-booking-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: bookingReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('advance_days').value='0';"
            + "document.getElementById('buffer_minutes').value='500';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S10: safety & handoff — the escalation/emergency form plus the read-only
    // protections panel. Desktop + 380px show the whole page; the third shot is
    // the panel alone (scrolled to it), which is the deliverable that has to be
    // legible on its own; the fourth is the validation state that matters most
    // here — a number typed without its country code, which normalizePhone would
    // otherwise turn into a real number in another country.
    const safetyReady = "document.getElementById('safetyForm') && !document.getElementById('safetyForm').hidden"
      + " && document.getElementById('protCard') && !document.getElementById('protCard').hidden";
    await shoot(cdp, { url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-desktop.png'),
      width: 1280, height: 1500, cookie, port, waitFor: safetyReady });
    await shoot(cdp, { url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-mobile.png'),
      width: 380, height: 1400, mobile: true, cookie, port, waitFor: safetyReady });
    await shoot(cdp, {
      url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-protections.png'),
      width: 1280, height: 1000, cookie, port, waitFor: safetyReady,
      // Full-page capture ignores scrolling, so the panel is isolated by hiding
      // the form above it — the shot is evidence about the panel, not the page.
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('safetyForm').hidden=true;",
        }, sid);
        await sleep(200);
      },
    });
    await shoot(cdp, {
      url: `${base}/safety.html`, out: path.join(OUT, 's10-safety-error.png'),
      width: 1280, height: 1100, cookie, port, waitFor: safetyReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.querySelector('.phone-row .input').value='9876543210';"
            + "document.getElementById('emergency_number').value='98765-BAD';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S11: FAQs — the first page writing knowledge_chunks. Desktop + 380px show
    // Sunrise Dental's 3 real FAQs (loaded, not-yet-enough-for-readiness state);
    // the third shot is Fresh Clinic's genuine empty state (the example-question
    // instruction, spec §4); the fourth adds a blank card and saves it empty →
    // the inline "question is required" / "answer is required" errors.
    const faqsReady = "document.querySelector('.faq') || !document.getElementById('emptyCard').hidden";
    await shoot(cdp, { url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-desktop.png'),
      width: 1280, height: 1100, cookie, port, waitFor: faqsReady });
    await shoot(cdp, { url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-mobile.png'),
      width: 380, height: 1200, mobile: true, cookie, port, waitFor: faqsReady });
    await shoot(cdp, { url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-empty.png'),
      width: 1280, height: 900, cookie: freshCookie, port, waitFor: faqsReady });
    await shoot(cdp, {
      url: `${base}/faqs.html`, out: path.join(OUT, 's11-faqs-error.png'),
      width: 1280, height: 1200, cookie, port, waitFor: faqsReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('addFaq').click();"
            + "var cards=document.querySelectorAll('.faq');"
            + "cards[cards.length-1].querySelector('[data-role=\"save\"]').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.faq .field.is-invalid')");
      },
    });

    // S13: receptionist — persona + voice. Desktop + 380px show the loaded page:
    // the "Asha" self-intro name, the Professional/Concise segmented controls,
    // the three greeting fields (Telugu is Sunrise Dental's DEFAULT language —
    // this is the Telugu-rendering proof, in the self-hosted Noto Sans Telugu
    // font, marked "Default"), and the Voice card's amber known-gap notice. The
    // third shot isolates the greeting card alone (same isolation technique as
    // S10's protections-panel shot) so the Telugu render is unambiguous evidence
    // on its own. The fourth is the validation state that matters most on this
    // page: clearing the DEFAULT language's greeting → Save → the inline
    // "it's your default language" error.
    const receptionistReady = "document.getElementById('receptionistForm') && !document.getElementById('receptionistForm').hidden";
    await shoot(cdp, { url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-desktop.png'),
      width: 1280, height: 1400, cookie, port, waitFor: receptionistReady });
    await shoot(cdp, { url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-mobile.png'),
      width: 380, height: 1500, mobile: true, cookie, port, waitFor: receptionistReady });
    await shoot(cdp, {
      url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-telugu-greeting.png'),
      width: 1280, height: 500, cookie, port, waitFor: receptionistReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('personaCard').hidden=true;"
            + "document.getElementById('voiceCard').hidden=true;",
        }, sid);
        await sleep(200);
      },
    });
    await shoot(cdp, {
      url: `${base}/receptionist.html`, out: path.join(OUT, 's13-receptionist-error.png'),
      width: 1280, height: 1400, cookie, port, waitFor: receptionistReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression:
            "(function(){document.getElementById('greet-te').value='';"
            + "document.getElementById('saveBtn').click();})();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.field.is-invalid')");
      },
    });

    // S14: test your receptionist — one real turn through the real renderer +
    // real brain (model stubbed above so this costs zero live Gemini calls).
    // Desktop + 380px show the empty state (starter questions); the third shot
    // clicks a starter and waits for the receptionist bubble + its provenance
    // line; the fourth is the daily-limit state, shot against Fresh Clinic after
    // pre-seeding 20 turn_traces rows so the very first click already hits it.
    // Waits for test.js's main() to finish (async, gated on window.Portal.me) —
    // NOT just the static #chatForm element existing, which is present from
    // first paint and would race the click-handler wiring (found live: the
    // reply/limited shots' afterReady click landed on a still-unwired button).
    const testReady = "document.body.dataset.testReady === '1'";
    await shoot(cdp, { url: `${base}/test.html`, out: path.join(OUT, 's14-test-desktop.png'),
      width: 1280, height: 900, cookie, port, waitFor: testReady });
    await shoot(cdp, { url: `${base}/test.html`, out: path.join(OUT, 's14-test-mobile.png'),
      width: 380, height: 820, mobile: true, cookie, port, waitFor: testReady });
    await shoot(cdp, {
      url: `${base}/test.html`, out: path.join(OUT, 's14-test-reply.png'),
      width: 1280, height: 900, cookie, port, waitFor: testReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.starter[data-q=\"What is the consultation fee?\"]').click();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.msg__prov')");
      },
    });

    // ── S3d: THE OFF ARM — states the maximal tenant cannot be in ────────────
    // Five shots, all desktop: four of Lotus Dental and one of Palm Dental. Each
    // is the OFF arm of a control every existing shot in this file shows
    // switched on, and each was named by the state census that now runs beside
    // the contrast sweep. Before this block the corpus was 54 pictures of a
    // clinic with everything turned on, and no picture at all of what the portal
    // looks like when an owner turns something off.
    //
    // The matching sweep entries are in CONTRAST_PAGES above — six of them, one
    // more than there are shots here, because `test.html[replied]` is already
    // photographed by s14-test-reply. Same seeded config, same real controls:
    // one fixture, measured and photographed.
    //
    // Placed beside S14 because the last shot is a test turn, and every test
    // turn in this file lives here. It spends one of PALM Dental's daily turns,
    // not Fresh Clinic's, so the loop below — which seeds 20 turn_traces onto
    // Fresh to force the daily-limit state for s14-test-limited — is unaffected
    // whichever side of it this block sits on.
    await shoot(cdp, {
      url: `${base}/clinic-profile.html`, out: path.join(OUT, 's3d-profile-one-language.png'),
      width: 1280, height: 1000, cookie: lotusCookie, port, waitFor: profileReady });
    await shoot(cdp, {
      url: `${base}/safety.html`, out: path.join(OUT, 's3d-safety-handoff-off.png'),
      width: 1280, height: 1500, cookie: lotusCookie, port, waitFor: safetyReady });
    await shoot(cdp, {
      url: `${base}/booking-rules.html`, out: path.join(OUT, 's3d-booking-same-day-off.png'),
      width: 1280, height: 1100, cookie: lotusCookie, port, waitFor: bookingReady });
    await shoot(cdp, {
      // The archived rows are seeded archived; the disclosure that reveals them
      // is not persisted anywhere, so the shot clicks the owner's own checkbox
      // and waits for pricing.js to drop `.tr--hidden` rather than sleeping.
      url: `${base}/pricing.html`, out: path.join(OUT, 's3d-pricing-archived-shown.png'),
      width: 1280, height: 1100, cookie: lotusCookie, port, waitFor: pricingReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('showArchived').click();",
        }, sid);
        await waitForSelector(c, sid,
          "document.querySelector('.tr--archived') && "
          + "!document.querySelector('.tr--archived').classList.contains('tr--hidden')");
      },
    });
    await shoot(cdp, {
      // Palm Dental has no config ROW — not merely an empty one — so the reply's
      // provenance line takes its OTHER arm: the amber `.msg__prov-warn` telling
      // the owner the reply came from defaults, not from their settings.
      url: `${base}/test.html`, out: path.join(OUT, 's3d-test-no-config.png'),
      width: 1280, height: 900, cookie: palmCookie, port, waitFor: testReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.starter').click();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.msg__prov-warn')");
      },
    });

    for (let i = 0; i < 20; i++) {
      await db.query(`INSERT INTO turn_traces (tenant_id, channel) VALUES ($1, 'test')`, [freshId]);
    }
    await shoot(cdp, {
      url: `${base}/test.html`, out: path.join(OUT, 's14-test-limited.png'),
      width: 1280, height: 900, cookie: freshCookie, port, waitFor: testReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.starter[data-q=\"What are your timings?\"]').click();",
        }, sid);
        await waitForSelector(c, sid, "document.querySelector('.msg--system')");
      },
    });

    // S15: what it knows — read-only reflection of the same seeded config used by
    // every page above (pricing, doctors, booking, FAQs, safety, receptionist).
    // Desktop + 380px show every card populated for real; the third isolates the
    // Telugu greeting row (same technique as S13) since the tenant's default
    // language is Telugu — the zero-tofu proof for THIS page, not just S13's.
    const knowsReady = "document.getElementById('sections') && !document.getElementById('sections').hidden";
    await shoot(cdp, { url: `${base}/knows.html`, out: path.join(OUT, 's15-knows-desktop.png'),
      width: 1280, height: 2200, cookie, port, waitFor: knowsReady });
    await shoot(cdp, { url: `${base}/knows.html`, out: path.join(OUT, 's15-knows-mobile.png'),
      width: 380, height: 2600, mobile: true, cookie, port, waitFor: knowsReady });
    await shoot(cdp, {
      url: `${base}/knows.html`, out: path.join(OUT, 's15-knows-telugu-greeting.png'),
      width: 1280, height: 500, cookie, port, waitFor: knowsReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "['card-clinic','card-hours','card-pricing','card-doctors','card-booking','card-faqs','card-safety','card-protections']"
            + ".forEach(function(id){document.getElementById(id).hidden=true;});",
        }, sid);
        await sleep(200);
      },
    });
    // Fresh Clinic: the never-configured tenant — every gated section's honest
    // fallback copy, in one shot (pricing/doctors/booking/FAQs/emergency all empty).
    await shoot(cdp, { url: `${base}/knows.html`, out: path.join(OUT, 's15-knows-empty.png'),
      width: 1280, height: 1600, cookie: freshCookie, port, waitFor: knowsReady });

    // S17: History — configuration history + restore. Desktop + 380px show the
    // 4-version timeline seeded above (Veprio's baseline write, two real owner
    // edits, and the owner's own revert) with genuine "You"/"Veprio"
    // attribution and per-version changed-section summaries. The third shot
    // opens v2's version-detail modal — pricing at ₹600, the value BEFORE the
    // later revert, proof the snapshot reflects THAT version and not the live
    // one — with its "Restore this version" action visible (hidden only for the
    // current version, v4). The fourth opens the restore confirmation modal from
    // inside it.
    const histReady = "!document.getElementById('listCard').hidden || !document.getElementById('emptyCard').hidden";
    await shoot(cdp, { url: `${base}/history.html`, out: path.join(OUT, 's17-history-desktop.png'),
      width: 1280, height: 900, cookie, port, waitFor: histReady });
    await shoot(cdp, { url: `${base}/history.html`, out: path.join(OUT, 's17-history-mobile.png'),
      width: 380, height: 900, mobile: true, cookie, port, waitFor: histReady });
    await shoot(cdp, {
      url: `${base}/history.html`, out: path.join(OUT, 's17-history-detail.png'),
      width: 1280, height: 900, cookie, port, waitFor: histReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.hist-row[data-version=\"2\"]').click();",
        }, sid);
        await waitForSelector(c, sid, "!document.getElementById('detailModal').hidden");
      },
    });
    await shoot(cdp, {
      url: `${base}/history.html`, out: path.join(OUT, 's17-history-restore-confirm.png'),
      width: 1280, height: 900, cookie, port, waitFor: histReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.querySelector('.hist-row[data-version=\"2\"]').click();",
        }, sid);
        await waitForSelector(c, sid, "!document.getElementById('detailModal').hidden");
        await c.send('Runtime.evaluate', { expression: "document.getElementById('restoreBtn').click();" }, sid);
        await waitForSelector(c, sid, "!document.getElementById('confirmModal').hidden");
      },
    });

    // ── S18: the go-live flow, driven through the REAL control ──────────────
    // Every shot below is a genuine transition: the button posts to
    // /portal/api/lifecycle/*, which runs the real validate → activate chain.
    // Order is load-bearing — Ready Dental moves draft → live → paused across
    // these shots, so each one captures the state the previous shot left.
    const homeReady = "document.querySelector('#checks .check, #readinessCard .emp')";
    const goLiveBtn = "document.querySelector('[data-lifecycle=\"activate\"]')";
    const modalUp = "document.querySelector('.modal-host .modal')";

    // 1. Eligible: every check green, Go live enabled.
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-golive-ready.png'),
      width: 1280, height: 900, cookie: readyCookie, port, waitFor: homeReady });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-golive-ready-mobile.png'),
      width: 380, height: 900, mobile: true, cookie: readyCookie, port, waitFor: homeReady });

    // 2. The confirm modal (does NOT confirm — state stays draft for shot 3).
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-golive-confirm.png'),
      width: 1280, height: 900, cookie: readyCookie, port, waitFor: homeReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: `${goLiveBtn}.click();` }, sid);
        await waitForSelector(c, sid, modalUp);
      },
    });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-golive-confirm-mobile.png'),
      width: 380, height: 900, mobile: true, cookie: readyCookie, port, waitFor: homeReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: `${goLiveBtn}.click();` }, sid);
        await waitForSelector(c, sid, modalUp);
      },
    });

    // 3. Confirm for real → live. Banner, ring and header all reflect it without
    //    a reload (the action re-renders from its own response).
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-live.png'),
      width: 1280, height: 900, cookie: readyCookie, port, waitFor: homeReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: `${goLiveBtn}.click();` }, sid);
        await waitForSelector(c, sid, modalUp);
        await c.send('Runtime.evaluate', { expression: "document.querySelector('.modal [data-confirm]').click();" }, sid);
        await waitForSelector(c, sid, "document.querySelector('[data-lifecycle=\"pause\"]')");
      },
    });

    // 4. Pause confirmation (does NOT confirm — state stays live for shot 5).
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-pause-confirm.png'),
      width: 1280, height: 900, cookie: readyCookie, port,
      waitFor: "document.querySelector('[data-lifecycle=\"pause\"]')",
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: "document.querySelector('[data-lifecycle=\"pause\"]').click();" }, sid);
        await waitForSelector(c, sid, modalUp);
      },
    });

    // 5. Confirm the pause → paused + Resume control.
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-paused.png'),
      width: 1280, height: 900, cookie: readyCookie, port,
      waitFor: "document.querySelector('[data-lifecycle=\"pause\"]')",
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: "document.querySelector('[data-lifecycle=\"pause\"]').click();" }, sid);
        await waitForSelector(c, sid, modalUp);
        await c.send('Runtime.evaluate', { expression: "document.querySelector('.modal [data-confirm]').click();" }, sid);
        await waitForSelector(c, sid, "document.querySelector('[data-lifecycle=\"resume\"]')");
      },
    });
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-paused-mobile.png'),
      width: 380, height: 900, mobile: true, cookie: readyCookie, port,
      waitFor: "document.querySelector('[data-lifecycle=\"resume\"]')" });

    // 6. The REFUSAL — Fresh Clinic has never been checked, so its control is
    //    enabled; pressing it runs a real validation that really fails, and the
    //    dialog names each blocking check with the page that fixes it.
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-golive-blocked.png'),
      width: 1280, height: 900, cookie: freshCookie, port, waitFor: homeReady,
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', { expression: `${goLiveBtn}.click();` }, sid);
        await waitForSelector(c, sid, modalUp);
        await c.send('Runtime.evaluate', { expression: "document.querySelector('.modal [data-confirm]').click();" }, sid);
        await waitForSelector(c, sid, "document.querySelector('.lc-blocks')");
      },
    });
    // 7. …and the state that press LEAVES the owner in, at 380px. The refusal
    //    persisted a real (failing) validation run, so the control is now
    //    correctly locked with the owner's own blocker count beside it — the
    //    state a mid-setup owner actually lives in. The dialog itself is already
    //    covered at 380px by s18-golive-confirm-mobile (same modal component).
    await shoot(cdp, { url: `${base}/index.html`, out: path.join(OUT, 's18-golive-blocked-after-mobile.png'),
      width: 380, height: 900, mobile: true, cookie: freshCookie, port, waitFor: homeReady });

    // S3: admin "create owner account" — fill the email, click Create, wait for the
    // one-time password panel, then capture. Uses the admin connect.sid cookie.
    await shoot(cdp, {
      url: `http://127.0.0.1:${port}/admin/tenant-detail.html?id=${meadowId}`,
      out: path.join(OUT, 's3-admin-create-owner.png'),
      width: 1280, height: 900, cookie: adminCookie, port,
      waitFor: "document.getElementById('ownerCreateBtn') && document.getElementById('detail').style.display==='block'",
      afterReady: async (c, sid) => {
        await c.send('Runtime.evaluate', {
          expression: "document.getElementById('ownerEmail').value='owner@meadowphysio.example';"
            + "document.getElementById('ownerCreateBtn').click();",
        }, sid);
        await waitForSelector(c, sid,
          "document.getElementById('ownerResult') && getComputedStyle(document.getElementById('ownerResult')).display!=='none'");
      },
    });

    console.log('done →', OUT);
    printQuarantine();
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { if (chrome) chrome.kill(); } catch (_) {}
    try { if (server) server.close(); } catch (_) {}
    try { if (db) await db.close(); } catch (_) {}
    const c1 = new Client({ connectionString: ADMIN, ssl: SSL });
    await c1.connect();
    try {
      await c1.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c1.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c1.end(); }
    console.log('cleaned up scratch DB');
  }
})().catch((e) => { console.error('shoot failed:', e); process.exit(1); });
