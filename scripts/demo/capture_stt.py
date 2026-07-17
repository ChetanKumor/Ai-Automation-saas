"""DEMO-00 STT capture harness — faithful reproduction of the live voice path's STT.

Transcribes a founder-recorded WAV through Sarvam Saaras exactly as the production
voice worker does. The live worker (voice-agent/agent.py) uses the official
livekit-plugins-sarvam STT with model="saaras:v3", mode="transcribe" — its batch
path (SpeechToText._recognize_impl in
voice-agent/.venv/.../livekit/plugins/sarvam/stt.py) POSTs the audio to
https://api.sarvam.ai/speech-to-text with fields {model, mode, language_code} and
the header api-subscription-key, and reads response["transcript"]. This script
issues the identical request for a single pre-recorded utterance.

The Node provider src/modules/voice/providers/sarvam.js is NOT on the voice path
(zero call sites) and uses a different model+endpoint (saaras:v2 /speech-to-text-
translate = English translation), so it is deliberately not used here.

NOT backend code: a one-shot capture tool. Prints and writes the raw Sarvam JSON
so the transcript's provenance is auditable and never hand-edited.

Run: voice-agent/.venv/Scripts/python.exe scripts/demo/capture_stt.py <audio.wav>
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[2]

# Match the live worker's plugin batch contract exactly.
SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
STT_MODEL = "saaras:v3"       # agent.py SARVAM_STT_MODEL default
STT_MODE = "transcribe"       # agent.py mode="transcribe" (native-language transcript)
STT_LANGUAGE = "unknown"      # agent.py STT_AUTO_DETECT (no per-call prior -> auto-detect)


def load_sarvam_key() -> str:
    """Read SARVAM_API_KEY from the repo .env without printing it."""
    for env_path in (REPO / ".env", REPO / "voice-agent" / ".env"):
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("SARVAM_API_KEY="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    raise SystemExit("SARVAM_API_KEY not found in .env")


def main() -> None:
    audio_path = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "demo-audio" / "booking.wav")
    if not audio_path.exists():
        raise SystemExit(f"audio not found: {audio_path}")

    key = load_sarvam_key()
    with open(audio_path, "rb") as f:
        wav_bytes = f.read()

    files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
    data = {"model": STT_MODEL, "mode": STT_MODE, "language_code": STT_LANGUAGE}
    headers = {"api-subscription-key": key}

    print(f"POST {SARVAM_STT_URL}  model={STT_MODEL} mode={STT_MODE} "
          f"language_code={STT_LANGUAGE}  file={audio_path.name} ({len(wav_bytes)} bytes)")
    resp = requests.post(SARVAM_STT_URL, files=files, data=data, headers=headers, timeout=120)
    print(f"HTTP {resp.status_code}")
    if resp.status_code != 200:
        print(resp.text)
        raise SystemExit(f"Sarvam STT failed: {resp.status_code}")

    payload = resp.json()
    out_path = REPO / "scripts" / "demo" / "stt_capture_raw.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== RAW SARVAM RESPONSE ===")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print("\n=== TRANSCRIPT (verbatim) ===")
    print(payload.get("transcript", ""))
    print(f"\nlanguage_code = {payload.get('language_code')}")
    print(f"request_id    = {payload.get('request_id')}")
    print(f"\nraw response saved -> {out_path}")


if __name__ == "__main__":
    main()
