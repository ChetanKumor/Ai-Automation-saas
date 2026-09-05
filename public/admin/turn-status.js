/* ============================================================================
 * turn-status.js — ONE derivation of a turn's outcome (INCIDENTS-C0)
 *
 * Two surfaces ask about a turn, and they ask DIFFERENT QUESTIONS. Both current
 * answers are correct; this file exists so there is one implementation behind
 * them rather than two that drift.
 *
 *   the trace viewer   "did this turn complete?"
 *                      A turn whose book_appointment returned {status:'error'}
 *                      COMPLETED. `ok` is the true answer.
 *   incidents          "did the patient get what they came for?"
 *                      The same turn is an incident.
 *
 * That is F-A054, and it is not a missing fourth arm in `turnStatus`. The two
 * entry points below are that ruling made structural: `incidentLevel` LAYERS
 * the tool-error test on top of `turnStatus` by CALLING it. It does not restate
 * the ladder. If you are about to add a second `error` test anywhere, stop —
 * that is the exact defect this file was created to prevent.
 *
 * ── THE SIGNATURE IS FLATTENED PRIMITIVES, AND THAT IS THE POINT ────────────
 * The two callers hold the same facts in different SHAPES:
 *
 *   the viewer     a raw `error` object off a SELECT * row
 *   incidents      flattened columns off GET /admin/api/incidents, which
 *                  src/modules/traces/incidentsQuery.js projects as
 *                  has_error · error_outcome · abort_reason ·
 *                  aborted_after_commit · has_tool_error
 *
 * So the classifier takes BOOLEANS, and each caller adapts its own shape. A
 * raw-object signature would force the incidents page to rebuild an envelope it
 * was never sent. `fromError` below is the adapter for the raw shape, and it is
 * the ONLY place in the tree that compares against the string 'aborted'.
 *
 * ── KEYS ONLY. NO PRESENTATION. ─────────────────────────────────────────────
 * No labels, no `badge-` classes, no human-facing text lives here.
 * public/admin/traces.js owns key -> {key, label, badge} and must keep owning
 * it: tests/design/adminShell.test.js:263 scans a HAND-NAMED list of files for
 * badge class literals and checks each resolves in style.css. This file is not
 * on that list, so badge strings moved here would not fail that scan — they
 * would silently stop being checked, which is worse than failing.
 *
 * ⚠ ONE CONSEQUENCE, STATED SO IT IS NEVER DISCOVERED: `traces.js`'s errorHtml
 *   renders a `turnStatus` return value as VISIBLE TEXT in the detail panel's
 *   Outcome line. Today 'aborted' and 'failed' are byte-identical to the
 *   literals it used to render, so the extraction changed nothing. But the key
 *   vocabulary below is load-bearing on rendered output at that one point.
 *   RENAMING A KEY IS NOT FREE.
 *
 * ── THE CLOSED SETS (settled upstream; do not extend) ───────────────────────
 *   error                     SQL NULL | object, never a scalar
 *   error.outcome             'aborted' | absent
 *   tool_calls[].outcome.status   'ok' | 'error'
 *
 * The ladder, in order:
 *   failed       error present and not an abort
 *   aborted      error.outcome = 'aborted'
 *   tool_error   error NULL and some tool outcome is 'error'
 *   ok           none of the above
 *
 * Deliberately NOT here, each because it encodes a guess no column states:
 * ranking failed against aborted by badness, stage-weighted severity, severity
 * derived from error.status (an upstream HTTP status — not a closed set), and a
 * truncated-reply level.
 *
 * ── UMD-lite, the idiom traces.js already names ─────────────────────────────
 * node requires THE EXACT FILE THE BROWSER LOADS. No DOM half, so this module
 * is inert on require in both environments.
 * ========================================================================== */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdminTurnStatus = api;
})(typeof window !== 'undefined' ? window : null, function () {

  /**
   * Flatten a raw `error` envelope into the two bits the ladder reads.
   *
   * THE ONLY SITE IN THE TREE THAT COMPARES AGAINST 'aborted'. Both of
   * traces.js's former comparisons (statusOf and errorHtml) now route here.
   *
   * `typeof e === 'object'` is carried over from the viewer verbatim. §6 says
   * `error` is NULL-or-object and never a scalar, so it is unreachable today —
   * but a scalar would flatten to {hasError:true, isAbort:false} => 'failed',
   * which is exactly what the viewer returned before this file existed. The
   * guard is preserved so the extraction changes no behaviour, not because a
   * scalar is expected.
   */
  function fromError(error) {
    return {
      hasError: error != null,
      isAbort: error != null && typeof error === 'object' && error.outcome === 'aborted',
    };
  }

  /**
   * DID THIS TURN COMPLETE? -> 'ok' | 'aborted' | 'failed'
   *
   * The one derivation. A tool that reported an error is NOT an input here and
   * must never become one: the turn still completed, and the trace viewer is
   * right to render it `ok`.
   *
   * @param {{hasError: boolean, isAbort: boolean}} f
   */
  function turnStatus(f) {
    if (!f || !f.hasError) return 'ok';
    return f.isAbort ? 'aborted' : 'failed';
  }

  /**
   * DID THE PATIENT GET WHAT THEY CAME FOR?
   *   -> 'failed' | 'aborted' | 'tool_error' | 'ok'
   *
   * DELEGATES. The three-arm ladder is not restated below; it is called. The
   * tool-error test is the only thing this function adds, and it applies only
   * where `turnStatus` already found nothing wrong — a row carrying both an
   * error envelope and a failed tool is ONE row, and it ranks by its envelope.
   *
   * @param {{hasError: boolean, isAbort: boolean, hasToolError: boolean}} f
   */
  function incidentLevel(f) {
    const base = turnStatus(f);
    if (base !== 'ok') return base;
    return f && f.hasToolError ? 'tool_error' : 'ok';
  }

  return { fromError, turnStatus, incidentLevel };
});
