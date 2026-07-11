'use strict';

// Trace writer (Issue 22) — turns a flushed collector into ONE turn_traces
// INSERT, off the hot path. Failure policy is absolute: a trace insert must
// never touch the turn. Every failure (FK race with a tenant delete, pool
// down, bad row) lands in a WARN carrying the correlation id, and the
// returned promise resolves regardless.

const db = require('../../db/db');
const logger = require('../../infra/logging/logger');

// Injectable insert — tests poison it to prove turn isolation. Same test-seam
// pattern as turnMetrics._setEmitFn / aiService._setModelProvider.
let insertFn = (text, params) => db.query(text, params);
function _setInsertFn(fn) {
  insertFn = fn || ((text, params) => db.query(text, params));
}

// Aggregate LLM meta from the timer's per-call records. null when the turn
// never reached the model (gated turn, pre-LLM error).
function llmMeta(calls) {
  if (!calls.length) return null;
  const sum = (pick) => calls.reduce((a, c) => a + (pick(c) ?? 0), 0);
  return {
    model: calls[0].model ?? null,
    input_tokens: sum((c) => c.input_tokens),
    output_tokens: sum((c) => c.output_tokens),
    latency_ms: Math.round(sum((c) => c.latency_ms) * 100) / 100,
    finish_reason: calls[calls.length - 1].finish_reason ?? null,
    calls,
  };
}

/**
 * Persist one collector as a turn_traces row. Never throws, never rejects.
 * Skips (silently, at debug level) when no tenant_id was ever learned — a
 * pre-hydration 404 isn't a turn, and the row couldn't be attributed anyway.
 */
async function writeTrace(collector) {
  const snap = collector.timer.snapshot();
  const { tenant_id, conversation_id, call_session_id } = collector.ids;

  if (!tenant_id) {
    logger.debug({ turn_id: snap.turn_id, correlation_id: collector.correlationId },
      'turn trace skipped — no tenant resolved');
    return;
  }

  // One guard for every JSONB param: null/absent stays SQL NULL (never the
  // JSON string 'null').
  const j = (v) => (v == null ? null : JSON.stringify(v));

  try {
    await insertFn(
      `INSERT INTO turn_traces
         (turn_id, tenant_id, conversation_id, call_session_id, channel,
          correlation_id, stage_timings, retrieval, prompt, llm, tool_calls, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        snap.turn_id,
        tenant_id,
        conversation_id,
        call_session_id,
        collector.channel,
        collector.correlationId,
        j({ ...snap.stages, total_ms: snap.total_node_ms }),
        j(collector.retrieval),
        j(collector.prompt),
        j(llmMeta(snap.gemini.calls)),
        j(snap.tools.length ? snap.tools : null),
        j(collector.error),
      ]
    );
  } catch (err) {
    logger.warn(
      { turn_id: snap.turn_id, correlation_id: collector.correlationId, tenant_id, err: err.message },
      'turn trace insert failed — trace dropped, turn unaffected'
    );
  }
}

module.exports = { writeTrace, _setInsertFn };
