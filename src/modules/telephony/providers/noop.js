'use strict';

const { randomUUID } = require('crypto');
const logger = require('../../../infra/logging/logger');
const eventBus = require('../../../../core/events');

/**
 * NoopTelephonyProvider — default dev telephony.
 *
 * Satisfies the TelephonyProvider interface so the service boots and wires with
 * TELEPHONY_PROVIDER=noop, with NO audio and NO external dependency. Every method
 * logs and returns safely. Lifecycle events are emitted so downstream wiring can
 * be observed in dev/tests; no media flows.
 */

let inboundHandler = null;

function onInboundCall(handler) {
  inboundHandler = handler;
  logger.info('[noop telephony] inbound handler registered');
}

async function startCall(callMeta = {}) {
  const callHandle = { id: callMeta.externalCallId || randomUUID() };
  logger.info({ callHandle, callMeta }, '[noop telephony] startCall');
  eventBus.emit('telephony.call_connected', { call_id: callHandle.id, ...callMeta });
  return callHandle;
}

function streamAudioIn(callHandle) {
  logger.info({ callHandle }, '[noop telephony] streamAudioIn (no audio)');
  return null;
}

function streamAudioOut(callHandle, _audioStream) {
  logger.info({ callHandle }, '[noop telephony] streamAudioOut (no audio)');
  return null;
}

async function endCall(callHandle = {}) {
  logger.info({ callHandle }, '[noop telephony] endCall');
  eventBus.emit('telephony.call_ended', { call_id: callHandle.id });
}

module.exports = {
  name: 'noop',
  onInboundCall,
  startCall,
  streamAudioIn,
  streamAudioOut,
  endCall,
  // exposed for tests/wiring inspection
  _getInboundHandler: () => inboundHandler,
};
