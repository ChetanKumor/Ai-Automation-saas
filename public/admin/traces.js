/* ============================================================================
 * Traces (Issue 27) — the turn-trace viewer. Static + vanilla JS, panel idiom,
 * read-only. It answers one question: what happened on this turn, and where did
 * the time go?
 *
 * ── UMD-lite, like /portal/shadow-notice.js and /portal/booking-summary.js ───
 * The pure half (url building, status derivation, every renderer) is exported so
 * node can require THE EXACT FILE THE BROWSER LOADS and test it with no DOM and
 * no server. The DOM half wires itself only when a document exists, so the
 * require is side-effect free.
 *
 * ── THE TENANT CONTRACT IS THE WHOLE DESIGN (ADMIN-S3a) ─────────────────────
 * Both routes REQUIRE tenant_id. The list without one is
 * `400 {"error":"tenant_id is required; …"}` and the detail without one is
 * `400 {"error":"tenant_id is required and must be a UUID"}`. So:
 *   • listUrl() returns null when it has no tenant, and the page renders the
 *     empty state rather than firing a request it knows will be refused —
 *     rendering a 400 as "no traces" is a different and untrue answer.
 *   • every row carries its OWN tenant_id forward into the detail call. The
 *     detail route takes the tenant from nowhere else.
 *
 * ── NO PAGINATION, AND THAT IS THE API'S SHAPE, NOT AN OMISSION ─────────────
 * GET /admin/api/traces offers `limit` (1..200, default 50) and nothing else —
 * no cursor, no offset, no before/after. The conversations page's keyset
 * pagination has no counterpart here. The limit select is therefore the only
 * lever, and adding a route to change that is out of scope by construction.
 *
 * ── WHAT THE PAGE MAY NOT DO (I2) ───────────────────────────────────────────
 * turn_traces has ZERO ROWS until Issue 20 and every real visit renders empty
 * until then. The page renders what the row carries and nothing else: it never
 * defaults, interpolates or synthesises a value that did not come from a row.
 * An absent number renders as an em dash, never as 0. A page that looks
 * populated when the table is empty is worse than one that says it is empty.
 * ========================================================================== */
'use strict';

(function (root, factory) {
  // ── The one dependency, resolved in BOTH environments ─────────────────────
  //   node     the tests require THE EXACT FILE THE BROWSER LOADS, so the
  //            `require` below is the real resolution path, not a shim.
  //   browser  traces.html loads /admin/turn-status.js FIRST, and it publishes
  //            window.AdminTurnStatus. SCRIPT ORDER IS LOAD-BEARING.
  //
  // The two environments fail differently and only one fails loudly by itself.
  // In node an unresolvable require throws at require time and every block in
  // tests/admin/tracePage.unit.test.js reddens at once — visible. In a browser
  // an unresolved global would simply be `undefined` here, and the page would
  // render a broken badge with no error reported anywhere; no test in this
  // repository loads this page through a browser, so nothing would catch it.
  // Hence the explicit throw — the browser branch refuses out loud instead of
  // degrading silently.
  const TS = (typeof module === 'object' && module.exports)
    ? require('./turn-status.js')
    : (root && root.AdminTurnStatus);
  if (!TS) {
    throw new Error('traces.js: /admin/turn-status.js must be loaded first');
  }
  const api = factory(TS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdminTraces = api;
  // The DOM half runs only in a browser, so `require` is side-effect free.
  if (root && typeof document !== 'undefined') api._wire(root, document);
})(typeof window !== 'undefined' ? window : null, function (TS) {

  const DASH = '—';

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

  /** Elide a long id for the column; the full value rides in title=. Eliding is
   * permitted, synthesising is not — this never invents the tail it hides. */
  function elide(id, keep) {
    if (id == null || id === '') return null;
    const s = String(id);
    return s.length <= keep ? s : s.slice(0, keep) + '…';
  }

  // ── Status ────────────────────────────────────────────────────────────────
  // key → how THIS PAGE draws it. The derivation is turn-status.js's; the look
  // is the panel's, and these `badge-` literals must stay in this file:
  // tests/design/adminShell.test.js:263 scans a HAND-NAMED list of files for
  // badge class literals and checks each resolves to a rule in style.css.
  // traces.js is on that list and turn-status.js is not, so a badge string
  // moved out of here would not fail that scan — it would quietly stop being
  // scanned, which is the worse outcome.
  const PRESENTATION = {
    ok: { label: 'ok', badge: 'badge-green' },
    aborted: { label: 'aborted', badge: 'badge-yellow' },
    failed: { label: 'failed', badge: 'badge-red' },
  };

  /**
   * The turn's outcome, derived from `error` AND NOTHING ELSE. `error` carries
   * two envelopes (writer.js documents both):
   *   NULL                                        → the turn succeeded
   *   { outcome:'aborted', abort_reason, … }      → an abort signal fired
   *   { stage, message, status }                  → the turn failed
   * This is a reading of a column, not a fact invented for the column: a row
   * with no error column value is a row that recorded no error.
   *
   * THE LADDER ITSELF LIVES IN /admin/turn-status.js and is shared with the
   * incidents read, which asks a DIFFERENT question of the same row (F-A054).
   * A tool that reported an error is NOT an input here: that turn COMPLETED,
   * and `ok` is the true answer to the question this page asks. Reaching the
   * tool-error arm from this page would be a defect, and it is asserted against
   * in tests/admin/turnStatus.unit.test.js.
   */
  function statusOf(row) {
    const key = TS.turnStatus(TS.fromError(row ? row.error : null));
    return { key: key, label: PRESENTATION[key].label, badge: PRESENTATION[key].badge };
  }

  /** The turn's wall clock, or null. Never 0-for-missing. */
  function totalMsOf(row) {
    const st = row ? row.stage_timings : null;
    if (!st || typeof st !== 'object') return null;
    const t = st.total_ms;
    return typeof t === 'number' && isFinite(t) ? t : null;
  }

  function fmtMs(ms) {
    if (ms == null) return DASH;
    return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms';
  }

  function channelChip(ch) {
    const known = { whatsapp: 'chip-whatsapp', voice: 'chip-voice', test: 'chip-test' };
    const cls = known[ch] || 'chip-other';
    return ch ? '<span class="chip ' + cls + '">' + esc(ch) + '</span>' : DASH;
  }

  // ── URLs — the page's own call path ───────────────────────────────────────
  /**
   * The list URL, or NULL when there is no tenant to ask about. Returning null
   * rather than a tenant-less URL is what keeps the page from rendering the
   * route's 400 as an empty result.
   */
  function listUrl(opts) {
    const o = opts || {};
    if (!o.tenantId) return null;
    const p = new URLSearchParams();
    p.set('tenant_id', o.tenantId);
    if (o.conversationId) p.set('conversation_id', o.conversationId);
    if (o.correlationId) p.set('correlation_id', o.correlationId);
    if (o.limit) p.set('limit', String(o.limit));
    return '/admin/api/traces?' + p.toString();
  }

  /** One trace. Null without BOTH ids — the route requires both and 400s on either. */
  function detailUrl(turnId, tenantId) {
    if (!turnId || !tenantId) return null;
    return '/admin/api/traces/' + encodeURIComponent(turnId) +
      '?tenant_id=' + encodeURIComponent(tenantId);
  }

  // ── List rendering ────────────────────────────────────────────────────────
  const COLUMNS = 6;

  /**
   * The empty state is the PRIMARY state, not an edge case: turn_traces holds
   * no rows until the first production deploy, so every real visit lands here.
   * The columns above stay drawn and this says, in one line, what will fill
   * them — so the surface is legible before it has data.
   */
  function emptyHtml(reason) {
    const lines = {
      'no-tenant': ['No clinics yet.',
        'Traces are per clinic, so this page needs one before it can list anything.'],
      'no-rows': ['No traces for this clinic yet.',
        'A row lands here for every AI turn the receptionist takes — WhatsApp, voice, '
        + 'and the owner’s own test turns — carrying its stage timings, what it '
        + 'retrieved, and what broke.'],
    }[reason] || ['No traces.', ''];
    return '<tr><td colspan="' + COLUMNS + '"><div class="empty-note">'
      + '<strong>' + esc(lines[0]) + '</strong>' + esc(lines[1]) + '</div></td></tr>';
  }

  function rowHtml(r) {
    const st = statusOf(r);
    const corr = elide(r.correlation_id, 22);
    const conv = elide(r.conversation_id, 8);
    return '<tr class="trace-row" data-turn="' + esc(r.turn_id) + '" data-tenant="' + esc(r.tenant_id) + '">'
      + '<td>' + esc(fmtTime(r.created_at)) + '</td>'
      + '<td class="mono">' + (corr ? '<span title="' + esc(r.correlation_id) + '">' + esc(corr) + '</span>' : DASH) + '</td>'
      + '<td class="mono hide-mobile">' + (conv ? '<span title="' + esc(r.conversation_id) + '">' + esc(conv) + '</span>' : DASH) + '</td>'
      + '<td>' + channelChip(r.channel) + '</td>'
      + '<td>' + esc(fmtMs(totalMsOf(r))) + '</td>'
      + '<td><span class="badge ' + st.badge + '">' + esc(st.label) + '</span></td>'
      + '</tr>';
  }

  /** Rows, or the empty state. Never a placeholder row that looks like data. */
  function rowsHtml(rows) {
    if (!rows || !rows.length) return emptyHtml('no-rows');
    return rows.map(rowHtml).join('');
  }

  // ── Detail: null versus absent ────────────────────────────────────────────
  //
  // A trace with no tool calls and a trace whose tool_calls failed to record are
  // DIFFERENT FACTS and this page must not merge them. What the page can
  // actually distinguish is the column's value, so that is what it reports:
  //   • SQL NULL  — nothing was stored. writer.js maps "no tools this turn" to
  //     null (`j(snap.tools.length ? snap.tools : null)`), so a turn that used
  //     no tools and a turn whose list never reached the row are the same value
  //     here and the copy says so rather than picking one.
  //   • []        — an empty list really was stored. Something wrote "zero", and
  //     that is a stronger statement than null.
  // Same rule for retrieval: contextAssembler records null, never [], when no
  // retrieval ran — so null there conflates a KB-less tenant with a RAG failure.
  function absence(value, nullCopy, emptyCopy) {
    if (value == null) return '<p class="sec-note" style="margin:0">' + esc(nullCopy) + '</p>';
    if (Array.isArray(value) && value.length === 0) {
      return '<p class="sec-note" style="margin:0">' + esc(emptyCopy) + '</p>';
    }
    return null;
  }

  // ── ⚠ CONTENT-CLASS:FREE-TEXT ─────────────────────────────────────────────
  //
  // Two fields on this row are UNSANITISED FREE TEXT and can carry strings the
  // system did not choose:
  //
  //   error.message              collector.setErrorFromException writes raw
  //                              err.message, from catches that wrap entire turn
  //                              bodies (internalVoice.js) — anything that
  //                              throws puts its message here.
  //   tool_calls[].outcome.error String(output.error) — and appointmentService's
  //                              doctor_not_found interpolates the model's own
  //                              `doctor` argument, which the model took from
  //                              the patient's utterance, verbatim.
  //
  // The DDL's "never full text" promise covers `prompt` and only `prompt`. The
  // real defect is upstream, at the writer, and is filed as its own session: a
  // fix here would leave every future reader of turn_traces re-inheriting it.
  //
  // Until then this page: renders the CLOSED-SET fields plainly, puts both free-
  // text fields behind a collapsed disclosure whose label says what they are,
  // and TRUNCATES in the renderer. The full value is never interpolated into the
  // DOM — eliding is permitted, synthesising is not, and neither is smuggling.
  const FREE_TEXT_CAP = 240;

  function freeText(value, what) {
    if (value == null) return '';
    const s = String(value);
    const clipped = s.length > FREE_TEXT_CAP;
    const shown = clipped ? s.slice(0, FREE_TEXT_CAP) : s;
    return '<details class="rawtext">'
      + '<summary>Show the raw ' + esc(what) + ' — unsanitised, and may contain text the system did not choose</summary>'
      + '<pre>' + esc(shown) + '</pre>'
      + (clipped
        ? '<span class="cap">… truncated at ' + FREE_TEXT_CAP + ' characters, ' + s.length + ' in the row.</span>'
        : '')
      + '</details>';
  }

  // ── Detail renderers ──────────────────────────────────────────────────────
  function kv(label, value) {
    return '<div><span>' + esc(label) + ':</span> ' + (value == null || value === '' ? DASH : value) + '</div>';
  }
  const monoOr = (v) => (v == null || v === '' ? DASH : '<span class="mono">' + esc(v) + '</span>');

  function metaHtml(t) {
    const st = statusOf(t);
    return kv('Turn', monoOr(t.turn_id))
      + kv('Correlation', monoOr(t.correlation_id))
      + kv('Channel', channelChip(t.channel))
      + kv('Conversation', monoOr(t.conversation_id))
      + kv('Call session', monoOr(t.call_session_id))
      + kv('Recorded', esc(fmtTime(t.created_at)))
      + kv('Status', '<span class="badge ' + st.badge + '">' + esc(st.label) + '</span>');
  }

  /**
   * Proportional bars over `total_ms`, longest first, with `total_ms` itself
   * removed from the set — it is the denominator, not a stage.
   *
   * Without a positive total_ms there is no denominator, and inventing one (the
   * largest stage, the sum) would be inventing the proportions the reader is
   * here to read. The values are listed instead, and the page says why.
   */
  function stagesHtml(stageTimings) {
    const absent = absence(stageTimings, 'No stage timings on this row.', 'An empty timing object was recorded.');
    if (absent) return absent;
    if (typeof stageTimings !== 'object') return absence(null, 'No stage timings on this row.', '');

    const entries = Object.keys(stageTimings)
      .filter((k) => k !== 'total_ms')
      .map((k) => [k, stageTimings[k]])
      .filter(([, v]) => typeof v === 'number' && isFinite(v))
      .sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
      return '<p class="sec-note" style="margin:0">No named stages on this row — only a turn total.</p>';
    }

    const total = stageTimings.total_ms;
    const scaled = typeof total === 'number' && isFinite(total) && total > 0;

    const rows = entries.map(([name, ms]) => {
      const pct = scaled ? Math.max(0.4, Math.min(100, (ms / total) * 100)) : null;
      const track = scaled
        ? '<div class="tw-track"><div class="tw-bar" style="width:' + pct.toFixed(2) + '%"></div></div>'
        : '<div></div>';
      return '<div class="tw-name">' + esc(name) + '</div>' + track
        + '<div class="tw-ms">' + esc(fmtMs(ms)) + '</div>';
    }).join('');

    const note = scaled
      ? '<p class="sec-note" style="margin:12px 0 0">Turn total ' + esc(fmtMs(total)) + '.</p>'
      : '<p class="sec-note" style="margin:12px 0 0">This row carries no <code>total_ms</code>, so there is '
        + 'no denominator to draw bars against. The durations are listed as recorded.</p>';

    return '<div class="tw">' + rows + '</div>' + note;
  }

  function retrievalHtml(retrieval) {
    const absent = absence(retrieval, 'No retrieval ran on this turn. The row stores null both for a tenant with '
      + 'no knowledge base and for a retrieval that failed — they are the same value here.',
    'An empty retrieval list was recorded.');
    if (absent) return absent;
    if (!Array.isArray(retrieval)) return absence(null, 'Retrieval is not a list on this row.', '');

    const rows = retrieval.map((c) => {
      const below = c && c.below_floor
        ? ' <span class="badge badge-yellow">below floor</span>' : '';
      const score = c && typeof c.score === 'number' ? c.score.toFixed(4) : DASH;
      return '<div>' + monoOr(c ? c.chunk_id : null) + ' &nbsp;<span>score</span> ' + esc(score) + below + '</div>';
    }).join('');
    return '<div class="kv">' + rows + '</div>';
  }

  function promptHtml(prompt) {
    const absent = absence(prompt, 'No prompt provenance on this row — the turn did not reach prompt preparation.', '');
    if (absent) return absent;
    return '<div class="kv">'
      + kv('Hash', monoOr(prompt.hash))
      + kv('Config version', prompt.config_version == null
        ? DASH + ' <span>(null unless the prompt was rendered from a config document)</span>'
        : esc(String(prompt.config_version)))
      + kv('Mode', prompt.mode == null ? DASH : esc(String(prompt.mode)))
      + '</div>';
  }

  function llmHtml(llm) {
    const absent = absence(llm, 'The turn never reached the model.', '');
    if (absent) return absent;
    const calls = Array.isArray(llm.calls) ? llm.calls : [];
    const perCall = calls.map((c) => '<div>'
      + '<span>call ' + esc(c.n) + '</span> ' + esc(c.model == null ? DASH : c.model)
      + ' &nbsp;<span>in</span> ' + esc(c.input_tokens == null ? DASH : c.input_tokens)
      + ' &nbsp;<span>out</span> ' + esc(c.output_tokens == null ? DASH : c.output_tokens)
      + ' &nbsp;<span>thinking</span> ' + esc(c.thinking_tokens == null ? DASH : c.thinking_tokens)
      + ' &nbsp;<span>took</span> ' + esc(fmtMs(typeof c.latency_ms === 'number' ? c.latency_ms : null))
      + ' &nbsp;<span>finish</span> ' + esc(c.finish_reason == null ? DASH : c.finish_reason)
      + (c.streamed ? ' &nbsp;<span class="badge badge-blue">streamed</span>' : '')
      + '</div>').join('');
    return '<div class="kv">'
      + kv('Model', llm.model == null ? null : esc(String(llm.model)))
      + kv('Input tokens', llm.input_tokens == null ? null : esc(String(llm.input_tokens)))
      + kv('Output tokens', llm.output_tokens == null ? null : esc(String(llm.output_tokens)))
      + kv('Model latency', esc(fmtMs(typeof llm.latency_ms === 'number' ? llm.latency_ms : null)))
      + kv('Finish reason', llm.finish_reason == null ? null : esc(String(llm.finish_reason)))
      + (perCall ? '<div style="margin-top:8px">' + perCall + '</div>' : '')
      + '</div>';
  }

  function toolCallsHtml(toolCalls) {
    const absent = absence(toolCalls,
      'Nothing recorded — the column is null. A turn that used no tools and a turn whose tool list never '
      + 'reached the row are the same value here.',
      'An empty list was recorded: this turn ran no tools, and said so.');
    if (absent) return absent;
    if (!Array.isArray(toolCalls)) return absence(null, 'Tool calls are not a list on this row.', '');

    return toolCalls.map((c) => {
      const o = c && c.outcome;
      const status = o && typeof o === 'object' && o.status != null ? String(o.status) : null;
      const badge = status === 'error' ? 'badge-red' : status === 'ok' ? 'badge-green' : 'badge-blue';
      const success = o && typeof o === 'object' && o.success !== undefined
        ? ' &nbsp;<span>success</span> ' + esc(String(o.success)) : '';
      // ⚠ CONTENT-CLASS:FREE-TEXT — outcome.error, site 1 of 2.
      const raw = o && typeof o === 'object' && o.error != null ? freeText(o.error, 'tool error') : '';
      return '<div style="margin-bottom:10px">'
        + '<div><span>' + esc(c && c.n != null ? c.n : DASH) + '.</span> <strong>'
        + esc(c && c.name != null ? c.name : DASH) + '</strong>'
        + ' &nbsp;<span>took</span> ' + esc(fmtMs(c && typeof c.latency_ms === 'number' ? c.latency_ms : null))
        + ' &nbsp;' + (status ? '<span class="badge ' + badge + '">' + esc(status) + '</span>'
          : '<span>outcome ' + DASH + '</span>')
        + success + '</div>' + raw + '</div>';
    }).join('');
  }

  function errorHtml(err) {
    const absent = absence(err, 'No error on this row — the turn completed.', '');
    if (absent) return absent;
    // Was a SECOND derivation of the same fact, eight lines from statusOf
    // (F-A060). `absence` above already returned for a null envelope, so this
    // is the two-arm tail of the same ladder and it routes through the same
    // module. The Outcome line below renders this value as VISIBLE TEXT, so
    // turn-status.js's key vocabulary is load-bearing on rendered output here.
    const aborted = TS.turnStatus(TS.fromError(err)) === 'aborted';
    return '<div class="kv">'
      + kv('Outcome', aborted ? 'aborted' : 'failed')
      + (aborted ? kv('Abort reason', err.abort_reason == null ? null : esc(String(err.abort_reason))) : '')
      + (aborted ? kv('After commit', err.aborted_after_commit == null
        ? null : esc(String(err.aborted_after_commit))) : '')
      + kv('Stage', err.stage == null ? null : esc(String(err.stage)))
      + (aborted ? '' : kv('Status', err.status == null ? null : esc(String(err.status))))
      // ⚠ CONTENT-CLASS:FREE-TEXT — error.message, site 2 of 2.
      + freeText(err.message, 'error message')
      + '</div>';
  }

  // ── The DOM half ──────────────────────────────────────────────────────────
  function _wire(win, doc) {
    const $ = (id) => doc.getElementById(id);
    let loading = false;

    function note(msg) {
      const el = $('filterNote');
      el.textContent = msg || '';
      el.style.display = msg ? 'block' : 'none';
    }

    async function loadTenants() {
      const res = await win.adminFetch('/admin/api/tenants');
      if (!res.ok) throw new Error('tenant list unavailable (' + res.status + ')');
      const tenants = await res.json();
      const sel = $('tenantFilter');
      // Same reasoning as conversations.js: the list route requires a tenant, so
      // there is no all-tenants view to offer and no placeholder option to keep.
      sel.innerHTML = '';
      tenants.forEach((t) => {
        const opt = doc.createElement('option');
        opt.value = t.id;
        opt.textContent = t.business_name;
        sel.appendChild(opt);
      });
      // Honor a ?tenant_id= deep link, as the conversations page does.
      const pre = new URLSearchParams(win.location.search).get('tenant_id');
      if (pre) sel.value = pre;
    }

    async function loadList() {
      if (loading) return;
      loading = true;
      const tbody = $('traceRows');
      try {
        const url = listUrl({
          tenantId: $('tenantFilter').value,
          conversationId: $('convFilter').value.trim(),
          correlationId: $('corrFilter').value.trim(),
          limit: $('limitFilter').value,
        });
        // Deliberately does NOT clear the note: the reason there is no tenant
        // may be the failure loadTenants just reported, and clearing it here
        // wiped that message off the page. Only a request that SUCCEEDS clears
        // the note.
        if (!url) { tbody.innerHTML = emptyHtml('no-tenant'); return; }

        const res = await win.adminFetch(url);
        if (!res.ok) {
          // The route's OWN message, verbatim. The page deliberately carries no
          // second copy of the route's filter validation: a copy is a thing that
          // can drift, and the reason a request was refused is the route's to
          // state. These strings are a closed set authored in adminRoutes.js.
          const body = await res.json().catch(() => null);
          note((body && body.error) || ('Request failed (' + res.status + ').'));
          tbody.innerHTML = emptyHtml('no-rows');
          return;
        }
        note('');
        tbody.innerHTML = rowsHtml(await res.json());
      } finally {
        loading = false;
      }
    }

    /* The detail route takes the tenant from NOWHERE but the query string
     * (ADMIN-S3a), so the row carries its own tenant_id and this hands it back.
     * A 404 here is both "no such trace" and "not your trace" — the route makes
     * them indistinguishable on purpose, so the page says the honest thing
     * rather than guessing which one it was. */
    async function openDetail(turnId, tenantId) {
      const url = detailUrl(turnId, tenantId);
      if (!url) return;
      const res = await win.adminFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        note((body && body.error) || ('Request failed (' + res.status + ').'));
        return;
      }
      note('');
      const t = await res.json();

      $('dTitle').textContent = 'Turn ' + (elide(t.turn_id, 8) || '');
      $('dMeta').innerHTML = metaHtml(t);
      $('dStages').innerHTML = stagesHtml(t.stage_timings);
      $('dRetrieval').innerHTML = retrievalHtml(t.retrieval);
      $('dPrompt').innerHTML = promptHtml(t.prompt);
      $('dLlm').innerHTML = llmHtml(t.llm);
      $('dTools').innerHTML = toolCallsHtml(t.tool_calls);
      $('dError').innerHTML = errorHtml(t.error);

      $('traceList').style.display = 'none';
      $('traceDetail').style.display = 'block';
      win.scrollTo(0, 0);
    }

    function showList() {
      $('traceDetail').style.display = 'none';
      $('traceList').style.display = 'block';
    }

    $('traceRows').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.trace-row');
      if (tr) openDetail(tr.dataset.turn, tr.dataset.tenant);
    });
    $('backBtn').addEventListener('click', showList);
    $('refreshBtn').addEventListener('click', loadList);
    ['tenantFilter', 'limitFilter'].forEach((id) =>
      $(id).addEventListener('change', loadList));
    ['convFilter', 'corrFilter'].forEach((id) =>
      $(id).addEventListener('change', loadList));

    // loadList ALWAYS runs, even when the tenant fetch failed. The empty state
    // is this page's primary state, so the one thing it may never do is leave
    // the reader a drawn table with no sentence under it: an unhandled rejection
    // in loadTenants used to do exactly that, and it was caught by looking at a
    // capture rather than by any assertion.
    (async () => {
      try {
        await loadTenants();
      } catch (err) {
        note('Could not load the clinic list, so there is no tenant to ask about. '
          + (err && err.message ? err.message : ''));
      }
      await loadList();
    })();
  }

  return {
    DASH, COLUMNS, FREE_TEXT_CAP,
    esc, fmtTime, fmtMs, elide, channelChip,
    statusOf, totalMsOf, absence, freeText,
    listUrl, detailUrl,
    emptyHtml, rowHtml, rowsHtml,
    metaHtml, stagesHtml, retrievalHtml, promptHtml, llmHtml, toolCallsHtml, errorHtml,
    _wire,
  };
});
