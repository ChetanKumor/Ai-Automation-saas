'use strict';

const { randomUUID } = require('crypto');
const axios = require('axios');
const logger = require('../../../infra/logging/logger');

/**
 * Sarvam VoiceProvider — Saaras (STT) + Bulbul (TTS).
 *
 * Implements the VoiceProvider contract (see ../voiceProvider.js). Stateless
 * REST against the Sarvam API; sessions are tracked locally. Transport only:
 * no language policy, no conversation state, no business logic.
 *
 * Docs: https://docs.sarvam.ai  (Saaras = speech-to-text-translate, Bulbul = text-to-speech)
 * Auth header: `api-subscription-key: <SARVAM_API_KEY>`.
 */

const BASE_URL = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const STT_MODEL = 'saaras:v2';   // Saaras
const TTS_MODEL = 'bulbul:v2';   // Bulbul
const DEFAULT_SPEAKER = 'anushka';

function requireKey() {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is not set');
  return key;
}

/**
 * STT: caller audio -> { text, language }. Language is whatever Saaras detected.
 * @param {Buffer|Blob|any} audioStream
 * @returns {Promise<{ text: string, language: string|null }>}
 */
async function transcribe(audioStream) {
  const key = requireKey();

  const form = new FormData();
  const file = audioStream instanceof Blob ? audioStream : new Blob([audioStream]);
  form.append('file', file, 'audio.wav');
  form.append('model', STT_MODEL);

  try {
    const { data } = await axios.post(`${BASE_URL}/speech-to-text-translate`, form, {
      headers: { 'api-subscription-key': key },
    });
    return { text: data.transcript || '', language: data.language_code || null };
  } catch (err) {
    logger.error({ err: err.message }, 'sarvam transcribe failed');
    throw err;
  }
}

/**
 * TTS: text + language -> audio (base64 string from Bulbul).
 * @param {string} text
 * @param {string} language  Target language code, e.g. 'te-IN'.
 * @returns {Promise<string|null>}
 */
async function synthesize(text, language) {
  const key = requireKey();

  try {
    const { data } = await axios.post(
      `${BASE_URL}/text-to-speech`,
      { inputs: [text], target_language_code: language, model: TTS_MODEL, speaker: DEFAULT_SPEAKER },
      { headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' } }
    );
    return Array.isArray(data.audios) ? data.audios[0] || null : null;
  } catch (err) {
    logger.error({ err: err.message }, 'sarvam synthesize failed');
    throw err;
  }
}

/**
 * Sarvam is stateless REST — a "session" is just a local handle.
 * @param {Object} callMeta
 * @returns {Promise<{ id: string, meta: Object }>}
 */
async function startSession(callMeta = {}) {
  return { id: callMeta.id || randomUUID(), meta: callMeta };
}

/** No remote session to tear down. */
async function endSession(_sessionId) {
  return;
}

module.exports = { name: 'sarvam', transcribe, synthesize, startSession, endSession };
