'use strict';

// ── The trace viewer's renderers (Issue 27) ─────────────────────────────────
//
// No DB, no server, no browser: node requires THE EXACT FILE THE BROWSER LOADS.
// `public/admin/traces.js` is UMD-lite for this reason, the same way
// `public/portal/shadow-notice.js` and `booking-summary.js` are, and its DOM
// half only wires itself when a document exists — so the require below has no
// side effects.
//
// WHAT THESE TESTS ARE ABOUT, and it is one thing: turn_traces has ZERO ROWS
// and will until the first production deploy, so every real visit to this page
// renders empty. A page that looks populated when the table is empty is worse
// than one that says it is empty. So the invariant under test is that the
// renderers report the ROW and nothing else — no defaults, no interpolation,
// no synthesised value standing in for an absent one.
//
// ELEVEN test() blocks across four describes, deliberately no more, following
// the rule tokenDrift.test.js, adminNav.test.js and adminShell.test.js all
// state: a block per assertion reports one fault many times and says nothing
// extra. The first draft of this file was thirty blocks and every assertion in
// it survives here.
//
// The tenant contract is tested here at the level the page controls: the URL it
// builds. That it is REFUSED correctly by the route is
// tests/admin/tracePageContract.integration.test.js's job, over HTTP.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const T = require('../../public/admin/traces.js');

const ADMIN = path.join(__dirname, '..', '..', 'public', 'admin');
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const TURN = '33333333-3333-3333-3333-333333333333';

describe('trace page — the tenant contract, as the page builds it (ADMIN-S3a)', () => {
  it('refuses to build a url the route would reject for want of a tenant', () => {
    // The list route answers a tenant-less request with 400. A page that sent
    // it anyway would render that 400 as "no traces", which is a different and
    // untrue answer — so the page declines to ask.
    assert.equal(T.listUrl({}), null);
    assert.equal(T.listUrl({ tenantId: '' }), null);
    assert.equal(T.listUrl({ tenantId: null, conversationId: 'c', correlationId: 'x' }), null);

    // The detail route 400s on EITHER id missing, and takes the tenant from
    // nowhere but the query string.
    assert.equal(T.detailUrl(TURN, null), null);
    assert.equal(T.detailUrl(null, TENANT), null);
  });

  it('puts tenant_id on every url it does build, and invents no other filter', () => {
    for (const opts of [
      { tenantId: TENANT },
      { tenantId: TENANT, limit: 25 },
      { tenantId: TENANT, conversationId: OTHER },
      { tenantId: TENANT, correlationId: 'wa_0123456789abcdef' },
    ]) {
      assert.ok(T.listUrl(opts).includes('tenant_id=' + TENANT));
    }
    assert.equal(T.detailUrl(TURN, TENANT), `/admin/api/traces/${TURN}?tenant_id=${TENANT}`);

    // Exactly the four parameters the route reads. A fifth would be silently
    // ignored by the route and would mislead whoever added it.
    const q = new URLSearchParams(T.listUrl({
      tenantId: TENANT, conversationId: OTHER, correlationId: 'wa_0123456789abcdef', limit: 200,
    }).split('?')[1]);
    assert.deepEqual([...q.keys()].sort(),
      ['conversation_id', 'correlation_id', 'limit', 'tenant_id']);
  });
});

describe('trace page — what the row says, and only what it says (I2)', () => {
  it('reads status off `error` and out of no other column', () => {
    assert.equal(T.statusOf({ error: null }).key, 'ok');
    assert.equal(T.statusOf({ error: undefined }).key, 'ok');
    assert.equal(T.statusOf({ error: { outcome: 'aborted', abort_reason: 'deadline' } }).key, 'aborted');
    assert.equal(T.statusOf({ error: { stage: 'dispatch', message: 'boom', status: 500 } }).key, 'failed');

    // A row with a full, healthy-looking body and an error is still failed.
    assert.equal(T.statusOf({
      error: { stage: 'dispatch', message: 'boom' },
      stage_timings: { total_ms: 12 }, llm: { model: 'g' }, tool_calls: [],
    }).key, 'failed');

    // Every badge class it emits must resolve to a rule that exists.
    const css = fs.readFileSync(path.join(ADMIN, 'style.css'), 'utf8');
    for (const e of [null, { outcome: 'aborted' }, { stage: 'x' }]) {
      const cls = T.statusOf({ error: e }).badge;
      assert.ok(css.includes('.' + cls), `style.css declares no .${cls}`);
    }
  });

  it('renders an absent number as a dash and never as zero, an absent time never as a date', () => {
    assert.equal(T.totalMsOf({ stage_timings: null }), null);
    assert.equal(T.totalMsOf({ stage_timings: {} }), null);
    assert.equal(T.totalMsOf({}), null);
    assert.equal(T.totalMsOf({ stage_timings: { total_ms: 0 } }), 0, 'a real zero is a real zero');
    assert.equal(T.totalMsOf({ stage_timings: { total_ms: 1904.2 } }), 1904.2);

    assert.equal(T.fmtMs(null), T.DASH);
    assert.notEqual(T.fmtMs(0), T.DASH, 'zero milliseconds is a measurement, not an absence');

    assert.equal(T.fmtTime(null), T.DASH);
    assert.equal(T.fmtTime(''), T.DASH);
    assert.equal(T.fmtTime('not-a-date'), T.DASH);

    // Eliding hides a tail; it never invents one.
    assert.equal(T.elide(null, 8), null);
    assert.equal(T.elide('', 8), null);
    assert.equal(T.elide('abcd', 8), 'abcd');
    assert.equal(T.elide('abcdefghijkl', 8), 'abcdefgh…');
  });

  it('draws the columns and one honest line when there is nothing, and no row that looks like data', () => {
    const html = T.rowsHtml([]);
    assert.match(html, /colspan="6"/, 'the empty state spans the drawn columns');
    assert.doesNotMatch(html, /class="trace-row"/, 'an empty list must render no row that looks like data');
    assert.match(html, /No traces for this clinic yet\./);
    // It says what WILL appear, which is the whole job of an empty state that
    // is the primary state.
    assert.match(html, /every AI turn/);
  });

  it('tells null and absent apart, everywhere the column can be either', () => {
    // A trace with no tool calls and a trace whose tool_calls failed to record
    // are different facts and must not render identically.
    const nulTools = T.toolCallsHtml(null);
    const emptyTools = T.toolCallsHtml([]);
    assert.notEqual(nulTools, emptyTools);
    assert.match(nulTools, /the column is null/);
    assert.match(emptyTools, /empty list was recorded/);

    const nulRetr = T.retrievalHtml(null);
    assert.notEqual(nulRetr, T.retrievalHtml([]));
    // null conflates two real cases and the copy admits it rather than picking.
    assert.match(nulRetr, /no knowledge base/);
    assert.match(nulRetr, /failed/);

    assert.match(T.llmHtml(null), /never reached the model/);
    assert.match(T.errorHtml(null), /the turn completed/);
  });

  it('renders the third channel value, and does not drop an unknown one', () => {
    // The DDL comment says 'whatsapp' | 'voice'. testTurnService writes 'test'
    // in production. The page renders what the column holds.
    assert.match(T.channelChip('whatsapp'), /chip-whatsapp/);
    assert.match(T.channelChip('voice'), /chip-voice/);
    assert.match(T.channelChip('test'), /chip-test/);
    assert.match(T.channelChip('something_new'), /chip-other/);
    assert.match(T.channelChip('something_new'), /something_new/);
    assert.equal(T.channelChip(null), T.DASH);
  });
});

describe('trace page — stage durations', () => {
  const TIMINGS = { fetch_parallel: 120, gemini_call_1: 840, dispatch: 40, total_ms: 1000 };

  it('scales against total_ms, excludes it from the bars, and orders longest first', () => {
    const html = T.stagesHtml(TIMINGS);
    // total_ms is the denominator, not a stage.
    assert.doesNotMatch(html, /class="tw-name">total_ms</);
    assert.match(html, /class="tw-name">gemini_call_1</);
    assert.match(html, /width:84\.00%/, '840 of 1000');
    assert.match(html, /width:12\.00%/, '120 of 1000');
    // "Where did the time go" is answered by reading down.
    const names = [...html.matchAll(/class="tw-name">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(names, ['gemini_call_1', 'fetch_parallel', 'dispatch']);
  });

  it('draws NO bars without a positive total_ms, says why, and still reports the durations', () => {
    // The alternative is inventing a denominator (the max, the sum), which
    // would be inventing the proportions the reader came to read.
    for (const st of [{ a: 10, b: 5 }, { a: 10, total_ms: 0 }, { a: 10, total_ms: null }]) {
      const html = T.stagesHtml(st);
      assert.doesNotMatch(html, /tw-bar/, `bars drawn without a denominator: ${JSON.stringify(st)}`);
      assert.match(html, /no denominator/);
      assert.match(html, /10 ms/, 'the durations are still reported');
    }
    assert.match(T.stagesHtml(null), /No stage timings on this row\./);
  });
});

describe('trace page — CONTENT-CLASS:FREE-TEXT is disclosed, truncated and escaped', () => {
  const LONG = 'y'.repeat(1000);

  it('never interpolates the full value, and states that it truncated', () => {
    const html = T.freeText(LONG, 'error message');
    assert.ok(!html.includes(LONG), 'the untruncated value reached the markup');
    assert.ok(html.includes('y'.repeat(T.FREE_TEXT_CAP)));
    assert.ok(!html.includes('y'.repeat(T.FREE_TEXT_CAP + 1)));
    // Eliding is allowed; hiding that you elided is not.
    assert.match(html, new RegExp(`truncated at ${T.FREE_TEXT_CAP} characters, 1000 in the row`));
    assert.doesNotMatch(T.freeText('short', 'error message'), /truncated/);
  });

  it('sits behind a collapsed disclosure that names the hazard, and escapes the value', () => {
    const html = T.freeText('anything', 'error message');
    assert.match(html, /^<details class="rawtext">/, 'must be collapsed, not open');
    assert.match(html, /<summary>[^<]*unsanitised[^<]*<\/summary>/);
    assert.match(html, /may contain text the system did not choose/);
    assert.doesNotMatch(html, /<summary>Details<\/summary>/);

    const injected = T.freeText('<img src=x onerror=alert(1)>', 'tool error');
    assert.ok(!injected.includes('<img'), 'raw markup reached the DOM');
    assert.match(injected, /&lt;img/);
  });

  it('guards BOTH sites, leaves the closed-set fields plain, and is greppable in the shipped file', () => {
    assert.match(T.errorHtml({ stage: 'dispatch', message: LONG }), /class="rawtext"/);
    assert.match(
      T.toolCallsHtml([{ n: 1, name: 'book_appointment', latency_ms: 5, outcome: { status: 'error', error: LONG } }]),
      /class="rawtext"/);

    const html = T.errorHtml({ outcome: 'aborted', abort_reason: 'client_gone', aborted_after_commit: true, stage: 'generate_reply', message: 'voice turn aborted' });
    const beforeDisclosure = html.split('<details')[0];
    for (const closed of ['aborted', 'client_gone', 'true', 'generate_reply']) {
      assert.ok(beforeDisclosure.includes(closed), `${closed} must render plainly`);
    }

    // The content-gate session finds these by grep instead of re-deriving the
    // analysis that put them here.
    const js = fs.readFileSync(path.join(ADMIN, 'traces.js'), 'utf8');
    assert.ok(js.split('CONTENT-CLASS:FREE-TEXT').length - 1 >= 3);
    assert.match(js, /CONTENT-CLASS:FREE-TEXT — outcome\.error/);
    assert.match(js, /CONTENT-CLASS:FREE-TEXT — error\.message/);
  });
});
