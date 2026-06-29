# voice-agent (LiveKit Agents — Python)

A **separate** deployable that runs the real-time audio loop for the Voice channel.

## What it does
- Owns the audio loop only: VAD, turn-taking, barge-in (LiveKit Agents).
- STT/TTS via **Sarvam** (Saaras / Bulbul).
- Delegates **every turn** to the Node brain via `POST /internal/voice/turn`
  (HMAC-signed; see `delegate_turn()` in `agent.py`).

## What it does NOT do
- No business reasoning: no tools, no memory, no identity, no booking — all of that
  is in the Node `ai_service` and reached only over HTTP.
- No direct carrier access: telephony is reached through the Node-side
  `TelephonyProvider` seam (noop in dev, Plivo in production).

It is **not** imported by the Node app and **not** part of the Node test suite. PR6's
core claim is proven without this worker via `/internal/voice/turn`.

## Status
**Skeleton.** `delegate_turn()` (transport + HMAC signing) is complete; the LiveKit
Agents wiring is documented inline in `agent.py` and must be filled in against the
current `livekit-agents` SDK before deploying.

## Env
| Var | Purpose |
| --- | --- |
| `NODE_BRAIN_URL` | Base URL of the Node app (default `http://localhost:3000`) |
| `VOICE_INTERNAL_SECRET` | Shared HMAC secret for `/internal/voice/turn` |
| `SARVAM_API_KEY` | Sarvam Saaras/Bulbul key |

## Run (production, after implementing the wiring)
```bash
uv sync
uv run agent.py dev
```
