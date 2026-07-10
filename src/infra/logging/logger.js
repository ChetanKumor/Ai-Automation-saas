'use strict';

const pino = require('pino');
const requestContext = require('../../core/requestContext');

// Stamp correlation_id on every line emitted inside a chain (Issue 21). Lines
// outside any chain (crons, boot) carry none — never a fabricated one.
// Must return a FRESH object every call: pino's default merge strategy is
// Object.assign(mixinResult, logObject) — the result is mutated as the target.
function mixin() {
  const ctx = requestContext.get();
  return ctx && ctx.correlationId ? { correlation_id: ctx.correlationId } : {};
}

const opts = {
  level: process.env.LOG_LEVEL || 'info',
  mixin,
};

if (process.env.NODE_ENV !== 'production') {
  try {
    require.resolve('pino-pretty');
    opts.transport = { target: 'pino-pretty' };
  } catch (_) {
    // pino-pretty not installed — plain output in dev is fine
  }
}

module.exports = pino(opts);
module.exports._mixin = mixin;
