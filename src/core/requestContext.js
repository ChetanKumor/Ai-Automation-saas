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
 * platformUserId (ADMIN-S3b, D-022) is the acting operator, present only on
 * the admin surface and null everywhere else. It rides here rather than
 * through route signatures so a service several calls deep can attribute a
 * write without every caller in between growing a parameter it does not use.
 *
 * It is NOT stamped on log lines. The pino mixin emits correlation_id and
 * nothing else, and extending it was ruled out of scope — reaching this value
 * means calling get(), which is what configService and validationService do.
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
 *
 * `actor` (optional) is a function of the request returning the acting
 * platform user id, or null. It is a function, and supplied per surface,
 * rather than this module reading a session field directly: requestContext is
 * mounted on the Meta webhook and the voice edge too, and neither has a
 * session. Teaching it the admin session's shape would couple a core module
 * to one surface's auth for no gain.
 */
function middleware({ prefix, channel, trusted = false, actor }) {
  return (req, res, next) => {
    const supplied = trusted ? req.headers['x-correlation-id'] : undefined;
    const correlationId = isValidCorrelationId(supplied)
      ? supplied
      : newCorrelationId(prefix);
    res.setHeader('X-Correlation-Id', correlationId);
    // Null rather than absent on every surface that has no actor, so a reader
    // never has to distinguish "no actor" from "field not set".
    const platformUserId = typeof actor === 'function' ? (actor(req) || null) : null;
    runWith({ correlationId, channel, platformUserId }, next);
  };
}

module.exports = { runWith, get, newCorrelationId, isValidCorrelationId, middleware };
