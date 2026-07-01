"""Unit tests for the per-turn latency recorder (pure)."""

import pytest

from latency import STAGES, TurnLatency


def test_mark_and_full_breakdown():
    lat = TurnLatency()
    for stage in STAGES:
        lat.mark(stage)
    b = lat.breakdown()
    assert set(b) == {
        "stt_to_delegate_ms",
        "delegate_rtt_ms",
        "delegate_to_tts_ms",
        "tts_to_playback_ms",
        "stt_final_to_playback_ms",
    }
    # All boundaries present → every delta is a non-negative number.
    for v in b.values():
        assert v is not None and v >= 0


def test_partial_breakdown_has_none_for_missing_boundaries():
    lat = TurnLatency()
    lat.mark("stt_final_at")
    b = lat.breakdown()
    assert b["delegate_rtt_ms"] is None
    assert b["stt_final_to_playback_ms"] is None


def test_mark_unknown_stage_raises():
    with pytest.raises(ValueError):
        TurnLatency().mark("bogus_stage")
