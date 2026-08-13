"""The tts_node override and the two guards the private assignment rests on.

Issue 41 installs a sentence tokenizer by assigning to `TTS._opts.word_tokenizer`
— a private attribute of the Sarvam plugin, because `TTS.__init__` accepts no
`word_tokenizer` argument and overwrites the field at sarvam/tts.py:549. That is
an accepted cost with one condition: it must not be able to fail SILENTLY. Two
ways it could, and one test for each:

  GUARD A  the field disappears on a plugin bump. A dataclass instance takes an
           unknown attribute without complaint, so the assignment would keep
           succeeding while nothing read it, and Hindi would stop segmenting
           with the whole suite green.
  GUARD B  the assignment stops surviving `update_options()`. It survives today
           because `SynthesizeStream.__init__` copies with `replace(tts._opts)`
           and `update_options` mutates fields in place — a property of the
           plugin, not a guarantee. If it ever stops, the fix dies exactly when
           a caller switches language mid-call: the worst moment, and the least
           likely to be noticed.

Both name the version they were measured against in their failure message, so
the next reader gets "measured against X, you are on Y" rather than a bare
assertion error.
"""

import importlib.metadata

import pytest
from livekit.agents.tokenize import basic
from livekit.plugins.sarvam import tts as sarvam_tts

from agent import (
    DANDA_TOKENIZER,
    TOKENIZER_FIELD,
    BrainAgent,
    CallState,
    build_tts,
    install_danda_tokenizer,
)
from danda_tokenizer import DandaSentenceTokenizer

# The plugin version every measurement in Issue 41 was taken against.
MEASURED_VERSION = "1.6.4"
INSTALLED_VERSION = importlib.metadata.version("livekit-plugins-sarvam")

VERSIONS = f"measured against livekit-plugins-sarvam {MEASURED_VERSION}, you are on {INSTALLED_VERSION}"


@pytest.fixture
def real_tts(monkeypatch):
    """A real `sarvam.TTS`. Construction makes no network call; the key is set
    here rather than read from the environment so the verdict cannot depend on a
    developer's gitignored .env (the V1a-R1 lesson)."""
    monkeypatch.setenv("SARVAM_API_KEY", "test-key-not-used")
    return sarvam_tts.TTS(
        model="bulbul:v3", speaker="shubh",
        target_language_code="hi-IN", api_key="test-key-not-used",
    )


# ── GUARD A — the field must exist, and must be checked before it is written ──


def test_guard_a_the_plugin_still_declares_the_tokenizer_field():
    fields = sarvam_tts.SarvamTTSOptions.__dataclass_fields__
    assert TOKENIZER_FIELD in fields, (
        f"SarvamTTSOptions no longer declares {TOKENIZER_FIELD!r} — the Issue 41 "
        f"assignment now writes an attribute nothing reads, and Hindi has stopped "
        f"segmenting incrementally with every test green. {VERSIONS}"
    )


def test_guard_a_the_field_is_the_one_the_plugin_actually_reads(real_tts):
    # Naming a field that exists is not enough; it has to be the field the
    # plugin consults. __init__ populating it with the stock tokenizer is the
    # evidence that this is the seam and not a lookalike.
    assert type(getattr(real_tts._opts, TOKENIZER_FIELD)) is not DandaSentenceTokenizer
    assert install_danda_tokenizer(real_tts) is True
    assert getattr(real_tts._opts, TOKENIZER_FIELD) is DANDA_TOKENIZER


def test_guard_a_a_missing_field_is_refused_not_silently_created():
    """THE guard. Without the existence check the assignment succeeds against
    options that never declared the field, and the failure is invisible."""
    from dataclasses import dataclass

    @dataclass
    class OptionsWithoutTheField:
        target_language_code: str = "hi-IN"

    class FutureTTS:
        def __init__(self):
            self._opts = OptionsWithoutTheField()

    tts = FutureTTS()

    assert install_danda_tokenizer(tts) is False, (
        f"the installer accepted options that do not declare {TOKENIZER_FIELD!r}; "
        f"a dataclass takes an unknown attribute silently, so this is the exact "
        f"shape of a fix that evaporates without a red test. {VERSIONS}"
    )
    assert not hasattr(tts._opts, TOKENIZER_FIELD), (
        "the installer created the attribute anyway — the check ran but did not gate the write"
    )


def test_guard_a_an_unrecognisable_tts_is_refused_rather_than_raising():
    # This runs at synthesis time; an exception here is dead air on a live call.
    class NotATTS:
        pass

    assert install_danda_tokenizer(NotATTS()) is False


# ── GUARD B — the assignment must survive a mid-call language switch ──────────


def survives_update_options(tts) -> bool:
    """Install, switch language the way `_switch_tts_language` does, and report
    whether the tokenizer is still ours. Shared by the guard and its control, so
    the control proves this function is capable of returning False."""
    install_danda_tokenizer(tts)
    tts.update_options(target_language_code="en-IN")
    return getattr(tts._opts, TOKENIZER_FIELD, None) is DANDA_TOKENIZER


def test_guard_b_the_tokenizer_survives_a_mid_call_language_switch(real_tts):
    assert survives_update_options(real_tts) is True, (
        "update_options() no longer preserves the tokenizer — Issue 41's fix now "
        f"dies precisely when a caller switches to Hindi mid-call. {VERSIONS}"
    )
    # and the switch really happened, so the assertion above is not passing
    # because update_options did nothing
    assert str(real_tts._opts.target_language_code) == "en-IN"


def test_guard_b_the_check_detects_a_plugin_that_rebuilds_its_options():
    """The control arm. A guard that has never been shown to fail is a guard
    nobody has measured — this is the plugin shape guard B exists to catch."""
    from dataclasses import dataclass, replace

    @dataclass
    class Options:
        target_language_code: str = "hi-IN"
        word_tokenizer: object = None

    class RebuildingTTS:
        """update_options() replaces _opts from a pristine template, dropping
        anything assigned onto the live instance."""

        def __init__(self):
            self._template = Options()
            self._opts = replace(self._template)

        def update_options(self, *, target_language_code):
            self._opts = replace(self._template, target_language_code=target_language_code)

    assert survives_update_options(RebuildingTTS()) is False, (
        "the survival check cannot fail, so guard B proves nothing"
    )


async def test_guard_b_the_installed_tokenizer_reaches_a_new_synthesis_stream(real_tts):
    # The end of the mechanism: SynthesizeStream copies with replace(tts._opts)
    # (sarvam/tts.py:968) and _tokenize_input reads _opts.word_tokenizer
    # (:1004-1008). Assert the copy actually carries it, after a switch.
    install_danda_tokenizer(real_tts)
    real_tts.update_options(target_language_code="hi-IN")

    stream = real_tts.stream()
    try:
        assert getattr(stream._opts, TOKENIZER_FIELD) is DANDA_TOKENIZER
    finally:
        await stream.aclose()


# ── The override itself ──────────────────────────────────────────────────────


class FakeTTS:
    """Mirrors test_agent_stream.py's stand-in: no `_opts`, like the fakes the
    rest of the suite hands to BrainAgent."""

    def __init__(self):
        self.updates = []

    def update_options(self, **kwargs):
        self.updates.append(kwargs)


def _agent(tts):
    return BrainAgent(brain=None, call=CallState(call_session_id="cs-1"), tts=tts)


async def _empty_text():
    return
    yield  # pragma: no cover — makes this an async generator


async def _advance(agent):
    """Run `tts_node`'s body, then let it fail on the absent AgentActivity.

    There is no AgentSession here, so `Agent.default.tts_node` raises
    RuntimeError at `agent.py:412-415`. That is the point: the install is the
    first statement of the override, ahead of the delegation, so reaching the
    RuntimeError proves the body ran without asserting on framework internals.
    """
    node = agent.tts_node(_empty_text(), None)
    with pytest.raises(RuntimeError, match="not running"):
        await node.__anext__()


async def test_tts_node_installs_the_tokenizer_on_the_calls_tts(real_tts):
    agent = _agent(real_tts)
    assert type(getattr(real_tts._opts, TOKENIZER_FIELD)) is not DandaSentenceTokenizer

    await _advance(agent)

    assert getattr(real_tts._opts, TOKENIZER_FIELD) is DANDA_TOKENIZER


async def test_a_tts_without_the_field_warns_once_and_never_raises(caplog):
    # The real override, driven three times — not a re-implementation of it.
    agent = _agent(FakeTTS())

    with caplog.at_level("WARNING", logger="voice-agent"):
        for _ in range(3):
            await _advance(agent)

    warned = [r for r in caplog.records if "danda sentence tokenizer not installed" in r.getMessage()]
    assert len(warned) == 1, "the warning must fire once per call, not once per segment"
    assert "FakeTTS" in warned[0].getMessage()
    assert agent._tokenizer_warned is True


def test_build_tts_does_not_install_the_tokenizer(monkeypatch):
    """Placement is load-bearing, so it is asserted rather than assumed.

    Installing at construction would raise AttributeError across
    test_greeting.py's `fake_tts` suite and test_agent_stream.py's `FakeTTS`,
    both of which stand in for the plugin with objects that have no `_opts`.
    The seam is `tts_node`, and only `tts_node`. Written against the literal
    field name, not TOKENIZER_FIELD, so it keeps measuring build_tts rather
    than the constant.
    """
    monkeypatch.setenv("SARVAM_API_KEY", "test-key-not-used")

    tts = build_tts("hi-IN")

    assert type(tts._opts.word_tokenizer) is basic.SentenceTokenizer, (
        "build_tts installed a tokenizer — move it back to tts_node, or the "
        "greeting and stream suites break on their _opts-less fakes"
    )
