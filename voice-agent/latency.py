"""Per-stage latency instrumentation for a single voice turn.

Pure, dependency-free timestamp recorder. The worker stamps a monotonic clock at
each pipeline stage and logs the per-stage breakdown once the turn reaches
playback, so a slow stage is visible in the logs. A clean turn targets a
conversational feel (< ~800 ms stt_final -> playback_start); deviations show up
in `stt_final_to_playback_ms`.

NO business logic — this only measures.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

# Ordered pipeline stages for one finalized turn.
STAGES = (
    "stt_final_at",       # STT produced the FINAL transcript for the user turn
    "delegate_sent_at",   # delegate_turn HTTP request left the worker
    "delegate_recv_at",   # brain reply_text received
    "tts_first_byte_at",  # first TTS audio byte back from Sarvam
    "playback_start_at",  # first audio frame pushed to the room
)


def now_ms() -> float:
    """Monotonic milliseconds (immune to wall-clock adjustments)."""
    return time.monotonic() * 1000.0


@dataclass
class TurnLatency:
    """Monotonic timestamps (ms) for the stages of one finalized turn."""

    stt_final_at: Optional[float] = None
    delegate_sent_at: Optional[float] = None
    delegate_recv_at: Optional[float] = None
    tts_first_byte_at: Optional[float] = None
    playback_start_at: Optional[float] = None

    def mark(self, stage: str) -> float:
        """Record `now` for `stage` (one of STAGES) and return the timestamp."""
        if stage not in STAGES:
            raise ValueError(f"unknown latency stage: {stage}")
        ts = now_ms()
        setattr(self, stage, ts)
        return ts

    def breakdown(self) -> dict:
        """Per-stage deltas in ms; a delta is None when either boundary is unset."""

        def delta(a: Optional[float], b: Optional[float]) -> Optional[float]:
            return round(b - a, 1) if (a is not None and b is not None) else None

        return {
            "stt_to_delegate_ms": delta(self.stt_final_at, self.delegate_sent_at),
            "delegate_rtt_ms": delta(self.delegate_sent_at, self.delegate_recv_at),
            "delegate_to_tts_ms": delta(self.delegate_recv_at, self.tts_first_byte_at),
            "tts_to_playback_ms": delta(self.tts_first_byte_at, self.playback_start_at),
            # The headline number the acceptance criteria target.
            "stt_final_to_playback_ms": delta(self.stt_final_at, self.playback_start_at),
        }
