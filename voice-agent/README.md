# voice-agent (LiveKit Agents — Python)

A **separate** deployable that runs the real-time audio loop for the Voice channel.

## What it does
- Owns the audio loop only: turn detection, endpointing, barge-in (LiveKit AgentSession).
- Streaming STT/TTS via the **official Sarvam plugin** (`livekit-plugins-sarvam`,
  Saaras STT / Bulbul TTS). The plugin owns all audio transport: voice-activity
  segmentation, framing, sample rates, connection lifecycle.
- Delegates **every finalized turn** to the Node brain via `POST /internal/voice/turn`
  (HMAC-signed), and bridges/closes the call via `/internal/voice/call/start` + `/call/end`.
  The delegation seam is `BrainAgent.llm_node` — latest user transcript in, one
  `reply_text` chunk out. No reasoning happens in this worker.

## What it does NOT do
- No business reasoning: no tools, no memory, no identity, no context assembly, no
  booking — all of that is in the Node `ai_service` and reached only over HTTP.
- No audio handling of its own: no local VAD model, no manual framing or sample-rate
  work — that layer is the plugin's.
- No direct carrier access: telephony is reached through the Node-side
  `TelephonyProvider` seam (noop in dev, Plivo in production). This worker never
  talks to a carrier; it joins a LiveKit dev room.

## Modules
| File | Role |
| --- | --- |
| `agent.py` | entrypoint · AgentSession wiring · `BrainAgent.llm_node` delegation shim · call lifecycle · resilience |
| `brain_client.py` | HMAC `call_start` / `delegate_turn` / `call_end` |
| `turn_context.py` | latest-user-text extraction (livekit-free) |

## Env
| Var | Purpose |
| --- | --- |
| `NODE_BRAIN_URL` | Base URL of the Node app (default `http://localhost:3000`) |
| `VOICE_INTERNAL_SECRET` | Shared HMAC secret for `/internal/voice/*` (match Node) |
| `VOICE_TURN_TIMEOUT_S` | Per-turn delegate timeout (static apology on failure) |
| `SARVAM_API_KEY` | Sarvam Saaras/Bulbul key |
| `SARVAM_STT_MODEL` / `SARVAM_TTS_MODEL` | `saaras:v3` / `bulbul:v3` |
| `SARVAM_TTS_SPEAKER` | bulbul:v3-valid voice (default `shubh`) |
| `VOICE_DEFAULT_LANGUAGE` | default spoken language (`te-IN`) |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit connection |
| `VOICE_TENANT_ID` / `VOICE_DEV_CALLER_NUMBER` | local call context (match the seed) |

See `.env.example` for the full list.

## Run (local dev room)
```bash
cp .env.example .env      # fill in values
uv sync
uv run agent.py dev       # or `uv run agent.py console` for a mic/speaker loop
```

## Test
```bash
uv run pytest             # delegation shim + brain client (HMAC/mock) + turn context
```

## Status
**Working local runtime** (not go-live). The full walkthrough — seed, run, hold a
spoken conversation, expected logs, acceptance checklist — is in
[`../PR7-livekit-runtime.md`](../PR7-livekit-runtime.md).

> Pinned against **livekit-agents 1.6.4** + **livekit-plugins-sarvam 1.6.4**
> (see `pyproject.toml`). The livekit-free modules and `brain_client` are
> unit-tested independently of the SDK.
