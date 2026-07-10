'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

/**
 * Per-chain request context (Issue 21). One correlation id per inbound causal
 * chain — a webhook delivery, a voice call, an admin request, a validation
 * run — carried implicitly via AsyncLocalStorage so the logger, the event bus
 * and the bridge payloads stamp it without manual threading.
 *
 * Context shape: { correlationId, channel, eventDepth?, eventId? }. The last
 * two are maintained by the event bus (core/events.js) so events emitted
 * inside a handler inherit the causal chain (depth + causation_id).
 *
 * Trust boundary: only HMAC-authenticated internal endpoints may ADOPT an id
 * from the `X-Correlation-Id` request header (`trusted: true`); public edges
 * (Meta webhook, admin) always generate fresh. A supplied id must match the
 * strict shape below or it is ignored — never let an edge inject arbitrary
 * bytes into every downstream log line.
 */

const storage = new AsyncLocalStorage();

// <prefix>_<16 hex> — e.g. wa_9f2c…, call_…, probe_…, adm_….
const ID_SHAPE = /^[a-z]{2,12}_[0-9a-f]{16}$/;

function newCorrelationId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function isValidCorrelationId(id) {
  return typeof id === 'string' && ID_SHAPE.test(id);
}

/** Run fn inside the given context. Returns fn's result. The store is used
 * as-is (this runs per request and per event emit — no defensive copy);
 * callers pass a fresh object and must not mutate it afterwards. */
function runWith(ctx, fn) {
  return storage.run(ctx, fn);
}

/** The active context, or null outside any chain (crons, boot). */
function get() {
  return storage.getStore() || null;
}

/**
 * Express middleware: establish a correlation context for the request and
 * echo the id on the response (`X-Correlation-Id`). With `trusted: true`
 * (HMAC'd internal routes only — mount AFTER the auth middleware) a
 * well-formed inbound `X-Correlation-Id` is adopted; otherwise a fresh
 * `<prefix>_` id is generated.
 */
function middleware({ prefix, channel, trusted = false }) {
  return (req, res, next) => {
    const supplied = trusted ? req.headers['x-correlation-id'] : undefined;
    const correlationId = isValidCorrelationId(supplied)
      ? supplied
      : newCorrelationId(prefix);
    res.setHeader('X-Correlation-Id', correlationId);
    runWith({ correlationId, channel }, next);
  };
}

module.exports = { runWith, get, newCorrelationId, isValidCorrelationId, middleware };
