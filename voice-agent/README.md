# voice-agent (LiveKit Agents — Python)

A **separate** deployable that runs the real-time audio loop for the Voice channel.

## What it does
- Owns the audio loop only: VAD, semantic turn detection, barge-in (LiveKit AgentSession).
- Streaming STT/TTS via **Sarvam** (Saaras / Bulbul) as LiveKit plugin adapters.
- Delegates **every finalized turn** to the Node brain via `POST /internal/voice/turn`
  (HMAC-signed), and bridges/closes the call via `/internal/voice/call/start` + `/call/end`.

## What it does NOT do
- No business reasoning: no tools, no memory, no identity, no context assembly, no
  booking — all of that is in the Node `ai_service` and reached only over HTTP.
- No direct carrier access: telephony is reached through the Node-side
  `TelephonyProvider` seam (noop in dev, Plivo in production). This worker never
  talks to a carrier; it joins a LiveKit dev room.

## Modules
| File | Role |
| --- | --- |
| `agent.py` | entrypoint · AgentSession · BrainLLM (delegate) · call lifecycle · resilience · latency |
| `stt_sarvam.py` | Sarvam streaming STT → LiveKit `stt.STT` plugin |
| `tts_sarvam.py` | Sarvam streaming TTS → LiveKit `tts.TTS` plugin |
| `sarvam_protocol.py` | pure Sarvam wire protocol (livekit-free, unit-tested) |
| `brain_client.py` | HMAC `call_start` / `delegate_turn` / `call_end` |
| `turn_context.py` | latest-user-text extraction (livekit-free) |
| `latency.py` | per-stage turn latency |

## Env
| Var | Purpose |
| --- | --- |
| `NODE_BRAIN_URL` | Base URL of the Node app (default `http://localhost:3000`) |
| `VOICE_INTERNAL_SECRET` | Shared HMAC secret for `/internal/voice/*` (match Node) |
| `SARVAM_API_KEY` | Sarvam Saaras/Bulbul key |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit connection |
| `VOICE_TENANT_ID` / `VOICE_DEV_CALLER_NUMBER` | local call context (match the seed) |

See `.env.example` for the full list (Sarvam model/speaker overrides, timeout).

## Run (local dev room)
```bash
cp .env.example .env      # fill in values
uv sync
uv run agent.py dev
```

## Test
```bash
uv run pytest             # protocol/latency/turn-context + brain client (HMAC/mock)
```

## Status
**Working local runtime** (not go-live). The full walkthrough — seed, run, hold a
spoken conversation, expected logs + latency, acceptance checklist — is in
[`../PR7-livekit-runtime.md`](../PR7-livekit-runtime.md).

> The LiveKit Agents glue is written against **livekit-agents 1.x**; validate on
> `uv sync`. The livekit-free modules and `brain_client` are unit-tested
> independently of the SDK.
