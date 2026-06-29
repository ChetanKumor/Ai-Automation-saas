# PR6 — Voice Channel into the Existing Conversation Brain

**Branch:** `pr6-voice-channel`  ·  **Status:** complete, 13/13 commits, **97/97 tests green** (80 existing + 17 new), not pushed.

Voice is added as a **real-time transport only**. Every voice turn flows through the *same*
`ai_service` reply + tool path WhatsApp already uses — same tools, same booking guards, same
persistence. Telephony and STT/TTS sit behind interfaces so the whole system is buildable and
testable **without a Plivo account, a phone number, or any audio**. Everything is gated by
`VOICE_ENABLED` (default false); with it off the WhatsApp path is unchanged.

---

## 1. Architecture implemented

```
                 ┌──────────────────────── voice-agent (Python, separate deploy) ───────────────────────┐
   PSTN/SIP ───► │  LiveKit Agents loop (VAD, turn-taking, barge-in)                                     │
                 │     │ STT (Sarvam Saaras)            ▲ TTS (Sarvam Bulbul)                             │
                 │     ▼ transcript + language          │ reply_text                                     │
                 │  delegate_turn()  ── HMAC-signed HTTP ─────────────────────────────────┐              │
                 └──────────────────────────────────────────────────────────────────────│──────────────┘
                                                                                          ▼
   Node app:   POST /internal/voice/turn ──► [ transport glue + persistence ]
                                               • hydrate tenant / customer / conversation
                                               • persist inbound message (channel='voice')
                                               • mode / ai_enabled gate
                                               • parallel fetch: knowledge + history + memory facts
                                               • ai_service.generateReply(..., { channel:'voice' })  ◄── THE ONE BRAIN
                                               •   └─ same tools: check_availability / book_appointment + guards
                                               • persist outbound message (channel='voice')
                                               • return { reply_text, end_call, language }

   Seams:   VoiceProvider (1 impl: Sarvam)   ·   TelephonyProvider (noop default | plivo stub)
   Bus:     call.started / call.ended        ·   call_sessions table (1 row per call)
```

**Boundaries enforced (review gates):**
- `voice-agent` worker — audio + delegation only; zero reasoning/tools/memory.
- `TelephonyProvider` — call transport only; no audio understanding, no logic.
- `VoiceProvider` — STT/TTS/session only; no language policy, no state.
- `ai_service` (the brain) — unchanged logic; the only new branch is a `channel` param affecting **response style**.
- Voice turns persist via the existing `messages` pipeline; identity/booking/CRM writes go through the shared services.

---

## 2. Files added and modified

### Added (16)
| File | Purpose |
| --- | --- |
| `src/db/migrations/018_voice.sql` | `call_sessions` table + `customers.preferred_language` (additive) |
| `src/modules/voice/voiceProvider.js` | `VoiceProvider` interface (JSDoc) + registry (1 entry: sarvam) |
| `src/modules/voice/providers/sarvam.js` | Sarvam adapter — Saaras STT + Bulbul TTS |
| `src/modules/voice/callSessions.js` | `call_sessions` create / updateStatus / get (raw SQL, tenant-scoped) |
| `src/modules/voice/events.js` | `call.started` / `call.ended` publishers |
| `src/modules/telephony/telephonyProvider.js` | `TelephonyProvider` interface (JSDoc) + registry (noop\|plivo) |
| `src/modules/telephony/providers/noop.js` | `NoopTelephonyProvider` — boots/wires, no audio |
| `src/modules/telephony/providers/plivo.js` | `PlivoTelephonyProvider` — documented `NotImplemented` stub |
| `src/modules/channels/voice/voiceChannelAdapter.js` | `ChannelAdapter` conformance + call lifecycle (start/endSession) |
| `src/routes/internalVoice.js` | `POST /internal/voice/turn` (HMAC-auth, internal only) |
| `src/utils/hmac.js` | Shared sha256 body sign/verify (the WhatsApp scheme) |
| `voice-agent/agent.py` | LiveKit Agents worker skeleton (delegation complete, loop = TODO) |
| `voice-agent/pyproject.toml` | Python deps (`livekit-agents`, `httpx`) |
| `voice-agent/README.md` | Worker scope, env, run instructions |
| `tests/voice/voice.unit.test.js` | Adapter shapes, registries, conformance, stub |
| `tests/voice/voice.integration.test.js` | The proof: Telugu + Hinglish booking, CRUD, telephony mock, 401 |

### Modified (6)
| File | Change |
| --- | --- |
| `src/modules/ai/aiService.js` | Trailing `{ channel }` option → **presentation-only** voice style; injectable model factory (`_setModelProvider`) for deterministic tests. Default path byte-for-byte unchanged. |
| `core/eventTypes.js` | Added `CALL_STARTED` / `CALL_ENDED` |
| `src/modules/customer/customerService.js` | Added `resolveLanguage` (preferred_language prior) |
| `src/infra/config/env.js` | Added optional `VOICE_ENABLED`, `TELEPHONY_PROVIDER`, `SARVAM_API_KEY`, `VOICE_INTERNAL_SECRET` (none in `REQUIRED`) |
| `server.js` | Gated wiring: register voice adapter, mount `/internal/voice` (before `express.json`, for raw HMAC bodies), wire telephony — all inside `if (VOICE_ENABLED)` |
| `package.json` | Added the two voice test files to the `test` script |

### Untouched (parity)
`src/modules/channels/whatsapp/*` — the WhatsApp adapter, sender, routes, and owner commands are unmodified.

---

## 3. Database migration summary

`src/db/migrations/018_voice.sql` — **additive only, reversible**. Applied to the dev DB; **not**
applied to prod (deferred to the deploy phase; must **not** be batched with the PR8 wamid-drop).

```sql
CREATE TABLE call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_call_id text,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number text, to_number text,
  language_detected text,
  status text NOT NULL CHECK (status IN ('initiated','in_progress','completed','failed')),
  started_at timestamptz, ended_at timestamptz, duration_seconds int,
  recording_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE customers ADD COLUMN preferred_language text NULL;
CREATE INDEX idx_call_sessions_tenant_customer ON call_sessions(tenant_id, customer_id);
CREATE INDEX idx_call_sessions_external        ON call_sessions(external_call_id);
```

**Rollback:** `DROP TABLE call_sessions; ALTER TABLE customers DROP COLUMN preferred_language;`

One row per call; the individual turns live in `messages` (`channel='voice'`), not a new store.

---

## 4. Voice request flow (LiveKit → Sarvam → `/internal/voice/turn` → `ai_service`)

1. **Call arrives** at the carrier and is bridged in via the Node `TelephonyProvider` seam
   (`noop` in dev, Plivo in production). Call context (tenant/customer/conversation/call_session
   ids + language prior) is provisioned to the LiveKit room.
2. **`voice-agent` (Python/LiveKit)** runs the audio loop — VAD, turn-taking, barge-in.
3. **STT (Sarvam Saaras)** turns the caller's utterance into `{ transcript, language }`. No reasoning.
4. **`delegate_turn()`** POSTs the turn to `POST /internal/voice/turn`, HMAC-signed
   (`x-internal-signature: sha256=…`, matching `src/utils/hmac.js`). Body:
   `{ tenant_id, customer_id, conversation_id, call_session_id, channel:"voice", language, transcript }`.
5. **Node route (`internalVoice.js`)** — transport glue + persistence only:
   - hydrate tenant (same `phone_number_id → tenantService.getByPhoneNumberId` path as WhatsApp),
   - validate customer + conversation belong to the tenant,
   - resolve effective language via `customerService.resolveLanguage` (prior honored),
   - persist the **inbound** voice message (`channel='voice'`),
   - apply the same `mode === 'human' || !ai_enabled` gate,
   - parallel-fetch knowledge chunks + recent history + `customer_memory` facts (identical to `whatsapp/routes.js`),
   - call **`ai_service.generateReply(..., { channel:'voice' })`** — the one brain, same tools and guards,
   - persist the **outbound** voice message (`channel='voice'`),
   - respond `{ reply_text, end_call, language }`.
6. **TTS (Sarvam Bulbul)** in the worker speaks `reply_text` back to the caller.
7. **Lifecycle**: the voice ChannelAdapter creates the `call_session` and emits `call.started` at
   call start, and marks it `completed` + emits `call.ended` at call end.

The reply is **returned** to the worker (it does TTS); voice does not push an outbound message like
WhatsApp — so the voice ChannelAdapter's `send()` is structural conformance, not an async push.

---

## 5. New interfaces introduced

**`VoiceProvider`** (`src/modules/voice/voiceProvider.js`) — STT/TTS/session seam:
```
transcribe(audioStream) -> { text, language }     // Sarvam Saaras
synthesize(text, language) -> audioStream          // Sarvam Bulbul
startSession(callMeta) -> session
endSession(sessionId)
```

**`TelephonyProvider`** (`src/modules/telephony/telephonyProvider.js`) — call transport seam:
```
onInboundCall(handler)                 // register inbound-call callback
startCall(callMeta) -> callHandle      // outbound (future)
streamAudioIn(callHandle) -> stream    // caller -> agent
streamAudioOut(callHandle, stream)     // agent -> caller
endCall(callHandle)
// emits telephony.call_connected / telephony.call_ended
```
- `NoopTelephonyProvider` — all methods log + return; satisfies the interface so the service boots/wires.
- `PlivoTelephonyProvider` — conformant stub; every method throws `NotImplemented — see PR6 production onboarding`.

**`POST /internal/voice/turn`** — internal, HMAC-authenticated; the telephony-independent proof surface.

**Events** — `call.started` / `call.ended` on the existing bus.

**Internal HTTP auth** — `src/utils/hmac.js` (`sign`/`verify`), reused by the route and the Python worker.

---

## 6. Feature flags

| Flag | Default | Effect |
| --- | --- | --- |
| `VOICE_ENABLED` | `false` | Master switch. Off ⇒ nothing voice is registered/mounted; WhatsApp path unchanged. |
| `TELEPHONY_PROVIDER` | `noop` | `noop` (dev, no audio) or `plivo` (production onboarding only). Orthogonal to `VOICE_ENABLED`. |
| `SARVAM_API_KEY` | — | Sarvam Saaras/Bulbul key (read at call time). Optional. |
| `VOICE_INTERNAL_SECRET` | — | HMAC secret for `/internal/voice/turn` (worker signs the same). Optional. |

None are in the `REQUIRED` env list, so an unset value never blocks boot. **Rollback = flip
`VOICE_ENABLED=false`** (instant kill, WhatsApp unaffected).

---

## 7. Tests added (17 new; 97 total green)

**Unit** (`tests/voice/voice.unit.test.js`, 12 tests, no DB):
- Sarvam adapter request/response shapes (mock Sarvam HTTP) for `transcribe`/`synthesize`; missing-key error; session handles.
- `VoiceProvider` registry resolves `sarvam`; unknown throws; rejects incomplete providers.
- `TelephonyProvider` registry resolves `noop`; Noop satisfies the interface; **noop↔plivo single-file-swap conformance** (identical interface surface); Plivo stub throws `NotImplemented` on every method.

**Integration** (`tests/voice/voice.integration.test.js`, 5 tests, DB-backed — no telephony, no audio):
- **Telugu** "book appointment" transcript → `/internal/voice/turn` → the **existing** `check_availability` + `book_appointment` + transactional guards fire (scripted model, real tool loop) → appointment row created, `customers.name` + `preferred_language` written, inbound+outbound `messages(channel='voice')` persisted, `call_session` created+closed, `call.started`/`call.ended` emitted.
- **Hinglish** transcript — same assertions on a second customer/slot.
- HMAC failure → **401**.
- `call_sessions` CRUD is tenant-scoped; a `TelephonyProvider` mock is called with the expected args.

Determinism: a tiny test-only `_setModelProvider` seam in `ai_service` scripts the tool loop, so the
proof runs the **real** tools/guards/persistence without a live LLM. RAG is stubbed to keep turns hermetic.

---

## 8. WhatsApp path remains unchanged (confirmed)

- `src/modules/channels/whatsapp/*` is **untouched**.
- The only edit to shared brain code (`ai_service`) adds a trailing `{ channel = 'whatsapp' }`
  option (default), a presentation-only voice block, and a test seam — the default WhatsApp call
  path is byte-for-byte identical.
- All **80 pre-existing tests still pass** alongside the 17 new ones (97/97, 0 failures).
- Boot verified both ways: with `VOICE_ENABLED` unset the `/internal/voice/turn` route is **not
  mounted** (404) and no voice wiring runs; with it on, `/health` is fine, signed turns reach the
  handler, unsigned → 401.

---

## 9. Known limitations — intentionally deferred to PR7 (real Plivo integration)

- **`PlivoTelephonyProvider` is a stub** (`NotImplemented`). PR7 implements it against the locked
  interface — the proven single-file swap.
- **`voice-agent` worker is a skeleton.** `delegate_turn()` (HTTP + HMAC) is complete; the LiveKit
  Agents wiring (STT/TTS plugins, VAD, turn loop) is documented TODOs and is **not run in CI**.
- **No real audio path is exercised** — STT/TTS/telephony are mocked or noop. The PSTN→STT→brain→
  TTS→PSTN loop is only meaningfully testable with a live call (PR7/production).
- **Production provisioning deferred**: Plivo account + local DID + DLT/KYC, LiveKit worker deploy,
  applying migration 018 in prod, `TELEPHONY_PROVIDER=plivo`, `VOICE_ENABLED=true` for a pilot tenant,
  turn-latency/cost monitoring.
- **`end_call` is always `false`** for now — hangup is the worker/telephony's concern, kept out of the
  brain to avoid business logic in the voice layer.
- **`customer_memory` rolling write-back is NOT in PR6** (it is PR8). Per the "no new memory store"
  invariant, voice does not add memory-write logic; "memory" updates manifest as `messages` +
  CRM/customer writes through the shared tools, exactly as WhatsApp does today.

---

*PR6 stops here. Real Plivo integration (PR7) and the `customer_memory` write-back (PR8) are separate PRs.*
