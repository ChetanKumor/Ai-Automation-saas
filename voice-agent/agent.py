"""voice-agent — real-time audio loop for the Voice channel (LiveKit Agents).

A SEPARATE Python deployable. It owns ONLY:
  - the real-time audio loop (VAD, semantic turn detection, barge-in) via LiveKit
    AgentSession,
  - streaming STT/TTS via Sarvam (Saaras / Bulbul) as LiveKit plugin adapters,
  - delegating EVERY finalized turn to the Node brain over HTTP (HMAC).

It performs NO business reasoning: no tools, no memory, no identity, no booking,
no context assembly. All of that lives in the Node `ai_service` and is reached
exclusively through the internal voice API (see brain_client.py). Identity
resolves ONCE at /call/start; every turn thereafter carries only the
call_session_id. The worker never sees a customer_id or assembles context.

DARK / LOCAL ONLY: telephony stays noop; this joins a LiveKit dev room. No PSTN.

Run (dev): `uv sync && uv run agent.py dev`   (or `python agent.py dev`)

NOTE (version): written against livekit-agents 1.x (AgentSession / Agent /
WorkerOptions / cli, custom llm.LLM node, silero VAD). The brain client, latency,
and Sarvam message helpers are SDK-independent and unit-tested; validate the
AgentSession glue on `uv sync`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    Agent,
    AgentSession,
    JobContext,
    WorkerOptions,
    cli,
    llm,
)
from livekit.plugins import silero

from brain_client import SPOKEN_FALLBACK, BrainClient, BrainError
from latency import TurnLatency
from stt_sarvam import SarvamSTT
from tts_sarvam import SarvamTTS
from turn_context import latest_user_text

logger = logging.getLogger("voice-agent")

# ── Config (env) ──────────────────────────────────────────────────────────────
NODE_BRAIN_URL = os.environ.get("NODE_BRAIN_URL", "http://localhost:3000")
VOICE_INTERNAL_SECRET = os.environ.get("VOICE_INTERNAL_SECRET", "")
TURN_TIMEOUT_S = float(os.environ.get("VOICE_TURN_TIMEOUT_S", "10"))
# In local/dev mode the dev room has no caller id, so we use the env number that
# maps to the seeded returning customer (scripts/seed_voice_test_customer).
VOICE_DEV_CALLER_NUMBER = os.environ.get("VOICE_DEV_CALLER_NUMBER", "")
VOICE_TENANT_ID = os.environ.get("VOICE_TENANT_ID", "")

# The Agent's instructions are cosmetic: ALL reasoning is delegated to the Node
# brain by BrainLLM (which forwards only the latest user transcript). Kept short
# so nothing here competes with the brain's system prompt.
AGENT_INSTRUCTIONS = (
    "You are a voice receptionist. Every reply is produced by the backend brain; "
    "do not add content of your own."
)


@dataclass
class CallState:
    """Per-call mutable state shared across the session, LLM node, and TTS."""

    call_session_id: str
    started_at: float = field(default_factory=time.monotonic)
    language: Optional[str] = None      # effective language (STT-detected / brain)
    failed: bool = False                # a delegate_turn failed → call ends 'failed'
    end_requested: bool = False         # brain asked to end (or fallback path)
    last_latency: Optional[TurnLatency] = None

    def duration_s(self) -> float:
        return round(time.monotonic() - self.started_at, 1)


# ── The brain-delegating "LLM" node (ZERO reasoning) ──────────────────────────
class BrainLLM(llm.LLM):
    """A custom LLM node that delegates each finalized turn to the Node brain.

    This is the integration seam that keeps every AgentSession feature (VAD, turn
    detection, barge-in, TTS pipeline) while moving ALL reasoning to Node: the
    node's only job is transcript -> HTTP brain -> reply_text, emitted as one
    assistant chunk for TTS.
    """

    def __init__(self, *, brain: BrainClient, call: CallState) -> None:
        super().__init__()
        self._brain = brain
        self._call = call

    def chat(self, *, chat_ctx, tools=None, conn_options=DEFAULT_API_CONNECT_OPTIONS, **_kwargs):
        return _BrainLLMStream(
            self,
            chat_ctx=chat_ctx,
            tools=tools or [],
            conn_options=conn_options,
            brain=self._brain,
            call=self._call,
        )


class _BrainLLMStream(llm.LLMStream):
    def __init__(self, llm_, *, chat_ctx, tools, conn_options, brain, call):
        super().__init__(llm_, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._brain = brain
        self._call = call

    async def _run(self) -> None:
        lat = TurnLatency()
        lat.mark("stt_final_at")  # the node fires right after the user turn finalizes
        self._call.last_latency = lat

        transcript = latest_user_text(self._chat_ctx)
        if not transcript:
            return

        lat.mark("delegate_sent_at")
        try:
            decision = await self._brain.delegate_turn(
                self._call.call_session_id, self._call.language, transcript
            )
        except BrainError as exc:
            # Resilience: never dead air. Speak a graceful fallback and end 'failed'.
            logger.error("delegate_turn failed: %s", exc)
            self._call.failed = True
            self._call.end_requested = True
            decision = {"reply_text": SPOKEN_FALLBACK, "end_call": True, "language": self._call.language}
        lat.mark("delegate_recv_at")

        reply = (decision.get("reply_text") or "").strip() or SPOKEN_FALLBACK
        if decision.get("language"):
            self._call.language = decision["language"]  # code-switch: speak in kind
        if decision.get("end_call"):
            self._call.end_requested = True

        # Emit the brain's reply as a single assistant chunk → TTS speaks it.
        self._event_ch.send_nowait(
            llm.ChatChunk(
                id=os.urandom(8).hex(),
                delta=llm.ChoiceDelta(role="assistant", content=reply),
            )
        )


class _InstrumentedTTS(SarvamTTS):
    """SarvamTTS that stamps the TTS/playback latency stages onto the call."""

    def __init__(self, *, call: CallState, **kwargs):
        super().__init__(language_provider=lambda: call.language, **kwargs)
        self._call = call

    def on_first_byte(self) -> None:
        lat = self._call.last_latency
        if lat and lat.tts_first_byte_at is None:
            lat.mark("tts_first_byte_at")

    def on_playback_start(self) -> None:
        lat = self._call.last_latency
        if lat and lat.playback_start_at is None:
            lat.mark("playback_start_at")
            logger.info("turn latency: %s", lat.breakdown())


# ── Entrypoint ────────────────────────────────────────────────────────────────
def _load_vad():
    """Silero VAD tuned so short pauses don't truncate an utterance.

    16 kHz mono to match the STT feed. min_silence_duration is relaxed to ~600 ms
    (from the 550 ms default) so a brief mid-sentence pause doesn't end the turn,
    with a min_speech_duration floor to reject blips.
    """
    return silero.VAD.load(
        sample_rate=16000,
        min_silence_duration=0.6,
        min_speech_duration=0.1,
    )


def _resolve_turn_detection():
    """Prefer the semantic multilingual turn detector; fall back to VAD."""
    try:
        from livekit.plugins.turn_detector.multilingual import MultilingualModel

        return MultilingualModel()
    except Exception:  # plugin not installed → session uses VAD turn detection
        return "vad"


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # Call context: dev room metadata if present, else env (local mode).
    import json

    meta = {}
    try:
        meta = json.loads(ctx.room.metadata or "{}")
    except (ValueError, TypeError):
        meta = {}
    tenant_id = meta.get("tenant_id") or VOICE_TENANT_ID
    caller_id = meta.get("caller_id") or VOICE_DEV_CALLER_NUMBER
    if not tenant_id or not caller_id:
        raise RuntimeError(
            "missing tenant_id/caller_id — set VOICE_TENANT_ID and "
            "VOICE_DEV_CALLER_NUMBER (or provide room metadata)"
        )

    brain = BrainClient(NODE_BRAIN_URL, VOICE_INTERNAL_SECRET, timeout=TURN_TIMEOUT_S)

    # Bridge the call: identity resolves ONCE here. A returning customer is matched
    # by phone and reuses their conversation/memory (cross-channel continuity).
    started = await brain.call_start(tenant_id, caller_id)
    call = CallState(call_session_id=started["call_session_id"])
    logger.info(
        "call bridged: call_session=%s customer=%s conversation=%s",
        started.get("call_session_id"), started.get("customer_id"), started.get("conversation_id"),
    )

    # Close the call_session on ANY terminal (clean disconnect or error).
    async def _on_shutdown():
        status = "failed" if call.failed else "completed"
        try:
            await brain.call_end(call.call_session_id, status, call.duration_s())
            logger.info("call ended: %s (%.1fs)", status, call.duration_s())
        except BrainError as exc:
            logger.error("call_end failed: %s", exc)

    ctx.add_shutdown_callback(_on_shutdown)

    vad = ctx.proc.userdata.get("vad") if ctx.proc.userdata else None
    session = AgentSession(
        stt=SarvamSTT(),
        tts=_InstrumentedTTS(call=call),
        vad=vad or _load_vad(),
        llm=BrainLLM(brain=brain, call=call),
        turn_detection=_resolve_turn_detection(),
        allow_interruptions=True,  # barge-in: caller speech stops/clears playback
        # Relax endpointing so short pauses don't cut the caller off mid-utterance.
        turn_handling={"endpointing": {"min_delay": 0.6}},
    )

    # End-of-call watcher: when the brain asks to end (or the fallback fired),
    # let the final reply play, then shut the job down (→ call_end).
    async def _watch_end():
        while not call.end_requested:
            await asyncio.sleep(0.2)
        await asyncio.sleep(1.5)  # grace for the closing line to finish speaking
        ctx.shutdown(reason="end_call")  # sync, returns None — do NOT await

    asyncio.create_task(_watch_end())

    await session.start(room=ctx.room, agent=Agent(instructions=AGENT_INSTRUCTIONS))


def prewarm(proc) -> None:
    # Load VAD once per worker process (saves per-call startup latency).
    proc.userdata["vad"] = _load_vad()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
