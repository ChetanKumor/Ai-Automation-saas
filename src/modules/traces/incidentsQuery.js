'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  CROSS-TENANT BY DESIGN. This module contains NO tenant predicate, and that
//  is deliberate — it is not an omission and must never be "fixed".
//
//  It lives apart from queryService.js on purpose. That file's header says
//  "the thin read layer behind the admin JSON routes" and both of its reads
//  are tenant-scoped, emphatically so, because ADMIN-S3a found a scoped read
//  hiding in a service with its predicate missing and nobody noticing. An
//  INTENTIONALLY unscoped read filed alongside them becomes the thing someone
//  copies as a template for a scoped one. Kept here, its posture is in the
//  filename and in this banner, and queryService.js stays byte-identical.
//
//  Scope comes from the REQUEST — the admin session, i.e. the platform
//  operator — exactly as GET /admin/api/tenants takes it (adminRoutes.js).
//  Scope is NEVER taken from a row. There is no second query and no
//  id→tenant resolution anywhere below; a returned row's tenant_id is data in
//  the response, never an input to a further read.
// ═══════════════════════════════════════════════════════════════════════════

const db = require('../../db/db');

// The tool-error arm, as a JSONB containment probe.
//
// `@>` on a JSONB array asks "does any element contain this object", and
// containment is recursive and partial — so this matches an element whose
// outcome carries `status:'error'` alongside its own `error` string and
// whatever else the writer put there. Measured against all four tool_calls
// shapes the writer can produce (a real error row, an ok-only row, a mixed
// row, `[]`) and against SQL NULL, which yields SQL NULL and is therefore
// NOT TRUE and excluded.
//
// A CONSTANT in the query text, not an interpolated runtime value — the
// parameterisation rule is about splicing values, and the only value here is
// the limit, which is $1.
//
// The containment form is also the one a GIN index could serve if the table
// ever earns one (F-A056); a jsonb_array_elements form could not.
const TOOL_ERROR = `'[{"outcome":{"status":"error"}}]'`;

/**
 * What failed, across ALL tenants, newest first.
 *
 * ── THE WHOLE POINT: THE PREDICATE IS INSIDE THE `WHERE` ────────────────────
 * It is applied BEFORE `ORDER BY created_at DESC` and BEFORE `LIMIT`. Filter,
 * then rank, then truncate.
 *
 * Rank-then-truncate is the defect this read exists to avoid. A route that
 * takes the newest N rows and filters them afterwards can only ever mean "the
 * failures inside the newest N turns": at a 200-row ceiling a clinic doing a
 * turn a minute is covered for 3.3 hours, and beyond that the route reports
 * ZERO incidents for a tenant that has many — confidently, and with no
 * symptom. On genesis day N=1, so the wrong implementation is indistinguishable
 * from this one. The `limit + 1` fixture in tests/traces/incidents.test.js is
 * what tells them apart, and it is why that fixture cannot be shortcut.
 *
 * ── THE PREDICATE, AND WHY IT IS AN `OR` ────────────────────────────────────
 * The severity ladder has three failure levels, each a pure function of a
 * closed set:
 *
 *   failed      error present and not an abort
 *   aborted     error.outcome = 'aborted'
 *   tool error  error NULL and some tool outcome is 'error'
 *
 * The first two both mean "the error envelope is a non-null object", so
 * `error IS NOT NULL` is exactly their union. The third is the containment
 * probe. Their union is the two arms below; a row matching both is one row.
 *
 * The third arm ships deliberately. Excluding it would silently omit the class
 * where the TURN SUCCEEDED AND THE PATIENT DID NOT GET THEIR BOOKING — a
 * `book_appointment` that returned `{status:'error'}` on a turn that otherwise
 * completed. That is the same shape of silent omission the `WHERE` placement
 * above exists to kill, so leaving it out would have fixed one and kept the
 * other.
 *
 * ── THIS FUNCTION DOES NOT CLASSIFY ─────────────────────────────────────────
 * It returns the closed-set fields and lets ONE classifier elsewhere decide.
 * No level name appears anywhere in this file. Note that the trace viewer's
 * `statusOf` answers a DIFFERENT question — "did this turn complete?" — and
 * correctly answers `ok` for a tool-error row. Both answers are true; see
 * F-A054. Nothing here is a second classifier and nothing here may become one.
 *
 * ── THE PROJECTION, AND WHAT IT DELIBERATELY LEAVES BEHIND ──────────────────
 * Identity, the trace-viewer link, and the ladder's closed sets. Nothing else.
 *
 * Two fields on a turn_traces row are UNSANITISED FREE TEXT (the census lives
 * at public/admin/traces.js): `error.message`, which is a raw err.message from
 * catches wrapping whole turn bodies and is unbounded — an axios error embeds
 * the upstream response body — and `tool_calls[].outcome.error`, which
 * appointmentService's doctor_not_found builds by interpolating the model's own
 * `doctor` argument, taken from the PATIENT'S UTTERANCE, verbatim.
 *
 * Measured on the repo's own canonical fixture rows, this projection is 40.7%
 * of `SELECT *` (388 B vs 952 B mean). At today's client-side fan-out over
 * /admin/api/tenants — 200 rows x 20 tenants — `SELECT *` would pull ~3.7 MiB
 * carrying ~292 KiB of that free text, partly patient-derived, into ONE
 * response. Not rendering free text is not the same as not fetching it, and a
 * cross-tenant read is the worst place to fetch it. The full row, both
 * free-text fields included, stays one click away at the tenant-scoped
 * GET /admin/api/traces/:turn_id.
 *
 * Projection notes, each measured rather than assumed:
 *   • `error->'aborted_after_commit'` returns a JS boolean through pg, so no
 *     `::boolean` cast that could raise 22P02 on an unexpected value.
 *   • `COALESCE(… @> …, false)` because `NULL @> x` is SQL NULL, and a
 *     three-valued boolean must not cross the wire.
 *   • `error->>'status'` is NOT projected. It is whatever HTTP status an
 *     upstream threw — not a closed set, and never a severity input.
 *
 * ── WHAT THIS READ CANNOT SEE ───────────────────────────────────────────────
 * A request refused BEFORE a turn began. Ten sites on the two voice branches
 * flush a row with `error: null` at 4xx hydration exits after setIds; no
 * closed-set column separates those from a clean successful turn. They are
 * invisible here by construction. The omission is at the WRITER and is filed
 * as F-A055; this read invents neither a level nor a column to paper over it.
 *
 * Probe rows (scriptedTurnCheck) and portal test-turn rows are NOT excluded.
 * A failed probe is a genuine operational signal — the probe exists to detect
 * breakage — and the only thing that distinguishes one is a correlation-id
 * PREFIX, which is a naming convention, not a closed set. Predicating on it
 * would be an open-set predicate that rots silently the first time someone
 * renames a prefix. `correlation_id` and `channel` are returned; whoever needs
 * to distinguish, can. F-A058.
 *
 * @param {Object}  args
 * @param {number} [args.limit=50]  Row cap. The ROUTE validates it; this
 *                                  function parameterises it ($1) and never
 *                                  interpolates it into the SQL text.
 */
async function listIncidents({ limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT
       turn_id,
       tenant_id,
       conversation_id,
       call_session_id,
       channel,
       correlation_id,
       created_at,
       (error IS NOT NULL)                            AS has_error,
       error->>'outcome'                              AS error_outcome,
       error->>'stage'                                AS error_stage,
       error->>'abort_reason'                         AS abort_reason,
       error->'aborted_after_commit'                  AS aborted_after_commit,
       COALESCE(tool_calls @> ${TOOL_ERROR}, false)   AS has_tool_error
     FROM turn_traces
     WHERE error IS NOT NULL
        OR tool_calls @> ${TOOL_ERROR}
     ORDER BY created_at DESC, turn_id DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { listIncidents };
