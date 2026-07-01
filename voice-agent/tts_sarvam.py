"""Sarvam streaming TTS (Bulbul) as a LiveKit Agents TTS plugin adapter.

Wraps Sarvam's streaming text-to-speech WebSocket in the LiveKit `tts.TTS` /
`tts.ChunkedStream` plugin contract. The brain returns a full reply_text per turn
(the HTTP boundary is turn-shaped), and this adapter streams the synthesized
audio OUT chunk-by-chunk: the first PCM chunk plays while Sarvam is still
generating the rest. The session's barge-in stops/clears playback when the caller
speaks over the agent.

A `language_provider` lets the agent speak each reply in the brain's effective
language (code-switch Telugu<->English within one call). No business logic — text
in, audio out. The wire protocol lives in the livekit-free sarvam_protocol module.

NOTE (version): written against livekit-agents 1.x (tts.TTS / ChunkedStream with
`_run(output_emitter)` and the AudioEmitter initialize/push/flush API). Validate
on `uv sync`.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Callable, Optional

import websockets
from livekit.agents import DEFAULT_API_CONNECT_OPTIONS, tts

from sarvam_protocol import config_message, flush_message, is_final_event, parse_audio, text_message

logger = logging.getLogger("voice-agent.tts")

SARVAM_TTS_WS = os.environ.get("SARVAM_TTS_WS_URL", "wss://api.sarvam.ai/text-to-speech/ws")
SARVAM_TTS_MODEL = os.environ.get("SARVAM_TTS_MODEL", "bulbul:v2")
SARVAM_TTS_SPEAKER = os.environ.get("SARVAM_TTS_SPEAKER", "anushka")
# bulbul:v2 → 22050; bulbul:v3 → 24000.
SARVAM_TTS_SAMPLE_RATE = int(os.environ.get("SARVAM_TTS_SAMPLE_RATE", "22050"))
DEFAULT_TTS_LANGUAGE = os.environ.get("VOICE_DEFAULT_LANGUAGE", "en-IN")


class SarvamTTS(tts.TTS):
    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        language: str = DEFAULT_TTS_LANGUAGE,
        speaker: str = SARVAM_TTS_SPEAKER,
        model: str = SARVAM_TTS_MODEL,
        sample_rate: int = SARVAM_TTS_SAMPLE_RATE,
        language_provider: Optional[Callable[[], Optional[str]]] = None,
    ) -> None:
        # streaming=False: the brain hands us a full reply per turn, so we use the
        # ChunkedStream (synthesize) path. Audio still streams OUT chunk-by-chunk.
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=1,
        )
        self._api_key = api_key or os.environ.get("SARVAM_API_KEY", "")
        self._language = language
        self._speaker = speaker
        self._model = model
        self._language_provider = language_provider

    def current_language(self) -> str:
        if self._language_provider:
            return self._language_provider() or self._language
        return self._language

    def on_first_byte(self) -> None:
        """Hook the agent overrides to stamp tts_first_byte_at latency."""

    def on_playback_start(self) -> None:
        """Hook the agent overrides to stamp playback_start_at latency."""

    def synthesize(self, text: str, *, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        return SarvamTTSStream(tts=self, input_text=text, conn_options=conn_options)


class SarvamTTSStream(tts.ChunkedStream):
    async def _run(self, output_emitter) -> None:
        t: SarvamTTS = self._tts
        url = f"{SARVAM_TTS_WS}?model={t._model}&send_completion_event=true"
        headers = {"api-subscription-key": t._api_key}
        language = t.current_language()

        output_emitter.initialize(
            request_id=uuid.uuid4().hex,
            sample_rate=t.sample_rate,
            num_channels=t.num_channels,
            mime_type="audio/pcm",
        )

        first = True
        async with websockets.connect(url, additional_headers=headers) as ws:
            await ws.send(config_message(language, t._speaker, t.sample_rate, t._model))
            await ws.send(text_message(self._input_text))
            await ws.send(flush_message())

            async for raw in ws:
                pcm = parse_audio(raw)
                if pcm:
                    if first:
                        t.on_first_byte()           # first audio byte back from Sarvam
                    output_emitter.push(pcm)        # play this chunk while the rest generates
                    if first:
                        first = False
                        t.on_playback_start()       # first frame fed to the room
                elif is_final_event(raw):
                    break

        output_emitter.flush()
