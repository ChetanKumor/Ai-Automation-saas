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
import math
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
    correlation_id: Optional[str] = None  # Issue 21: the call's chain id, from /call/start
    language: Optional[str] = None      # effective language (STT-detected / brain)
    failed: bool = False                # a delegate_turn failed → call ends 'failed'
    end_requested: bool = False         # brain asked to end (or the failure path)
    turn_index: int = 0                 # agent turns seen; indexes the metrics line
    # The user leg of the turn's timings, held until the agent leg arrives.
    pending_user_metrics: Optional[dict] = None

    def duration_s(self) -> float:
        return round(time.monotonic() - self.started_at, 1)


# ── Per-turn latency line ─────────────────────────────────────────────────────
# ONE structured line per turn, carrying the stage timings livekit-agents already
# computes and currently discards. The source is the framework's own per-turn
# report, `ChatMessage.metrics` (livekit-agents 1.6.4 — the `MetricsReport`
# TypedDict at llm/chat_context.py:261-313, attached to every message at :324),
# delivered on the session's `conversation_item_added` event.
#
# NOT the session's `metrics_collected` event, for two reasons read out of the
# INSTALLED library rather than assumed:
#   1. It is deprecated for exactly this use. voice/events.py:375-376:
#      "Per-turn latency metrics are available on ChatMessage.metrics".
#   2. Decisively, it cannot carry the llm_node timing on THIS wiring. LLMMetrics
#      is constructed at one site only — llm/llm.py:315, emitted at :369 — inside
#      LLMStream._metrics_monitor_task, and an LLMStream exists only when
#      LLM.chat() is called. BrainAgent.llm_node overrides that slot and
#      BrainStubLLM.chat raises by contract, so LLMMetrics NEVER fires here.
#      The framework does still time the overridden node: generation.py:146-147
#      stamps _LLMGenerationData.ttft on the FIRST chunk llm_node yields, and
#      agent_activity.py:2987-2988 publishes it as `llm_node_ttft` on the
#      assistant message built at :3028-3038. Same number, different carrier.
#
# The two legs arrive on two different messages: the endpoint/STT timings ride the
# USER message (agent_activity.py:3967-3986, `_init_metrics_from_end_of_turn`) and
# the llm/tts timings ride the ASSISTANT message. The handler therefore holds the
# user leg and emits once, when the assistant item for that turn lands.
TURN_METRICS_EVENT = "voice_worker_turn_metrics"

# Payload field → `ChatMessage.metrics` key, ordered as the stages occur. Both
# user-leg values are measured from the same anchor (the caller's last speaking
# time), so transcription_delay precedes end_of_turn_delay on the timeline.
_USER_STAGES = (
    ("stt_final_ms", "transcription_delay"),
    ("eou_delay_ms", "end_of_turn_delay"),
)
_AGENT_STAGES = (
    ("llm_ttft_ms", "llm_node_ttft"),
    ("tts_ttfb_ms", "tts_node_ttfb"),
    ("e2e_ms", "e2e_latency"),
)


def _ms(metrics, key: str) -> Optional[float]:
    """`metrics[key]` (seconds, per MetricsReport) in milliseconds, or None.

    Never raises. A missing key, a carrier that is not a mapping, a bool, a
    non-number, a NaN or an infinity all degrade to a null field: a surprise in
    the metrics must cost a null in the log line, never a turn.
    """
    try:
        value = metrics[key]
    except Exception:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return round(value * 1000.0, 1)


def build_turn_metrics(call: CallState, turn: int, user_metrics, agent_metrics) -> dict:
    """The one payload per turn. Pure — no logging, no I/O, never raises.

    Keyed on the Issue 21 correlation id, which /call/start returns and
    entrypoint() stores on CallState; `turn` disambiguates the many turns that
    share one call's chain id.
    """
    payload = {
        "call_session_id": call.call_session_id,
        "correlation_id": call.correlation_id,
        "turn": turn,
        "language": call.language,
    }
    for name, key in _USER_STAGES:
        payload[name] = _ms(user_metrics, key)
    for name, key in _AGENT_STAGES:
        payload[name] = _ms(agent_metrics, key)
    return payload


def turn_metrics_listener(call: CallState, log: Optional[logging.Logger] = None):
    """Build the `conversation_item_added` handler that emits the per-turn line.

    Returned as a closure rather than written inline in entrypoint() so tests can
    drive it directly, with no live AgentSession and no room.
    """
    log = log or logger

    def _on_conversation_item_added(ev) -> None:
        try:
            item = getattr(ev, "item", None)
            role = getattr(item, "role", None)
            metrics = getattr(item, "metrics", None)

            if role == "user":
                # Overwritten each turn and cleared on use, so a leg is never
                # counted twice. ⚠️ One residual: a turn whose reply is empty
                # (human mode / AI disabled) adds NO assistant message —
                # agent_activity.py:3024 gates on `forwarded_text` — so its leg
                # stays pending until the next assistant item. Today the next
                # such item is always the next turn's, which then carries the
                # right leg anyway; it would mis-attribute only to a session.say()
                # reply, and say() is unreachable at HEAD (/call/start returns no
                # greeting). Documented rather than defended: nothing on the two
                # messages links them, so a real fix needs a turn id the
                # framework does not expose.
                call.pending_user_metrics = metrics
                return
            if role != "assistant":
                # AgentHandoff and the unknown-type discriminator carry no timings.
                return

            call.turn_index += 1
            payload = build_turn_metrics(
                call, call.turn_index, call.pending_user_metrics, metrics
            )
            call.pending_user_metrics = None
            log.info(TURN_METRICS_EVENT, extra={"turn_metrics": payload})
        except Exception:
            # This fires inside the framework's reply task, and rtc.EventEmitter
            # .emit swallows Exception but RE-RAISES TypeError — so a raising
            # handler really can land on the turn path. The guard has to be here.
            log.warning("turn metrics line skipped", exc_info=True)

    return _on_conversation_item_added


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
                call.call_session_id, call.language, transcript,
                correlation_id=call.correlation_id,
            )
        except BrainError as exc:
            # Never dead air, no retries: speak the static apology, end 'failed'.
            logger.error("delegate_turn failed: %s correlation_id=%s", exc, call.correlation_id)
            call.failed = True
            yield apology_for(call.language)
            self._signal_end()
            return
        logger.info(
            "delegate_rtt_ms=%.1f correlation_id=%s",
            (time.perf_counter() - t0) * 1000.0, call.correlation_id,
        )

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
                call.call_session_id, call.language, transcript,
                max_s=_turn_max_s(), correlation_id=call.correlation_id,
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
            logger.error("stream_turn failed: %s correlation_id=%s", exc, call.correlation_id)
            call.failed = True
            yield apology_for(call.language)
            self._signal_end()
            return
        logger.info(
            "stream_turn_total_ms=%.1f correlation_id=%s",
            (time.perf_counter() - t0) * 1000.0, call.correlation_id,
        )

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
    call = CallState(
        call_session_id=started["call_session_id"],
        correlation_id=started.get("correlation_id"),
        language=language_prior,
    )
    logger.info(
        "call bridged: call_session=%s customer=%s conversation=%s correlation_id=%s",
        started.get("call_session_id"), started.get("customer_id"),
        started.get("conversation_id"), call.correlation_id,
    )
    if not call.correlation_id:
        # Deploy skew (older brain): with no id to echo, every turn/end post
        # gets a FRESH server-side correlation id and the call fragments into
        # unlinked chains. Warn loudly so the skew is visible before an
        # incident needs the logs.
        logger.warning("call_start returned no correlation_id — call chain will fragment")

    # Close the call_session on ANY terminal (clean disconnect or error).
    async def _on_shutdown():
        status = "failed" if call.failed else "completed"
        try:
            await brain.call_end(
                call.call_session_id, status, call.duration_s(),
                correlation_id=call.correlation_id,
            )
            logger.info(
                "call ended: %s (%.1fs) correlation_id=%s",
                status, call.duration_s(), call.correlation_id,
            )
        except BrainError as exc:
            logger.error("call_end failed: %s correlation_id=%s", exc, call.correlation_id)
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

    # ONE latency line per turn. Registration only — the session is already
    # constructed and its turn behaviour is untouched. See build_turn_metrics for
    # why the source is conversation_item_added and not metrics_collected.
    session.on("conversation_item_added", turn_metrics_listener(call))

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
