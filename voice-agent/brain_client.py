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
from typing import Any, Optional

import httpx

# A spoken fallback the brain may also override; kept here so the worker never
# emits dead air even if the brain is unreachable (see resilience in agent.py).
SPOKEN_FALLBACK = "Sorry, I'm having trouble right now. Could you say that again?"


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

        owns = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout)
        try:
            resp = await client.post(url, content=raw, headers=headers, timeout=self._timeout)
            if resp.status_code >= 400:
                raise BrainError(f"{path} -> HTTP {resp.status_code}: {resp.text[:200]}")
            return resp.json()
        except httpx.HTTPError as exc:  # timeouts, connection errors
            raise BrainError(f"{path} -> {type(exc).__name__}: {exc}") from exc
        finally:
            if owns:
                await client.aclose()

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

    async def call_end(
        self, call_session_id: str, status: str, duration_seconds: Optional[float]
    ) -> dict:
        """Close the call_session. status is "completed" | "failed"."""
        return await self._post(
            "/internal/voice/call/end",
            {
                "call_session_id": call_session_id,
                "status": status,
                "duration_seconds": duration_seconds,
            },
        )
