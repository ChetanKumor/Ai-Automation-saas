"""The greeting spoken on join (V1c).

Hermetic: no network, no room, no AgentSession. `speak_greeting` is a plain
function over the `/call/start` response and the session, extracted from
`entrypoint()` for exactly this reason — the same move `turn_metrics_listener`
made, and for the same reason: `entrypoint()` needs a LiveKit job context and no
test calls it.

Two properties are under test, and the second one is the fragile one:

  1. WHAT IS SPOKEN. Once, with the brain's string, verbatim — the worker never
     authors or edits greeting text, the same rule the apology table follows in
     reverse. An empty or absent greeting means say nothing and carry on, which
     is also the deploy-skew path (an older brain returns no `greeting` key).

  2. `add_to_chat_ctx=False`, and what it does NOT cost. It keeps the greeting
     out of the chat context, and therefore out of `conversation_item_added` and
     out of the per-turn metrics line. Without it the greeting emits a turn-1
     line with null stt/eou/llm fields and shifts every real turn's index by one.
     But the caller must still HEAR it and the room must still get the
     transcript — those are forwarded before the flag is consulted, and that
     ordering lives in the installed library, not in our code. So it is pinned
     against the installed library here: a version bump that moved transcript
     forwarding behind `add_to_chat_ctx` would otherwise silence the greeting's
     transcript with every one of our own tests still green.
"""

import ast
import inspect
import textwrap

import pytest
from livekit.agents.voice import agent_activity

from agent import speak_greeting


class FakeSession:
    """Records say() calls; stands in for AgentSession."""

    def __init__(self):
        self.calls = []

    def say(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return f"handle-{len(self.calls)}"


GREETING = "నమస్తే! స్మైల్ డెంటల్ కి స్వాగతం. ఈ కాల్ రికార్డ్ చేయబడవచ్చు."


def _started(**over):
    base = {
        "call_session_id": "cs-1",
        "customer_id": "cu-1",
        "conversation_id": "co-1",
        "correlation_id": "call_abc",
        "greeting": GREETING,
    }
    base.update(over)
    return base


# ── What is spoken ───────────────────────────────────────────────────────────


def test_speaks_the_greeting_exactly_once():
    session = FakeSession()
    speak_greeting(session, _started())

    assert len(session.calls) == 1, "one join, one greeting"
    assert session.calls[0][0] == GREETING, "verbatim — the worker never edits it"


def test_returns_the_speech_handle():
    # entrypoint() discards it today, but a caller that wants to await the
    # greeting must be able to; returning None on the spoken path would make
    # "did it speak?" indistinguishable from "was there anything to speak?".
    session = FakeSession()
    assert speak_greeting(session, _started()) == "handle-1"


def test_consent_line_rides_inside_the_greeting_untouched():
    # The brain joins greeting + recording_consent into one string precisely so
    # this is ONE say(). A worker that split or trimmed it would be authoring a
    # legal-floor line.
    session = FakeSession()
    text = "Hello! Welcome to Smile Dental. This call may be recorded for quality purposes."
    speak_greeting(session, _started(greeting=text))

    assert session.calls[0][0] == text
    assert "may be recorded" in session.calls[0][0]


@pytest.mark.parametrize(
    "greeting",
    [pytest.param("", id="empty"),
     pytest.param("   ", id="whitespace"),
     pytest.param("\n\t ", id="newlines"),
     pytest.param(None, id="null")],
)
def test_empty_greeting_says_nothing(greeting):
    session = FakeSession()
    assert speak_greeting(session, _started(greeting=greeting)) is None
    assert session.calls == [], "nothing to say → say() is never called"


def test_absent_greeting_key_says_nothing():
    # Deploy skew: a brain older than V1c returns the four original fields only.
    # The call must bridge and proceed exactly as it did before this feature.
    started = _started()
    del started["greeting"]

    session = FakeSession()
    assert speak_greeting(session, started) is None
    assert session.calls == []


def test_surrounding_whitespace_is_trimmed_but_inner_text_is_not():
    session = FakeSession()
    speak_greeting(session, _started(greeting="  Hello!  Welcome.  "))
    assert session.calls[0][0] == "Hello!  Welcome."


# ── add_to_chat_ctx=False, and what it must not cost ─────────────────────────


def test_say_is_called_with_add_to_chat_ctx_false():
    # Load-bearing: True would make the greeting fire conversation_item_added
    # and emit a phantom turn-1 metrics line (see speak_greeting's docstring).
    session = FakeSession()
    speak_greeting(session, _started())

    _, kwargs = session.calls[0]
    assert kwargs.get("add_to_chat_ctx") is False


def test_greeting_is_still_forwarded_to_audio_and_transcript():
    """Pins the installed library, not our code.

    In `AgentActivity._tts_task_impl`, audio and transcript forwarding must start
    OUTSIDE any `add_to_chat_ctx` conditional — the flag may gate only the
    chat-context insert. If an upgrade moves either behind it, passing False
    would stop the caller hearing the greeting (or stop it reaching the room
    transcript) while every other test in this file still passed.

    Asserted over the AST rather than by string match so reformatting cannot
    break it and a real restructure cannot slip through.
    """
    # dedent: getsource on a method keeps its class indentation, which is not
    # parseable on its own.
    tree = ast.parse(textwrap.dedent(inspect.getsource(agent_activity.AgentActivity._tts_task_impl)))

    def gated_by_flag(node):
        """The `add_to_chat_ctx` conditions enclosing `node`, if any."""
        for parent in ast.walk(tree):
            if not isinstance(parent, ast.If):
                continue
            names = {n.id for n in ast.walk(parent.test) if isinstance(n, ast.Name)}
            if "add_to_chat_ctx" not in names:
                continue
            if any(child is node for body in (parent.body, parent.orelse) for child in ast.walk(ast.Module(body=body, type_ignores=[]))):
                return True
        return False

    calls = {
        name: [c for c in ast.walk(tree)
               if isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id == name]
        for name in ("perform_audio_forwarding", "perform_text_forwarding")
    }

    for name, found in calls.items():
        # Fail loudly if the call vanished entirely: an assertion that can no
        # longer find its subject must not pass by default.
        assert found, f"{name} not found in _tts_task_impl — the library restructured; re-verify"
        for call in found:
            assert not gated_by_flag(call), f"{name} is now gated on add_to_chat_ctx"

    # And the flag really does still gate the chat-context insert — otherwise
    # passing False buys nothing and the metrics defence is gone.
    gates = [n for n in ast.walk(tree)
             if isinstance(n, ast.If)
             and any(isinstance(x, ast.Name) and x.id == "add_to_chat_ctx" for x in ast.walk(n.test))]
    assert gates, "add_to_chat_ctx no longer gates anything in _tts_task_impl"
