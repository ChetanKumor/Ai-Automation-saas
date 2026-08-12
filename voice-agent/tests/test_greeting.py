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

import agent as agent_mod
from agent import DEFAULT_LANGUAGE, build_tts, speak_greeting


class FakeSession:
    """Records say() calls; stands in for AgentSession."""

    def __init__(self):
        self.calls = []

    def say(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return f"handle-{len(self.calls)}"


GREETING = "నమస్తే! స్మైల్ డెంటల్ కి స్వాగతం. ఈ కాల్ రికార్డ్ చేయబడవచ్చు."

# Per-language greetings, so an assertion about the language a greeting is
# SYNTHESISED in can be paired with the language its bytes are actually in. A
# test that checked the code alone would pass on exactly the bug Issue 38 fixes.
GREETINGS = {
    "te-IN": GREETING,
    "hi-IN": "नमस्ते! स्माइल डेंटल में आपका स्वागत है। यह कॉल रिकॉर्ड की जा सकती है।",
    "en-IN": "Hello! Welcome to Smile Dental. This call may be recorded.",
}


def _started(**over):
    base = {
        "call_session_id": "cs-1",
        "customer_id": "cu-1",
        "conversation_id": "co-1",
        "correlation_id": "call_abc",
        "greeting": GREETING,
        "language": "te-IN",
    }
    base.update(over)
    return base


# ── The TTS harness (Issue 38) ───────────────────────────────────────────────
#
# The FakeTTS in test_agent_shim.py records update_options only, because the
# mid-call switch is the only surface that had ever needed asserting. Issue 38
# lands at CONSTRUCTION — /call/start answers before sarvam.TTS is built
# (agent.py: call_start then build_tts, in that order), so the language is a
# constructor argument and not an update_options call. Hence a harness that
# records construction. It is an extension of the same idea, not a second one:
# update_options is recorded here too, and asserted to stay empty, because a
# greeting that needed a switch would mean the constructor argument did nothing.


class FakeTTS:
    """Records construction and update_options; stands in for sarvam.TTS."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.updates = []

    @property
    def language(self):
        return self.kwargs.get("target_language_code")

    def update_options(self, **kwargs):
        self.updates.append(kwargs)


@pytest.fixture
def fake_tts(monkeypatch):
    """Patch the plugin out; yield the list of TTS objects build_tts constructs.

    Patching the plugin rather than injecting a factory keeps the production
    signature honest: build_tts takes a language and nothing else, and no
    test-only seam exists in agent.py.
    """
    made = []

    class _Recorder(FakeTTS):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            made.append(self)

    monkeypatch.setattr(agent_mod.sarvam, "TTS", _Recorder)
    return made


# ── entrypoint()'s own precedence expression, executed ───────────────────────


def _build_tts_argument() -> ast.expr:
    """The expression entrypoint() passes to build_tts, from the SHIPPED source.

    Read out of the source rather than restated in the test, so the precedence
    tests below cannot drift from the line that actually runs. A mirror of the
    policy written here would go on passing after the real one changed.
    """
    tree = ast.parse(textwrap.dedent(inspect.getsource(agent_mod.entrypoint)))
    calls = [n for n in ast.walk(tree)
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
             and n.func.id == "build_tts"]
    assert len(calls) == 1, f"expected exactly one build_tts call in entrypoint, found {len(calls)}"
    assert len(calls[0].args) == 1 and not calls[0].keywords, \
        "build_tts takes one positional language argument — see its docstring"
    return calls[0].args[0]


def resolve_language(started, language_prior):
    """Run entrypoint()'s precedence expression over these inputs."""
    node = ast.Expression(body=_build_tts_argument())
    ast.fix_missing_locations(node)
    return eval(  # noqa: S307 — the source is this repository's own agent.py
        compile(node, "<entrypoint>", "eval"),
        {"DEFAULT_LANGUAGE": DEFAULT_LANGUAGE},
        {"started": started, "language_prior": language_prior},
    )


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


# ── The language it is synthesised IN (Issue 38) ─────────────────────────────
#
# V1c resolved the greeting's language in the brain and told the worker nothing
# about it, so the worker synthesised with `language_prior or DEFAULT_LANGUAGE` —
# a dev-room metadata hint or an env default. Measured that session: an English
# greeting spoken by a Telugu-configured voice. /call/start now returns the
# resolved language in the same 'te-IN' namespace the SSE done event uses, and
# the worker passes it through. It maps nothing: the brain emits the form its
# consumer needs (schema.js speakableLang), and a reverse map here is exactly
# what that boundary exists to prevent.


def test_greeting_is_synthesised_in_the_language_the_brain_resolved(fake_tts):
    # The whole point, in one test: the bytes said and the language they are
    # synthesised in come from the same /call/start response.
    started = _started(language="hi-IN", greeting=GREETINGS["hi-IN"])
    tts = build_tts(resolve_language(started, None))

    session = FakeSession()
    speak_greeting(session, started)

    assert tts.language == "hi-IN"
    assert session.calls[0][0] == GREETINGS["hi-IN"]
    assert tts.updates == [], "the constructor argument must stand on its own"
    assert fake_tts == [tts], "exactly one TTS is built for the call"


@pytest.mark.parametrize("language", ["te-IN", "hi-IN", "en-IN"])
def test_every_supported_language_reaches_the_plugin_verbatim(fake_tts, language):
    # Verbatim: the worker holds no language table and must not normalise, alias
    # or "correct" a code the brain resolved. te-IN is included deliberately —
    # it is the old hardcoded default, so a mutation that pins the language to
    # te-IN leaves this case green and reddens the other two.
    started = _started(language=language, greeting=GREETINGS[language])
    tts = build_tts(resolve_language(started, None))

    assert tts.language == language
    speak_greeting(FakeSession(), started)
    assert tts.language == language, "nothing after construction may change it"


# ── The precedence chain, as entrypoint() actually spells it ─────────────────


def test_precedence_brain_language_wins(fake_tts):
    # Even against a room prior that says otherwise: the prior is a hint about
    # the CALLER, and the greeting text is already written in the brain's
    # language. Synthesising it in the prior's language is the original bug.
    started = _started(language="hi-IN")
    assert resolve_language(started, "en-IN") == "hi-IN"
    assert build_tts(resolve_language(started, "en-IN")).language == "hi-IN"


def test_precedence_absent_brain_language_falls_back_to_the_room_prior(fake_tts):
    # Deploy skew: a brain older than this returns no `language` key at all. The
    # worker must behave exactly as it did before the field existed.
    started = _started()
    del started["language"]

    assert resolve_language(started, "hi-IN") == "hi-IN"
    assert build_tts(resolve_language(started, "hi-IN")).language == "hi-IN"


def test_precedence_both_absent_falls_back_to_the_default(fake_tts):
    # A real call has no room metadata language, so this is the ordinary path for
    # a brain that returns null — a tenant with no config row.
    started = _started(language=None)

    assert resolve_language(started, None) == DEFAULT_LANGUAGE
    assert build_tts(resolve_language(started, None)).language == DEFAULT_LANGUAGE


def test_precedence_blank_brain_language_does_not_reach_the_plugin(fake_tts, caplog):
    # '   ' is TRUTHY in Python, so the `or` chain hands it straight through and
    # only build_tts's guard stops it. sarvam.TTS.__init__ raises on a blank
    # target_language_code ("Target language code is required and cannot be
    # empty"), and that raise is at bridge time — a DROPPED CALL, which is worse
    # than the wrong-language greeting this change fixes.
    started = _started(language="   ")
    assert resolve_language(started, None) == "   ", "the chain does not filter it"

    with caplog.at_level("WARNING", logger="voice-agent"):
        tts = build_tts(resolve_language(started, None))

    assert tts.language == DEFAULT_LANGUAGE
    assert any("'   '" in r.getMessage() for r in caplog.records), \
        "the unusable value must be WARNed, naming it"


@pytest.mark.parametrize(
    "language",
    [pytest.param(123, id="int"),
     pytest.param({"code": "te-IN"}, id="dict"),
     pytest.param(["te-IN"], id="list"),
     pytest.param(True, id="bool")],
)
def test_precedence_non_string_brain_language_does_not_reach_the_plugin(fake_tts, caplog, language):
    # Same class, different arrival: a truthy non-string passes the `or` chain
    # and then dies inside the plugin on `.strip()`. The column behind this field
    # is written by an unvalidated path (A-010 / Issue 37), so "the brain always
    # sends a string" is precisely the assumption that has already been false.
    started = _started(language=language)
    assert resolve_language(started, None) is language

    with caplog.at_level("WARNING", logger="voice-agent"):
        tts = build_tts(resolve_language(started, None))

    assert tts.language == DEFAULT_LANGUAGE
    assert any(repr(language) in r.getMessage() for r in caplog.records)


def test_a_well_formed_but_unsupported_code_is_passed_through_not_second_guessed(fake_tts, caplog):
    # The worker holds no language table, so it cannot know 'ta-IN' is
    # unsupported — and inventing one would be the second convention the whole
    # boundary exists to prevent. The brain never sends this (speakableLang
    # answers null for anything undeclared, and null takes the fallback path);
    # if it ever did, the plugin is what rejects it.
    started = _started(language="ta-IN")
    with caplog.at_level("WARNING", logger="voice-agent"):
        tts = build_tts(resolve_language(started, None))

    assert tts.language == "ta-IN"
    assert caplog.records == [], "a well-formed code is not the guard's business"


def test_no_warning_on_the_ordinary_path(fake_tts, caplog):
    # The guard must be silent when nothing is wrong; a WARN on every call is a
    # WARN nobody reads.
    with caplog.at_level("WARNING", logger="voice-agent"):
        build_tts(resolve_language(_started(language="te-IN"), None))
        build_tts(resolve_language(_started(language=None), "hi-IN"))
    assert caplog.records == []


# ── The wiring, pinned against the shipped source ────────────────────────────


def test_entrypoint_builds_the_tts_from_the_brains_language_and_leaves_stt_alone():
    """Pins entrypoint(), which no test can call (it needs a LiveKit JobContext).

    Two properties, and the second is a scope guarantee rather than a feature:
    the TTS language comes from the /call/start response, and the STT language
    PRIOR is untouched by this change. STT auto-detect is what lets a caller be
    understood in a language the clinic did not predict; narrowing it to the
    greeting's language would silently undo that, and no other test in either
    suite would notice.
    """
    tree = ast.parse(textwrap.dedent(inspect.getsource(agent_mod.entrypoint)))

    # 1. The TTS is built by build_tts, and its argument reads the brain's field.
    arg = _build_tts_argument()          # asserts exactly one call, one argument
    names = {n.id for n in ast.walk(arg) if isinstance(n, ast.Name)}
    keys = {c.value for c in ast.walk(arg) if isinstance(c, ast.Constant)}
    assert "language" in keys, "the /call/start language field must be read here"
    assert "started" in names, "the language must come from the /call/start response"
    assert {"language_prior", "DEFAULT_LANGUAGE"} <= names, \
        "the pre-change fallback chain must remain behind it"

    # And sarvam.TTS is no longer constructed inline — build_tts owns the guard,
    # so a second construction site would bypass it.
    inline_tts = [n for n in ast.walk(tree)
                  if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                  and n.func.attr == "TTS"]
    assert not inline_tts, "sarvam.TTS is constructed in build_tts, not in entrypoint"

    # 2. The STT prior is exactly what it was: `language_prior or STT_AUTO_DETECT`.
    stt_calls = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and n.func.attr == "STT"]
    assert len(stt_calls) == 1, "expected exactly one sarvam.STT construction"
    language_kwarg = [k for k in stt_calls[0].keywords if k.arg == "language"]
    assert len(language_kwarg) == 1, "sarvam.STT must still be given a language prior"
    assert ast.unparse(language_kwarg[0].value) == "language_prior or STT_AUTO_DETECT", \
        "the STT language prior is out of scope for Issue 38 and must not change"
    stt_names = {n.id for n in ast.walk(stt_calls[0]) if isinstance(n, ast.Name)}
    assert "started" not in stt_names, "the brain's greeting language must not reach STT"
