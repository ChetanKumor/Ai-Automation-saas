'use strict';

// HERO-1 phase 4.1 — the hero conversation can be switched between languages
// mid-playback, and this file pins what the clock does when it is.
//
// THE DEFECT THIS EXISTS FOR. usePlayback's rAF chain schedules its own
// successor from inside `tick`, and `tick` closes over the timeline it was built
// with. Changing the language rebuilds the timeline and re-renders — but the
// chain already in flight keeps running the OUTGOING language's numbers, for the
// rest of the sequence. The reader sees the new script's words arriving on the
// old script's cadence, and the turn they were in the middle of never restarts.
//
// WHY TOTALS CANNOT TEST IT, and why every assertion below is about phrase
// BOUNDARIES. Telugu's sequence is 13207.5ms and English's is 13203.33ms — 4.17ms
// apart, deliberately, so that switching does not change how much of the
// conversation is left. Any assertion on the total, on the completion time or on
// data-playback-total therefore passes just as happily on the broken code. What
// the two languages do NOT share is where inside a turn each phrase lands: those
// boundaries are hundreds of milliseconds apart, they are the only signal that
// discriminates, and this file refuses to pass if that margin ever collapses.
//
// WHY IT DRIVES ITS OWN CLOCK. A timing defect tested against a real clock is a
// second intermittent, and this suite already carries one nobody could name. So
// nothing here waits: requestAnimationFrame and the reduced-motion media query
// are fakes the test steps by hand, one millisecond at a time. Seventeen seconds
// of playback run in a fraction of that, with the same answer every run.
//
// WHY A CHILD PROCESS, AND WHAT "react" MEANS HERE. usePlayback.ts is TypeScript
// and the root suite is plain CommonJS with no loader, so the module is imported
// for real in a child that can strip types — the same device
// conversationLanguages.test.js uses for cadence.ts, and for the same reason: a
// regex over a .ts file passes because it matched a string.
//
// That child resolves the specifier "react" to the small runtime below rather
// than to web/node_modules/react. React is not installed at the repo root, it
// needs a DOM to run effects, and none of that is what is under test — the hook
// is. The runtime implements the five hooks usePlayback uses, to their
// documented contract and nothing more: useMemo/useCallback recompute iff a
// dependency changes by Object.is, useRef is a stable box, useState bails out on
// an Object.is-equal write, useEffect runs after commit and cleans up before it
// re-runs. The hook itself is imported byte-for-byte unmodified, which is the
// point: the stale closure under test is the one that ships.
//
// THE RUNTIME IS NOT TAKEN ON FAITH. Two scenarios play a language straight
// through with no switch at all, and assertion 1 requires every boundary they
// produce to fall on the real buildTimeline's step starts. A runtime that got the
// closure or dependency semantics wrong would fail those before it could lie
// about a switch. The red this file was written against also reproduces, to
// within the sampling step, the boundary table a CDP probe measured against a
// real browser in phase 4.
//
// ONE test() block, for the reason its two neighbours in this directory state:
// the suite total is a tracked number and a per-assertion block would move it
// every time a scenario is added.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'web', 'components', 'sections', 'conversation');

// The sampling step, in milliseconds, and the tolerance it earns. An observed
// boundary is the first sample at or after the true one, so it is at most one
// step late; restarting the rAF chain costs one further step, because the frame
// after a restart contributes no elapsed time (the same rule that makes pause
// exact). Two steps of slack, plus one for arithmetic.
const STEP = 1;
const TOL = 3;

// Below this, the two languages' boundaries sit too close together for any
// observation to say which timeline the frames followed, and this whole file
// would be green without being able to fail. The measured minimum is over a
// second: this is a floor under a cliff, not a threshold anyone has to tune.
const MARGIN_MS = 50;

// ── the child ────────────────────────────────────────────────────────────────
//
// Two modules delivered as data: URLs, so the experiment adds no file to the
// tree and leaves nothing behind. NEITHER SOURCE MAY CONTAIN A BACKTICK OR A
// DOLLAR-BRACE: they are template literals, and either one would terminate or
// interpolate the source instead of shipping it.

const REACT_SRC = `
let cur = null;
function slot(make) {
  const inst = cur;
  if (inst === null) throw new Error('hook called outside render');
  const i = inst.i++;
  if (inst.hooks.length <= i) inst.hooks.push(make());
  return inst.hooks[i];
}
function sameDeps(a, b) {
  if (a === null || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (!Object.is(a[k], b[k])) return false;
  return true;
}
export function useState(init) {
  const inst = cur;
  const h = slot(() => ({ v: typeof init === 'function' ? init() : init, set: null }));
  if (h.set === null) {
    h.set = (next) => {
      const v = typeof next === 'function' ? next(h.v) : next;
      if (Object.is(v, h.v)) return;
      h.v = v;
      inst.dirty = true;
    };
  }
  return [h.v, h.set];
}
export function useRef(initial) { return slot(() => ({ current: initial })); }
export function useMemo(fn, deps) {
  const h = slot(() => ({ deps: null, v: undefined }));
  if (!sameDeps(h.deps, deps)) { h.v = fn(); h.deps = deps === undefined ? null : deps; }
  return h.v;
}
export function useCallback(fn, deps) { return useMemo(() => fn, deps); }
function pushEffect(kind, fn, deps) {
  const inst = cur;
  const h = slot(() => ({ deps: null, cleanup: undefined, first: true }));
  if (h.first || !sameDeps(h.deps, deps)) {
    h.first = false;
    h.deps = deps === undefined ? null : deps;
    inst.pending[kind].push([h, fn]);
  }
}
export function useEffect(fn, deps) { pushEffect('passive', fn, deps); }
export function useLayoutEffect(fn, deps) { pushEffect('layout', fn, deps); }
function renderOnce(inst) {
  inst.i = 0;
  inst.dirty = false;
  inst.pending = { layout: [], passive: [] };
  cur = inst;
  try { inst.result = inst.fn(inst.props); } finally { cur = null; }
  for (const kind of ['layout', 'passive']) {
    const list = inst.pending[kind];
    for (const e of list) if (typeof e[0].cleanup === 'function') e[0].cleanup();
    for (const e of list) { const c = e[1](); e[0].cleanup = typeof c === 'function' ? c : undefined; }
  }
  inst.pending = null;
}
export function flush(inst) {
  let guard = 0;
  while (inst.dirty) {
    renderOnce(inst);
    if (++guard > 50) throw new Error('render loop did not settle');
  }
}
export function mount(fn, props) {
  const inst = { fn, props, hooks: [], i: 0, dirty: false, result: undefined, pending: null };
  renderOnce(inst);
  flush(inst);
  return inst;
}
export function setProps(inst, props) { inst.props = props; inst.dirty = true; flush(inst); }
`;

// "react" is the runtime above. "./cadence" gains its extension, because Node's
// type stripping does not add one and the source is written for a bundler.
const LOADER_SRC = (reactUrl) => `
const REACT = ${JSON.stringify(reactUrl)};
const EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css'];
export async function resolve(spec, ctx, next) {
  if (spec === 'react') return { url: REACT, shortCircuit: true };
  if (spec.startsWith('.') && !EXT.some((e) => spec.endsWith(e))) {
    try { return await next(spec + '.ts', ctx); } catch (e) { /* fall through */ }
  }
  return next(spec, ctx);
}
`;

/** Every scenario, run in one child. No expectation travels into the child: it
 *  reports what the hook did, and the analysis below judges it. */
function probe() {
  const reactUrl = 'data:text/javascript,' + encodeURIComponent(REACT_SRC);
  const loaderUrl = 'data:text/javascript,' + encodeURIComponent(LOADER_SRC(reactUrl));
  const src = [
    'import { register } from "node:module";',
    'import { readFileSync } from "node:fs";',
    'register(' + JSON.stringify(loaderUrl) + ');',
    'const R = await import(' + JSON.stringify(reactUrl) + ');',
    'const { buildTimeline } = await import(' +
      JSON.stringify(pathToFileURL(path.join(DIR, 'cadence.ts')).href) + ');',
    'const { usePlayback } = await import(' +
      JSON.stringify(pathToFileURL(path.join(DIR, 'usePlayback.ts')).href) + ');',
    'const DIR = ' + JSON.stringify(DIR.split(path.sep).join('/')) + ';',
    'const read = (p) => JSON.parse(readFileSync(p, "utf8"));',
    'const META = read(DIR + "/meta.json");',
    'const TURNS = {}, TL = {};',
    'for (const code of ["en", "te"]) {',
    '  const s = read(DIR + "/" + code + ".json");',
    '  TURNS[code] = META.map((m) => ({ ...m, ...s[m.id], lang: code }));',
    '  TL[code] = buildTimeline(TURNS[code], code);',
    '}',
    // The clock, and the two browser globals the hook reaches for. A callback
    // registered during a frame waits for the NEXT one, exactly as a browser
    // schedules it — and two chains in flight at once is an error, not a leak
    // to be noticed later.
    'let now = 0, nextId = 1, maxChains = 0;',
    'const scheduled = new Map();',
    'globalThis.requestAnimationFrame = (cb) => { const id = nextId++; scheduled.set(id, cb); return id; };',
    'globalThis.cancelAnimationFrame = (id) => { scheduled.delete(id); };',
    'let REDUCED = false;',
    'globalThis.window = {',
    '  matchMedia: () => ({ matches: REDUCED, addEventListener() {}, removeEventListener() {} }),',
    '  setTimeout: () => nextId++,',
    '  clearTimeout: () => {},',
    '};',
    'function frame(dt) {',
    '  now += dt;',
    '  const batch = [...scheduled.values()];',
    '  scheduled.clear();',
    '  if (batch.length > maxChains) maxChains = batch.length;',
    '  for (const cb of batch) cb(now);',
    '}',
    'const STEP = ' + STEP + ';',
    'function play(o) {',
    '  REDUCED = !!o.reduced;',
    '  now = 0; maxChains = 0; scheduled.clear();',
    '  const inst = R.mount((p) => usePlayback(p.turns, p.lang), { turns: TURNS[o.lang], lang: o.lang });',
    '  const marks = [];',
    '  let prev = null;',
    '  const mark = () => {',
    '    const r = inst.result;',
    '    const key = r.state + "|" + r.activeIndex + "|" + r.revealed;',
    '    if (key === prev) return;',
    '    prev = key;',
    '    marks.push({ t: now, state: r.state, i: r.activeIndex, r: r.revealed });',
    '  };',
    '  mark();',
    '  inst.result.toggle();',
    '  R.flush(inst);',
    // Anchor: the first frame after Play contributes no elapsed time, so take it
    // at t=0. From here the driver's clock and the hook's `elapsed` are one number.
    '  frame(0); R.flush(inst); mark();',
    '  for (let f = 0; f < o.to / STEP; f++) {',
    '    frame(STEP); R.flush(inst);',
    '    if (now === o.pauseAt) { inst.result.toggle(); R.flush(inst); mark(); }',
    '    if (now === o.switchAt) {',
    '      const other = o.lang === "te" ? "en" : "te";',
    '      R.setProps(inst, { turns: TURNS[other], lang: other });',
    '      mark();',
    '    }',
    '    if (now === o.resumeAt) { inst.result.toggle(); R.flush(inst); mark(); }',
    '    mark();',
    '  }',
    '  return { marks: marks, maxChains: maxChains, inFlight: scheduled.size };',
    '}',
    'const out = { steps: {}, totals: {}, turnCount: TL.te.counts.length, scenarios: {} };',
    'for (const code of ["en", "te"]) {',
    '  out.steps[code] = TL[code].steps.map((s) => ({ turn: s.turn, phrase: s.phrase, start: s.start }));',
    '  out.totals[code] = TL[code].total;',
    '}',
    'out.scenarios["te straight"] = play({ lang: "te", to: 14000 });',
    'out.scenarios["en straight"] = play({ lang: "en", to: 14000 });',
    'out.scenarios["te->en"] = play({ lang: "te", to: 17000, switchAt: 10000 });',
    'out.scenarios["en->te"] = play({ lang: "en", to: 17000, switchAt: 9600 });',
    'out.scenarios["te->en reduced"] = play({ lang: "te", to: 17000, switchAt: 10000, reduced: true });',
    'out.scenarios["te->en paused"] = play({ lang: "te", to: 17000, pauseAt: 10000, switchAt: 10000, resumeAt: 10500 });',
    // At idle nothing is in flight and nothing may move: the same three numbers
    // before the switch, after it, and a frame later.
    'REDUCED = false; now = 0; scheduled.clear();',
    'const idle = R.mount((p) => usePlayback(p.turns, p.lang), { turns: TURNS.te, lang: "te" });',
    'const snap = () => ({ state: idle.result.state, i: idle.result.activeIndex,',
    '  r: idle.result.revealed, totalMs: idle.result.totalMs });',
    'out.idle = { before: snap() };',
    'R.setProps(idle, { turns: TURNS.en, lang: "en" });',
    'out.idle.after = snap();',
    'frame(16); R.flush(idle);',
    'out.idle.settled = snap();',
    'out.idle.inFlight = scheduled.size;',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');

  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', src],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
    );
  } catch (e) {
    assert.fail('the playback probe did not run:\n' + (e.stderr || e.message));
  }
}

// ── analysis, in the test, where a reader can check it ───────────────────────

const P = probe();

/** Where a turn begins in a language's timeline; the total once every turn has
 *  landed. This is the value a correct switch re-anchors `elapsed` to. */
function turnStart(lang, turn) {
  const s = P.steps[lang].find((x) => x.turn === turn);
  return s ? s.start : P.totals[lang];
}

/**
 * Every (activeIndex, revealed) transition a language produces, as driver-clock
 * times, on the hypothesis that `elapsed = clock - offset`. `byTurn` drops the
 * phrase axis for the reduced-motion run, where every phrase of a turn arrives
 * with the turn and only activeIndex can be watched.
 */
function predict(lang, offset, byTurn) {
  const out = [];
  for (const s of P.steps[lang]) {
    if (byTurn && s.phrase !== 0) continue;
    out.push({ t: s.start + offset, i: s.turn, r: s.phrase + 1 });
  }
  out.push({ t: P.totals[lang] + offset, i: P.turnCount, r: 0 });
  return out;
}

/** The marks at which what is on SCREEN changed. A pause and a resume are state
 *  changes, not boundaries, and classifying them would compare a timeline
 *  against a moment it never claimed anything about. */
function boundaries(scenario) {
  const out = [];
  let prev = null;
  for (const m of P.scenarios[scenario].marks) {
    const key = m.i + '/' + m.r;
    if (key === prev) continue;
    prev = key;
    out.push(m);
  }
  return out;
}

function nearest(list, m, byTurn) {
  let best = Infinity;
  for (const p of list) {
    if (p.i !== m.i) continue;
    if (!byTurn && p.r !== m.r) continue;
    best = Math.min(best, Math.abs(p.t - m.t));
  }
  return best;
}

/**
 * Which timeline the frames after `at` actually followed.
 *
 * STALE is the defect: the outgoing language, its clock never re-anchored.
 * FIXED is the repair: the incoming language, `elapsed` moved to the start of
 * the turn the reader was in. The two hypotheses put the same
 * (activeIndex, revealed) pair at different clock times, and `margin` is the
 * smallest of those differences over the pairs the fix expects to be seen — the
 * discrimination this entire comparison rests on.
 */
function classify(scenario, from, to, at, staleOffset, fixedOffset, byTurn) {
  const stale = predict(from, staleOffset, byTurn);
  const fixed = predict(to, fixedOffset, byTurn);
  const rows = [];
  const tally = { [from]: 0, [to]: 0, indistinguishable: 0 };
  for (const m of boundaries(scenario)) {
    if (m.t < at) continue;
    const ds = nearest(stale, m, byTurn);
    const df = nearest(fixed, m, byTurn);
    const follows = Math.abs(ds - df) < MARGIN_MS ? 'indistinguishable' : ds < df ? from : to;
    tally[follows]++;
    rows.push({ t: m.t, i: m.i, r: m.r, ds, df, follows });
  }
  let margin = Infinity;
  for (const p of fixed) {
    if (p.t < at) continue;
    for (const q of stale) {
      if (p.i !== q.i || (!byTurn && p.r !== q.r)) continue;
      margin = Math.min(margin, Math.abs(p.t - q.t));
    }
  }
  return { rows, tally, margin, follows: from + ' ' + tally[from] + ' · ' + to + ' ' + tally[to] };
}

const big = (n) => (n === Number.MAX_SAFE_INTEGER ? 'all' : String(n));
const pair = (m) => 'i' + m.i + ' r' + big(m.r);

/** The whole picture for one direction, so a red says what happened rather than
 *  which number was not equal to which other number. */
function report(name, c) {
  const head = '     clock   pair       d(stale)   d(fixed)   follows';
  const rows = c.rows.map(
    (r) =>
      '  ' + String(r.t).padStart(8) + '   ' + pair(r).padEnd(9) +
      '  ' + r.ds.toFixed(2).padStart(9) + '  ' + r.df.toFixed(2).padStart(9) + '   ' + r.follows
  );
  const trace = P.scenarios[name].marks.map(
    (m) => '  ' + String(m.t).padStart(8) + '   ' + m.state.padEnd(9) + '  ' + pair(m)
  );
  return [
    '', '  ' + name + ' — every transition:', ...trace,
    '', '  ' + name + ' — after the switch:', head, ...rows,
    '  follows: ' + c.follows, '',
  ].join('\n');
}

// The switch moments. Both land inside turn 3's THIRD phrase, so the reader has
// three phrases of that turn on screen when the language changes — which is what
// makes "the turn restarts" an observation rather than a coincidence: during the
// first phrase, restarting and not restarting look identical.
const AT = { 'te->en': 10000, 'en->te': 9600, 'te->en reduced': 10000 };
const PAUSE_AT = 10000;
const RESUME_AT = 10500;
const TURN = 3;
const DIRECTIONS = [['te', 'en'], ['en', 'te']];

test('switching language mid-playback restarts the turn on the new timeline', () => {
  // 1 — THE RUNTIME, BEFORE ANYTHING IS ASKED OF IT. Each language played
  // straight through must land every boundary on its own buildTimeline. A hook
  // runtime that got useMemo, useCallback or the rAF chain wrong fails here,
  // before it can be believed about a switch.
  for (const lang of ['te', 'en']) {
    const s = P.scenarios[lang + ' straight'];
    const want = predict(lang, 0, false);
    const got = s.marks.filter((m) => m.state !== 'idle');
    assert.equal(
      got.length,
      want.length,
      lang + ' played straight through produced ' + got.length + ' transitions, expected ' +
        want.length + '\n' + report(lang + ' straight', classify(lang + ' straight', lang, lang, 1e9, 0, 0, false))
    );
    for (let k = 0; k < got.length; k++) {
      assert.equal(
        got[k].i + '/' + got[k].r,
        want[k].i + '/' + want[k].r,
        lang + ' transition ' + k + ' is ' + pair(got[k]) + ', expected i' + want[k].i + ' r' + want[k].r
      );
      assert.ok(
        Math.abs(got[k].t - want[k].t) <= TOL,
        lang + ' i' + want[k].i + ' r' + want[k].r + ' landed at ' + got[k].t +
          'ms; buildTimeline says ' + want[k].t.toFixed(2) + 'ms'
      );
    }
    assert.equal(s.maxChains, 1, lang + ' straight ran ' + s.maxChains + ' rAF chains at once');
    assert.equal(s.inFlight, 0, lang + ' left an rAF chain in flight after completing');
  }

  // 2 — THE SWITCH, BOTH DIRECTIONS. A fix that re-anchors correctly one way and
  // not the other is a half fix, so te->en and en->te are asserted alike and
  // reported together.
  const C = {};
  for (const [from, to] of DIRECTIONS) {
    const name = from + '->' + to;
    C[name] = classify(name, from, to, AT[name], 0, AT[name] - turnStart(to, TURN), false);
  }
  const both = DIRECTIONS.map(([f, t]) => report(f + '->' + t, C[f + '->' + t])).join('\n');

  // 2a — the premise. If the two languages ever read at the same cadence,
  // nothing below can discriminate and this file is green for no reason.
  for (const [from, to] of DIRECTIONS) {
    const name = from + '->' + to;
    assert.ok(
      C[name].margin >= MARGIN_MS,
      name + ' can no longer tell the two timelines apart: the closest pair of ' +
        'predictions is ' + C[name].margin.toFixed(2) + 'ms, under the ' + MARGIN_MS + 'ms floor'
    );
  }

  // 2b — THE FRAMES FOLLOW THE NEW TIMELINE. Every boundary after the switch,
  // against both hypotheses. This is the assertion no total can make, and it is
  // deliberately first: it carries the whole picture in its message.
  assert.deepEqual(
    DIRECTIONS.map(([f, t]) => C[f + '->' + t].follows),
    ['te 0 · en 7', 'en 0 · te 7'],
    'the frames after a language switch did not follow the incoming timeline\n' + both
  );

  for (const [from, to] of DIRECTIONS) {
    const name = from + '->' + to;
    const at = AT[name];
    const marks = boundaries(name);
    const before = marks.filter((m) => m.t < at).pop();
    const post = marks.filter((m) => m.t >= at);

    // 2c — THE PLAYHEAD IS PRESERVED. The language changed, not the
    // conversation: the reader stays in the turn they were reading.
    assert.equal(before.i, TURN, name + ' was not in turn ' + TURN + ' at the switch\n' + both);
    assert.equal(post[0].i, TURN, name + ' moved the reader to turn ' + post[0].i + '\n' + both);

    // 2d — THE TURN RESTARTS. Three phrases were on screen; the new language's
    // rendering of the same turn begins again from its first, and the sequence
    // runs out from there.
    assert.equal(before.r, 3, name + ' had ' + before.r + ' phrases revealed at the switch, expected 3');
    assert.deepEqual(
      post.map((m) => 'i' + m.i + 'r' + m.r),
      ['i3r1', 'i3r2', 'i3r3', 'i3r4', 'i4r1', 'i5r1', 'i6r0'],
      name + ' did not restart turn ' + TURN + ' and replay it in the new language\n' + both
    );

    assert.equal(P.scenarios[name].maxChains, 1,
      name + ' ran ' + P.scenarios[name].maxChains + ' rAF chains at once');
    assert.equal(P.scenarios[name].inFlight, 0, name + ' left an rAF chain in flight');
  }

  // 3 — WHILE PAUSED. Nothing is in flight to cancel, so a fix that only cancels
  // would leave this broken: pausing inside turn 3, switching, then resuming has
  // to resume the NEW language's turn 3 from its first phrase.
  {
    const name = 'te->en paused';
    const marks = P.scenarios[name].marks;
    const c = classify(name, 'te', 'en', RESUME_AT, RESUME_AT - PAUSE_AT,
      RESUME_AT - turnStart('en', TURN), false);
    const held = marks.filter((m) => m.state === 'paused');
    assert.equal(held[0].i + '/' + held[0].r, '3/3',
      name + ' did not pause inside the third phrase of turn 3\n' + report(name, c));
    const last = held[held.length - 1];
    assert.equal(last.i, TURN, name + ' lost the playhead while paused\n' + report(name, c));
    assert.equal(last.r, 1, name + ' did not restart the turn while paused\n' + report(name, c));
    assert.ok(c.margin >= MARGIN_MS, name + ' can no longer discriminate: margin ' + c.margin.toFixed(2) + 'ms');
    assert.equal(c.follows, 'te 0 · en ' + c.rows.length,
      name + ' did not resume on the incoming timeline\n' + report(name, c));
  }

  // 4 — UNDER REDUCED MOTION. Phrases arrive with their turn, so `revealed` is
  // pinned and only activeIndex can be watched — but the re-anchor is still
  // plainly visible, because turn 3 then holds the screen for English's full
  // turn-3 duration rather than Telugu's remainder. The ladder that animates is
  // CSS scoped to .live; nothing here consults it.
  {
    const name = 'te->en reduced';
    const at = AT[name];
    const c = classify(name, 'te', 'en', at, 0, at - turnStart('en', TURN), true);
    const marks = boundaries(name);
    const before = marks.filter((m) => m.t < at).pop();
    const post = marks.filter((m) => m.t >= at);
    assert.ok(c.margin >= MARGIN_MS, name + ' can no longer discriminate: margin ' + c.margin.toFixed(2) + 'ms');
    assert.equal(before.i, TURN, name + ' was not in turn ' + TURN + ' at the switch\n' + report(name, c));
    assert.equal(before.r, Number.MAX_SAFE_INTEGER,
      name + ' revealed phrases one at a time under reduced motion');
    assert.deepEqual(post.map((m) => 'i' + m.i), ['i4', 'i5', 'i6'],
      name + ' did not walk the remaining turns\n' + report(name, c));
    assert.equal(c.follows, 'te 0 · en ' + c.rows.length,
      name + ' kept the outgoing cadence under reduced motion\n' + report(name, c));
  }

  // 5 — AT IDLE, NOTHING MOVES. The selector is usable before Play is pressed,
  // and there the only thing that may change is how long the sequence will take.
  assert.deepEqual(
    { state: P.idle.after.state, i: P.idle.after.i, r: P.idle.after.r },
    { state: P.idle.before.state, i: P.idle.before.i, r: P.idle.before.r },
    'switching at idle moved the playhead: ' + JSON.stringify(P.idle)
  );
  assert.deepEqual(P.idle.settled, P.idle.after,
    'switching at idle started the clock: ' + JSON.stringify(P.idle));
  assert.equal(P.idle.inFlight, 0, 'switching at idle scheduled a frame');
  assert.notEqual(
    P.idle.after.totalMs,
    P.idle.before.totalMs,
    'the two languages now report the same total, so this file cannot see a switch at all'
  );
});
