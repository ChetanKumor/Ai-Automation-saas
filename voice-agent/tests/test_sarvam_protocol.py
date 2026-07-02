"""Unit tests for the pure Sarvam wire protocol (no LiveKit / no network)."""

import base64
import json

from sarvam_protocol import (
    config_message,
    encode_audio_message,
    flush_message,
    is_final_event,
    parse_audio,
    parse_message,
    text_message,
)


# ── STT: audio out ────────────────────────────────────────────────────────────
def test_encode_audio_message_base64_roundtrip():
    pcm = b"\x01\x02\x03\x04"
    msg = json.loads(encode_audio_message(pcm, 16000))
    # Sarvam's audio.encoding enum rejects "audio/x-raw"; must be "audio/wav"
    # (raw PCM16 payload, no per-frame container).
    assert msg["audio"]["encoding"] == "audio/wav"
    assert msg["audio"]["sample_rate"] == 16000
    assert base64.b64decode(msg["audio"]["data"]) == pcm


# ── STT: transcripts in ───────────────────────────────────────────────────────
def test_parse_message_final_transcript():
    bit = parse_message('{"type":"data","data":{"transcript":"namaste","language_code":"te-IN"}}')
    assert bit == {"kind": "final", "text": "namaste", "language": "te-IN"}


def test_parse_message_interim_when_not_final():
    bit = parse_message('{"type":"data","data":{"transcript":"nam","language_code":"te-IN","is_final":false}}')
    assert bit["kind"] == "interim"
    assert bit["text"] == "nam"


def test_parse_message_empty_transcript_is_none():
    assert parse_message('{"type":"data","data":{"transcript":"   "}}') is None


def test_parse_message_vad_events():
    assert parse_message('{"type":"events","data":{"signal_type":"START_SPEECH"}}')["kind"] == "speech_start"
    assert parse_message('{"type":"events","data":{"signal_type":"END_SPEECH"}}')["kind"] == "speech_end"


def test_parse_message_garbage_is_none():
    assert parse_message("not json") is None
    assert parse_message('{"type":"other"}') is None
    assert parse_message('["a","list"]') is None


# ── TTS: text/config out, audio in ────────────────────────────────────────────
def test_tts_config_text_flush_messages():
    cfg = json.loads(config_message("te-IN", "anushka", 22050, "bulbul:v2"))
    assert cfg["type"] == "config"
    assert cfg["data"]["target_language_code"] == "te-IN"
    assert cfg["data"]["speaker"] == "anushka"
    assert cfg["data"]["model"] == "bulbul:v2"
    assert cfg["data"]["speech_sample_rate"] == "22050"

    assert json.loads(text_message("hello")) == {"type": "text", "data": {"text": "hello"}}
    assert json.loads(flush_message()) == {"type": "flush"}


def test_parse_audio_decodes_chunk_else_none():
    payload = base64.b64encode(b"PCMDATA").decode()
    assert parse_audio(json.dumps({"type": "audio", "data": {"audio": payload}})) == b"PCMDATA"
    assert parse_audio('{"type":"event","data":{"event_type":"final"}}') is None
    assert parse_audio("garbage") is None


def test_is_final_event():
    assert is_final_event('{"type":"event","data":{"event_type":"final"}}') is True
    assert is_final_event('{"type":"audio","data":{"audio":"x"}}') is False
    assert is_final_event("garbage") is False
