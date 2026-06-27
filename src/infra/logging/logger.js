'use strict';

const pino = require('pino');

const opts = {
  level: process.env.LOG_LEVEL || 'info',
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
