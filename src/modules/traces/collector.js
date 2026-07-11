'use strict';

// Turn-trace collector (Issue 22) — the structured, queryable twin of Issue
// 21's correlation-id log chains.
//
// One collector per AI turn, opened at turn start by the turn core (WhatsApp
// route, voice route, validation probe). It RIDES the existing ALS request
// context (requestContext, Issue 21): open() associates the collector with the
// active context (WeakMap below), so deep capture sites (contextAssembler's
// retrieval, aiService's prompt provenance) reach it via current() with zero
// parameter threading — exactly how the correlation id itself travels.
//
// The collector does NOT time anything itself: it wraps a PR9A turn timer
// (turnMetrics.createTurnTimer) — the incumbent per-stage instrumentation —
// and reads its snapshot() at flush. There is deliberately no second timing
// system. flush() is fire-and-forget after dispatch: an insert failure WARNs
// with the correlation id and never touches the turn (see writer.js).
//
// Traces are best-effort by design: a collector opened but never flushed
// (process crash pre-flush) simply leaves no row.

const requestContext = require('../../core/requestContext');
const { createTurnTimer } = require('../../infra/logging/turnMetrics');
const writer = require('./writer');

// Collector attachment is a WeakMap keyed on the ALS store OBJECT — not a
// property written onto it. The event bus derives handler contexts by
// SPREADING the emitter's ctx (core/events.js), so a property would leak the
// collector into every event handler the turn causes: a handler touching
// contextAssembler/aiService would then pollute an already-flushed trace, and
// the spread copies would pin the collector (timer, stages, tool records) in
// memory for the handlers' lifetime. A WeakMap entry does neither: handler
// contexts are NEW objects (no entry → current() is null there), and the
// entry dies with the request's store object.
const collectors = new WeakMap();

/**
 * Open a collector for one turn and attach it to the active request context.
 *
 * @param {Object}  args
 * @param {string}  args.channel            'whatsapp' | 'voice'
 * @param {Object} [args.timer]             An existing PR9A turn timer (the voice
 *                                          route already owns one); a fresh one is
 *                                          created when absent (WhatsApp, probe).
 * @param {string} [args.tenantId]
 * @param {string} [args.conversationId]
 * @param {string} [args.callSessionId]
 */
function open({ channel, timer = null, tenantId = null, conversationId = null, callSessionId = null }) {
  const t = timer || createTurnTimer({ tenant_id: tenantId });
  let flushPromise = null;

  const collector = {
    channel,
    timer: t,
    correlationId: requestContext.get()?.correlationId ?? null,
    ids: { tenant_id: tenantId, conversation_id: conversationId, call_session_id: callSessionId },
    prompt: null,     // {hash, config_version, mode} — set by aiService
    retrieval: null,  // [{chunk_id, score}] — set by contextAssembler; null = no retrieval
    error: null,      // {stage, message, status} — set by the turn core's catch

    /** Fill in ids discovered mid-turn (voice learns tenant/conversation post-hydrate). */
    setIds(fields) { Object.assign(this.ids, fields); },
    setPrompt(p) { this.prompt = p; },
    setRetrieval(r) { this.retrieval = r; },
    setError(e) { this.error = e; },

    /** The ONE exception→error mapping for every turn core's catch site:
     * stage falls back to the timer's in-flight stage, status is normalized
     * (axios-style err.response.status, then err.status, then null). */
    setErrorFromException(err, stage = null) {
      this.error = {
        stage: stage ?? t.currentStage() ?? 'generate_reply',
        message: err.message,
        status: err.response?.status ?? err.status ?? null,
      };
    },

    /** Aborted turn (Issue 29, closes V-011's shadow): the abort signal
     * (client disconnect or turn budget) fired during this turn. Recorded in
     * the SAME error envelope — schema untouched; envelope shape documented
     * in writer.js. afterCommit=true means the turn crossed the point of no
     * return (a mutating tool had executed) and completed persistence anyway;
     * false means reply generation was stopped. */
    setAbort({ reason, afterCommit = false }) {
      this.error = {
        outcome: 'aborted',
        abort_reason: reason,                  // 'client_gone' | 'deadline'
        aborted_after_commit: !!afterCommit,
        stage: t.currentStage() ?? null,
        message: 'voice turn aborted',
      };
    },

    /**
     * Persist the trace. Idempotent — the first call wins; the returned
     * promise never rejects (failures are WARNed inside the writer), so
     * callers may fire-and-forget (live turns) or await (probe/tests).
     */
    flush() {
      if (!flushPromise) flushPromise = writer.writeTrace(this);
      return flushPromise;
    },
  };

  const ctx = requestContext.get();
  if (ctx) collectors.set(ctx, collector);
  return collector;
}

/** The turn's collector, or null outside a turn (crons, event handlers —
 * their derived contexts carry no entry by design, see the WeakMap note).
 * Capture sites must tolerate null. */
function current() {
  const ctx = requestContext.get();
  return ctx ? (collectors.get(ctx) ?? null) : null;
}

module.exports = { open, current };
