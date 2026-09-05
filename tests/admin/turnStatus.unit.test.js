'use strict';

// ── The shared turn-status derivation (INCIDENTS-C0) ────────────────────────
//
// No DB, no server, no browser: node requires THE EXACT FILE THE BROWSER LOADS,
// the same way tests/admin/tracePage.unit.test.js requires traces.js.
//
// WHAT THIS FILE IS ABOUT, and it is one thing: there must be ONE derivation of
// a turn's outcome, and two surfaces must be able to ask different questions of
// it without either one lying.
//
//   the trace viewer   "did this turn complete?"   -> ok | aborted | failed
//   incidents          "did the patient get what
//                       they came for?"            -> + tool_error
//
// A turn whose book_appointment returned {status:'error'} COMPLETED. The viewer
// is right to call it `ok`; incidents is right to call it an incident. That is
// F-A054, and the third arm is NOT a missing fourth arm on the viewer's ladder.
// Block three below asserts the viewer cannot reach it — a guard against
// "fixing" a page that is already correct.
//
// FOUR test() blocks, following the rule tokenDrift.test.js, adminNav.test.js
// and adminShell.test.js all state: a block per assertion reports one fault
// many times and says nothing extra. The blocks are four CONCERNS — the
// derivation, the layering, the viewer's consumption of it, and the incidents
// projection's ability to satisfy it — not four assertions.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TS = require('../../public/admin/turn-status.js');
const T = require('../../public/admin/traces.js');

const ADMIN = path.join(__dirname, '..', '..', 'public', 'admin');

// The closed sets, restated as fixtures rather than as prose. Every envelope
// shape §6 of the brief allows, and nothing outside it.
const ABORT_CLIENT_GONE = {
  outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: true,
  stage: 'generate_reply', message: 'voice turn aborted',
};
const ABORT_DEADLINE = {
  outcome: 'aborted', abort_reason: 'deadline', aborted_after_commit: false,
  stage: 'generate_reply', message: 'deadline exceeded',
};
const PLAIN_FAILURE = { stage: 'dispatch', message: 'boom', status: 500 };

const TOOL_CALLS_WITH_ERROR = [
  { n: 1, name: 'check_availability', latency_ms: 62.8, outcome: { status: 'ok' } },
  { n: 2, name: 'book_appointment', latency_ms: 118.3, outcome: { status: 'error', error: 'doctor_not_found' } },
];

describe('turn status — one derivation, two questions (INCIDENTS-C0)', () => {
  it('derives ok | aborted | failed from the error envelope and nothing else', () => {
    const key = (e) => TS.turnStatus(TS.fromError(e));

    // The null arm. A row with no error column value recorded no error.
    assert.equal(key(null), 'ok');
    assert.equal(key(undefined), 'ok');

    // The abort arm, over BOTH abort_reason values and BOTH commit values —
    // neither of which may reach the ladder, because neither changes it.
    assert.equal(key(ABORT_CLIENT_GONE), 'aborted');
    assert.equal(key(ABORT_DEADLINE), 'aborted');
    assert.equal(key({ outcome: 'aborted' }), 'aborted', 'the bare abort envelope is still an abort');

    // The failure arm, including the shapes that carry no recognised key. An
    // envelope that is present and is not an abort is a failure, whatever else
    // it holds.
    assert.equal(key(PLAIN_FAILURE), 'failed');
    assert.equal(key({}), 'failed', 'an empty envelope is still an envelope');
    assert.equal(key({ outcome: 'something_else' }), 'failed');

    // A full, healthy-looking body alongside an error is still failed: the
    // ladder reads `error` and refuses to be talked out of it by context.
    assert.equal(key(Object.assign({ stage_timings: { total_ms: 12 } }, PLAIN_FAILURE)), 'failed');

    // `error.status` is NOT a severity input. It is whatever HTTP status an
    // upstream threw — not a closed set — and two rows differing only there
    // must rank identically.
    assert.equal(key({ stage: 'dispatch', status: 500 }), key({ stage: 'dispatch', status: 429 }));

    // The ladder takes flattened primitives, so it can be driven with no
    // envelope at all — which is exactly how the incidents page will drive it.
    assert.equal(TS.turnStatus({ hasError: false, isAbort: false }), 'ok');
    assert.equal(TS.turnStatus({ hasError: true, isAbort: true }), 'aborted');
    assert.equal(TS.turnStatus({ hasError: true, isAbort: false }), 'failed');
  });

  it('layers the tool-error arm over that derivation rather than beside it', () => {
    // THE ROW THE THIRD ARM EXISTS FOR: the turn completed, and the patient did
    // not get their booking.
    assert.equal(TS.incidentLevel({ hasError: false, isAbort: false, hasToolError: true }), 'tool_error');
    assert.equal(TS.incidentLevel({ hasError: false, isAbort: false, hasToolError: false }), 'ok');

    // DELEGATION, asserted rather than assumed: wherever turnStatus already
    // found something wrong, incidentLevel returns exactly what turnStatus
    // returned — for every combination, with the tool bit set both ways. If
    // incidentLevel ever restates the ladder instead of calling it, this is
    // what notices.
    for (const hasError of [true, false]) {
      for (const isAbort of [true, false]) {
        const base = TS.turnStatus({ hasError, isAbort });
        if (base === 'ok') continue;
        for (const hasToolError of [true, false]) {
          assert.equal(TS.incidentLevel({ hasError, isAbort, hasToolError }), base,
            `an envelope row must rank by its envelope (hasError=${hasError}, `
            + `isAbort=${isAbort}, hasToolError=${hasToolError}); a row matching `
            + 'both arms is ONE row, and the tool bit must not re-rank it');
        }
      }
    }

    // The level vocabulary is closed. Nothing outside these four may appear —
    // no stage-weighted level, no severity read off error.status, no
    // truncated-reply level.
    const seen = new Set();
    for (const hasError of [true, false]) {
      for (const isAbort of [true, false]) {
        for (const hasToolError of [true, false]) {
          seen.add(TS.incidentLevel({ hasError, isAbort, hasToolError }));
        }
      }
    }
    assert.deepEqual([...seen].sort(), ['aborted', 'failed', 'ok', 'tool_error']);
  });

  it('is the derivation the viewer consumes, and the viewer cannot reach tool_error', () => {
    // 1. statusOf IS this ladder, not a copy of it that happens to agree today.
    //    Delete turn-status.js's body and this file's blocks redden together
    //    with tracePage.unit.test.js's — which is the red-check for "one
    //    implementation", run by hand at the session that extracted it.
    for (const [error, want] of [
      [null, 'ok'], [undefined, 'ok'],
      [ABORT_CLIENT_GONE, 'aborted'], [ABORT_DEADLINE, 'aborted'],
      [PLAIN_FAILURE, 'failed'], [{}, 'failed'],
    ]) {
      assert.equal(T.statusOf({ error }).key, TS.turnStatus(TS.fromError(error)),
        'the page must not derive status independently of turn-status.js');
      assert.equal(T.statusOf({ error }).key, want);
    }

    // 2. THE UNREACHABILITY. A turn whose tool errored, with error NULL, is an
    //    INCIDENT and is `ok` on this page. Both are true. The page renders the
    //    turn's completion, so wiring the tool bit into it would be a defect
    //    dressed as a fix.
    const toolErrorRow = { error: null, tool_calls: TOOL_CALLS_WITH_ERROR };
    assert.equal(T.statusOf(toolErrorRow).key, 'ok',
      'a turn whose tool errored COMPLETED — the viewer answers "did this turn '
      + 'complete?" and `ok` is the true answer (F-A054)');
    assert.equal(T.statusOf(toolErrorRow).badge, 'badge-green');
    assert.equal(TS.incidentLevel({ hasError: false, isAbort: false, hasToolError: true }), 'tool_error',
      'and the SAME row is an incident — two questions, two true answers');

    // The page never even sees the tool bit: statusOf reads `error` alone, so
    // a row with and without tool_calls ranks identically.
    assert.deepEqual(T.statusOf(toolErrorRow), T.statusOf({ error: null }));

    // 3. SCRIPT ORDER IS LOAD-BEARING (B4/B6). The browser resolves the module
    //    through a global, so turn-status.js must be in the page BEFORE the
    //    script that consumes it. An HTML reorder would break the page with no
    //    other test noticing.
    const html = fs.readFileSync(path.join(ADMIN, 'traces.html'), 'utf8');
    const iDep = html.indexOf('/admin/turn-status.js');
    const iPage = html.indexOf('/admin/traces.js');
    assert.ok(iDep > -1, 'traces.html must load /admin/turn-status.js');
    assert.ok(iPage > -1, 'traces.html must load /admin/traces.js');
    assert.ok(iDep < iPage,
      'traces.html must load /admin/turn-status.js BEFORE /admin/traces.js — '
      + "the browser branch resolves the dependency off window, so a reorder "
      + 'leaves the page with no derivation at all');

    // 4. THE BROWSER BRANCH REFUSES OUT LOUD. node throws at require time if
    //    the module is missing, which is visible; a browser would silently hand
    //    the factory `undefined` and render a broken badge with nothing logged,
    //    and NO test in this repository loads this page through a browser. So
    //    the branch is exercised here directly: traces.js is evaluated in a
    //    context shaped like a browser — a `window`, no `module`, no `document`
    //    — which is the only way to reach code the require path never runs.
    const src = fs.readFileSync(path.join(ADMIN, 'traces.js'), 'utf8');

    const bare = { window: {} };
    vm.createContext(bare);
    assert.throws(() => vm.runInContext(src, bare), /turn-status\.js must be loaded first/,
      'with the global absent the page script must throw, not degrade to a '
      + 'broken badge that nothing reports');

    const loaded = { window: { AdminTurnStatus: TS } };
    vm.createContext(loaded);
    vm.runInContext(src, loaded);
    assert.equal(typeof loaded.window.AdminTraces.statusOf, 'function',
      'with the global present the browser branch must wire the page up');
    assert.equal(loaded.window.AdminTraces.statusOf({ error: ABORT_DEADLINE }).key, 'aborted',
      'and the browser-resolved dependency must be the same derivation');
  });

  it('classifies the incidents projection without a second flattening', () => {
    // The consumer contract, as GET /admin/api/incidents actually emits it.
    // src/modules/traces/incidentsQuery.js projects these names; if they are
    // renamed, the adapter below is what must move with them.
    const QUERY = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'modules', 'traces', 'incidentsQuery.js'), 'utf8');
    for (const alias of ['AS has_error', 'AS error_outcome', 'AS has_tool_error']) {
      assert.ok(QUERY.includes(alias),
        `incidentsQuery.js must still project \`${alias}\` — the classifier's `
        + 'inputs come from that projection and nowhere else');
    }

    // The adapter the incidents surface will use: three field reads, no ladder.
    const levelOf = (row) => TS.incidentLevel({
      hasError: row.has_error,
      isAbort: row.error_outcome === 'aborted',
      hasToolError: row.has_tool_error,
    });

    // Rows shaped exactly as the route returns them, mirroring the fixtures in
    // tests/traces/incidents.test.js one for one.
    const rows = [
      { name: 'a_failed', has_error: true, error_outcome: null, error_stage: 'dispatch',
        abort_reason: null, aborted_after_commit: null, has_tool_error: false, want: 'failed' },
      { name: 'a_abort_commit', has_error: true, error_outcome: 'aborted', error_stage: 'generate_reply',
        abort_reason: 'client_gone', aborted_after_commit: true, has_tool_error: false, want: 'aborted' },
      { name: 'a_abort_stopped', has_error: true, error_outcome: 'aborted', error_stage: 'generate_reply',
        abort_reason: 'deadline', aborted_after_commit: false, has_tool_error: false, want: 'aborted' },
      { name: 'a_tool_error', has_error: false, error_outcome: null, error_stage: null,
        abort_reason: null, aborted_after_commit: null, has_tool_error: true, want: 'tool_error' },
      { name: 'both_arms', has_error: true, error_outcome: null, error_stage: 'dispatch',
        abort_reason: null, aborted_after_commit: null, has_tool_error: true, want: 'failed' },
    ];
    for (const r of rows) assert.equal(levelOf(r), r.want, `${r.name} must rank ${r.want}`);

    // AND THE TWO SURFACES AGREE WHERE THEY ARE ASKING THE SAME QUESTION. For
    // every row carrying an error envelope, the incidents level and the trace
    // viewer's key are the SAME STRING — because they are the same call. They
    // diverge on exactly one row: the tool-error one, by design.
    for (const r of rows.filter((x) => x.has_error)) {
      const viewer = T.statusOf({
        error: r.error_outcome === 'aborted'
          ? { outcome: 'aborted', abort_reason: r.abort_reason }
          : { stage: r.error_stage },
      }).key;
      assert.equal(levelOf(r), viewer,
        `${r.name}: both surfaces read one derivation, so an envelope row must `
        + 'rank identically on the page and in the incidents list');
    }
    const toolRow = rows.find((x) => x.name === 'a_tool_error');
    assert.equal(levelOf(toolRow), 'tool_error');
    assert.equal(T.statusOf({ error: null }).key, 'ok',
      'the one row where the answers differ, and both are true (F-A054)');
  });
});
