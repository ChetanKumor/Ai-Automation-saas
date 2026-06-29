'use strict';

/**
 * PlivoTelephonyProvider — DOCUMENTED STUB ONLY.
 *
 * The real Plivo implementation is deferred to production onboarding (it requires
 * a Plivo account, a local DID, DLT/KYC provisioning, and a deployed LiveKit
 * worker on the Plivo Voice AI Infra path). This stub exists so that selecting
 * TELEPHONY_PROVIDER=plivo is a SINGLE-FILE swap: only the bodies below need to be
 * implemented against the locked TelephonyProvider interface.
 *
 * Every method intentionally throws so any accidental use in dev fails loudly.
 *
 * TODO (production, see PR6 "PRODUCTION" checklist):
 *   - onInboundCall:  subscribe to Plivo inbound-call webhooks / SIP and invoke handler.
 *   - startCall:      place an outbound call via Plivo Voice API, return a CallHandle.
 *   - streamAudioIn:  bridge the caller's media (SIP/WebRTC) to a readable stream.
 *   - streamAudioOut: write the agent's synthesized audio back onto the call.
 *   - endCall:        hang up the Plivo call and release the leg.
 *   - emit telephony.call_connected / telephony.call_ended on the shared bus.
 */

const NOT_IMPLEMENTED = 'NotImplemented — see PR6 production onboarding';

function onInboundCall() {
  throw new Error(NOT_IMPLEMENTED);
}

function startCall() {
  throw new Error(NOT_IMPLEMENTED);
}

function streamAudioIn() {
  throw new Error(NOT_IMPLEMENTED);
}

function streamAudioOut() {
  throw new Error(NOT_IMPLEMENTED);
}

function endCall() {
  throw new Error(NOT_IMPLEMENTED);
}

module.exports = {
  name: 'plivo',
  onInboundCall,
  startCall,
  streamAudioIn,
  streamAudioOut,
  endCall,
};
