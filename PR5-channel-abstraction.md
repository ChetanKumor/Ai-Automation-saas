# Zyon V2 — Channel Abstraction + WhatsApp Adapter (spec PR5, no migrations)

> Implementation package. Staff → Senior handoff. Read fully before coding.
> Source of truth: `ZYON_V2_SPEC.md` (Phase 2 folder structure, Phase 3 Channels + WhatsApp adapter boundaries, Phase 6 event table, Phase 8 PR5). Evolution, not a rewrite.
> This is a **pure structural refactor**: same behavior, new seam. No DB change. Success metric: the existing test suite passes unchanged.

---

## 0. Carry-forward deploy dependency (read first)

Migrations **014–017 are committed and tested locally but NOT applied in production.** PR5 has no migrations of its own, but its code **writes the PR4 columns** (`channel`, `direction`, `external_id`, `message_type`, `media_ref`) through the storage path. So in the eventual batched deploy:

- **Apply migrations in order 014 → 015 → 016 → 017 first, then deploy PR3–PR5 code.** PR5 code crashes against a pre-PR4 schema (writes to columns that don't exist).
- Flip `IDENTITY_RESOLUTION_ENABLED` to true only after the identity parity check, as planned.
- The `wamid` **column** drop (PR8 / ~020) stays out of this batch — separate verification window.

PR5 itself is safe to build and run locally now (your local DB already has 014–017).

---

## 1. PR Objective

Introduce the `ChannelAdapter` abstraction: a common inbound **envelope**, an adapter **interface**, and a **registry** with `dispatchOutbound`. Re-home the existing WhatsApp handling (routes, controller, sender, owner commands) into `modules/channels/whatsapp/` as the first adapter implementing that interface — with byte-for-byte identical behavior. This is the seam Voice (PR6/7) and every future channel plug into.

---

## 2. Why This PR Exists

Today the WhatsApp controller *is* the inbound pipeline — transport parsing, customer resolution, storage, and reply are fused into WhatsApp-specific code. Voice cannot reuse any of it. The spec's design is a thin transport-specific adapter (verify, parse-to-envelope, send) sitting above a channel-agnostic ingestion path (resolve → store → publish `message.received`). Establishing that boundary now means PR6's Retell adapter implements the same interface and the rest of the platform never learns a second channel exists. This is the structural payoff of PR3 (identity) and PR4 (channel-agnostic storage): with a customer key and channel-aware tables in place, the pipeline above them can finally be made channel-independent.

---

## 3. Scope

1. **`core/events.js`** — define the common `InboundEnvelope` schema + the `message.received` event (envelope as payload).
2. **`modules/channels/index.js`** — `ChannelAdapter` interface, a registry (`register`, `getAdapter`), and `dispatchOutbound({tenantId, customerId, channel, payload})`.
3. **`modules/channels/whatsapp/`** — relocate the existing WA pieces (routes, controller→adapter, sender, ownerCommands) into an adapter implementing the interface. Behavior unchanged.
4. **Inbound path** — adapter `verifyWebhook` → `parseInbound` → channel-agnostic ingest (resolve → open conversation → append message) → publish `message.received`. Status callbacks (sent/delivered/read) handled exactly as today.
5. **Outbound path** — WhatsApp sends route through `dispatchOutbound({channel:'whatsapp', …})`, a thin indirection over the existing sender (24h window + template fallback preserved).
6. **Bootstrap** — register adapters before routes accept traffic; update the relocated route wiring + health/shutdown references.
7. **Imports** — update every importer of the moved files.
8. **Tests** — adapter-contract test + inbound/outbound parity; all 53 existing tests stay green.

---

## 4. Out of Scope

- Any DB migration or schema change. None in PR5.
- Converting the **reply** path to event-driven if it is currently inline. Publish `message.received` additively; do **not** add a new reply consumer that would double-handle. (Workflow already consumes events; voice/other consumers come later.)
- Rewiring `notifications` to emit `notification.requested` if it currently calls senders directly — keep existing notification sends working; `dispatchOutbound` is the new unified path, adopted incrementally.
- Voice, `call_sessions`, the `VoiceProvider` interface (PR6).
- `customer_memory` / write-back (PR8).
- Identity resolution changes (PR3) beyond calling it from the ingest path as today.
- The `customers.phone` NOT NULL change (tracked; first non-phone channel).
- The two tracked app bugs (Gemini model-role, extraction JSON).
- Downloading media binaries (still reference-only).

---

## 5. The ChannelAdapter contract (design centerpiece)

### Common inbound envelope (`core/events.js`)

```
InboundEnvelope {
  tenantId
  channel          // 'whatsapp'
  direction        // 'inbound'
  identifier       // sender's channel identifier (phone for WA)
  externalId       // provider message id (wamid)
  messageType      // 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | ...
  text?            // body when text
  mediaRef?        // provider media id when non-text
  profile?         // { name } from the WA contact profile
  timestamp        // provider timestamp
}
```

### Adapter interface (`modules/channels/index.js`)

```
interface ChannelAdapter {
  channelType: string                                   // 'whatsapp'
  verifyWebhook(req): boolean                           // PR1 HMAC check lives here now
  parseInbound(req): InboundEnvelope[]                  // normalize messages (incl. non-text)
  send({ tenantId, customerId, payload }): Promise<{ externalId }>  // 24h window + template fallback
}
```

### Registry + dispatch

```
register(adapter)                  // keyed by adapter.channelType
getAdapter(channelType)            // throws on unknown channel
dispatchOutbound({ tenantId, customerId, channel, payload })
   = getAdapter(channel).send({ tenantId, customerId, payload })
```

### Channel-agnostic ingest (the part that is no longer WhatsApp-specific)

```
handleInbound(adapter, req):
  if not adapter.verifyWebhook(req): return 401
  for env in adapter.parseInbound(req):
     customer = identity.resolveCustomer({ tenantId, channelType: env.channel,
                                           identifier: env.identifier, profile: env.profile })  // flag-gated as today
     convo = memory.getOpenConversation(tenantId, customer.id, env.channel)
     memory.appendMessage({ ...env, customerId: customer.id, conversationId: convo.id })  // PR4 storage; ON CONFLICT dedup
     eventBus.publish('message.received', env)
  // existing reply trigger stays exactly as it is today (do not rewire in PR5)
```

`parseInbound` returns **messages only**. Status callbacks (sent/delivered/read) keep their existing handling inside the adapter — do not route them through the message ingest path.

---

## 6. Architecture Impact

- Inbound splits into **transport** (adapter: verify, parse, send) and **ingest** (channel-agnostic: resolve, store, publish). PR6's Retell adapter implements the same interface; ingest is reused unchanged.
- `dispatchOutbound` becomes the single outbound entry; the rest of the platform addresses channels by name, not by importing a specific sender.
- `message.received` is now emitted with a normalized, channel-independent envelope — the contract Workflow/AI consume.
- This is the first PR that **moves files** (the `channels/` folder is introduced now because the module is finally being touched — consistent with the spec's incremental-folder rule). No behavior changes.

---

## 7. Files to Modify

Reconcile real paths in Step 0.

| File | Action | Why |
|---|---|---|
| `core/events.js` (or eventTypes) | Edit | Add `InboundEnvelope` schema + `message.received` |
| `modules/channels/index.js` | **New** | Interface + registry + `dispatchOutbound` |
| `modules/channels/whatsapp/routes.js` | **Move** | From existing webhook routes (GET handshake + POST) |
| `modules/channels/whatsapp/adapter.js` | **Move/refactor** | From `webhookController.js`; implements `ChannelAdapter` |
| `modules/channels/whatsapp/sender.js` | **Move** | Existing WA send (24h window + template fallback) |
| `modules/channels/whatsapp/ownerCommands.js` | **Move** | Existing owner-command handling |
| `app/bootstrap` / `server.js` | Edit | Register adapters before routes; fix relocated route + health/shutdown refs |
| `notifications` / outbound callers | Edit (thin) | Route WA sends through `dispatchOutbound` |
| every importer of the moved files | Edit | Update import paths |
| `tests/` | **New** | Adapter contract + parity |

---

## 8. Migration Strategy

**No migrations in PR5.** The production-safety concern is purely **deploy ordering** (see §0): PR5 code depends on the unapplied 014–017 schema, so in the batch, migrations 014→017 apply before PR3–PR5 code. There is nothing for PR5 to roll back at the DB level.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| File moves break imports → boot/runtime failure | Med | Step 0 maps all importers; update every one; reviewer checks for dangling imports |
| Refactor drifts inbound/outbound behavior → WA regression | Med | Behavior-preserving wrapper, no logic rewrite; all 53 existing tests must pass unchanged |
| Status-callback handling lost in the move | Med | Explicitly preserve status handling in the adapter; parity test for delivery-state updates |
| `message.received` + inline reply → double replies | Low-Med | Publish additively only; add no new reply consumer in PR5 |
| `dispatchOutbound` indirection swallows send errors | Low | Pass errors through unchanged; parity test on send failure |
| Adapter not registered before first webhook at boot | Low | Register in bootstrap before the server accepts connections |
| Deployed against pre-PR4 schema | High if ignored | §0 deploy-order note |

---

## 10. Backwards Compatibility

Pure refactor: identical inbound resolution/storage/reply, identical outbound send. No DB change, no flag. The existing test suite is the parity guard — if all 53 pass after the move, behavior is preserved. The `message.received` publication is additive (no consumer is forced to change). `dispatchOutbound` wraps the existing sender. Rollback is a git revert.

---

## 11. Acceptance Criteria

1. `ChannelAdapter` interface, `InboundEnvelope` schema, registry, and `dispatchOutbound` defined.
2. WhatsApp implemented as an adapter satisfying the interface, living under `modules/channels/whatsapp/`.
3. Inbound: verify → parseInbound → resolve → store → publish `message.received`; text, non-text, and status callbacks handled exactly as before.
4. Outbound WA sends route through `dispatchOutbound({channel:'whatsapp'})` with identical behavior (24h window + template fallback) and return `externalId`.
5. GET verification handshake preserved.
6. All importers updated; app boots; adapters registered before routes serve traffic.
7. `getAdapter(unknownChannel)` throws; `dispatchOutbound` to an unknown channel throws (no silent drop).
8. All 53 existing tests pass unchanged; new adapter-contract + parity tests pass.
9. No DB migration; no invariant touched; no behavior change.
10. `npm test` green.

---

## 12. Testing Strategy

- **Adapter contract:** the WA adapter and a mock adapter both satisfy the interface (`channelType`, `verifyWebhook`, `parseInbound`, `send`).
- **Inbound parity (characterization):** a fixed WA webhook payload yields the same stored message(s) and the same reply trigger as before the refactor.
- **Non-text + status callbacks:** image/audio/document/location normalize correctly; sent/delivered/read still update delivery state.
- **Outbound:** `dispatchOutbound({channel:'whatsapp'})` calls the WA sender and returns `externalId`; send failure propagates (not swallowed).
- **Registry:** `register`/`getAdapter`; unknown channel throws on both `getAdapter` and `dispatchOutbound`.
- **Boot:** adapters registered before the server listens.
- **The real guard:** all 53 existing tests pass with zero edits to their assertions.

---

## 13. Rollback Strategy

Pure code, no DB. Rollback = `git revert` the PR commits; imports and routes return to their prior locations. Nothing to undo in the database. No flag needed because behavior is unchanged by construction and verified by the unchanged existing suite.

---

## 14. Atomic Commit Plan

1. `feat(channels): define ChannelAdapter interface, InboundEnvelope, registry + dispatchOutbound`
2. `refactor(whatsapp): relocate routes/controller/sender/ownerCommands into modules/channels/whatsapp as an adapter`
3. `chore: update imports and bootstrap registration for relocated whatsapp module`
4. `refactor(channels): route WhatsApp outbound through dispatchOutbound`
5. `feat(channels): publish normalized message.received on inbound`
6. `test(channels): adapter contract + inbound/outbound parity tests`

---

## 15. Claude Code Implementation Prompt

```text
# Zyon V2 — PR5: Channel Abstraction + WhatsApp Adapter (no migrations)

You are the backend-engineer sub-agent. Follow your standing rules in
.claude/agents/backend-engineer.md. code-reviewer reviews read-only before commit.

Source of truth: ZYON_V2_SPEC.md (Phase 2 folder structure, Phase 3 Channels +
WhatsApp adapter, Phase 6 event table, Phase 8 PR5). This is a PURE STRUCTURAL
REFACTOR: identical behavior, new seam. No DB change.

## Critical context
- This is the first PR that MOVES files. Introduce modules/channels/ now.
  Preserve behavior byte-for-byte. The 53 existing tests are the parity guard —
  do not edit their assertions to make them pass.
- DO NOT rewire the reply path to event-driven if it is currently inline.
  Publish message.received ADDITIVELY. Add no new reply consumer.
- DO NOT rewire notifications to events if they currently call senders directly.
  dispatchOutbound is the new unified outbound path; adopt it for WA sends only.
- Status callbacks (sent/delivered/read) keep their existing handling — they are
  NOT messages; do not route them through message ingest.
- DO NOT touch identity resolution logic, DB schema, voice, customer_memory,
  customers, or the two tracked app bugs.
- No migrations. (Deploy note: PR5 code writes PR4 columns; in the batched
  deploy, migrations 014->017 apply BEFORE this code.)

## Step 0 — Assess (output BEFORE editing)
Report:
- Real paths of: WA webhook routes (GET handshake + POST), webhookController,
  WA sender, owner commands.
- How inbound currently flows from webhook -> reply (is the reply inline or via
  the event bus?). Report the exact call chain.
- How outbound WA send is currently invoked (direct sender call? notifications?).
- How status callbacks (sent/delivered/read) are currently handled.
- Every file that imports the four files to be moved.
- Where adapters should be registered at boot (bootstrap/server entry).
- Confirm no test asserts an internal import path that the move would break.
- Planned diff + move map per file.
Then build.

## Build

### core/events.js
Define InboundEnvelope { tenantId, channel, direction, identifier, externalId,
messageType, text?, mediaRef?, profile?, timestamp } and the message.received
event name. No inline event-name string literals elsewhere.

### modules/channels/index.js
- ChannelAdapter interface: channelType, verifyWebhook(req), parseInbound(req)
  -> InboundEnvelope[], send({tenantId, customerId, payload}) -> {externalId}.
- Registry: register(adapter) keyed by channelType; getAdapter(channelType)
  (throws on unknown).
- dispatchOutbound({tenantId, customerId, channel, payload}) =
  getAdapter(channel).send(...). Throw on unknown channel — never silently drop.

### modules/channels/whatsapp/ (relocate, do not rewrite)
- routes.js: GET verify handshake + POST webhook (moved). POST calls the
  channel-agnostic handleInbound(adapter, req).
- adapter.js: implements ChannelAdapter. channelType='whatsapp'.
  verifyWebhook = the existing PR1 HMAC check (length-guarded, timingSafeEqual).
  parseInbound = normalize WA messages to InboundEnvelope[] (text + non-text:
  map type -> messageType, set mediaRef for media). send = the existing WA
  sender (24h window + template fallback), returns {externalId}.
  Preserve existing status-callback handling here.
- sender.js, ownerCommands.js: moved as-is.

### Channel-agnostic ingest
handleInbound(adapter, req): verifyWebhook -> 401 on fail; for each envelope ->
identity.resolveCustomer (flag-gated exactly as today) -> getOpenConversation
(tenant, customer, channel) -> appendMessage (PR4 storage, ON CONFLICT dedup) ->
eventBus.publish('message.received', envelope). Leave the existing reply trigger
exactly where/how it is today.

### Outbound
Route WhatsApp sends through dispatchOutbound({channel:'whatsapp', ...}).
Preserve error propagation. Do not change notification internals.

### Bootstrap + imports
Register the WA adapter before the server accepts connections. Update the
relocated route wiring and any health/shutdown references. Update EVERY importer
of the moved files.

## Tests (wire into npm test)
- Contract: WA adapter + a mock adapter both satisfy the interface.
- Inbound parity: a fixed WA payload yields the same stored message + same reply
  trigger as before.
- Non-text + status callbacks handled as before.
- dispatchOutbound -> WA sender, returns externalId; send failure propagates.
- Registry: getAdapter(unknown) and dispatchOutbound(unknown) throw.
- Boot: adapters registered before listen.
- ALL 53 existing tests pass with zero assertion edits.

## Acceptance criteria
1. Interface + envelope + registry + dispatchOutbound defined.
2. WhatsApp is an adapter under modules/channels/whatsapp implementing the interface.
3. Inbound text/non-text/status handled identically; message.received published.
4. Outbound via dispatchOutbound, identical behavior, returns externalId.
5. GET handshake preserved; app boots; adapters registered before serving.
6. Unknown channel throws (no silent drop).
7. 53 existing tests green unchanged + new tests green.
8. No migration; no invariant touched; no behavior change.

## Rollback
git revert the commits. No DB to undo. Files return to prior locations.

## Commits (atomic, Conventional, my git identity)
1. feat(channels): define ChannelAdapter interface, InboundEnvelope, registry + dispatchOutbound
2. refactor(whatsapp): relocate routes/controller/sender/ownerCommands into modules/channels/whatsapp as an adapter
3. chore: update imports and bootstrap registration for relocated whatsapp module
4. refactor(channels): route WhatsApp outbound through dispatchOutbound
5. feat(channels): publish normalized message.received on inbound
6. test(channels): adapter contract + inbound/outbound parity tests

## Finish with
A <=12-line summary: the move map (old path -> new path), confirmation the 53
existing tests pass unchanged, what the adapter interface looks like, and the
deploy note: PR5 has no migrations but its code writes PR4 columns, so in the
batched deploy migrations 014->017 apply before PR3-PR5 code; the wamid column
drop stays in a later batch.
```

---

## 16. Deferred-deploy note (carried forward)

When the batch deploys: migrations **014 → 015 → 016 → 017** first, then PR3–PR5 code, then flip `IDENTITY_RESOLUTION_ENABLED` after the identity parity check. The `wamid` **column** drop (PR8) is excluded from this batch and gets its own production verification window. PR5 adds nothing to roll back at the DB level.

---

## Note for PR6

PR5 leaves a tested `ChannelAdapter` seam + `dispatchOutbound`. PR6 is **gated on M0** — the Telugu/Hindi voice spike must pass before any voice code is written. PR6 then defines the separate `VoiceProvider` interface (Retell call lifecycle, in-call tools, `call_sessions` / migration 018-real) and reuses this seam for the message/timeline model. If M0 has not passed, do not start PR6.
