'use strict';

/**
 * VoiceProvider — STT/TTS/session seam (transport only).
 *
 * A VoiceProvider turns audio into text and text into audio. It contains NO
 * language policy, NO conversation state, and NO business logic — those live in
 * the brain (`ai_service`) and identity/memory layers. Swapping providers is a
 * single-file change behind this interface.
 *
 * @typedef {Object} Transcript
 * @property {string} text              Recognized utterance.
 * @property {string|null} language     Detected language code (e.g. 'te-IN'), or null.
 *
 * @typedef {Object} VoiceSession
 * @property {string} id                Provider-local session id.
 * @property {Object} [meta]            Echo of the callMeta used to start it.
 *
 * @typedef {Object} VoiceProvider
 * @property {string} name              Registry key (e.g. 'sarvam').
 * @property {(audioStream: any) => Promise<Transcript>} transcribe
 *           STT: caller audio -> { text, language }.
 * @property {(text: string, language: string) => Promise<any>} synthesize
 *           TTS: text + language -> audio stream/buffer.
 * @property {(callMeta: Object) => Promise<VoiceSession>} startSession
 * @property {(sessionId: string) => Promise<void>} endSession
 */

const registry = new Map();

/**
 * Register a VoiceProvider implementation.
 * @param {VoiceProvider} provider
 */
function register(provider) {
  if (!provider || !provider.name) throw new Error('VoiceProvider must define a name');
  for (const fn of ['transcribe', 'synthesize', 'startSession', 'endSession']) {
    if (typeof provider[fn] !== 'function') {
      throw new Error(`VoiceProvider "${provider.name}" must implement ${fn}()`);
    }
  }
  registry.set(provider.name, provider);
}

/**
 * Resolve a registered VoiceProvider by name.
 * @param {string} name
 * @returns {VoiceProvider}
 */
function getProvider(name) {
  const provider = registry.get(name);
  if (!provider) throw new Error(`Unknown voice provider: ${name}`);
  return provider;
}

// ── Single registered implementation: Sarvam (Saaras STT, Bulbul TTS) ──
register(require('./providers/sarvam'));

module.exports = { register, getProvider };
