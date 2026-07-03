"""voice-agent — real-time audio loop for the Voice channel (LiveKit Agents).

A SEPARATE Python deployable. It owns ONLY:
  - the real-time audio loop (turn detection, endpointing, barge-in) via
    LiveKit AgentSession,
  - streaming STT/TTS via the OFFICIAL Sarvam plugin (livekit-plugins-sarvam),
  - delegating EVERY finalized turn to the Node brain over HTTP (HMAC).

It performs NO business reasoning: no tools, no memory, no identity, no booking,
no context assembly. All of that lives in the Node `ai_service` and is reached
exclusively through the internal voice API (see brain_client.py). Identity
resolves ONCE at /call/start; every turn thereafter carries only the
call_session_id. The worker never sees a customer_id or assembles context.

The delegation seam is `BrainAgent.llm_node`: the pipeline slot where an LLM
would normally reason is instead a forwarding shim — latest user transcript in,
one reply_text chunk out, via brain_client.delegate_turn(). Everything below
that seam (audio framing, sample rates, voice-activity segmentation, streaming
connections and their lifecycle) is owned by livekit-agents + the Sarvam plugin;
this worker contains no audio handling of its own.

DARK / LOCAL ONLY: telephony stays noop; this joins a LiveKit dev room. No PSTN.

Run (dev): `uv sync && uv run agent.py dev`   (or `python agent.py dev`)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

from livekit.agents import Agent, AgentSession, FlushSentinel, JobContext, WorkerOptions, cli, llm
from livekit.plugins import sarvam

from brain_client import BrainClient, BrainError, aclose_shared_client
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

# PR9C — opt-in SSE turn streaming (dark by default). Read at call time so the
# JSON path stays byte-identical when off and tests can toggle per case.
def _stream_enabled() -> bool:
    return os.environ.get("VOICE_STREAM_TURNS", "false").strip().lower() in ("1", "true", "yes")


def _turn_max_s() -> float:
    try:
        return float(os.environ.get("VOICE_TURN_MAX_S", "60"))
    except ValueError:
        return 60.0


SARVAM_STT_MODEL = os.environ.get("SARVAM_STT_MODEL", "saaras:v3")
SARVAM_TTS_MODEL = os.environ.get("SARVAM_TTS_MODEL", "bulbul:v3")
SARVAM_TTS_SPEAKER = os.environ.get("SARVAM_TTS_SPEAKER", "shubh")
DEFAULT_LANGUAGE = os.environ.get("VOICE_DEFAULT_LANGUAGE", "te-IN")

# Sarvam saaras STT auto-detects the spoken language when given this code
# (valid for saaras:v3 per the plugin's language table).
STT_AUTO_DETECT = "unknown"

# The Agent's instructions are cosmetic: ALL reasoning is delegated to the Node
# brain by BrainAgent.llm_node (which forwards only the latest user transcript).
AGENT_INSTRUCTIONS = (
    "You are a voice receptionist. Every reply is produced by the backend brain; "
    "do not add content of your own."
)

# Static spoken apologies for the delegate-failure path. Hardcoded per language —
# the worker NEVER authors language; these are fixed strings, not generation.
APOLOGIES = {
    "te-IN": "క్షమించండి, ప్రస్తుతం సాంకేతిక సమస్య వచ్చింది. దయచేసి కాసేపటి తర్వాత మళ్లీ కాల్ చేయండి.",
    "hi-IN": "क्षमा करें, अभी तकनीकी समस्या आ रही है। कृपया थोड़ी देर बाद फिर से कॉल करें।",
    "en-IN": "Sorry, we are having technical trouble right now. Please call again in a little while.",
}


def apology_for(language: Optional[str]) -> str:
    """The static apology for `language`, falling back to the default language."""
    return APOLOGIES.get(language or "", APOLOGIES.get(DEFAULT_LANGUAGE, APOLOGIES["en-IN"]))


@dataclass
class CallState:
    """Per-call mutable state shared between the session wiring and the shim."""

    call_session_id: str
    started_at: float = field(default_factory=time.monotonic)
    language: Optional[str] = None      # effective language (STT-detected / brain)
    failed: bool = False                # a delegate_turn failed → call ends 'failed'
    end_requested: bool = False         # brain asked to end (or the failure path)

    def duration_s(self) -> float:
        return round(time.monotonic() - self.started_at, 1)


class BrainStubLLM(llm.LLM):
    """Inert placeholder: the AgentSession pipeline skips reply generation
    entirely when no LLM instance is set ("skip response if no llm is set" in
    agent_activity), even when llm_node is overridden. BrainAgent overrides
    llm_node, so nothing ever reaches this instance — chat() must never run."""

    def chat(self, **kwargs):
        raise RuntimeError("BrainStubLLM.chat must never be called — llm_node is overridden")


# ── The delegation shim (ZERO reasoning) ──────────────────────────────────────
class BrainAgent(Agent):
    """Forwards each finalized user turn to the Node brain and yields the
    brain's reply_text unchanged. Default: one chunk (JSON contract). With
    VOICE_STREAM_TURNS=true (PR9C): the brain's SSE events — a brain-authored
    ack chunk, then delta chunks — all authored by the brain; this worker still
    generates zero language.

    The session-local chat history is deliberately ignored (only the latest
    user message is read): the Node brain owns conversation state, and the
    local context must never influence output.
    """

    def __init__(
        self,
        *,
        brain: BrainClient,
        call: CallState,
        tts,
        on_end_call=None,
    ) -> None:
        super().__init__(instructions=AGENT_INSTRUCTIONS)
        self._brain = brain
        self._call = call
        self._sarvam_tts = tts
        self._on_end_call = on_end_call
        self._end_signaled = False

    def _signal_end(self) -> None:
        """Idempotently mark the call as ending (brain end_call or failure)."""
        if self._end_signaled:
            return
        self._end_signaled = True
        self._call.end_requested = True
        if self._on_end_call is not None:
            self._on_end_call()

    def _switch_tts_language(self, language: str) -> None:
        """Code-switch: speak the brain's effective language. Effective for the
        reply about to be synthesized — the session creates the synthesis stream
        only after llm_node yields its first chunk."""
        try:
            self._sarvam_tts.update_options(target_language_code=language)
        except ValueError as exc:
            # The plugin validates language codes; a bad code must not kill the turn.
            logger.warning("tts language switch to %r rejected: %s", language, exc)

    async def llm_node(self, chat_ctx, tools, model_settings):
        # ONLY the latest user message — history is owned by the Node brain.
        transcript = latest_user_text(chat_ctx)
        if not transcript:
            return

        # PR9C: opt-in SSE turn mode. The inner generator is aclosed
        # DETERMINISTICALLY on barge-in (the framework acloses llm_node →
        # GeneratorExit here → finally → inner aclose → HTTP stream closed →
        # the brain's disconnect abort fires). Flag off ⇒ the JSON path below
        # runs untouched.
        if _stream_enabled():
            inner = self._llm_node_streamed(transcript)
            try:
                async for chunk in inner:
                    yield chunk
            finally:
                await inner.aclose()
            return

        call = self._call
        t0 = time.perf_counter()
        try:
            decision = await self._brain.delegate_turn(
                call.call_session_id, call.language, transcript
            )
        except BrainError as exc:
            # Never dead air, no retries: speak the static apology, end 'failed'.
            logger.error("delegate_turn failed: %s", exc)
            call.failed = True
            yield apology_for(call.language)
            self._signal_end()
            return
        logger.info("delegate_rtt_ms=%.1f", (time.perf_counter() - t0) * 1000.0)

        reply = (decision.get("reply_text") or "").strip()
        language = decision.get("language")
        if language and language != call.language:
            call.language = language
            self._switch_tts_language(language)

        # Single chunk: /internal/voice/turn is non-streaming. An EMPTY
        # reply_text is a valid brain decision (conversation in human mode /
        # AI disabled) → stay silent.
        if reply:
            yield reply

        # Defensive: the brain currently always returns end_call=false, but the
        # contract allows true. Signal AFTER the yield so the reply is already
        # queued for playout; the entrypoint lets it finish, then shuts down.
        if decision.get("end_call"):
            self._signal_end()

    async def _llm_node_streamed(self, transcript: str):
        """PR9C — SSE turn consumption (VOICE_STREAM_TURNS=true only).

        Yields the brain-authored ack as the first chunk followed by a
        FlushSentinel — the sentinel ends the TTS segment so the ack is
        synthesized and spoken IMMEDIATELY (without it, the sentence tokenizer
        holds a lone sentence until more text arrives — livekit-agents
        token_stream.py buffers until a second sentence begins). Deltas then
        stream into the next TTS segment as received.

        done applies end_call/language exactly like the JSON path. Limitation:
        the TTS language of THIS turn is fixed at the turn's start; a language
        change on done only takes effect from the next synthesis stream (next
        turn). On any transport/brain error after audio may have been spoken:
        yield the static per-language apology and end the call — never silence.
        """
        call = self._call
        t0 = time.perf_counter()
        done: Optional[dict] = None
        try:
            events = self._brain.stream_turn(
                call.call_session_id, call.language, transcript, max_s=_turn_max_s()
            )
            try:
                async for name, data in events:
                    if name == "ack":
                        text = (data.get("text") or "").strip()
                        if text:
                            yield text
                            yield FlushSentinel()
                    elif name == "delta":
                        text = data.get("text") or ""
                        if text:
                            yield text
                    elif name == "done":
                        done = data
                        break
                    elif name == "error":
                        raise BrainError(f"turn error event: {data.get('message')}")
            finally:
                # Idempotent; also the barge-in path (GeneratorExit lands here
                # and closing the generator closes the HTTP stream).
                await events.aclose()
            if done is None:
                raise BrainError("SSE stream ended without a done event")
        except BrainError as exc:
            # Never dead air, no retries: speak the static apology, end 'failed'.
            logger.error("stream_turn failed: %s", exc)
            call.failed = True
            yield apology_for(call.language)
            self._signal_end()
            return
        logger.info("stream_turn_total_ms=%.1f", (time.perf_counter() - t0) * 1000.0)

        # Same decision handling as the JSON path; language only affects the
        # NEXT turn's synthesis (mid-stream switching is not supported).
        language = done.get("language")
        if language and language != call.language:
            call.language = language
            self._switch_tts_language(language)

        if done.get("end_call"):
            self._signal_end()


# ── Entrypoint ────────────────────────────────────────────────────────────────
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # Call context: dev room metadata if present, else env (local mode).
    meta = {}
    try:
        meta = json.loads(ctx.room.metadata or "{}")
    except (ValueError, TypeError):
        meta = {}
    tenant_id = meta.get("tenant_id") or VOICE_TENANT_ID
    caller_id = meta.get("caller_id") or VOICE_DEV_CALLER_NUMBER
    language_prior = meta.get("language")  # optional per-call language prior
    if not tenant_id or not caller_id:
        raise RuntimeError(
            "missing tenant_id/caller_id — set VOICE_TENANT_ID and "
            "VOICE_DEV_CALLER_NUMBER (or provide room metadata)"
        )

    brain = BrainClient(NODE_BRAIN_URL, VOICE_INTERNAL_SECRET, timeout=TURN_TIMEOUT_S)

    # Bridge the call: identity resolves ONCE here. A returning customer is matched
    # by phone and reuses their conversation/memory (cross-channel continuity).
    started = await brain.call_start(tenant_id, caller_id)
    call = CallState(call_session_id=started["call_session_id"], language=language_prior)
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
        finally:
            # PR9A: release the shared keepalive HTTP client with the job.
            await aclose_shared_client()

    ctx.add_shutdown_callback(_on_shutdown)

    # STT/TTS and all audio transport live inside the official Sarvam plugin:
    # no separate VAD model, no manual audio handling anywhere in this worker.
    stt = sarvam.STT(
        model=SARVAM_STT_MODEL,
        mode="transcribe",          # native-language transcript; the brain replies in-language
        flush_signal=True,
        language=language_prior or STT_AUTO_DETECT,
    )
    tts = sarvam.TTS(
        model=SARVAM_TTS_MODEL,
        speaker=SARVAM_TTS_SPEAKER,
        target_language_code=language_prior or DEFAULT_LANGUAGE,
    )

    end_requested = asyncio.Event()
    agent = BrainAgent(brain=brain, call=call, tts=tts, on_end_call=end_requested.set)

    session = AgentSession(
        stt=stt,
        tts=tts,
        llm=BrainStubLLM(),
        # STT-signal turn detection: the Sarvam plugin's server-side voice
        # activity events segment utterances (no local VAD model). Barge-in
        # (interruptions) stays on by default.
        turn_handling={
            "turn_detection": "stt",
            "endpointing": {"min_delay": 0.07},
        },
    )

    # Track the STT-detected language so each delegate_turn carries it.
    @session.on("user_input_transcribed")
    def _on_user_input_transcribed(ev) -> None:
        if ev.is_final and ev.language:
            call.language = str(ev.language)

    # End-of-call: when the brain asks to end (or the failure path fired), let
    # the queued closing line finish playing, then shut the job down (→ call_end).
    async def _finish_then_shutdown() -> None:
        await end_requested.wait()
        try:
            await asyncio.wait_for(session.drain(), timeout=30.0)
        except (asyncio.TimeoutError, RuntimeError) as exc:
            logger.warning("session drain before shutdown did not complete: %s", exc)
        ctx.shutdown(reason="end_call")  # sync, returns None — do NOT await

    asyncio.create_task(_finish_then_shutdown())

    await session.start(room=ctx.room, agent=agent)

    # Greeting: /call/start does not currently return greeting text; if the
    # brain adds one, speak it proactively (say() needs only the TTS plugin).
    # All subsequent turns flow through llm_node, never say().
    greeting = (started.get("greeting") or "").strip()
    if greeting:
        session.say(greeting)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
