/* ============================================================================
 * Incidents (INCIDENTS-C) — what failed, across every clinic, newest first.
 *
 * Static + vanilla JS, panel idiom, read-only. One request to
 * GET /admin/api/incidents, one to GET /admin/api/tenants for the names, and
 * nothing else. It renders. It does not classify, filter, page or rank.
 *
 * ── UMD-lite, like traces.js and turn-status.js ─────────────────────────────
 * The pure half is exported so node can require THE EXACT FILE THE BROWSER
 * LOADS and test it with no DOM and no server. The DOM half wires itself only
 * when a document exists, so the require is side-effect free.
 *
 * ── THE TWO THINGS THIS PAGE MUST NOT DO ────────────────────────────────────
 *
 * 1. AN EMPTY LIST MUST NOT READ AS "NOTHING IS WRONG".
 *    `turn_traces` has zero rows and will until the first production deploy, so
 *    the empty state is not an edge case — it is the SHIPPING state, the first
 *    thing anyone sees and for weeks the only thing. Two separate facts make
 *    "no incidents" a false reading of it:
 *      • zero rows means zero TRAFFIC, not zero failures;
 *      • F-A055: a request refused before a turn began writes `error: null` and
 *        is invisible to this route BY CONSTRUCTION. A clinic whose config is
 *        gone can be answering nobody while this page shows an empty list and
 *        looks correct.
 *    So `emptyHtml` is a statement about THE RECORD and never a claim about
 *    reality, and the standing scope note in incidents.html — visible at every
 *    volume, including zero — carries the blind spot. The copy is authored
 *    once, in each of those two places, and is asserted on MEANING in
 *    tests/admin/incidentsPage.unit.test.js.
 *
 * 2. A TRUNCATED LIST MUST SAY IT IS TRUNCATED.
 *    The route caps at 200 and offers no cursor. When the response length
 *    equals the requested limit the list is a WINDOW and not the set.
 *    Presenting it as the set is rank-then-truncate — the defect INCIDENTS-B
 *    existed to kill — reappearing one layer up, where no SQL test can see it.
 *    `truncationHtml` discloses it and the boundary is tested from both sides.
 *
 * ── ONE DERIVATION OF SEVERITY, AND IT IS NOT HERE ──────────────────────────
 * `/admin/turn-status.js` owns the ladder. This file calls `incidentLevel` and
 * writes no `error` test and no `'aborted'` comparison of its own. If you are
 * about to add one, stop — that is the defect turn-status.js was created to
 * prevent (F-A060).
 *
 * SCRIPT ORDER IS LOAD-BEARING: incidents.html loads /admin/turn-status.js
 * FIRST. In node an unresolvable require throws at require time and every block
 * in the unit test reddens at once. In a browser an unresolved global would
 * simply be `undefined` and the page would render a broken badge with nothing
 * logged, and no test in this repository loads this page through a browser —
 * hence the explicit throw.
 *
 * ── PRESENTATION LIVES HERE, DELIBERATELY ───────────────────────────────────
 * turn-status.js returns KEYS ONLY. tests/design/adminShell.test.js:263 scans a
 * HAND-NAMED list of files for `badge-` class literals and checks each resolves
 * to a rule in style.css; `incidents.js` is on that list and turn-status.js is
 * not, so these strings must stay in this file. No new badge class and no new
 * design token was introduced (D-016): `failed` and `tool error` share
 * `badge-red` and are separated by their LABEL, which SC 1.4.1 requires anyway
 * — colour may never be the only carrier of meaning.
 *
 * ── WHAT NEVER CROSSES THE WIRE ─────────────────────────────────────────────
 * `error.message` and `tool_calls[].outcome.error` are unbounded and partly
 * patient-derived, and `incidentsQuery.js` does not project them. This page
 * does not fetch them, does not render them and does not work around their
 * absence. The full row is one click away at the tenant-scoped trace viewer.
 *
 * ── WHAT THE ROW CANNOT TELL YOU, AND IS NOT ASKED TO ───────────────────────
 * Rates, trends, comparisons and per-tenant verdicts are absent because a rate
 * needs a denominator this route does not return. Levels are never ranked
 * against each other either: `aborted_after_commit` is REPORTED, not scored —
 * which of "crossed the point of no return and finished anyway" and "generation
 * stopped" is worse is a judgement about patient impact that no column states.
 * Rank by recency inside a level; never rank levels.
 * ========================================================================== */
'use strict';

(function (root, factory) {
  // The one dependency, resolved in BOTH environments — traces.js's idiom.
  const TS = (typeof module === 'object' && module.exports)
    ? require('./turn-status.js')
    : (root && root.AdminTurnStatus);
  if (!TS) {
    throw new Error('incidents.js: /admin/turn-status.js must be loaded first');
  }
  const api = factory(TS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdminIncidents = api;
  if (root && typeof document !== 'undefined') api._wire(root, document);
})(typeof window !== 'undefined' ? window : null, function (TS) {

  const DASH = '—';

  /* The route's hard cap, asked for explicitly. The page has no pagination, so
   * requesting less than the ceiling would discard rows it could show and make
   * truncation MORE likely, for nothing. Asking for it explicitly is also what
   * makes truncation detectable: `rows.length === LIMIT` is only a statement
   * when the limit is known. */
  const LIMIT = 200;

  /* Time · Clinic · Channel · Level · Why · Correlation id · Trace. */
  const COLUMNS = 7;

  /* Every field this page reads off a row of GET /admin/api/incidents.
   *
   * THIS IS A CONTRACT, NOT A CONVENIENCE. A renamed column arrives as
   * `undefined`, which is falsy, which flattens to {hasError:false} and ranks a
   * FAILED turn `ok` — a silent wrong answer on the one page whose whole job is
   * to say what failed. So: the shape is asserted before the row is read
   * (`assertRowShape`), the list is checked against incidentsQuery.js's own
   * projection by tests/admin/incidentsPage.unit.test.js with no database
   * involved, and the real response is put through this renderer over HTTP by
   * tests/admin/incidentsPageContract.integration.test.js. The static check is
   * the one that always runs; the integration suite skips without a database. */
  const REQUIRED_FIELDS = [
    'turn_id', 'tenant_id', 'channel', 'correlation_id', 'created_at',
    'has_error', 'error_outcome', 'error_stage', 'abort_reason',
    'aborted_after_commit', 'has_tool_error',
  ];

  /* key -> how THIS PAGE draws it. The derivation is turn-status.js's.
   *
   * `ok` IS DELIBERATELY ABSENT. The route's WHERE returns only rows carrying
   * an error envelope or a failed tool, so `incidentLevel` cannot answer `ok`
   * on a row that reached this page. Leaving the key out turns "the response
   * shape changed" from a green badge into a thrown error — the missing-field
   * guard and the unknown-level guard are the same defence, twice. */
  const PRESENTATION = {
    failed: { label: 'failed', badge: 'badge-red' },
    aborted: { label: 'aborted', badge: 'badge-yellow' },
    tool_error: { label: 'tool error', badge: 'badge-red' },
  };

  const CONTRACT = 'incidents.js: GET /admin/api/incidents returned a row this page cannot read — ';

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** A timestamp, or the dash. Never "Invalid Date" and never today's date. */
  function fmtTime(ts) {
    if (!ts) return DASH;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return DASH;
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  }

  /** Elide a long id; the full value rides in title=. Eliding is permitted,
   * synthesising is not — this never invents the tail it hides. */
  function elide(id, keep) {
    if (id == null || id === '') return null;
    const s = String(id);
    return s.length <= keep ? s : s.slice(0, keep) + '…';
  }

  /* The channel palette conversations.html and traces.html already use, so one
   * channel reads the same on all three. A third copy of five CSS rules, and
   * knowingly: hoisting them into style.css is the right fix and style.css is
   * held byte-identical this session. Filed rather than smuggled. */
  function channelChip(ch) {
    const known = { whatsapp: 'chip-whatsapp', voice: 'chip-voice', test: 'chip-test' };
    const cls = known[ch] || 'chip-other';
    return ch ? '<span class="chip ' + cls + '">' + esc(ch) + '</span>' : DASH;
  }

  // ── The contract ──────────────────────────────────────────────────────────
  /**
   * Every projected field this page reads must be PRESENT on the row. Absence
   * is the failure mode, not falsity: `has_error: false` is a fact the route
   * states, and `has_error` missing is a response this page cannot interpret.
   * `in` is therefore the test, never truthiness.
   */
  function assertRowShape(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(CONTRACT + 'the row is not an object.');
    }
    for (const f of REQUIRED_FIELDS) {
      if (!(f in row)) {
        throw new Error(CONTRACT + 'it carries no `' + f + '`. '
          + 'src/modules/traces/incidentsQuery.js projects that column and this '
          + 'page reads it; a missing field would flatten to false and rank a '
          + 'failed turn `ok`.');
      }
    }
  }

  /**
   * The row's level, through the one derivation. Three field reads and no
   * ladder: `incidentLevel` decides, this only adapts the shape it is given —
   * flattened columns — to the flattened primitives the classifier takes.
   */
  function levelOf(row) {
    assertRowShape(row);
    const level = TS.incidentLevel({
      hasError: row.has_error,
      isAbort: row.error_outcome === 'aborted',
      hasToolError: row.has_tool_error,
    });
    if (!Object.prototype.hasOwnProperty.call(PRESENTATION, level)) {
      throw new Error(CONTRACT + 'it ranks `' + level + '`, which this route '
        + 'cannot return — every row it selects carries an error envelope or a '
        + 'failed tool. Reaching this line means the response shape changed.');
    }
    return level;
  }

  function presentationOf(level) {
    const p = PRESENTATION[level];
    if (!p) throw new Error(CONTRACT + 'no presentation for level `' + level + '`.');
    return { key: level, label: p.label, badge: p.badge };
  }

  // ── URLs ──────────────────────────────────────────────────────────────────
  /** The one request this page makes. No filters, no cursor, no sort. */
  function listUrl() {
    return '/admin/api/incidents?limit=' + LIMIT;
  }

  /**
   * The trace viewer, scoped to the clinic this row belongs to.
   *
   * KNOWN DEGRADATION, stated rather than papered over (F-A066): traces.js
   * honours `?tenant_id=` and nothing else, so this cannot open the turn
   * itself. The correlation id is on the row for exactly that reason — it is
   * what the viewer's own filter takes. Deep-linking the viewer is a traces.js
   * change and traces.js is byte-identical this session.
   */
  function traceUrl(row) {
    if (!row || !row.tenant_id) return null;
    return '/admin/traces.html?tenant_id=' + encodeURIComponent(row.tenant_id);
  }

  // ── Cells ─────────────────────────────────────────────────────────────────
  /**
   * The clinic, named where it can be and identified where it cannot.
   *
   * `names` comes from ONE call to the cross-tenant GET /admin/api/tenants,
   * mapped client-side — no fan-out, no join, and incidentsQuery.js stays
   * exactly as INCIDENTS-B left it. A row whose tenant is missing from the map
   * (deleted since, or the tenant call failed outright) shows the ID. It never
   * shows a blank: a blank cell where a clinic belongs reads as "no clinic",
   * which is a claim the row does not make.
   */
  function clinicHtml(row, names) {
    const id = row.tenant_id;
    if (id == null || id === '') return DASH;
    const name = names && Object.prototype.hasOwnProperty.call(names, id) ? names[id] : null;
    if (name) return esc(name);
    return '<span class="mono" title="' + esc(id) + '">' + esc(elide(id, 8)) + '</span>';
  }

  /**
   * Why the row is here, from the closed sets and nothing else.
   *
   *   failed      error_stage — six timer literals, explicit args, and a
   *               'generate_reply' fallback
   *   aborted     abort_reason ('client_gone' | 'deadline') and, when the row
   *               states it, whether the turn had already committed. REPORTED,
   *               never scored: see the file header.
   *   tool_error  `has_tool_error` in words. WHICH tool, and what it said, live
   *               in tool_calls[].outcome.error, which is free text and is not
   *               projected. This renders the boolean it was given; it does not
   *               work around the absence of the string it was not.
   */
  function whyHtml(row, level) {
    if (level === 'aborted') {
      const reason = row.abort_reason == null
        ? DASH : '<span class="mono">' + esc(String(row.abort_reason)) + '</span>';
      if (row.aborted_after_commit == null) return reason;
      return reason + ' · ' + (row.aborted_after_commit ? 'after commit' : 'before commit');
    }
    if (level === 'tool_error') return 'a tool call reported an error';
    return row.error_stage == null
      ? DASH : '<span class="mono">' + esc(String(row.error_stage)) + '</span>';
  }

  // ── The empty state ───────────────────────────────────────────────────────
  /**
   * THE SHIPPING STATE. See the file header, point 1.
   *
   * Two sentences, and the second is the whole point: it refuses the inference
   * a reader would otherwise make from a drawn table with nothing in it. What
   * this list cannot see at ANY volume is the standing scope note's job, in
   * incidents.html, which is why it is not repeated here — the caveat is true
   * with two hundred rows on screen and does not belong to emptiness.
   *
   * Deliberately carries no date and no "until the first production deploy":
   * copy that self-falsifies on a known deploy is a defect with a timer on it.
   */
  function emptyHtml() {
    return '<tr><td colspan="' + COLUMNS + '"><div class="empty-note">'
      + '<strong>No failed turn has been recorded.</strong>'
      + 'An empty record is not the same as nothing having failed.'
      + '</div></td></tr>';
  }

  // ── The truncation disclosure ─────────────────────────────────────────────
  /**
   * A response that exactly fills the page it asked for is a WINDOW, and the
   * route offers no cursor to widen it. Silence here would present a window as
   * the set — which is rank-then-truncate one layer up, where no SQL test can
   * see it.
   *
   * `''` when the list is the whole answer. The boundary is asserted from both
   * sides: length == limit discloses, length == limit - 1 does not.
   */
  function truncationHtml(rows, limit) {
    const n = rows ? rows.length : 0;
    const cap = limit == null ? LIMIT : limit;
    if (n < cap) return '';
    return '<p class="trunc-note" role="status">'
      + '<strong>This is a window, not the whole list.</strong> '
      + 'The newest ' + n + ' are shown, which is the most this route will return, '
      + 'and there is no next page — older failures exist and are not on this page.'
      + '</p>';
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  function rowHtml(row, names) {
    const st = presentationOf(levelOf(row));
    const corr = elide(row.correlation_id, 22);
    const href = traceUrl(row);
    return '<tr class="incident-row">'
      + '<td>' + esc(fmtTime(row.created_at)) + '</td>'
      + '<td>' + clinicHtml(row, names) + '</td>'
      + '<td>' + channelChip(row.channel) + '</td>'
      + '<td><span class="badge ' + st.badge + '">' + esc(st.label) + '</span></td>'
      + '<td>' + whyHtml(row, st.key) + '</td>'
      + '<td class="mono hide-mobile">'
      + (corr ? '<span title="' + esc(row.correlation_id) + '">' + esc(corr) + '</span>' : DASH)
      + '</td>'
      + '<td>' + (href
        ? '<a href="' + esc(href) + '">Open&nbsp;&rarr;</a>' : DASH) + '</td>'
      + '</tr>';
  }

  /**
   * A row this page cannot read is reported IN THE TABLE, loudly and by name.
   *
   * The alternative is what this exists to prevent: a renamed column ranks a
   * failed turn `ok`, or renders a blank badge, and the page looks like it
   * worked. Throwing alone would blank the surface and tell the reader nothing,
   * so the throw is caught here and its message is what gets drawn.
   */
  function contractErrorHtml(err) {
    return '<tr><td colspan="' + COLUMNS + '"><div class="contract-fail">'
      + '<strong>This page could not read the response.</strong>'
      + esc(err && err.message ? err.message : String(err))
      + '</div></td></tr>';
  }

  /** Rows, the empty state, or the contract failure. Never a placeholder row
   * that looks like data, and never a level this page invented. */
  function rowsHtml(rows, names) {
    if (!rows || !rows.length) return emptyHtml();
    try {
      return rows.map((r) => rowHtml(r, names)).join('');
    } catch (err) {
      return contractErrorHtml(err);
    }
  }

  // ── The DOM half ──────────────────────────────────────────────────────────
  function _wire(win, doc) {
    const $ = (id) => doc.getElementById(id);
    let loading = false;

    function note(msg) {
      const el = $('pageNote');
      el.textContent = msg || '';
      el.style.display = msg ? 'block' : 'none';
    }

    /* One call, mapped client-side. A failure here is NOT fatal: the list still
     * loads and every row falls back to its tenant id, which is why the note is
     * left standing rather than cleared by the list request below. */
    async function loadTenantNames() {
      const res = await win.adminFetch('/admin/api/tenants');
      if (!res.ok) throw new Error('clinic list unavailable (' + res.status + ')');
      const names = {};
      for (const t of await res.json()) names[t.id] = t.business_name;
      return names;
    }

    async function load(names) {
      if (loading) return;
      loading = true;
      const tbody = $('incidentRows');
      const trunc = $('truncNote');
      try {
        const res = await win.adminFetch(listUrl());
        if (!res.ok) {
          // The route's OWN message, verbatim. The page carries no second copy
          // of the route's validation: a copy is a thing that can drift, and
          // the reason a request was refused is the route's to state.
          const body = await res.json().catch(() => null);
          note((body && body.error) || ('Request failed (' + res.status + ').'));
          // NOT the empty state. A refused request is not an empty record, and
          // rendering it as one is the untrue answer this page exists to avoid.
          tbody.innerHTML = '';
          trunc.innerHTML = '';
          return;
        }
        const rows = await res.json();
        tbody.innerHTML = rowsHtml(rows, names);
        trunc.innerHTML = truncationHtml(rows, LIMIT);
      } finally {
        loading = false;
      }
    }

    $('refreshBtn').addEventListener('click', () => {
      loadTenantNames()
        .then((names) => { note(''); return load(names); })
        .catch((err) => {
          note('Could not load the clinic list, so rows show tenant ids. '
            + (err && err.message ? err.message : ''));
          return load(null);
        });
    });

    /* load() ALWAYS runs, even when the clinic fetch failed. The empty state is
     * this page's primary state, so the one thing it may never do is leave the
     * reader a drawn table with no sentence under it. */
    (async () => {
      let names = null;
      try {
        names = await loadTenantNames();
      } catch (err) {
        note('Could not load the clinic list, so rows show tenant ids. '
          + (err && err.message ? err.message : ''));
      }
      await load(names);
    })();
  }

  return {
    DASH, LIMIT, COLUMNS, REQUIRED_FIELDS, PRESENTATION,
    esc, fmtTime, elide, channelChip,
    assertRowShape, levelOf, presentationOf,
    listUrl, traceUrl,
    clinicHtml, whyHtml,
    emptyHtml, truncationHtml, rowHtml, rowsHtml, contractErrorHtml,
    _wire,
  };
});
