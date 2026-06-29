'use strict';

const logger       = require('../../../infra/logging/logger');
const callSessions = require('../../voice/callSessions');
const voiceEvents  = require('../../voice/events');

/**
 * Voice ChannelAdapter — registry conformance + call lifecycle.
 *
 * Implements the existing ChannelAdapter contract (channelType/verifyWebhook/
 * parseInbound/send) so voice is a first-class channel in the registry, and adds
 * the call lifecycle (startSession/endSession) that creates the call_session and
 * emits call.started/call.ended. No business logic — transport + persistence.
 *
 * Note: voice has no inbound webhook (the worker posts turns to
 * /internal/voice/turn) and replies are RETURNED in the turn response (the worker
 * does TTS), so verifyWebhook/parseInbound/send are structural conformance.
 */

const channelType = 'voice';

function verifyWebhook() {
  return false; // no webhook for voice; the internal endpoint uses HMAC auth
}

function parseInbound() {
  return []; // turns arrive via POST /internal/voice/turn, not a webhook payload
}

/**
 * Voice outbound is returned synchronously in the turn response; there is no
 * async push. Present for ChannelAdapter uniformity.
 */
async function send({ payload }) {
  return { externalId: null, text: payload && payload.text };
}

/**
 * Start a call: create the call_session (in_progress) and emit call.started.
 * @returns {Promise<Object>} the call_sessions row
 */
async function startSession({
  tenantId,
  customerId,
  conversationId = null,
  provider = 'noop',
  externalCallId = null,
  direction = 'inbound',
  fromNumber = null,
  toNumber = null,
  languageDetected = null,
}) {
  const session = await callSessions.create({
    tenantId, customerId, conversationId, provider, externalCallId,
    direction, fromNumber, toNumber, languageDetected, status: 'in_progress',
  });
  voiceEvents.emitCallStarted(session);
  logger.info({ callSessionId: session.id, tenantId }, 'voice call started');
  return session;
}

/**
 * End a call: mark the call_session completed (or failed) and emit call.ended.
 * @returns {Promise<Object|null>} the updated row
 */
async function endSession(callSessionId, tenantId, {
  status = 'completed',
  durationSeconds = null,
  recordingUrl = null,
  languageDetected = null,
} = {}) {
  const session = await callSessions.updateStatus(callSessionId, tenantId, {
    status, endedAt: new Date(), durationSeconds, recordingUrl, languageDetected,
  });
  if (session) voiceEvents.emitCallEnded(session);
  logger.info({ callSessionId, tenantId }, 'voice call ended');
  return session;
}

module.exports = { channelType, verifyWebhook, parseInbound, send, startSession, endSession };
