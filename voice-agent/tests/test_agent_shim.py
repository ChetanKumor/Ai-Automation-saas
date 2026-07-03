"""Unit tests for the BrainAgent llm_node delegation shim.

Hermetic: no network, no audio, no LiveKit room, no keys. delegate_turn is
exercised through the REAL BrainClient over httpx.MockTransport so the wire
contract (payload shape + HMAC over the raw body) is asserted end-to-end; the
AgentSession is never started (llm_node is driven directly, as the pipeline
drives it).
"""

import hashlib
import hmac as hmac_mod
import json

import httpx
import pytest

from agent import APOLOGIES, BrainAgent, CallState, apology_for
from brain_client import BrainClient, BrainError, sign

SECRET = "s3cr3t-shared"


class FakeTTS:
    """Records update_options calls; stands in for the Sarvam TTS plugin."""

    def __init__(self):
        self.updates = []

    def update_options(self, **kwargs):
        self.updates.append(kwargs)


class _Msg:
    def __init__(self, role, content):
        self.role = role
        self.content = content


class _Ctx:
    def __init__(self, items):
        self.items = items


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _agent(brain, call, *, tts=None, on_end_call=None):
    return BrainAgent(brain=brain, call=call, tts=tts or FakeTTS(), on_end_call=on_end_call)


async def _collect(agent, ctx):
    return [chunk async for chunk in agent.llm_node(ctx, [], None)]


# ── HMAC: vector-check against a fixture ─────────────────────────────────────
def test_hmac_signature_matches_fixture_vector():
    # Independently computed (Node: crypto.createHmac('sha256','k')
    # .update('{"a":1}').digest('hex')) — the exact scheme src/utils/hmac.js
    # verifies on /internal/voice/*.
    assert (
        sign(b'{"a":1}', "k")
        == "sha256=c3a92ff9e274cdcce27a58c15a78ec6dcbbdbd0038a87e7a11baef2028fd8bff"
    )


# ── Happy path ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_happy_path_delegates_exact_contract_and_yields_reply_exactly():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        expected = (
            "sha256="
            + hmac_mod.new(SECRET.encode(), request.content, hashlib.sha256).hexdigest()
        )
        seen["sig_ok"] = request.headers.get("x-internal-signature") == expected
        return httpx.Response(
            200, json={"reply_text": "నమస్తే!", "end_call": False, "language": "te-IN"}
        )

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="te-IN")

    chunks = await _collect(_agent(brain, call), _Ctx([_Msg("user", "నమస్కారం")]))
    await client.aclose()

    assert chunks == ["నమస్తే!"]  # reply_text verbatim, single chunk
    assert seen["url"].endswith("/internal/voice/turn")
    assert seen["sig_ok"] is True
    assert seen["body"] == {
        "call_session_id": "cs-1",
        "channel": "voice",
        "language": "te-IN",
        "transcript": "నమస్కారం",
    }


# ── History isolation ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_only_latest_user_message_is_forwarded():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200, json={"reply_text": "ok", "end_call": False, "language": "en-IN"}
        )

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="en-IN")

    ctx = _Ctx(
        [
            _Msg("user", "first utterance"),
            _Msg("assistant", "earlier reply"),
            _Msg("user", "latest utterance"),
        ]
    )
    await _collect(_agent(brain, call), ctx)
    await client.aclose()

    assert len(bodies) == 1
    assert bodies[0]["transcript"] == "latest utterance"
    # No prior history leaks into the request in any field.
    raw = json.dumps(bodies[0])
    assert "first utterance" not in raw and "earlier reply" not in raw


@pytest.mark.asyncio
async def test_empty_transcript_skips_delegation_entirely():
    def handler(request):  # pragma: no cover - must never run
        raise AssertionError("delegate_turn must not be called without a user turn")

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1")

    chunks = await _collect(_agent(brain, call), _Ctx([_Msg("assistant", "only me")]))
    await client.aclose()
    assert chunks == []


# ── Language switch ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_brain_language_switch_calls_update_options_before_reply():
    client = _client(
        lambda request: httpx.Response(
            200, json={"reply_text": "ठीक है", "end_call": False, "language": "hi-IN"}
        )
    )
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="te-IN")
    tts = FakeTTS()

    agen = _agent(brain, call, tts=tts).llm_node(_Ctx([_Msg("user", "hindi please")]), [], None)
    first = await agen.__anext__()
    # update_options must land BEFORE the reply chunk is handed to synthesis.
    assert tts.updates == [{"target_language_code": "hi-IN"}]
    assert first == "ठीक है"
    assert call.language == "hi-IN"
    await agen.aclose()
    await client.aclose()


@pytest.mark.asyncio
async def test_same_language_does_not_touch_tts_options():
    client = _client(
        lambda request: httpx.Response(
            200, json={"reply_text": "same", "end_call": False, "language": "te-IN"}
        )
    )
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="te-IN")
    tts = FakeTTS()

    await _collect(_agent(brain, call, tts=tts), _Ctx([_Msg("user", "hi")]))
    await client.aclose()
    assert tts.updates == []


# ── end_call handling ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_end_call_true_signals_shutdown_once_after_yield():
    client = _client(
        lambda request: httpx.Response(
            200, json={"reply_text": "bye now", "end_call": True, "language": "en-IN"}
        )
    )
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="en-IN")
    ends = []
    agent = _agent(brain, call, on_end_call=lambda: ends.append(1))

    agen = agent.llm_node(_Ctx([_Msg("user", "goodbye")]), [], None)
    assert await agen.__anext__() == "bye now"
    assert ends == []  # not signaled until AFTER the reply chunk is out
    with pytest.raises(StopAsyncIteration):
        await agen.__anext__()
    assert ends == [1]
    assert call.end_requested is True
    assert call.failed is False

    # A second end_call decision must not re-fire the shutdown path.
    await _collect(agent, _Ctx([_Msg("user", "still there?")]))
    await client.aclose()
    assert ends == [1]


@pytest.mark.asyncio
async def test_empty_reply_stays_silent_and_keeps_call_open():
    # The brain returns reply_text:"" when the conversation is in human mode /
    # AI is disabled — the worker must not speak and must not end the call.
    client = _client(
        lambda request: httpx.Response(
            200, json={"reply_text": "", "end_call": False, "language": "en-IN"}
        )
    )
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="en-IN")

    chunks = await _collect(_agent(brain, call), _Ctx([_Msg("user", "hello?")]))
    await client.aclose()
    assert chunks == []
    assert call.end_requested is False and call.failed is False


# ── Delegate failure path ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_delegate_timeout_yields_static_apology_ends_call_no_retry():
    attempts = []

    def handler(request):
        attempts.append(1)
        raise httpx.TimeoutException("timed out", request=request)

    client = _client(handler)
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="te-IN")
    ends = []

    chunks = await _collect(
        _agent(brain, call, on_end_call=lambda: ends.append(1)),
        _Ctx([_Msg("user", "నమస్కారం")]),
    )
    await client.aclose()

    assert chunks == [APOLOGIES["te-IN"]]  # the static constant, verbatim
    assert call.failed is True and call.end_requested is True
    assert ends == [1]
    assert len(attempts) == 1  # exactly one HTTP attempt — no retry storm


@pytest.mark.asyncio
async def test_delegate_http_error_speaks_apology_in_current_language():
    client = _client(lambda request: httpx.Response(500, text="boom"))
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language="hi-IN")

    chunks = await _collect(_agent(brain, call), _Ctx([_Msg("user", "hello")]))
    await client.aclose()
    assert chunks == [APOLOGIES["hi-IN"]]
    assert call.failed is True


def test_apology_falls_back_to_default_language_for_unknown_codes():
    assert apology_for("te-IN") == APOLOGIES["te-IN"]
    assert apology_for("fr-FR") in APOLOGIES.values()
    assert apology_for(None) in APOLOGIES.values()
