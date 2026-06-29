require('dotenv').config();

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// ── Sarvam adapter: request/response shapes (mock Sarvam HTTP) ───────────────

describe('Sarvam adapter (Saaras STT, Bulbul TTS)', () => {
  const sarvam = require('../../src/modules/voice/providers/sarvam');

  it('transcribe() posts to Saaras and maps { transcript, language_code }', async () => {
    process.env.SARVAM_API_KEY = 'test-key';
    const seen = [];
    const m = mock.method(axios, 'post', async (url, _body, opts) => {
      seen.push({ url, opts });
      return { data: { transcript: 'namaste', language_code: 'te-IN' } };
    });

    const out = await sarvam.transcribe(Buffer.from('audio-bytes'));

    assert.equal(out.text, 'namaste');
    assert.equal(out.language, 'te-IN');
    assert.match(seen[0].url, /\/speech-to-text-translate$/);
    assert.equal(seen[0].opts.headers['api-subscription-key'], 'test-key');
    m.mock.restore();
  });

  it('synthesize() posts to Bulbul and returns the first audio', async () => {
    process.env.SARVAM_API_KEY = 'test-key';
    const seen = [];
    const m = mock.method(axios, 'post', async (url, body, opts) => {
      seen.push({ url, body, opts });
      return { data: { audios: ['BASE64AUDIO', 'second'] } };
    });

    const audio = await sarvam.synthesize('hello', 'te-IN');

    assert.equal(audio, 'BASE64AUDIO');
    assert.match(seen[0].url, /\/text-to-speech$/);
    assert.equal(seen[0].body.target_language_code, 'te-IN');
    assert.equal(seen[0].body.model, 'bulbul:v2');
    assert.equal(seen[0].opts.headers['api-subscription-key'], 'test-key');
    m.mock.restore();
  });

  it('throws a clear error when SARVAM_API_KEY is missing', async () => {
    const saved = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    await assert.rejects(() => sarvam.transcribe(Buffer.from('x')), /SARVAM_API_KEY/);
    if (saved !== undefined) process.env.SARVAM_API_KEY = saved;
  });

  it('startSession returns a local handle; endSession resolves', async () => {
    const s = await sarvam.startSession({ id: 'call-9' });
    assert.equal(s.id, 'call-9');
    await assert.doesNotReject(() => sarvam.endSession('call-9'));
  });
});

// ── VoiceProvider registry ───────────────────────────────────────────────────

describe('VoiceProvider registry', () => {
  const v = require('../../src/modules/voice/voiceProvider');

  it('resolves the single registered provider (sarvam)', () => {
    assert.equal(v.getProvider('sarvam').name, 'sarvam');
  });

  it('unknown provider throws', () => {
    assert.throws(() => v.getProvider('whisper'), /Unknown voice provider/);
  });

  it('register rejects a provider missing interface methods', () => {
    assert.throws(() => v.register({ name: 'bad' }), /must implement/);
  });
});

// ── TelephonyProvider registry + conformance ─────────────────────────────────

describe('TelephonyProvider registry', () => {
  const t = require('../../src/modules/telephony/telephonyProvider');

  it('resolves noop and it satisfies the interface', () => {
    const n = t.getProvider('noop');
    assert.equal(n.name, 'noop');
    for (const fn of t.REQUIRED_METHODS) assert.equal(typeof n[fn], 'function');
  });

  it('unknown provider throws', () => {
    assert.throws(() => t.getProvider('twilio'), /Unknown telephony provider/);
  });

  it('register rejects an incomplete provider', () => {
    assert.throws(() => t.register({ name: 'bad' }), /must implement/);
  });

  it('noop<->plivo swap is single-file: both expose the SAME interface surface', () => {
    const noop = t.getProvider('noop');
    const plivo = t.getProvider('plivo');
    const surface = (p) => t.REQUIRED_METHODS.filter((fn) => typeof p[fn] === 'function').sort();
    assert.deepEqual(surface(noop), t.REQUIRED_METHODS.slice().sort());
    assert.deepEqual(surface(plivo), surface(noop)); // identical interface => selecting plivo is the only change
  });

  it('Plivo stub throws NotImplemented on every method', () => {
    const p = t.getProvider('plivo');
    for (const fn of t.REQUIRED_METHODS) {
      assert.throws(() => p[fn]({}), /NotImplemented/);
    }
  });
});
