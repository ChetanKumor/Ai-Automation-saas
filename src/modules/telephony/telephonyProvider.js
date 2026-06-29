'use strict';

/**
 * TelephonyProvider — call transport seam.
 *
 * Carries audio between the PSTN/SIP world and the voice-agent worker. It does
 * NO audio understanding and NO business logic — it only sets up/tears down
 * calls and exposes the in/out audio streams. Swapping the carrier (noop -> plivo)
 * is a single-file change behind this interface.
 *
 * Implementations emit lifecycle events on the shared bus:
 *   - telephony.call_connected
 *   - telephony.call_ended
 *
 * @typedef {Object} CallMeta
 * @property {string} [externalCallId]
 * @property {'inbound'|'outbound'} direction
 * @property {string} [from]
 * @property {string} [to]
 *
 * @typedef {Object} CallHandle
 * @property {string} id
 *
 * @typedef {Object} TelephonyProvider
 * @property {string} name                                   Registry key ('noop'|'plivo').
 * @property {(handler: (call: CallMeta) => any) => void} onInboundCall
 *           Register a callback fired when a call arrives.
 * @property {(callMeta: CallMeta) => Promise<CallHandle>} startCall   Outbound (future).
 * @property {(callHandle: CallHandle) => any} streamAudioIn           caller -> agent.
 * @property {(callHandle: CallHandle, audioStream: any) => any} streamAudioOut  agent -> caller.
 * @property {(callHandle: CallHandle) => Promise<void>} endCall
 */

const REQUIRED_METHODS = ['onInboundCall', 'startCall', 'streamAudioIn', 'streamAudioOut', 'endCall'];

const registry = new Map();

/**
 * Register a TelephonyProvider implementation.
 * @param {TelephonyProvider} provider
 */
function register(provider) {
  if (!provider || !provider.name) throw new Error('TelephonyProvider must define a name');
  for (const fn of REQUIRED_METHODS) {
    if (typeof provider[fn] !== 'function') {
      throw new Error(`TelephonyProvider "${provider.name}" must implement ${fn}()`);
    }
  }
  registry.set(provider.name, provider);
}

/**
 * Resolve a registered TelephonyProvider by name (defaults via TELEPHONY_PROVIDER).
 * @param {string} name
 * @returns {TelephonyProvider}
 */
function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) throw new Error(`Unknown telephony provider: ${name}`);
  return provider;
}

// ── Default dev implementation + production stub ──
register(require('./providers/noop'));
register(require('./providers/plivo'));

module.exports = { register, getProvider, REQUIRED_METHODS };
