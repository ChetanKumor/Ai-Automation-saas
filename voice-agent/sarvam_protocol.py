"""Pure Sarvam streaming WebSocket message helpers (no LiveKit / no I/O).

Split out from the STT/TTS plugin adapters so the wire protocol (what we send to
and parse from Sarvam) is unit-testable in isolation — no livekit-agents, no
websockets, no network. The plugin adapters (stt_sarvam.py / tts_sarvam.py) are
thin glue over these.

STT (speech-to-text-translate, Saaras):
  send: {"audio":{"data":"<b64 PCM16>","encoding":"audio/x-raw","sample_rate":16000}}
  recv: {"type":"data","data":{"transcript":"...","language_code":"te-IN"}}
        {"type":"events","data":{"signal_type":"START_SPEECH"|"END_SPEECH"}}

TTS (text-to-speech, Bulbul):
  send: {"type":"config","data":{target_language_code,speaker,speech_sample_rate,model}}
        {"type":"text","data":{"text":"<reply>"}}
        {"type":"flush"}
  recv: {"type":"audio","data":{"audio":"<b64 PCM>"}}
        {"type":"event","data":{"event_type":"final"}}
"""

from __future__ import annotations

import base64
import json
from typing import Optional

INPUT_SAMPLE_RATE = 16000  # Sarvam streaming STT expects 16 kHz mono PCM16


# ── STT ───────────────────────────────────────────────────────────────────────
def encode_audio_message(pcm16: bytes, sample_rate: int = INPUT_SAMPLE_RATE) -> str:
    """Build the JSON audio frame Sarvam streaming STT expects (base64 PCM16)."""
    return json.dumps(
        {
            "audio": {
                "data": base64.b64encode(pcm16).decode("ascii"),
                "encoding": "audio/x-raw",
                "sample_rate": sample_rate,
            }
        }
    )


def parse_message(raw: str) -> Optional[dict]:
    """Normalize a Sarvam STT WS message → {kind, text, language} or None.

    kind ∈ {"interim", "final", "speech_start", "speech_end"}.
    """
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(msg, dict):
        return None

    mtype = msg.get("type")
    data = msg.get("data") or {}

    if mtype == "data":
        text = (data.get("transcript") or "").strip()
        if not text:
            return None
        is_final = data.get("is_final", True)  # finalized unless explicitly partial
        return {
            "kind": "final" if is_final else "interim",
            "text": text,
            "language": data.get("language_code"),
        }

    if mtype == "events":
        signal = (data.get("signal_type") or "").upper()
        if signal in ("START_SPEECH", "SPEECH_START"):
            return {"kind": "speech_start", "text": "", "language": None}
        if signal in ("END_SPEECH", "SPEECH_END"):
            return {"kind": "speech_end", "text": "", "language": None}

    return None


# ── TTS ───────────────────────────────────────────────────────────────────────
def config_message(language: str, speaker: str, sample_rate: int, model: str) -> str:
    return json.dumps(
        {
            "type": "config",
            "data": {
                "target_language_code": language,
                "speaker": speaker,
                "speech_sample_rate": str(sample_rate),
                "model": model,
            },
        }
    )


def text_message(text: str) -> str:
    return json.dumps({"type": "text", "data": {"text": text}})


def flush_message() -> str:
    return json.dumps({"type": "flush"})


def parse_audio(raw: str) -> Optional[bytes]:
    """Return decoded PCM bytes for an audio message, else None."""
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(msg, dict) or msg.get("type") != "audio":
        return None
    b64 = (msg.get("data") or {}).get("audio")
    if not b64:
        return None
    try:
        return base64.b64decode(b64)
    except (ValueError, TypeError):
        return None


def is_final_event(raw: str) -> bool:
    """True when Sarvam signals synthesis completion for the segment."""
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return False
    return (
        isinstance(msg, dict)
        and msg.get("type") == "event"
        and (msg.get("data") or {}).get("event_type") == "final"
    )
