"""The worker's per-turn latency line.

Hermetic and deterministic: no network (httpx.MockTransport), no room, no
AgentSession, no sleeps. A scripted turn is driven through the SAME harness the
shim tests use, and the framework events that turn would produce are then
constructed from the REAL livekit-agents types — `llm.ChatMessage` carrying a
`MetricsReport` — so the field names are pinned to the installed library rather
than to a hand-rolled stub. If an upgrade renames `llm_node_ttft` or moves the
report off ChatMessage, these tests go red, which is the point.

Why ChatMessage and not the `metrics_collected` event: see the block comment
above TURN_METRICS_EVENT in agent.py. Short version — on this wiring LLMMetrics
is never emitted at all (llm_node is overridden, BrainStubLLM.chat never runs),
and `llm_node_ttft` on the assistant message is the only carrier of the number.
"""

import logging

import httpx
import pytest
from livekit.agents import llm
from livekit.agents.voice.events import ConversationItemAddedEvent

from agent import (
    TURN_METRICS_EVENT,
    BrainAgent,
    CallState,
    build_turn_metrics,
    turn_metrics_listener,
)
from brain_client import BrainClient
from test_agent_shim import SECRET, FakeTTS, _Ctx, _Msg, _client

# Stage timings in SECONDS, as MetricsReport declares them. Realistic for a
# voice turn and deliberately ordered: the caller stops speaking, the final
# transcript lands, the turn commits, the brain's first chunk arrives, the first
# audio byte follows — all inside e2e.
USER_LEG = {"transcription_delay": 0.180, "end_of_turn_delay": 0.250}
AGENT_LEG = {"llm_node_ttft": 0.640, "tts_node_ttfb": 0.310, "e2e_latency": 1.290}

TIMING_FIELDS = ("stt_final_ms", "eou_delay_ms", "llm_ttft_ms", "tts_ttfb_ms", "e2e_ms")


def _user_item(metrics=None):
    return ConversationItemAddedEvent(
        item=llm.ChatMessage(role="user", content=["నాకు అపాయింట్‌మెంట్ కావాలి"],
                             metrics=USER_LEG if metrics is None else metrics)
    )


def _agent_item(text, metrics=None):
    return ConversationItemAddedEvent(
        item=llm.ChatMessage(role="assistant", content=[text],
                             metrics=AGENT_LEG if metrics is None else metrics)
    )


def _lines(caplog):
    return [r.turn_metrics for r in caplog.records if r.msg == TURN_METRICS_EVENT]


async def _scripted_turn(call, reply, *, tts=None):
    """One real turn through the shim: BrainAgent.llm_node over MockTransport."""
    client = _client(
        lambda request: httpx.Response(
            200, json={"reply_text": reply, "end_call": False, "language": call.language}
        )
    )
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    agent = BrainAgent(brain=brain, call=call, tts=tts or FakeTTS())
    chunks = [c async for c in agent.llm_node(_Ctx([_Msg("user", "hi")]), [], None)]
    await client.aclose()
    return chunks


@pytest.fixture(autouse=True)
def _json_turn_path(monkeypatch, caplog):
    # agent.py calls load_dotenv() at import, and a developer's voice-agent/.env
    # may set VOICE_STREAM_TURNS. Pin the path so the scripted turn is the same
    # on every machine.
    monkeypatch.setenv("VOICE_STREAM_TURNS", "false")
    caplog.set_level(logging.INFO, logger="voice-agent")


# ── One line per turn, fields present, monotonically ordered ─────────────────
@pytest.mark.asyncio
async def test_scripted_turn_emits_exactly_one_ordered_metrics_line(caplog):
    call = CallState(call_session_id="cs-42", correlation_id="voi_abc123", language="te-IN")
    on_item = turn_metrics_listener(call)

    chunks = await _scripted_turn(call, "రేపు పదకొండు గంటలకు ఖాళీ ఉంది.")
    assert chunks == ["రేపు పదకొండు గంటలకు ఖాళీ ఉంది."]

    # The two items the framework adds for that turn, in the order it adds them:
    # the user message carries the endpoint/STT leg, the assistant message the
    # llm/tts leg (agent_activity.py:2806-2810 then :3028-3038).
    on_item(_user_item())
    assert _lines(caplog) == []  # the user leg alone must NOT emit
    on_item(_agent_item(chunks[0]))

    lines = _lines(caplog)
    assert len(lines) == 1  # exactly one line per turn
    line = lines[0]

    assert line["call_session_id"] == "cs-42"
    assert line["correlation_id"] == "voi_abc123"  # Issue 21 chain id, not a fresh one
    assert line["turn"] == 1
    assert line["language"] == "te-IN"

    for name in TIMING_FIELDS:
        assert line[name] is not None, f"{name} missing from the metrics line"

    # Monotonic on one timeline: both user-leg values are offsets from the same
    # anchor (the caller's last speaking time), and the agent stages nest inside
    # end-to-end latency.
    assert line["stt_final_ms"] <= line["eou_delay_ms"]
    assert line["eou_delay_ms"] <= line["e2e_ms"]
    assert line["eou_delay_ms"] + line["llm_ttft_ms"] + line["tts_ttfb_ms"] <= line["e2e_ms"]

    # Seconds → milliseconds, not passed through raw.
    assert line["eou_delay_ms"] == 250.0
    assert line["llm_ttft_ms"] == 640.0


@pytest.mark.asyncio
async def test_second_turn_emits_its_own_line_with_the_next_index(caplog):
    call = CallState(call_session_id="cs-42", correlation_id="voi_abc123", language="te-IN")
    on_item = turn_metrics_listener(call)

    for reply in ("మొదటి బదులు", "రెండవ బదులు"):
        chunks = await _scripted_turn(call, reply)
        on_item(_user_item())
        on_item(_agent_item(chunks[0]))

    lines = _lines(caplog)
    assert len(lines) == 2  # one per turn, not one per item
    assert [line["turn"] for line in lines] == [1, 2]
    assert {line["correlation_id"] for line in lines} == {"voi_abc123"}


# ── The metrics never arrive ─────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_turn_completes_normally_when_the_metrics_event_never_fires(caplog):
    """The listener is registered but the framework emits nothing — the turn must
    still delegate, yield its reply and switch language exactly as before."""
    call = CallState(call_session_id="cs-77", correlation_id="voi_zzz", language="te-IN")
    turn_metrics_listener(call)  # registered, never invoked
    tts = FakeTTS()

    client = _client(
        lambda request: httpx.Response(
            200, json={"reply_text": "ठीक है", "end_call": False, "language": "hi-IN"}
        )
    )
    brain = BrainClient("http://brain:3000", SECRET, client=client)
    agent = BrainAgent(brain=brain, call=call, tts=tts)
    chunks = [c async for c in agent.llm_node(_Ctx([_Msg("user", "hindi please")]), [], None)]
    await client.aclose()

    assert chunks == ["ठीक है"]
    assert call.language == "hi-IN"
    assert tts.updates == [{"target_language_code": "hi-IN"}]
    assert call.end_requested is False and call.failed is False
    assert _lines(caplog) == []
    assert call.turn_index == 0  # nothing observed, nothing counted


# ── Absent / malformed metrics degrade to nulls, never to an exception ───────
@pytest.mark.asyncio
async def test_assistant_item_with_no_metrics_logs_nulls_not_an_exception(caplog):
    call = CallState(call_session_id="cs-1", correlation_id="voi_1", language="en-IN")
    on_item = turn_metrics_listener(call)

    chunks = await _scripted_turn(call, "Sure, tomorrow at eleven.")
    # A ChatMessage built with no metrics at all — the default is {} (chat_context.py:324).
    on_item(_agent_item(chunks[0], metrics={}))

    lines = _lines(caplog)
    assert len(lines) == 1
    assert all(lines[0][name] is None for name in TIMING_FIELDS)
    assert lines[0]["turn"] == 1  # the turn still counted
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


@pytest.mark.asyncio
async def test_non_finite_values_survive_the_carrier_and_degrade_to_null(caplog):
    """`MetricsReport` is pydantic-validated on ChatMessage, and NaN/inf are the
    malformed values that pass that validation (measured: None is rejected,
    "0.18" and True are coerced, unknown keys are dropped — NaN and inf are
    stored verbatim). They are also the dangerous ones: a NaN in the line poisons
    every downstream average silently. Each field degrades on its own."""
    call = CallState(call_session_id="cs-1", correlation_id="voi_1", language="en-IN")
    on_item = turn_metrics_listener(call)

    on_item(_user_item(metrics={"transcription_delay": float("nan"),
                                "end_of_turn_delay": 0.25}))
    on_item(_agent_item("ok", metrics={"llm_node_ttft": float("inf"),
                                       "e2e_latency": 1.29}))

    line = _lines(caplog)[0]
    assert line["stt_final_ms"] is None     # NaN is not a duration
    assert line["eou_delay_ms"] == 250.0    # its healthy sibling still lands
    assert line["llm_ttft_ms"] is None      # nor is an infinity
    assert line["tts_ttfb_ms"] is None      # key absent — dropped by validation
    assert line["e2e_ms"] == 1290.0
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_values_that_only_a_non_chatmessage_carrier_can_deliver_degrade_too():
    """`getattr(item, "metrics", None)` is None for an item that is not a
    ChatMessage, and a future version could carry an unvalidated dict — so the
    reader is tested directly against what pydantic would have refused."""
    call = CallState(call_session_id="cs-1", correlation_id="voi_1")

    payload = build_turn_metrics(
        call, 1,
        {"transcription_delay": None, "end_of_turn_delay": "0.25"},
        {"llm_node_ttft": True, "tts_node_ttfb": object(), "e2e_latency": 1.29},
    )
    assert payload["stt_final_ms"] is None   # None is not a duration
    assert payload["eou_delay_ms"] is None   # nor is a string, unconverted
    assert payload["llm_ttft_ms"] is None    # nor is a bool, though bool is an int
    assert payload["tts_ttfb_ms"] is None
    assert payload["e2e_ms"] == 1290.0

    # No carrier at all — every timing is null and nothing raises.
    absent = build_turn_metrics(call, 2, None, None)
    assert all(absent[name] is None for name in TIMING_FIELDS)


def test_listener_never_raises_on_a_hostile_event(caplog):
    """rtc.EventEmitter.emit swallows Exception but RE-RAISES TypeError, and this
    handler runs inside the reply task — so it must swallow everything itself."""
    call = CallState(call_session_id="cs-1", correlation_id="voi_1")
    on_item = turn_metrics_listener(call)

    class _Exploding:
        @property
        def item(self):
            raise TypeError("boom")

    for event in (object(), None, _Exploding(), ConversationItemAddedEvent(
        item=llm.ChatMessage(role="system", content=["not a turn"])
    )):
        on_item(event)  # must not raise

    assert _lines(caplog) == []  # and must not invent a turn
    assert call.turn_index == 0


def test_build_turn_metrics_is_pure_and_carries_the_identity_fields():
    call = CallState(call_session_id="cs-9", correlation_id="voi_9", language="hi-IN")
    payload = build_turn_metrics(call, 3, USER_LEG, AGENT_LEG)

    assert payload == {
        "call_session_id": "cs-9",
        "correlation_id": "voi_9",
        "turn": 3,
        "language": "hi-IN",
        "stt_final_ms": 180.0,
        "eou_delay_ms": 250.0,
        "llm_ttft_ms": 640.0,
        "tts_ttfb_ms": 310.0,
        "e2e_ms": 1290.0,
    }
    assert call.turn_index == 0  # pure: builds, counts nothing


def test_missing_correlation_id_still_produces_a_keyed_line():
    """Deploy skew: an older brain returns no correlation_id (agent.py warns).
    The line must still identify the turn by call_session_id + index."""
    call = CallState(call_session_id="cs-old", correlation_id=None)
    payload = build_turn_metrics(call, 1, USER_LEG, AGENT_LEG)

    assert payload["correlation_id"] is None
    assert payload["call_session_id"] == "cs-old" and payload["turn"] == 1
