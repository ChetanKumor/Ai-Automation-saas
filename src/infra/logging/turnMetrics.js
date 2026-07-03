'use strict';

const { randomUUID } = require('crypto');
const logger = require('./logger');

/**
 * Per-turn stage instrumentation for the voice turn path (PR9A).
 *
 * Logging only: a timer collects named stage durations, per-Gemini-call
 * latency/token telemetry, and per-tool execution timings, then emits ONE
 * structured JSON log line per turn:
 *
 *   { turn_id, call_session_id, tenant_id, stages: {...},
 *     gemini: { calls: [...] }, tools: [...], total_node_ms }
 *
 * Stage keys: hydrate_validate, persist_inbound, fetch_parallel (plus
 * fetch_parallel_history / _memory / _knowledge sub-timings), gemini_call_<n>,
 * tool_exec_<n>_<name>, persist_outbound. Durations are ms with sub-ms
 * resolution (hrtime). No response-shape change, no DB writes.
 *
 * The timer doubles as the `metrics` collector aiService.generateReply accepts
 * (recordGeminiCall / recordToolExec) — the WhatsApp path passes no collector
 * and is untouched.
 */

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const round = (ms) => Math.round(ms * 100) / 100;

// Injectable emitter — tests capture the payload object; production logs it.
// Same test-seam pattern as aiService._setModelProvider.
let emitFn = (payload) => logger.info(payload, 'voice_turn_metrics');
function _setEmitFn(fn) {
  emitFn = fn || ((payload) => logger.info(payload, 'voice_turn_metrics'));
}

function createTurnTimer({ call_session_id = null, tenant_id = null } = {}) {
  const t0 = nowMs();
  const ids = { turn_id: randomUUID(), call_session_id, tenant_id };
  const stages = {};
  const geminiCalls = [];
  const toolCalls = [];
  const extra = {}; // PR9C: top-level annotations (stream_mode, ack_emitted_ms, first_delta_ms)

  return {
    turn_id: ids.turn_id,

    /** Fill in ids discovered mid-turn (e.g. tenant_id after hydration). */
    set(fields) { Object.assign(ids, fields); },

    /** PR9C: merge extra top-level fields into the emitted line. */
    annotate(fields) { Object.assign(extra, fields); },

    /** Milliseconds elapsed since the turn started (for offset annotations). */
    elapsed() { return round(nowMs() - t0); },

    /** Start a named stage; call the returned closure to record its duration. */
    start(name) {
      const s = nowMs();
      return () => { stages[name] = round(nowMs() - s); };
    },

    /** Record an externally-measured duration (e.g. fetch_parallel sub-timings). */
    record(name, ms) { stages[name] = round(ms); },

    /** One Gemini model call: latency + token usage (thinking tokens when the
     * API returns usageMetadata.thoughtsTokenCount; absent ⇒ 0 thinking).
     * streamed marks SSE-mode calls made via sendMessageStream (PR9C). */
    recordGeminiCall({ latency_ms, usageMetadata, streamed = false }) {
      const n = geminiCalls.length + 1;
      const u = usageMetadata || null;
      geminiCalls.push({
        n,
        latency_ms: round(latency_ms),
        input_tokens: u ? (u.promptTokenCount ?? null) : null,
        output_tokens: u ? (u.candidatesTokenCount ?? null) : null,
        thinking_tokens: u ? (u.thoughtsTokenCount ?? 0) : null,
        total_tokens: u ? (u.totalTokenCount ?? null) : null,
        streamed: !!streamed,
      });
      stages[`gemini_call_${n}`] = round(latency_ms);
    },

    /** One tool execution inside the model loop, named. */
    recordToolExec(name, latency_ms) {
      const n = toolCalls.length + 1;
      toolCalls.push({ n, name, latency_ms: round(latency_ms) });
      stages[`tool_exec_${n}_${name}`] = round(latency_ms);
    },

    /** Emit the single structured log line for this turn. */
    emit() {
      emitFn({
        turn_id: ids.turn_id,
        call_session_id: ids.call_session_id,
        tenant_id: ids.tenant_id,
        ...extra,
        stages,
        gemini: { calls: geminiCalls },
        tools: toolCalls,
        total_node_ms: round(nowMs() - t0),
      });
    },
  };
}

module.exports = { createTurnTimer, _setEmitFn };
