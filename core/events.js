const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const bus = new EventEmitter();
bus.setMaxListeners(100);

function emit(type, payload, meta = {}) {
  const envelope = Object.freeze({
    type,
    payload: Object.freeze({ ...payload }),
    tenant_id: payload.tenant_id ?? meta.tenant_id ?? null,
    event_id: randomUUID(),
    depth: meta.depth ?? 0,
    causation_id: meta.causation_id ?? null,
    ts: Date.now(),
  });

  setImmediate(() => {
    bus.emit(type, envelope);
    bus.emit('*', envelope);
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
