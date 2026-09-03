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
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdminTraces = api;
  // The DOM half runs only in a browser, so `require` is side-effect free.
  if (root && typeof document !== 'undefined') api._wire(root, document);
})(typeof window !== 'undefined' ? window : null, function () {

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
  /**
   * The turn's outcome, derived from `error` AND NOTHING ELSE. `error` carries
   * two envelopes (writer.js documents both):
   *   NULL                                        → the turn succeeded
   *   { outcome:'aborted', abort_reason, … }      → an abort signal fired
   *   { stage, message, status }                  → the turn failed
   * This is a reading of a column, not a fact invented for the column: a row
   * with no error column value is a row that recorded no error.
   */
  function statusOf(row) {
    const e = row ? row.error : null;
    if (e == null) return { key: 'ok', label: 'ok', badge: 'badge-green' };
    if (typeof e === 'object' && e.outcome === 'aborted') {
      return { key: 'aborted', label: 'aborted', badge: 'badge-yellow' };
    }
    return { key: 'failed', label: 'failed', badge: 'badge-red' };
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
        if (!url) { note(''); tbody.innerHTML = emptyHtml('no-tenant'); return; }

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

    $('refreshBtn').addEventListener('click', loadList);
    ['tenantFilter', 'limitFilter'].forEach((id) =>
      $(id).addEventListener('change', loadList));
    ['convFilter', 'corrFilter'].forEach((id) =>
      $(id).addEventListener('change', loadList));

    (async () => {
      await loadTenants();
      await loadList();
    })();
  }

  return {
    DASH, COLUMNS,
    esc, fmtTime, fmtMs, elide, channelChip,
    statusOf, totalMsOf,
    listUrl, detailUrl,
    emptyHtml, rowHtml, rowsHtml,
    _wire,
  };
});
