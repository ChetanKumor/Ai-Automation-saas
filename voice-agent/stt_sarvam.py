"""Sarvam streaming STT as a LiveKit Agents STT plugin adapter.

Wraps Sarvam's streaming speech-to-text-translate WebSocket (Saaras) in the
LiveKit `stt.STT` / `stt.RecognizeStream` plugin contract, so an AgentSession can
use it like any built-in STT: push audio frames, receive interim + final
transcripts, and let the session own VAD / turn detection / barge-in. The
translate endpoint also handles code-switch (Telugu<->English) and returns a
detected `language_code` we forward to the brain.

Streaming lives ENTIRELY worker-side. The HTTP boundary to the brain is
turn-shaped — one delegate_turn per FINAL transcript (see agent.py). No business
logic here: audio in, transcripts out. The wire protocol lives in the
livekit-free sarvam_protocol module (unit-tested there).

NOTE (version): written against livekit-agents 1.x and the `websockets` client
(`additional_headers=`). Validate the streaming glue on `uv sync`.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import websockets
from livekit import rtc
from livekit.agents import DEFAULT_API_CONNECT_OPTIONS, stt

from sarvam_protocol import INPUT_SAMPLE_RATE, encode_audio_message, parse_message

logger = logging.getLogger("voice-agent.stt")

SARVAM_STT_WS = os.environ.get(
    "SARVAM_STT_WS_URL", "wss://api.sarvam.ai/speech-to-text-translate/ws"
)
SARVAM_STT_MODEL = os.environ.get("SARVAM_STT_MODEL", "saaras:v2.5")


class SarvamSTT(stt.STT):
    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        language: Optional[str] = None,
        model: str = SARVAM_STT_MODEL,
    ) -> None:
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=True, interim_results=True)
        )
        self._api_key = api_key or os.environ.get("SARVAM_API_KEY", "")
        self._language = language
        self._model = model

    async def _recognize_impl(self, buffer, *, language=None, conn_options=None):
        # Streaming-only adapter; AgentSession uses .stream() for a streaming STT.
        raise NotImplementedError("SarvamSTT is streaming-only — use .stream()")

    def stream(self, *, language=None, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        return SarvamSTTStream(
            stt=self,
            api_key=self._api_key,
            model=self._model,
            language=language or self._language,
            conn_options=conn_options,
        )


class SarvamSTTStream(stt.RecognizeStream):
    def __init__(self, *, stt, api_key, model, language, conn_options):
        super().__init__(stt=stt, conn_options=conn_options, sample_rate=INPUT_SAMPLE_RATE)
        self._api_key = api_key
        self._model = model
        self._language = language

    def _connect_url(self) -> str:
        url = f"{SARVAM_STT_WS}?model={self._model}"
        if self._language:
            url += f"&language_code={self._language}"
        return url

    async def _run(self) -> None:
        headers = {"api-subscription-key": self._api_key}
        async with websockets.connect(self._connect_url(), additional_headers=headers) as ws:
            sender = asyncio.create_task(self._send_audio(ws))
            try:
                async for raw in ws:
                    bit = parse_message(raw)
                    if bit:
                        self._emit(bit)
            finally:
                sender.cancel()

    async def _send_audio(self, ws) -> None:
        # `self._input_ch` yields rtc.AudioFrame (resampled to INPUT_SAMPLE_RATE)
        # plus flush sentinels — only forward real frames.
        async for frame in self._input_ch:
            if not isinstance(frame, rtc.AudioFrame):
                continue
            await ws.send(encode_audio_message(frame.data.tobytes(), frame.sample_rate))

    def _emit(self, bit: dict) -> None:
        kind = bit["kind"]
        if kind == "speech_start":
            self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH))
            return
        if kind == "speech_end":
            self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.END_OF_SPEECH))
            return

        ev_type = (
            stt.SpeechEventType.FINAL_TRANSCRIPT
            if kind == "final"
            else stt.SpeechEventType.INTERIM_TRANSCRIPT
        )
        language = bit.get("language") or self._language or ""
        self._event_ch.send_nowait(
            stt.SpeechEvent(
                type=ev_type,
                alternatives=[stt.SpeechData(language=language, text=bit["text"])],
            )
        )
        if kind == "final":
            logger.debug("stt FINAL [%s]: %s", language, bit["text"])
