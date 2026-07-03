"""Unit tests for BrainClient — HMAC signing + turn-shaped request contracts.

Uses httpx.MockTransport (no network, no Node app) to assert the worker signs the
EXACT body it sends and hits the right endpoints, and that transport/HTTP failures
surface as BrainError (→ the agent speaks a fallback and ends the call 'failed').
"""

import hashlib
import hmac
import json

import httpx
import pytest

import brain_client
from brain_client import BrainClient, BrainError, sign

SECRET = "s3cr3t-shared"


def _sig_ok(request: httpx.Request) -> bool:
    expected = "sha256=" + hmac.new(SECRET.encode(), request.content, hashlib.sha256).hexdigest()
    return request.headers.get("x-internal-signature") == expected


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_sign_matches_node_scheme():
    body = b'{"a":1}'
    assert sign(body, SECRET) == "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_delegate_turn_signs_body_and_shapes_request():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["sig_ok"] = _sig_ok(request)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"reply_text": "hi", "end_call": False, "language": "te-IN"})

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    out = await brain.delegate_turn("cs-1", "te-IN", "namaste")
    await client.aclose()

    assert out == {"reply_text": "hi", "end_call": False, "language": "te-IN"}
    assert seen["sig_ok"] is True
    assert seen["url"].endswith("/internal/voice/turn")
    assert seen["body"] == {
        "call_session_id": "cs-1",
        "channel": "voice",
        "language": "te-IN",
        "transcript": "namaste",
    }


@pytest.mark.asyncio
async def test_call_start_then_end_hit_the_right_paths():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"call_session_id": "cs", "customer_id": "c", "conversation_id": "conv", "ok": True})

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    started = await brain.call_start("tenant-1", "+919000000001")
    await brain.call_end("cs", "completed", 42)
    await client.aclose()

    assert started["call_session_id"] == "cs"
    assert calls[0].endswith("/internal/voice/call/start")
    assert calls[1].endswith("/internal/voice/call/end")


@pytest.mark.asyncio
async def test_http_error_becomes_brain_error():
    client = _client(lambda request: httpx.Response(500, text="boom"))
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    with pytest.raises(BrainError):
        await brain.delegate_turn("cs", "en-IN", "hi")
    await client.aclose()


@pytest.mark.asyncio
async def test_timeout_becomes_brain_error():
    def handler(request):
        raise httpx.TimeoutException("timed out", request=request)

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    with pytest.raises(BrainError):
        await brain.delegate_turn("cs", "en-IN", "hi")
    await client.aclose()


# ── PR9A: persistent shared client (no injected client) ──────────────────────

def _counting_async_client_factory(created):
    """Wrap the real httpx.AsyncClient so shared-client construction is counted
    and backed by a MockTransport (no network)."""
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(
            lambda request: httpx.Response(
                200, json={"reply_text": "ok", "end_call": False, "language": "te-IN"}
            )
        )
        instance = real(*args, **kwargs)
        created.append(instance)
        return instance

    return factory


@pytest.mark.asyncio
async def test_shared_client_constructed_once_and_reused_across_turns(monkeypatch):
    created = []
    monkeypatch.setattr(brain_client.httpx, "AsyncClient", _counting_async_client_factory(created))
    await brain_client.aclose_shared_client()  # clean slate

    brain = BrainClient("http://brain:3000", SECRET)
    await brain.delegate_turn("cs-1", "te-IN", "turn one")
    await brain.delegate_turn("cs-1", "te-IN", "turn two")

    assert len(created) == 1                            # constructed once
    assert brain_client._shared_client is created[0]    # identity: same instance reused

    await brain_client.aclose_shared_client()           # existing shutdown path
    assert created[0].is_closed
    assert brain_client._shared_client is None


@pytest.mark.asyncio
async def test_shared_client_recreated_after_shutdown_close(monkeypatch):
    created = []
    monkeypatch.setattr(brain_client.httpx, "AsyncClient", _counting_async_client_factory(created))
    await brain_client.aclose_shared_client()

    brain = BrainClient("http://brain:3000", SECRET)
    await brain.delegate_turn("cs-1", "te-IN", "before shutdown")
    await brain_client.aclose_shared_client()
    await brain.delegate_turn("cs-2", "te-IN", "after shutdown")  # lazily recreated

    assert len(created) == 2
    assert created[0].is_closed
    assert not created[1].is_closed

    await brain_client.aclose_shared_client()


@pytest.mark.asyncio
async def test_aclose_shared_client_is_idempotent_and_safe_when_unused():
    await brain_client.aclose_shared_client()
    await brain_client.aclose_shared_client()
    assert brain_client._shared_client is None
