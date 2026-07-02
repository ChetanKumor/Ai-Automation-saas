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

from sarvam_protocol import (
    config_message,
    flush_message,
    is_final_event,
    parse_audio,
    pcm16_from_wav,
    text_message,
)

logger = logging.getLogger("voice-agent.tts")

# Emitter framing. We buffer decoded PCM and push whole frames of this size so no
# partial frame is dropped; the trailing remainder is padded with silence. Small
# (20 ms) to keep time-to-first-frame low.
FRAME_MS = 20

# Dev-only per-hop tracing. OFF by default; NEVER alters control flow.
VOICE_DEBUG = os.environ.get("VOICE_DEBUG", "").lower() in ("1", "true", "yes")

SARVAM_TTS_WS = os.environ.get("SARVAM_TTS_WS_URL", "wss://api.sarvam.ai/text-to-speech/ws")
SARVAM_TTS_MODEL = os.environ.get("SARVAM_TTS_MODEL", "bulbul:v2")
SARVAM_TTS_SPEAKER = os.environ.get("SARVAM_TTS_SPEAKER", "anushka")
# MUST equal the LiveKit room AudioSource rate (RoomOutputOptions default 24000)
# so the AgentSession's TTS→output path does NO resampling (generation.py only
# inserts an rtc.AudioResampler when tts.sample_rate != audio_output.sample_rate).
# Sarvam Bulbul honors this rate; 24000 is native to bulbul:v2 and returns audio
# reliably, whereas the old 22050 forced a non-integer 22050→24000 resample.
SARVAM_TTS_SAMPLE_RATE = int(os.environ.get("SARVAM_TTS_SAMPLE_RATE", "24000"))
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
            frame_size_ms=FRAME_MS,
        )
        if VOICE_DEBUG:
            # hop9: the rate/channels we declare to the AudioSource. The room
            # output is 24000 mono; when this equals 24000 no resample occurs.
            logger.info(
                "tts emitter declared: sample_rate=%d ch=%d (requested speech_sample_rate=%d)",
                t.sample_rate, t.num_channels, t.sample_rate,
            )
        pushed_bytes = 0

        # One emitter frame in bytes (PCM16). Sarvam's WAV chunks arrive at
        # arbitrary sizes, so we align our pushes to this to avoid dropped/partial
        # frames. Matches the emitter's own samples_per_channel formula.
        frame_bytes = int(t.sample_rate // 1000 * FRAME_MS) * 2 * t.num_channels

        buf = bytearray()
        first_byte = True
        first_frame = True
        async with websockets.connect(url, additional_headers=headers) as ws:
            await ws.send(config_message(language, t._speaker, t.sample_rate, t._model))
            await ws.send(text_message(self._input_text))
            await ws.send(flush_message())

            async for raw in ws:
                pcm = parse_audio(raw)
                if pcm:
                    if first_byte:
                        first_byte = False
                        t.on_first_byte()           # first audio byte back from Sarvam
                        if VOICE_DEBUG:
                            # hop6: read the TRUE shape of Sarvam's first chunk. The
                            # streaming endpoint returns headerless raw PCM16 at the
                            # requested speech_sample_rate (no RIFF to parse).
                            has_riff = pcm[:4] == b"RIFF"
                            logger.info(
                                "tts hop6 first-chunk bytes=%d riff_header=%s "
                                "(payload treated as PCM16 @%dHz)",
                                len(pcm), has_riff, t.sample_rate,
                            )
                    buf.extend(pcm16_from_wav(pcm))  # strip WAV container → raw PCM16
                    # Push only whole frames; hold the remainder for the next chunk.
                    n = (len(buf) // frame_bytes) * frame_bytes
                    if n:
                        output_emitter.push(bytes(buf[:n]))
                        pushed_bytes += n
                        del buf[:n]
                        if first_frame:
                            first_frame = False
                            t.on_playback_start()   # first frame actually fed to the room
                elif is_final_event(raw):
                    break

        # Pad the trailing partial frame with silence so nothing is dropped at flush.
        if buf:
            buf.extend(b"\x00" * (frame_bytes - len(buf)))
            output_emitter.push(bytes(buf))
            pushed_bytes += len(buf)
            if first_frame:
                first_frame = False
                t.on_playback_start()

        if VOICE_DEBUG:
            # hop10/11: total PCM16 fed to the AudioSource at the declared rate.
            logger.info(
                "tts pushed total=%d bytes = %.2fs @%dHz mono",
                pushed_bytes, pushed_bytes / 2 / t.sample_rate, t.sample_rate,
            )
        output_emitter.flush()
