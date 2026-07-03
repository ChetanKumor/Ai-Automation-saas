"""HTTP client for the Node brain — the ONLY thing this worker does with a turn.

Three turn-shaped, HMAC-signed calls over the internal API:
  - call_start(tenant_id, caller_id)            -> POST /internal/voice/call/start
  - delegate_turn(call_session_id, lang, text)  -> POST /internal/voice/turn
  - call_end(call_session_id, status, seconds)  -> POST /internal/voice/call/end

The HMAC scheme mirrors src/utils/hmac.js: `sha256=<hexdigest>` over the EXACT
raw request body bytes (header `x-internal-signature`). There is ZERO business
logic here — identity, context assembly, tools, memory, and persistence all live
behind these endpoints in the Node brain. The worker never resolves a customer,
never assembles context, never selects a tool.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, AsyncIterator, Optional, Tuple

import httpx

# A spoken fallback the brain may also override; kept here so the worker never
# emits dead air even if the brain is unreachable (see resilience in agent.py).
SPOKEN_FALLBACK = "Sorry, I'm having trouble right now. Could you say that again?"

# Module-level persistent HTTP client (PR9A): created once, reused across every
# turn so delegate_turn stops paying a fresh TCP/TLS handshake per call.
# Lazily (re)created; closed via aclose_shared_client() in the worker's existing
# shutdown path (agent.py add_shutdown_callback). Per-request timeouts still
# come from each BrainClient's VOICE_TURN_TIMEOUT_S — unchanged.
_shared_client: Optional[httpx.AsyncClient] = None


def _get_shared_client() -> httpx.AsyncClient:
    global _shared_client
    if _shared_client is None or _shared_client.is_closed:
        _shared_client = httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=10,
                max_keepalive_connections=5,
                keepalive_expiry=30.0,
            ),
        )
    return _shared_client


async def aclose_shared_client() -> None:
    """Close the shared client (worker shutdown). Safe to call repeatedly."""
    global _shared_client
    client, _shared_client = _shared_client, None
    if client is not None and not client.is_closed:
        await client.aclose()


class BrainError(Exception):
    """Any non-2xx / transport failure talking to the Node brain."""


def sign(raw_body: bytes, secret: str) -> str:
    """HMAC-SHA256 over the raw body. Matches Node `hmac.sign` exactly."""
    digest = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


class BrainClient:
    """Thin async HTTP client. Inject an httpx.AsyncClient in tests."""

    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        timeout: float = 10.0,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._secret = secret
        self._timeout = timeout
        self._client = client  # when provided (tests), we do not own its lifecycle

    def _headers(self, raw: bytes) -> dict:
        return {
            "content-type": "application/json",
            "x-internal-signature": sign(raw, self._secret),
        }

    async def _post(self, path: str, payload: dict) -> dict:
        # Sign the EXACT bytes we send so Node's raw-body HMAC verify matches.
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = self._headers(raw)
        url = f"{self._base_url}{path}"

        # Injected client (tests) wins; otherwise the shared keepalive client.
        # Neither is closed here — lifecycle belongs to the injector / shutdown.
        client = self._client or _get_shared_client()
        try:
            resp = await client.post(url, content=raw, headers=headers, timeout=self._timeout)
            if resp.status_code >= 400:
                raise BrainError(f"{path} -> HTTP {resp.status_code}: {resp.text[:200]}")
            return resp.json()
        except httpx.HTTPError as exc:  # timeouts, connection errors
            raise BrainError(f"{path} -> {type(exc).__name__}: {exc}") from exc

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def call_start(self, tenant_id: str, caller_id: str, *, channel: str = "voice") -> dict:
        """Bridge a call: identity resolves server-side; returns
        { call_session_id, customer_id, conversation_id }."""
        return await self._post(
            "/internal/voice/call/start",
            {"tenant_id": tenant_id, "caller_id": caller_id, "channel": channel},
        )

    async def delegate_turn(
        self, call_session_id: str, language: Optional[str], transcript: str
    ) -> dict:
        """Delegate ONE finalized turn. Returns { reply_text, end_call, language }."""
        return await self._post(
            "/internal/voice/turn",
            {
                "call_session_id": call_session_id,
                "channel": "voice",
                "language": language,
                "transcript": transcript,
            },
        )

    async def stream_turn(
        self,
        call_session_id: str,
        language: Optional[str],
        transcript: str,
        *,
        max_s: float = 60.0,
    ) -> AsyncIterator[Tuple[str, dict]]:
        """PR9C — delegate ONE finalized turn in SSE mode; yields (event, data)
        tuples in wire order: ack / delta / done / error.

        Opt-in is belt-and-braces: `accept: text/event-stream` header AND
        `"stream": true` in the (HMAC-signed) body. Timeouts: the client's
        VOICE_TURN_TIMEOUT_S applies PER READ (a stalled stream times out
        chunk-by-chunk, not whole-body); `max_s` is the overall hard cap for
        the turn, checked between events. Any transport failure surfaces as
        BrainError. Closing this generator (barge-in) closes the HTTP stream,
        which fires the brain's disconnect abort.
        """
        payload = {
            "call_session_id": call_session_id,
            "channel": "voice",
            "language": language,
            "transcript": transcript,
            "stream": True,
        }
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {**self._headers(raw), "accept": "text/event-stream"}
        url = f"{self._base_url}/internal/voice/turn"
        client = self._client or _get_shared_client()

        deadline = time.monotonic() + max_s
        try:
            async with client.stream(
                "POST", url, content=raw, headers=headers, timeout=self._timeout
            ) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    raise BrainError(
                        f"/internal/voice/turn -> HTTP {resp.status_code}: "
                        f"{body.decode('utf-8', 'replace')[:200]}"
                    )
                event: Optional[str] = None
                data_lines: list = []
                async for line in resp.aiter_lines():
                    if time.monotonic() > deadline:
                        raise BrainError(
                            f"/internal/voice/turn -> stream exceeded hard cap {max_s}s"
                        )
                    line = line.rstrip("\r")
                    if line == "":
                        if event is not None or data_lines:
                            try:
                                data = json.loads("\n".join(data_lines)) if data_lines else {}
                            except ValueError as exc:
                                raise BrainError(
                                    f"/internal/voice/turn -> bad SSE data: {exc}"
                                ) from exc
                            yield (event or "message", data)
                        event, data_lines = None, []
                    elif line.startswith("event:"):
                        event = line[len("event:"):].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[len("data:"):].strip())
                    # comments / unknown fields are ignored per the SSE spec
        except httpx.HTTPError as exc:  # timeouts, connect/read errors, protocol errors
            raise BrainError(f"/internal/voice/turn (stream) -> {type(exc).__name__}: {exc}") from exc

    async def call_end(
        self, call_session_id: str, status: str, duration_seconds: Optional[float]
    ) -> dict:
        """Close the call_session. status is "completed" | "failed".

        duration_seconds goes over the wire as an int — the DB column is
        integer (migration 018) and the producer owns rounding."""
        return await self._post(
            "/internal/voice/call/end",
            {
                "call_session_id": call_session_id,
                "status": status,
                "duration_seconds": (
                    None if duration_seconds is None else int(round(duration_seconds))
                ),
            },
        )
