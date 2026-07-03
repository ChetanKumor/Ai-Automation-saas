"""Unit tests for the PR9C SSE turn-streaming path (VOICE_STREAM_TURNS=true).

Hermetic: the SSE wire is served by httpx.MockTransport over a custom byte
stream, through the REAL BrainClient.stream_turn — so the opt-in (accept header
+ body flag), HMAC over the exact bytes, SSE parsing, timeouts, and stream
closure on barge-in are all asserted end-to-end. llm_node is driven directly,
as the pipeline drives it.
"""

import asyncio
import hashlib
import hmac as hmac_mod
import json

import httpx
import pytest
from livekit.agents import FlushSentinel

from agent import APOLOGIES, BrainAgent, CallState
from brain_client import BrainClient, BrainError

SECRET = "s3cr3t-shared"


def sse(event, data) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


class SSEByteStream(httpx.AsyncByteStream):
    """Scripted response body: yields chunks (optionally slowly), can raise a
    transport error mid-stream, and records aclose() — the barge-in assert."""

    def __init__(self, chunks, *, error_after=False, drip_delay=0.0):
        self._chunks = list(chunks)
        self._error_after = error_after
        self._drip_delay = drip_delay
        self.closed = False

    async def __aiter__(self):
        for i, chunk in enumerate(self._chunks):
            if self._drip_delay and i > 0:  # first chunk arrives immediately
                await asyncio.sleep(self._drip_delay)
            yield chunk
        if self._error_after:
            raise httpx.ReadError("mid-stream transport error")

    async def aclose(self):
        self.closed = True


class FakeTTS:
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


def _make(handler, *, language="te-IN", on_end_call=None, tts=None):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    call = CallState(call_session_id="cs-1", language=language)
    agent = BrainAgent(brain=brain, call=call, tts=tts or FakeTTS(), on_end_call=on_end_call)
    return client, brain, call, agent


def _sse_response(stream):
    return httpx.Response(
        200, stream=stream, headers={"content-type": "text/event-stream"}
    )


async def _collect(agent, ctx):
    return [chunk async for chunk in agent.llm_node(ctx, [], None)]


@pytest.fixture(autouse=True)
def stream_flag(monkeypatch):
    monkeypatch.setenv("VOICE_STREAM_TURNS", "true")


# ── (1) happy path: ack + deltas verbatim, done handled ──────────────────────
@pytest.mark.asyncio
async def test_tool_turn_yields_ack_flush_then_deltas_verbatim():
    seen = {}
    body = SSEByteStream([
        sse("ack", {"text": "ఒక్క నిమిషం, చూస్తున్నాను.", "language": "te-IN"}),
        sse("delta", {"text": "రేపు పది "}),
        sse("delta", {"text": "గంటలకు బుక్ అయింది."}),
        sse("done", {"reply_text": "రేపు పది గంటలకు బుక్ అయింది.", "end_call": False, "language": "te-IN"}),
    ])

    def handler(request):
        seen["accept"] = request.headers.get("accept")
        seen["body"] = json.loads(request.content)
        expected = (
            "sha256="
            + hmac_mod.new(SECRET.encode(), request.content, hashlib.sha256).hexdigest()
        )
        seen["sig_ok"] = request.headers.get("x-internal-signature") == expected
        return _sse_response(body)

    client, _, call, agent = _make(handler)
    ends = []
    agent._on_end_call = lambda: ends.append(1)

    chunks = await _collect(agent, _Ctx([_Msg("user", "రేపు అపాయింట్‌మెంట్")]))
    await client.aclose()

    # Ack first, then a FlushSentinel (ends the TTS segment so the ack is
    # spoken IMMEDIATELY), then each delta verbatim.
    assert chunks[0] == "ఒక్క నిమిషం, చూస్తున్నాను."
    assert isinstance(chunks[1], FlushSentinel)
    assert chunks[2:] == ["రేపు పది ", "గంటలకు బుక్ అయింది."]

    # Opt-in is belt and braces: header AND signed body flag.
    assert seen["accept"] == "text/event-stream"
    assert seen["sig_ok"] is True
    assert seen["body"] == {
        "call_session_id": "cs-1",
        "channel": "voice",
        "language": "te-IN",
        "transcript": "రేపు అపాయింట్‌మెంట్",
        "stream": True,
    }
    assert ends == []  # done had end_call:false
    assert call.failed is False and call.end_requested is False


@pytest.mark.asyncio
async def test_plain_turn_no_ack_no_flush_sentinel():
    body = SSEByteStream([
        sse("delta", {"text": "We open "}),
        sse("delta", {"text": "at nine."}),
        sse("done", {"reply_text": "We open at nine.", "end_call": False, "language": "en-IN"}),
    ])
    client, _, _, agent = _make(lambda request: _sse_response(body), language="en-IN")

    chunks = await _collect(agent, _Ctx([_Msg("user", "hours?")]))
    await client.aclose()
    assert chunks == ["We open ", "at nine."]  # no ack, no sentinel


@pytest.mark.asyncio
async def test_done_end_call_signals_drain_path_exactly_once():
    body = SSEByteStream([
        sse("delta", {"text": "Bye now."}),
        sse("done", {"reply_text": "Bye now.", "end_call": True, "language": "en-IN"}),
    ])
    ends = []
    client, _, call, agent = _make(
        lambda request: _sse_response(body), language="en-IN", on_end_call=lambda: ends.append(1)
    )

    agen = agent.llm_node(_Ctx([_Msg("user", "goodbye")]), [], None)
    assert await agen.__anext__() == "Bye now."
    assert ends == []  # not before the reply chunk is out
    with pytest.raises(StopAsyncIteration):
        await agen.__anext__()
    await client.aclose()
    assert ends == [1]
    assert call.end_requested is True and call.failed is False


@pytest.mark.asyncio
async def test_done_language_change_updates_state_for_next_turn():
    body = SSEByteStream([
        sse("delta", {"text": "ठीक है"}),
        sse("done", {"reply_text": "ठीक है", "end_call": False, "language": "hi-IN"}),
    ])
    tts = FakeTTS()
    client, _, call, agent = _make(lambda request: _sse_response(body), language="te-IN", tts=tts)

    chunks = await _collect(agent, _Ctx([_Msg("user", "hindi please")]))
    await client.aclose()
    assert chunks == ["ठीक है"]
    # Mid-stream switching is NOT supported: this turn already synthesized in
    # te-IN; the change lands on CallState + TTS options for the NEXT turn.
    assert call.language == "hi-IN"
    assert tts.updates == [{"target_language_code": "hi-IN"}]


# ── (2) barge-in: generator close closes the HTTP stream ─────────────────────
@pytest.mark.asyncio
async def test_barge_in_generator_close_closes_http_stream():
    body = SSEByteStream(
        [
            sse("ack", {"text": "One moment.", "language": "en-IN"}),
            sse("delta", {"text": "never spoken"}),
        ],
        drip_delay=30.0,  # the delta would only arrive far in the future
    )
    client, _, call, agent = _make(lambda request: _sse_response(body), language="en-IN")

    agen = agent.llm_node(_Ctx([_Msg("user", "book it")]), [], None)
    assert await agen.__anext__() == "One moment."
    assert isinstance(await agen.__anext__(), FlushSentinel)

    await agen.aclose()  # what the framework does on interruption
    await client.aclose()

    assert body.closed is True  # HTTP stream closed -> Node's disconnect abort fires
    assert call.failed is False  # barge-in is not a failure


# ── (3) mid-stream transport error after the ack: apology, never silence ─────
@pytest.mark.asyncio
async def test_mid_stream_transport_error_after_ack_yields_apology_and_ends():
    body = SSEByteStream(
        [
            sse("ack", {"text": "ఒక్క నిమిషం, చూస్తున్నాను.", "language": "te-IN"}),
            sse("delta", {"text": "రేపు "}),
        ],
        error_after=True,  # connection dies before done
    )
    ends = []
    client, _, call, agent = _make(
        lambda request: _sse_response(body), on_end_call=lambda: ends.append(1)
    )

    chunks = await _collect(agent, _Ctx([_Msg("user", "బుక్ చేయండి")]))
    await client.aclose()

    assert chunks[0] == "ఒక్క నిమిషం, చూస్తున్నాను."
    assert isinstance(chunks[1], FlushSentinel)
    assert chunks[2] == "రేపు "
    assert chunks[3] == APOLOGIES["te-IN"]  # static apology, verbatim
    assert call.failed is True and call.end_requested is True
    assert ends == [1]


@pytest.mark.asyncio
async def test_stream_ending_without_done_is_an_error_apology():
    body = SSEByteStream([sse("delta", {"text": "half a reply "})])  # then clean EOF
    client, _, call, agent = _make(lambda request: _sse_response(body), language="hi-IN")

    chunks = await _collect(agent, _Ctx([_Msg("user", "नमस्ते")]))
    await client.aclose()
    assert chunks == ["half a reply ", APOLOGIES["hi-IN"]]
    assert call.failed is True


@pytest.mark.asyncio
async def test_http_error_status_before_events_yields_apology():
    client, _, call, agent = _make(lambda request: httpx.Response(500, text="boom"))
    chunks = await _collect(agent, _Ctx([_Msg("user", "hello")]))
    await client.aclose()
    assert chunks == [APOLOGIES["te-IN"]]
    assert call.failed is True


# ── (4) timeouts ──────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_per_chunk_read_timeout_uses_voice_turn_timeout():
    seen = {}
    body = SSEByteStream([
        sse("done", {"reply_text": "", "end_call": False, "language": "en-IN"}),
    ])

    def handler(request):
        seen["timeout"] = request.extensions.get("timeout")
        return _sse_response(body)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    brain = BrainClient("http://brain:3000", SECRET, timeout=7.5, client=client)
    call = CallState(call_session_id="cs-1", language="en-IN")
    agent = BrainAgent(brain=brain, call=call, tts=FakeTTS())

    await _collect(agent, _Ctx([_Msg("user", "hi")]))
    await client.aclose()

    # The read timeout is PER CHUNK (a stalled stream trips it between reads),
    # not a whole-body budget.
    assert seen["timeout"]["read"] == 7.5


@pytest.mark.asyncio
async def test_overall_hard_cap_voice_turn_max_s(monkeypatch):
    monkeypatch.setenv("VOICE_TURN_MAX_S", "0.05")
    body = SSEByteStream(
        [sse("delta", {"text": f"chunk {i} "}) for i in range(50)],  # never done
        drip_delay=0.02,
    )
    client, _, call, agent = _make(lambda request: _sse_response(body), language="en-IN")

    chunks = await _collect(agent, _Ctx([_Msg("user", "talk forever")]))
    await client.aclose()

    assert chunks[-1] == APOLOGIES["en-IN"]  # capped -> apology, call ends
    assert call.failed is True
    assert len(chunks) < 50  # it really was cut short


# ── (5) flag off: the JSON path is byte-identical (delegate_turn, one chunk) ──
@pytest.mark.asyncio
async def test_flag_off_uses_json_delegate_path(monkeypatch):
    monkeypatch.setenv("VOICE_STREAM_TURNS", "false")
    seen = {}

    def handler(request):
        seen["accept"] = request.headers.get("accept")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"reply_text": "నమస్తే!", "end_call": False, "language": "te-IN"}
        )

    client, _, _, agent = _make(handler)
    chunks = await _collect(agent, _Ctx([_Msg("user", "నమస్కారం")]))
    await client.aclose()

    assert chunks == ["నమస్తే!"]  # single chunk, no sentinel
    assert "stream" not in seen["body"]  # body identical to the pre-PR contract
    assert seen["accept"] != "text/event-stream"
