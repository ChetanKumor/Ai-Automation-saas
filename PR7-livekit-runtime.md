# PR7 — LiveKit Runtime (local end-to-end voice) · Runbook

Turns the PR6 worker skeleton into a real-time, interruptible voice runtime that
holds a spoken conversation **locally** (LiveKit dev room / Agents Playground —
no phone), using streaming Sarvam STT/TTS and delegating **every finalized turn**
to the existing Node brain over HTTP. Telephony stays `noop`; no code path reaches
PSTN.

---

## Architecture (what this PR proves)

```
  ┌─────────────── voice-agent (Python, LiveKit Agents) ───────────────┐
  │ mic → Sarvam STT (stream) → VAD/turn-detect → BrainLLM (delegate)  │
  │                                   │                                 │
  │        Sarvam TTS (stream) ← reply_text ←──────┐                    │
  │              │                                 │  HTTP (HMAC)       │
  └──────────────┼─────────────────────────────────┼────────────────────┘
                 │ audio out                        │  turn-shaped
                 ▼                                  ▼
           LiveKit dev room            POST /internal/voice/{call/start,turn,call/end}
                                                    │
                                          ┌─────────▼──────────┐
                                          │  Node brain (ONE)  │
                                          │  identity · context│
                                          │  ai_service · tools│
                                          │  memory · events   │
                                          └────────────────────┘
```

- **One brain.** Every voice turn runs the existing `ai_service` reply+tool path.
  The worker holds **zero** business logic — no identity, no context assembly, no
  tools, no memory. It only moves audio and forwards the latest transcript.
- **Identity resolves ONCE**, at `/call/start`. A returning customer is matched by
  phone and **reuses their existing conversation + memory** — voice and WhatsApp
  share one customer, one conversation, one memory.
- **The HTTP boundary is turn-shaped**: one `delegate_turn` per finalized turn.
  Streaming lives entirely worker-side; `/internal/voice/turn` never streams.
- **Shared context helper** (`contextAssembler.js`) is the single assembly path for
  both WhatsApp and voice — this is what keeps "one brain" true for voice.

---

## What's in this PR

**Node (additive + one behavior-preserving refactor):**
| File | Change |
| --- | --- |
| `src/modules/conversation/contextAssembler.js` | NEW — shared RAG+history+memory assembly, extracted from the WhatsApp path |
| `src/modules/channels/whatsapp/routes.js` | uses the shared helper (behavior-preserving) |
| `src/routes/internalVoice.js` | `+ /call/start`, `+ /call/end`; `/turn` resolves from `call_session_id`; emits `message.received` (parity) |

**Worker (Python, LiveKit Agents):**
| File | Role |
| --- | --- |
| `voice-agent/agent.py` | entrypoint, AgentSession (VAD + turn detection + barge-in), BrainLLM delegate, call lifecycle, resilience, latency |
| `voice-agent/stt_sarvam.py` / `tts_sarvam.py` | Sarvam streaming STT / TTS as LiveKit plugin adapters |
| `voice-agent/sarvam_protocol.py` | pure Sarvam wire protocol (livekit-free, unit-tested) |
| `voice-agent/brain_client.py` | HMAC `call_start` / `delegate_turn` / `call_end` |
| `voice-agent/turn_context.py` · `latency.py` | latest-user-text extraction · per-stage latency |
| `scripts/seed_voice_test_customer.{js,sql}` | seeded returning customer (prior WhatsApp history + memory) |

---

## Prerequisites

- **PostgreSQL** with the schema applied (migration 018 already shipped in PR6).
- **Node app** runnable (existing `.env` with the usual required vars).
- **LiveKit Cloud** project (or self-host) — `LIVEKIT_URL/API_KEY/API_SECRET`.
- **Sarvam** subscription key (`SARVAM_API_KEY`) — Saaras STT + Bulbul TTS.
- **Python 3.11+** and **[uv](https://docs.astral.sh/uv/)** (or pip) for the worker.

---

## Run it (local dev room)

### 1. Node brain

Add to the Node app's `.env`:

```bash
VOICE_INTERNAL_SECRET=<a-shared-secret>     # the worker signs turns with this
VOICE_ENABLED=true                          # LOCAL ONLY — mounts /internal/voice (see note)
TELEPHONY_PROVIDER=noop                      # no carrier, no PSTN
```

> **VOICE_ENABLED note.** `server.js` (a frozen PR6 flag) mounts `/internal/voice`
> only when `VOICE_ENABLED=true`, so the worker can reach the brain. This does
> **not** touch a carrier: `TELEPHONY_PROVIDER=noop` and the worker joins a LiveKit
> dev room, not a phone. **Production stays `VOICE_ENABLED=false`** until go-live
> (PR8+). Flipping it locally only exposes the HMAC-protected internal endpoints.

Seed the returning test customer, then start the app:

```bash
node scripts/seed_voice_test_customer.js    # prints tenant_id + caller number
npm start                                    # or: npm run dev
```

### 2. Worker

```bash
cd voice-agent
cp .env.example .env      # then fill in the values below
uv sync                   # installs livekit-agents, silero, websockets, httpx
uv run agent.py dev       # joins your LiveKit project; ready for a dev room
```

`voice-agent/.env` must match the brain:

```bash
NODE_BRAIN_URL=http://localhost:3000
VOICE_INTERNAL_SECRET=<same-as-Node>
SARVAM_API_KEY=<your-sarvam-key>
LIVEKIT_URL=<wss://...>
LIVEKIT_API_KEY=<...>
LIVEKIT_API_SECRET=<...>
VOICE_TENANT_ID=<from the seed output>
VOICE_DEV_CALLER_NUMBER=<from the seed output, e.g. +919000000001>
```

### 3. Talk to it

Open the **LiveKit Agents Playground** (or any LiveKit client) and join a room the
worker is dispatched to. Speak — e.g. in Telugu: *"repu Dr. Rao daggara appointment
kावాలి"* ("I want an appointment with Dr. Rao tomorrow"). The agent transcribes,
delegates the turn, fires the **existing** `book_appointment` tool, and speaks the
confirmation back.

---

## Expected logs

```
call bridged: call_session=<uuid> customer=<uuid> conversation=<uuid>
tool call            { tool: 'check_availability', ... }        # Node brain
tool call            { tool: 'book_appointment',   ... }        # Node brain
turn latency: {stt_to_delegate_ms: .., delegate_rtt_ms: .., delegate_to_tts_ms: .., tts_to_playback_ms: .., stt_final_to_playback_ms: 742.3}
call ended: completed (37.4s)
```

- A **clean turn targets `stt_final_to_playback_ms` < ~800 ms**; slow stages are
  visible per stage in the breakdown.
- A forced `delegate_turn` failure (stop the Node app mid-call) logs
  `delegate_turn failed: ...`, the agent **speaks a fallback** (never dead air),
  and the call closes with `status='failed'` + `call.ended`.

---

## Acceptance checklist

- [ ] Spoken conversation end-to-end in a dev room — no phone, `TELEPHONY_PROVIDER=noop`.
- [ ] Telugu "book an appointment" fires the **existing** `book_appointment` tool
      (same guards as WhatsApp); confirmation is spoken back.
- [ ] **Identity proof:** `call/start` resolves the dev caller to the **seeded
      returning customer's existing conversation**; the reply reflects prior
      WhatsApp history/memory (one customer / conversation / memory).
- [ ] **Barge-in:** talking over the agent stops playback near-instantly; agent yields.
- [ ] **Code-switch** (Telugu↔English) within one call is transcribed and answered in kind.
- [ ] **Event parity:** a voice turn emits the same `message.received` a WhatsApp
      turn does (asserted in `tests/voice/voiceLifecycle.integration.test.js`).
- [ ] Per-stage latency logged per turn.
- [ ] Forced failure → spoken fallback + `call_session status='failed'`.

---

## Tests

```bash
# Node (brain side) — 116/116 including PR7 identity, turn-from-session, parity
npm test

# Worker (Python) — pure protocol/latency/turn-context + brain client (HMAC/mock)
cd voice-agent && uv run pytest
```

The Node suite is the regression gate for the context-helper extraction: the
existing 97 tests stay green, proving WhatsApp behavior is preserved.

---

## Rollback

The worker is a separate deployable in **no production path** (telephony noop,
`VOICE_ENABLED=false` in prod). Rollback = stop/revert the worker commits; the Node
app is unaffected. Reverting the Node PR7 commits restores PR6 exactly — the
context-helper extraction is behavior-preserving and the new internal endpoints are
unused in production (flag off, no telephony wired). No schema changes in PR7 (018
already shipped).

---

## Notes / follow-ups (NOT PR7)

- The LiveKit Agents glue (AgentSession, custom `llm.LLM` node, AudioEmitter, plugin
  base classes) is written against **livekit-agents 1.x**; validate on `uv sync`.
  The livekit-free modules (`sarvam_protocol`, `turn_context`, `latency`) and
  `brain_client` are unit-tested independently of the SDK.
- If Sarvam ships an official LiveKit plugin, prefer it and drop the adapters.
- Go-live gates (PlivoTelephonyProvider, DID/DLT/KYC, deploy the worker, real
  inbound-call identity + latency validation, per-tenant `VOICE_ENABLED=true`,
  ₹/min monitoring) are PR8+/onboarding — not this PR.
