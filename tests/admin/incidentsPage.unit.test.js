'use strict';

// ── The incidents page's renderers (INCIDENTS-C) ────────────────────────────
//
// No DB, no server, no browser: node requires THE EXACT FILE THE BROWSER LOADS.
// `public/admin/incidents.js` is UMD-lite for this reason, the same way
// `traces.js` and `turn-status.js` are, and its DOM half only wires itself when
// a document exists — so the require below has no side effects.
//
// WHAT THESE TESTS ARE ABOUT, and it is two things the page must not do:
//
//   1. AN EMPTY LIST MUST NOT READ AS "NOTHING IS WRONG". `turn_traces` has
//      zero rows and will until the first production deploy, so the empty state
//      is the SHIPPING state — the first thing anyone sees and for weeks the
//      only thing. Block four asserts its MEANING, not the presence of an
//      element: the copy must state something about the RECORD and must not
//      claim health. Its red-check swaps in "Everything is working normally."
//
//   2. A TRUNCATED LIST MUST SAY IT IS TRUNCATED. The route caps at 200 and has
//      no cursor, so a response that exactly fills the page it asked for is a
//      window and not the set. Block five asserts the disclosure and BOTH sides
//      of the boundary — a list one row short must stay quiet, or the guard is
//      satisfied by a page that cries truncation always.
//
// EIGHT test() blocks, following the rule tokenDrift.test.js, adminNav.test.js
// and adminShell.test.js all state: a block per assertion reports one fault many
// times and says nothing extra. The eight are eight CONCERNS, not eight
// assertions — and block three is separate from block four on purpose. Both are
// about the field contract, but block three is the only guard in this session
// that runs with no database: incidentsPageContract.integration.test.js SKIPS
// without DATABASE_URL, so folding the always-running check into the runtime one
// would make the one block that never skips the one whose failure is ambiguous.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I = require('../../public/admin/incidents.js');
const TS = require('../../public/admin/turn-status.js');

const ADMIN = path.join(__dirname, '..', '..', 'public', 'admin');
const QUERY_FILE = path.join(__dirname, '..', '..', 'src', 'modules', 'traces',
  'incidentsQuery.js');
const SRC = fs.readFileSync(path.join(ADMIN, 'incidents.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ADMIN, 'incidents.html'), 'utf8');

// Fixture tenant ids, disjoint from every other suite's — the RAG Session 3
// §6.3 rule that tests/infra/fixtureTenantIds.unit.test.js enforces. Nothing
// here reaches a database; they are map keys.
const TENANT_A = '44444444-4444-4444-4444-444444444444';
const TENANT_B = '55555555-5555-5555-5555-555555555555';
const NAMES = { [TENANT_A]: 'Smile Dental' };

/**
 * A row exactly as GET /admin/api/incidents emits one — every projected field
 * the page reads, present, with the closed-set values §6 allows and nothing
 * outside them. Overrides are applied on top so each case states only what it
 * is about.
 */
function row(over) {
  return Object.assign({
    turn_id: '99999999-9999-9999-9999-999999999999',
    tenant_id: TENANT_A,
    channel: 'whatsapp',
    correlation_id: 'wa_0123456789abcdef',
    created_at: '2026-09-05T10:00:00.000Z',
    has_error: true,
    error_outcome: null,
    error_stage: 'dispatch',
    abort_reason: null,
    aborted_after_commit: null,
    has_tool_error: false,
  }, over || {});
}

// The three levels this route can return, each as the row that produces it.
// Mirrors tests/traces/incidents.test.js's fixtures one for one.
const FAILED = row({ has_error: true, error_outcome: null, error_stage: 'dispatch' });
const ABORTED_COMMIT = row({
  has_error: true, error_outcome: 'aborted', error_stage: 'gemini_call_1',
  abort_reason: 'client_gone', aborted_after_commit: true,
});
const ABORTED_STOPPED = row({
  has_error: true, error_outcome: 'aborted', error_stage: 'generate_reply',
  abort_reason: 'deadline', aborted_after_commit: false,
});
const TOOL_ERROR = row({
  has_error: false, error_outcome: null, error_stage: null, has_tool_error: true,
  channel: 'voice',
});
// A row carrying BOTH arms. One row, ranked by its envelope — not two.
const BOTH_ARMS = row({ has_error: true, has_tool_error: true });

const ALL_SHAPES = [FAILED, ABORTED_COMMIT, ABORTED_STOPPED, TOOL_ERROR, BOTH_ARMS];

describe('incidents page — the record, and what it refuses to imply (INCIDENTS-C)', () => {
  it('renders the three reachable levels and cannot render a fourth', () => {
    assert.equal(I.levelOf(FAILED), 'failed');
    assert.equal(I.levelOf(ABORTED_COMMIT), 'aborted');
    assert.equal(I.levelOf(ABORTED_STOPPED), 'aborted');
    assert.equal(I.levelOf(TOOL_ERROR), 'tool_error');
    assert.equal(I.levelOf(BOTH_ARMS), 'failed',
      'a row carrying an error envelope AND a failed tool is ONE row, and it '
      + 'ranks by its envelope');

    // The presentation map is exactly the reachable set. `ok` is DELIBERATELY
    // absent: the route's WHERE cannot return a row that ranks ok, so leaving
    // the key out turns "the response shape changed" from a green badge into a
    // thrown error. That is block four's subject and it depends on this.
    assert.deepEqual(Object.keys(I.PRESENTATION).sort(),
      ['aborted', 'failed', 'tool_error']);
    assert.ok(!('ok' in I.PRESENTATION),
      '`ok` is unreachable on this page and must not be renderable');

    // No new badge class and no new design token (D-016). `failed` and
    // `tool error` share badge-red and are separated by their LABEL, which
    // SC 1.4.1 requires anyway — colour may never be the only carrier.
    const style = fs.readFileSync(path.join(ADMIN, 'style.css'), 'utf8');
    const badges = new Set();
    for (const k of Object.keys(I.PRESENTATION)) {
      const p = I.PRESENTATION[k];
      badges.add(p.badge);
      assert.ok(style.includes('.' + p.badge),
        `${k} draws "${p.badge}" but /admin/style.css declares no such rule`);
    }
    assert.deepEqual([...badges].sort(), ['badge-red', 'badge-yellow'],
      'the page reuses two existing badge classes and introduces none');
    assert.equal(I.PRESENTATION.failed.badge, I.PRESENTATION.tool_error.badge,
      'these two share a colour on purpose');
    assert.notEqual(I.PRESENTATION.failed.label, I.PRESENTATION.tool_error.label,
      'so the LABEL must be what tells them apart, not the colour');

    // And every level actually reaches the DOM as its own badge and its own
    // word — a mapping that is right in the object and wrong in the renderer
    // is the failure this catches.
    for (const r of [FAILED, ABORTED_COMMIT, TOOL_ERROR]) {
      const p = I.PRESENTATION[I.levelOf(r)];
      const html = I.rowHtml(r, NAMES);
      assert.match(html, new RegExp('class="badge ' + p.badge + '">' + p.label + '<'),
        `the ${I.levelOf(r)} row must draw ${p.badge} carrying "${p.label}"`);
    }

    // Why the row is here, from the closed sets and nothing else.
    assert.match(I.whyHtml(FAILED, 'failed'), /dispatch/);
    assert.match(I.whyHtml(ABORTED_COMMIT, 'aborted'), /client_gone/);
    assert.match(I.whyHtml(ABORTED_COMMIT, 'aborted'), /after commit/);
    assert.match(I.whyHtml(ABORTED_STOPPED, 'aborted'), /deadline/);
    assert.match(I.whyHtml(ABORTED_STOPPED, 'aborted'), /before commit/);
    assert.match(I.whyHtml(TOOL_ERROR, 'tool_error'), /tool call reported an error/);
    // aborted_after_commit is REPORTED, never scored. Neither value may reach
    // the level, so the two abort rows rank identically.
    assert.equal(I.levelOf(ABORTED_COMMIT), I.levelOf(ABORTED_STOPPED));
    // An absent stage is a dash, never an invented reason.
    assert.equal(I.whyHtml(row({ error_stage: null }), 'failed'), I.DASH);
  });

  it('derives every level through turn-status.js and keeps no ladder of its own', () => {
    // THE GUARD, and it is not a restatement of the implementation: the page's
    // flattening is compared against turn-status.js's OWN flattening
    // (`fromError`, the single site in the tree that compares a raw envelope
    // against 'aborted') on every closed-set shape. A typo, a case change or a
    // renamed literal on either side moves them apart and reddens here.
    //
    // F-A064: `incidents.js` holds a SECOND textual comparison against
    // 'aborted', because the route hands it a flattened column and not an
    // envelope — turn-status.js:28-31 chose that signature deliberately. This
    // block is what stops the two from drifting; the finding is stated, not
    // fixed, and turn-status.js is byte-identical this session.
    for (const r of ALL_SHAPES) {
      const viaModule = TS.incidentLevel(Object.assign(
        TS.fromError(r.has_error ? { outcome: r.error_outcome } : null),
        { hasToolError: r.has_tool_error }));
      assert.equal(I.levelOf(r), viaModule,
        'the page must not derive severity independently of turn-status.js');
    }

    // The ladder is not restated here either. `turnStatus` is the three-arm
    // answer and `incidentLevel` layers the tool arm over it by CALLING it; the
    // page reaches both only through the module.
    assert.equal(TS.incidentLevel({ hasError: false, isAbort: false, hasToolError: false }), 'ok');
    assert.ok(!('ok' in I.PRESENTATION),
      'the one level the module can return that this page cannot draw');

    // Greppable, in the shipped file: no `has_error` test outside the one
    // adapter, and no second `hasToolError` test. A second derivation added
    // later has to move one of these numbers.
    assert.equal((SRC.match(/row\.has_error/g) || []).length, 1,
      'has_error is read in exactly one place — the adapter');
    assert.equal((SRC.match(/row\.has_tool_error/g) || []).length, 1,
      'has_tool_error is read in exactly one place — the adapter');
    assert.equal((SRC.match(/TS\.incidentLevel\(/g) || []).length, 1,
      'the classifier is called once, from the adapter, and nowhere else');
    assert.ok(!/turnStatus\(/.test(SRC),
      'the page asks the incidents question, so it calls incidentLevel and '
      + 'never the viewer\'s turnStatus');
  });

  it('keys the fields it reads to incidentsQuery.js\'s own projection', () => {
    // THE ONLY CONTRACT GUARD THAT ALWAYS RUNS. The integration test skips
    // without DATABASE_URL; this reads two files off disk.
    //
    // The failure it catches is silent by construction: rename a projected
    // column and the page reads `undefined`, which is falsy, which flattens to
    // {hasError:false} and ranks a FAILED turn `ok` — on the one page whose
    // whole job is to say what failed.
    // EOL-NORMALISED DELIBERATELY, and measured rather than assumed: this
    // scan parsed ZERO columns on its first run. public/admin/ is w/lf and
    // src/modules/traces/ is w/crlf (F-A062), so an anchor written with a
    // bare LF finds nothing in that file — and a broken parser would have
    // reported itself as a broken projection.
    const query = fs.readFileSync(QUERY_FILE, 'utf8').replace(/\r\n/g, '\n');

    // Derived from the SQL, never a second hand-written list: a hand list would
    // agree with itself forever. Anchored on the template literal so the
    // `SELECT *` in the file's prose cannot be mistaken for the projection.
    const opens = query.split('`SELECT\n').length - 1;
    assert.equal(opens, 1,
      'incidentsQuery.js must open exactly one `SELECT` template literal; '
      + 'found ' + opens + ' — fix this parser before trusting it');
    const list = query.match(/`SELECT\n([\s\S]*?)\n\s*FROM turn_traces/)[1];

    const projected = [];
    for (const raw of list.split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      if (!line) continue;
      const aliased = line.match(/\bAS\s+([a-z_][a-z0-9_]*)$/i);
      if (aliased) { projected.push(aliased[1]); continue; }
      const bare = line.match(/^([a-z_][a-z0-9_]*)$/i);
      if (bare) projected.push(bare[1]);
    }

    // A scan that silently matched nothing would pass forever.
    assert.equal(projected.length, 13,
      'expected the 13 columns INCIDENTS-B settled on, parsed '
      + projected.length + ': ' + projected.join(', '));

    for (const f of I.REQUIRED_FIELDS) {
      assert.ok(projected.includes(f),
        `incidents.js reads \`${f}\` off every row and incidentsQuery.js no `
        + 'longer projects it. A missing field arrives as undefined, which is '
        + 'falsy, which ranks a failed turn `ok` with no symptom.');
    }

    // The reverse containment is deliberately NOT asserted: the query projects
    // conversation_id and call_session_id, which this page does not draw. They
    // are ids the trace viewer needs, not fields whose absence would break a
    // render, and requiring the page to read every projected column would make
    // adding a column to the route a change to this page.
    const unread = projected.filter((c) => !I.REQUIRED_FIELDS.includes(c));
    assert.deepEqual(unread.sort(), ['call_session_id', 'conversation_id'],
      'the page reads every projected column but these two; a THIRD unread '
      + 'column means a projection changed without this page noticing');

    // And neither free-text field is projected, so the page cannot render one
    // even by accident. Not fetching is not the same as not rendering.
    assert.ok(!projected.includes('error'), 'the raw error envelope is not projected');
    assert.ok(!projected.includes('tool_calls'), 'the raw tool_calls array is not projected');
  });

  it('fails loudly on a row the projection did not shape, instead of ranking it ok', () => {
    // THE TRAP, stated first so the guard below is read against something real:
    // with a field missing, the classifier itself answers `ok` — quietly, and
    // correctly for the inputs it was handed.
    assert.equal(TS.incidentLevel({ hasError: undefined, isAbort: false, hasToolError: undefined }),
      'ok', 'this is what a renamed column would rank a failed turn');

    // So the page refuses the row instead. `in`, never truthiness: has_error
    // false is a fact the route states; has_error missing is a response this
    // page cannot interpret.
    for (const f of I.REQUIRED_FIELDS) {
      const broken = row();
      delete broken[f];
      assert.throws(() => I.levelOf(broken), new RegExp('carries no `' + f + '`'),
        `a row missing ${f} must be refused by name`);
    }

    // The rename, end to end: has_error -> hasError on a row that is otherwise
    // a perfectly good failure.
    const renamed = row();
    renamed.hasError = renamed.has_error;
    delete renamed.has_error;
    assert.throws(() => I.levelOf(renamed), /carries no `has_error`/);

    // A level the route cannot return is refused the same way — the
    // missing-field guard and the unknown-level guard are one defence twice.
    assert.throws(() => I.presentationOf('ok'), /no presentation for level `ok`/);
    assert.throws(() => I.assertRowShape(null), /the row is not an object/);
    assert.throws(() => I.assertRowShape([]), /the row is not an object/);

    // And the table SAYS SO rather than blanking. A throw alone would leave the
    // reader an empty surface and tell them nothing.
    const html = I.rowsHtml([renamed], NAMES);
    assert.match(html, /class="contract-fail"/);
    assert.match(html, /could not read the response/);
    assert.match(html, /carries no `has_error`/);
    assert.doesNotMatch(html, /class="badge/,
      'a row the page cannot read must not also draw a level');
    assert.doesNotMatch(html, /No failed turn has been recorded/,
      'and it must not be reported as an empty record either');
  });

  it('says an empty list is a fact about the record, never a claim about the clinics', () => {
    const empty = I.emptyHtml();

    // The copy itself, which is the deliverable. Two sentences: what the record
    // holds, and the inference a reader must not draw from it.
    assert.match(empty, /<strong>No failed turn has been recorded\.<\/strong>/);
    assert.match(empty, /An empty record is not the same as nothing having failed\./);

    // MEANING, not presence. Zero rows means zero TRAFFIC, not zero failures,
    // and F-A055's class is invisible here at any volume — so nothing on this
    // page may assert health. This is the assertion the red-check aims at.
    const CLAIMS_HEALTH = [
      /nothing is wrong/i, /all clear/i, /no incidents/i, /no problems/i,
      /all good/i, /\bhealthy\b/i, /all systems/i,
      /everything (is |looks )?(fine|ok|okay|normal|working|good)/i,
      /working normally/i, /operating normally/i,
    ];
    for (const re of CLAIMS_HEALTH) {
      assert.doesNotMatch(empty, re,
        'the empty state may not claim health. Zero rows means zero traffic, '
        + 'not zero failures, and a request refused before its turn began '
        + 'records no error and never appears here at all (F-A055).');
    }

    // No date, and no deploy that dates it. Copy that self-falsifies on a known
    // event is a defect with a timer on it.
    assert.doesNotMatch(empty, /production deploy|until Issue|2026|first deploy/i,
      'the empty state must not carry a claim that goes false on a known date');

    // The blind spot is a STANDING fact, not a property of emptiness, so it
    // lives in the page furniture and is visible at every volume — including
    // with two hundred rows on screen.
    assert.match(HTML, /class="scope-note"/);
    const note = HTML.match(/<p class="scope-note">([\s\S]*?)<\/p>/)[1]
      .replace(/\s+/g, ' ').trim();
    assert.match(note, /record of failed turns, not a measure of health/);
    assert.match(note, /refused\s*before its turn began records no error and never appears here/,
      'F-A055: the class this read cannot see, stated on the page');
    assert.match(note, /Probe turns and owners' own test turns are not filtered out/,
      'F-A058: probe and portal-test rows sit beside patient failures');
    assert.match(note, /channel and correlation id/,
      'and the two columns that tell them apart are named');
    for (const re of CLAIMS_HEALTH) assert.doesNotMatch(note, re);

    // Both empties render it, and nothing else does.
    assert.equal(I.rowsHtml([], NAMES), empty);
    assert.equal(I.rowsHtml(null, NAMES), empty);
    assert.equal((SRC.match(/emptyHtml\(\)/g) || []).length, 2,
      'emptyHtml has exactly one definition and one call site. A REFUSED '
      + 'request must NOT render it: rendering a 400 as "no failed turn has '
      + 'been recorded" is a different and untrue answer.');
    const call = SRC.indexOf('return emptyHtml();');
    const rows = SRC.indexOf('function rowsHtml');
    assert.ok(call > rows && call - rows < 200,
      'the one call site is inside rowsHtml, not in the request-failure branch');
  });

  it('discloses a full page as a window, and stays quiet one row short', () => {
    const rows = (n) => Array.from({ length: n }, () => row());

    // The page asks for the route's ceiling, explicitly. Asking for less would
    // discard rows it could show and make truncation MORE likely; asking
    // explicitly is also what makes truncation detectable at all.
    assert.equal(I.LIMIT, 200);
    assert.equal(I.listUrl(), '/admin/api/incidents?limit=200');

    // FULL PAGE -> the list is a window, and the disclosure says so.
    const full = I.truncationHtml(rows(200), 200);
    assert.match(full, /window, not the whole list/i);
    assert.match(full, /older failures exist and are not on this page/);
    assert.match(full, /no next page/,
      'the route has no cursor, and the reader is told rather than left to '
      + 'look for a control that does not exist');
    assert.match(full, /newest 200/);

    // ONE ROW SHORT -> silence. Without this the guard is satisfied by a page
    // that cries truncation always, which discloses nothing.
    assert.equal(I.truncationHtml(rows(199), 200), '',
      'a list that did not fill the page it asked for IS the set');
    assert.equal(I.truncationHtml([], 200), '');
    assert.equal(I.truncationHtml(null, 200), '');

    // Relative to the limit actually requested, not to the constant — so the
    // disclosure cannot be right by coincidence at 200 and wrong everywhere.
    assert.notEqual(I.truncationHtml(rows(6), 6), '');
    assert.equal(I.truncationHtml(rows(5), 6), '');
    assert.match(I.truncationHtml(rows(6), 6), /newest 6/);
  });

  it('names the clinic where it can, shows the id where it cannot, and carries no free text', () => {
    assert.match(I.clinicHtml(FAILED, NAMES), /Smile Dental/);

    // DEGRADATION, and it is never a blank: a blank cell where a clinic belongs
    // reads as "no clinic", which is a claim the row does not make.
    const foreign = row({ tenant_id: TENANT_B });
    for (const names of [NAMES, {}, null, undefined]) {
      const cell = I.clinicHtml(foreign, names);
      assert.notEqual(cell.trim(), '');
      assert.match(cell, /55555555/, 'an unnamed clinic shows its id');
      assert.match(cell, new RegExp('title="' + TENANT_B + '"'),
        'elided in the column, whole in the title — eliding is permitted, '
        + 'synthesising is not');
    }

    // A clinic name is operator-supplied text and is escaped like any other.
    const hostile = I.clinicHtml(FAILED, { [TENANT_A]: '<script>x</script>' });
    assert.doesNotMatch(hostile, /<script>/);
    assert.match(hostile, /&lt;script&gt;/);

    // The handoff to the trace viewer, tenant-scoped, and null without one.
    assert.equal(I.traceUrl(FAILED), '/admin/traces.html?tenant_id=' + TENANT_A);
    assert.equal(I.traceUrl(row({ tenant_id: null })), null);
    assert.equal(I.traceUrl(null), null);
    assert.match(I.rowHtml(FAILED, NAMES), /href="\/admin\/traces\.html\?tenant_id=/);

    // NO FREE TEXT. incidentsQuery.js does not project error.message or
    // tool_calls[].outcome.error, and this proves the renderer reads only what
    // it declared: a row carrying them anyway renders neither.
    const NEEDLE = 'ZZFREETEXTNEEDLEZZ';
    const smuggled = row({
      error: { message: NEEDLE, stage: 'dispatch' },
      tool_calls: [{ outcome: { status: 'error', error: 'Dr. ' + NEEDLE } }],
    });
    const html = I.rowHtml(smuggled, NAMES);
    assert.ok(!html.includes(NEEDLE),
      'the renderer reads REQUIRED_FIELDS and nothing else, so free text that '
      + 'somehow reached the page still cannot reach the DOM');
    assert.ok(!/error\.message|tool_calls/.test(
      SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')),
    'and neither field is named anywhere in the page\'s code');

    // Every row renders every shape without inventing a value.
    const all = I.rowsHtml(ALL_SHAPES, NAMES);
    assert.equal((all.match(/class="incident-row"/g) || []).length, ALL_SHAPES.length);
    assert.doesNotMatch(all, /undefined|NaN|\[object Object\]/);
    // An absent time is a dash, never today's date.
    assert.equal(I.fmtTime(null), I.DASH);
    assert.equal(I.fmtTime('not-a-date'), I.DASH);
    // The third channel value renders, and an unknown one is not dropped.
    assert.match(I.channelChip('test'), /chip-test">test</);
    assert.match(I.channelChip('carrier-pigeon'), /chip-other">carrier-pigeon</);
  });

  it('loads its derivation first and refuses out loud without it', () => {
    // SCRIPT ORDER IS LOAD-BEARING. The browser resolves the module through a
    // global, so turn-status.js must be in the page BEFORE the script that
    // consumes it. An HTML reorder would break the page with no other test
    // noticing.
    const iDep = HTML.indexOf('/admin/turn-status.js');
    const iPage = HTML.indexOf('/admin/incidents.js');
    const iApp = HTML.indexOf('/admin/app.js');
    assert.ok(iDep > -1, 'incidents.html must load /admin/turn-status.js');
    assert.ok(iPage > -1, 'incidents.html must load /admin/incidents.js');
    assert.ok(iApp > -1, 'incidents.html must load /admin/app.js — the API is '
      + 'the gate on this page (the HTML is served by express.static with no '
      + 'auth), and adminFetch is what turns a 401 into the login redirect');
    assert.ok(iDep < iPage,
      'incidents.html must load /admin/turn-status.js BEFORE /admin/incidents.js '
      + '— the browser branch resolves the dependency off window, so a reorder '
      + 'leaves the page with no derivation at all');

    // THE BROWSER BRANCH REFUSES OUT LOUD. node throws at require time if the
    // module is missing, which is visible; a browser would silently hand the
    // factory `undefined` and render a broken badge with nothing logged, and NO
    // test in this repository loads this page through a browser. So the branch
    // is exercised here directly, in a context shaped like a browser.
    const bare = { window: {} };
    vm.createContext(bare);
    assert.throws(() => vm.runInContext(SRC, bare),
      /incidents\.js: \/admin\/turn-status\.js must be loaded first/,
      'with the global absent the page script must throw, not degrade to a '
      + 'broken badge that nothing reports');

    const loaded = { window: { AdminTurnStatus: TS } };
    vm.createContext(loaded);
    vm.runInContext(SRC, loaded);
    assert.equal(typeof loaded.window.AdminIncidents.levelOf, 'function',
      'with the global present the browser branch must wire the page up');
    assert.equal(loaded.window.AdminIncidents.levelOf(ABORTED_DEADLINE_CHECK()), 'aborted',
      'and the browser-resolved dependency must be the same derivation');
  });
});

// Declared as a function so the browser-branch assertion above reads a row it
// did not close over from the module under test.
function ABORTED_DEADLINE_CHECK() {
  return {
    turn_id: 'x', tenant_id: TENANT_A, channel: 'voice', correlation_id: 'c',
    created_at: '2026-09-05T10:00:00.000Z',
    has_error: true, error_outcome: 'aborted', error_stage: 'generate_reply',
    abort_reason: 'deadline', aborted_after_commit: false, has_tool_error: false,
  };
}
