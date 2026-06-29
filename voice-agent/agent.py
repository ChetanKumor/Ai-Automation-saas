"""
voice-agent — real-time audio loop for the Voice channel (SKELETON).

This is a SEPARATE Python deployable built on LiveKit Agents. It owns ONLY:
  - the real-time audio loop (VAD, turn-taking, barge-in) via LiveKit, and
  - STT/TTS via Sarvam (Saaras / Bulbul), and
  - delegating EVERY turn to the Node brain over HTTP.

It performs NO business reasoning: no tools, no memory, no identity, no booking.
All of that lives in the Node `ai_service` and is reached exclusively through
`POST /internal/voice/turn`. Telephony is reached ONLY through the Node-side
TelephonyProvider seam (noop in dev, Plivo in production); this worker never
talks to a carrier directly.

It is NOT imported by the Node app and is NOT exercised by the Node test suite.
The PR6 core claim is proven WITHOUT this worker, via /internal/voice/turn.

Run (production): `uv run agent.py dev`  (after `uv sync`).
"""

import hashlib
import hmac
import json
import logging
import os

import httpx

logger = logging.getLogger("voice-agent")

# ── Config (env) ──────────────────────────────────────────────────────────
NODE_BRAIN_URL = os.environ.get("NODE_BRAIN_URL", "http://localhost:3000")
VOICE_INTERNAL_SECRET = os.environ.get("VOICE_INTERNAL_SECRET", "")
SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY", "")
TURN_TIMEOUT_S = float(os.environ.get("VOICE_TURN_TIMEOUT_S", "10"))


# ── Brain delegation (the ONLY thing this worker does with a "turn") ────────
def _sign(raw_body: bytes) -> str:
    """HMAC-SHA256 over the raw request body. Mirrors Node src/utils/hmac.js
    so /internal/voice/turn accepts it: header value is `sha256=<hexdigest>`."""
    digest = hmac.new(VOICE_INTERNAL_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


async def delegate_turn(
    *,
    tenant_id: str,
    customer_id: str,
    conversation_id: str,
    call_session_id: str,
    language: str | None,
    transcript: str,
) -> dict:
    """Send one transcribed turn to the Node brain and return its decision.

    Returns the brain's response dict: { reply_text, end_call, language }.
    Contains NO logic beyond transport + signing.
    """
    payload = {
        "tenant_id": tenant_id,
        "customer_id": customer_id,
        "conversation_id": conversation_id,
        "call_session_id": call_session_id,
        "channel": "voice",
        "language": language,
        "transcript": transcript,
    }
    raw = json.dumps(payload).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "x-internal-signature": _sign(raw),
    }
    async with httpx.AsyncClient(timeout=TURN_TIMEOUT_S) as client:
        resp = await client.post(
            f"{NODE_BRAIN_URL}/internal/voice/turn", content=raw, headers=headers
        )
        resp.raise_for_status()
        return resp.json()


# ── LiveKit Agents entrypoint (SKELETON) ────────────────────────────────────
#
# The wiring below is intentionally a skeleton. At build time against the current
# `livekit-agents` SDK, fill in the STT/TTS plumbing and turn loop. The shape:
#
#   from livekit import agents
#   from livekit.agents import AgentSession, JobContext, WorkerOptions, cli
#
#   async def entrypoint(ctx: JobContext):
#       await ctx.connect()
#
#       # Call context (tenant/customer/conversation/call_session ids + language
#       # prior) is provisioned when the call is bridged in via the Node
#       # TelephonyProvider seam and handed to the room (e.g. room metadata).
#       call_ctx = json.loads(ctx.room.metadata or "{}")
#
#       # STT (Sarvam Saaras) and TTS (Sarvam Bulbul). Use the SARVAM_API_KEY.
#       # VAD / turn detection / barge-in are handled by AgentSession.
#       session = AgentSession(
#           stt=...,   # Sarvam Saaras
#           tts=...,   # Sarvam Bulbul
#           vad=...,   # e.g. silero
#       )
#
#       @session.on("user_turn_completed")
#       async def on_user_turn(ev):
#           # ev.transcript + detected language come from STT — NO reasoning here.
#           decision = await delegate_turn(
#               tenant_id=call_ctx["tenant_id"],
#               customer_id=call_ctx["customer_id"],
#               conversation_id=call_ctx["conversation_id"],
#               call_session_id=call_ctx["call_session_id"],
#               language=ev.language or call_ctx.get("language"),
#               transcript=ev.transcript,
#           )
#           await session.say(decision["reply_text"])  # Bulbul TTS plays it
#           if decision.get("end_call"):
#               await ctx.shutdown()
#
#       await session.start(room=ctx.room)
#
#   if __name__ == "__main__":
#       cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))


def _skeleton_guard():
    raise NotImplementedError(
        "voice-agent is a skeleton. Implement the LiveKit Agents wiring above against "
        "the current livekit-agents SDK before deploying. delegate_turn() is complete."
    )


if __name__ == "__main__":
    _skeleton_guard()
