const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const requestContext = require('../src/core/requestContext');

const bus = new EventEmitter();
bus.setMaxListeners(100);

function emit(type, payload, meta = {}) {
  // Capture the emitter's chain context (Issue 21). An event emitted inside a
  // handler inherits the chain: depth+1 and causation_id = the parent event —
  // this is what keeps the workflow depth guard honest for handler-emitted
  // events (the old lead-event finding). Explicit meta always wins, INCLUDING
  // an explicit null/0 (undefined-checks, not ??): callers that thread meta by
  // hand (collectionsService) must keep their exact pre-Issue-21 lineage
  // rather than get a half-inherited one (explicit depth 0 + inherited cause
  // would reset the workflow depth counter mid-chain).
  const ctx = requestContext.get();
  const envelope = Object.freeze({
    type,
    payload: Object.freeze({ ...payload }),
    tenant_id: payload.tenant_id ?? meta.tenant_id ?? null,
    event_id: randomUUID(),
    correlation_id: meta.correlation_id !== undefined
      ? meta.correlation_id
      : (ctx?.correlationId ?? null),
    depth: meta.depth !== undefined
      ? meta.depth
      : (ctx?.eventDepth != null ? ctx.eventDepth + 1 : 0),
    causation_id: meta.causation_id !== undefined
      ? meta.causation_id
      : (ctx?.eventId ?? null),
    ts: Date.now(),
  });

  // Handlers run inside the captured context (restored explicitly — the
  // setImmediate hop must not be trusted to carry it) extended with this
  // event's depth/id so nested emits and handler log lines inherit.
  const handlerCtx = {
    ...(ctx || {}),
    correlationId: envelope.correlation_id,
    eventDepth: envelope.depth,
    eventId: envelope.event_id,
  };

  setImmediate(() => {
    requestContext.runWith(handlerCtx, () => {
      bus.emit(type, envelope);
      bus.emit('*', envelope);
    });
  });

  return envelope;
}

function on(type, handler) {
  const safe = (envelope) => {
    try {
      const result = handler(envelope);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.error(`[EventBus] Async handler error on "${type}":`, err.message);
        });
      }
    } catch (err) {
      console.error(`[EventBus] Handler error on "${type}":`, err.message);
    }
  };
  bus.on(type, safe);
  return () => bus.removeListener(type, safe);
}

module.exports = { emit, on };
