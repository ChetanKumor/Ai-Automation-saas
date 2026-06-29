'use strict';

const eventBus = require('../../../core/events');
const EVENT    = require('../../../core/eventTypes');

/**
 * call.started / call.ended publishers on the existing event bus. Payloads are
 * derived from a call_sessions row (snake_case columns). Downstream consumers
 * (memory write-back, workflow, CRM, post-call notifications) subscribe later.
 */

function emitCallStarted(session) {
  return eventBus.emit(EVENT.CALL_STARTED, {
    tenant_id:       session.tenant_id,
    customer_id:     session.customer_id,
    conversation_id: session.conversation_id,
    call_session_id: session.id,
    provider:        session.provider,
    direction:       session.direction,
  });
}

function emitCallEnded(session) {
  return eventBus.emit(EVENT.CALL_ENDED, {
    tenant_id:        session.tenant_id,
    customer_id:      session.customer_id,
    conversation_id:  session.conversation_id,
    call_session_id:  session.id,
    status:           session.status,
    duration_seconds: session.duration_seconds,
    recording_url:    session.recording_url,
  });
}

module.exports = { emitCallStarted, emitCallEnded };
