# Zyon V2 — Implementation Specification

> Status: Final pre-implementation spec. This document guides every PR.
> Source: derived from the Codex review, the validated Claude review, and the established Zyon architecture. **File paths must be reconciled against the live repo during implementation** — the module mapping and decisions are authoritative; exact filenames are indicative.

---

## 0. Ground Rules (binding)

**This is evolution, not a rewrite.** V2 is three seams bolted onto a working codebase:
1. **Customer Identity** (channel-independent customer resolution)
2. **Channel Abstraction** (WhatsApp becomes one adapter; Voice becomes another)
3. **Voice Adapter** (integration layer over Retell — we do not build telephony)

**Preserve (do not touch):** idempotency (`wamid` dedup, `ON CONFLICT DO NOTHING`), advisory locks, `SKIP LOCKED`, the event bus with depth limiting (`MAX_DEPTH=5`), workflow claim-dedup (`rule_id, event_id`), error classification, the stuck-row reaper, pgvector + HNSW, multi-tenancy, the workflow engine, CRM, the crash-safe crons.

**Stack stays:** Node/Express, PostgreSQL (raw SQL), pgvector, event-driven, modular monolith.

**Out of scope — locked (both reviews agree these are premature):** PostgreSQL RLS, composite-FK enforcement, MFA, microservices/service extraction, durable inbox/outbox (until ~1000 tenants), multi-provider abstraction *beyond the interface seam*, circuit breaker, booking confirmation-token state machine, public versioned API, Redis session store, DLQ, cursor pagination. Build the **seam**, integrate **one** provider, refactor to swap only when there is a real second provider.

**Provider choices (locked):** Voice = **Retell AI** (fastest to production, ~620ms, HIPAA included, SIP to any telephony). Telephony = **Plivo or Exotel** (Indian local numbers + DLT). LLM = **Gemini 2.5 Flash** via the existing `ai_service`. Each sits behind an interface so it is replaceable later — but only one implementation ships.

---

## Phase 1 — Repository Map

| Current file (indicative) | Future module | Action | Reason |
|---|---|---|---|
| `server.js` | `app/bootstrap` | **Keep** + graceful shutdown, DB-ping health | Entry point is fine; carries 2 launch fixes |
| `db.js` | `infra/db` | **Keep** + fix `rejectUnauthorized:false` | Pool fine; SSL verification is a launch fix |
| `webhookRoutes.js` | `modules/channels/whatsapp/routes` | **Refactor** | Signature length-check; becomes WA adapter route |
| `webhookController.js` | `modules/channels/whatsapp/adapter` | **Refactor** | Normalizes WA → channel-agnostic envelope; stores non-text |
| `whatsappService.js` | `modules/channels/whatsapp/sender` | **Keep** | WA send; idempotency already partial |
| `ownerCommandHandler.js` | `modules/handoff` | **Keep** + persist owner-dedup | TAKEOVER/MSG/DONE/STATUS; fix restart-dedup gap |
| `aiService.js` | `modules/ai/aiService` | **Keep** + retry/timeout | The LLM seam; add reliability only |
| `extractionHandler.js` | `modules/memory/writeback` | **Refactor** | Becomes channel-agnostic memory write-back |
| `appointmentService.js` | `modules/scheduling` | **Keep** | Server-side guards + `uniq_doctor_slot` are sufficient |
| `tenantService.js` | `modules/tenant` | **Keep** | Tenant + credential cache fine at this scale |
| `customerService.js` | `modules/identity` | **Refactor** | Becomes identity resolution incl. `channel_identifiers` |
| `conversationService.js` | `modules/memory` | **Refactor** | Channel-aware; fix `ON CONFLICT` missing `tenant_id` |
| `crmService.js` | `modules/crm` | **Keep** | CRM stays |
| `knowledgeService.js` | `modules/knowledge` | **Keep** | RAG fine; HNSW exists in migration 004 |
| `workflowEngine.js` | `modules/workflow` | **Keep** + new event types | Engine stays; consumes voice events |
| `events.js` | `core/eventBus` | **Keep** | In-memory bus fine until ~1000 tenants |
| `reminderCron.js` | `modules/scheduling/reminders` | **Keep** + `LIMIT` | Reuse crash-safe cron; add batch cap |
| `collectionsCron.js` | `modules/collections` | **Keep** + `LIMIT` | Reuse; add batch cap |
| `adminRoutes.js` | `modules/admin` | **Keep** + session/cookie/rate-limit fixes | Single-operator panel; carries launch fixes |
| `public/admin/` | `apps/admin-ui` | **Keep** | Operator dashboard |
| `schema.sql` | `infra/db/schema.sql` | **Refactor** | Fresh-install DDL kept in sync with new migrations |
| `src/db/migrations/` | `infra/db/migrations` | **Keep** + new + runner (before 100) | Migrations continue |
| `scripts/` | `scripts/` | **Keep** | Utilities (encrypt, seed, ingest) |
| `tests/` | `tests/` | **Refactor** | Wire workflow tests into `npm test`; add identity/voice/channel tests |
| `web/` | `apps/web` | **Keep** | Marketing site (already isolated) |
| — | `modules/channels/` (abstraction) | **NEW** | Channel interface + registry |
| — | `modules/voice/` | **NEW** | Voice adapter + `VoiceProvider` interface |
| — | `modules/identity/channel_identifiers` | **NEW** | Cross-channel customer resolution |
| — | `modules/memory/customer_memory` | **NEW** | Cross-channel rolling memory |
| — | `modules/onboarding/` | **NEW** (deferred build) | Tenant provisioning pipeline |
| — | `modules/entitlements/` | **NEW** (seam now, enforce later) | Plan/limit config |

No file in the "Preserve" set is deleted. Nothing is moved in a big-bang; folders are introduced as modules are touched (see Phase 8).

---

## Phase 2 — Folder Structure (target; reached incrementally)

```
src/
  app/
    bootstrap.js            # express init, middleware, graceful shutdown, health
  core/
    eventBus.js             # existing in-memory bus (depth-limited)
    events.js               # event name constants + envelope schema
  infra/
    db/
      index.js              # pool (SSL verified)
      schema.sql            # fresh-install DDL
      migrations/           # ordered, single directory
    config/
      env.js                # validated env (required SESSION_SECRET, etc.)
    logging/
      logger.js             # redacted structured logging (pino) — added at ~500
  modules/
    tenant/                 # tenant record + credential cache
    identity/               # customers + channel_identifiers + resolution
    memory/                 # conversations, messages, customer_memory, writeback
    channels/
      index.js              # ChannelAdapter interface + registry
      whatsapp/             # adapter: routes, controller(adapter), sender, ownerCommands
      voice/                # (lives under modules/voice; channels/ holds the interface)
    voice/                  # VoiceProvider interface + retell/ adapter + tools
    ai/                     # aiService (LLM seam) + prompt templates
    scheduling/             # appointments + availability + reminders
    workflow/               # engine (unchanged) + new action types
    crm/                    # contacts, leads, stages
    knowledge/              # RAG ingest + retrieval
    notifications/          # outbound dispatch (WA/SMS/voice triggers)
    collections/            # payment reminders (unchanged logic)
    handoff/                # human takeover state
    admin/                  # operator routes + (later) tenant-facing auth
    onboarding/             # provisioning pipeline (deferred)
    entitlements/           # plan config + limit checks
  apps/
    admin-ui/               # existing operator dashboard
    web/                    # marketing site (isolated)
  scripts/
  tests/
```

**Why module folders:** each module owns its tables and exposes a thin service API; cross-module communication is via the event bus or explicit service calls — never reaching into another module's tables. This gives microservice-style boundaries with zero distributed-systems tax, and lets any module be extracted later if scale ever demands it.

---

## Phase 3 — Module Boundaries

Format per module: **Responsibilities · Public API · Events pub→sub · DB owned · Providers/cache.**

**Tenant** — Resolve tenant context; hold per-tenant config + encrypted channel credentials. API: `getTenant(id)`, `getTenantByChannel(channelType, providerRef)`. Pub: —. Sub: —. DB: `tenants`, channel-credential columns. Cache: 5-min decrypted-credential cache (existing; add invalidation endpoint before 100).

**Identity** — Resolve any channel identifier to a single customer; create on first contact. API: `resolveCustomer({tenantId, channelType, identifier, profile})` → `customer`, `getTimeline(customerId)`. Pub: `customer.created`, `customer.identified`. Sub: —. DB: `customers`, **`channel_identifiers`**. Cache: none (indexed lookups).

**Memory** — Channel-agnostic conversation + message storage; rolling per-customer summary + embeddings; the write-back loop. API: `appendMessage(envelope)`, `getOpenConversation(tenantId, customerId, channel)`, `getMemory(customerId)`, `writeBack(conversationId)`. Pub: `memory.updated`, `message.received`. Sub: `call.ended`, `conversation.idle`. DB: `conversations`, `messages`, **`customer_memory`**. Provider: `ai_service` (summary + embeddings), pgvector.

**Channels (abstraction)** — Define the `ChannelAdapter` contract; normalize inbound to a common envelope; route outbound to the right adapter. API: `register(adapter)`, `dispatchOutbound({tenantId, customerId, channel, payload})`. Pub: `message.received` (normalized). Sub: `notification.requested`. DB: none. Providers: each adapter.

**WhatsApp adapter** — Implement `ChannelAdapter` for WA Cloud API; verify webhook; normalize inbound (incl. non-text → stored with type + media ref); send within the 24h window with template fallback; owner commands. API: implements adapter. Pub: `message.received`. Sub: `notification.requested(channel=whatsapp)`. DB: WA-session columns. Provider: WhatsApp Cloud API. (Carries the signature length-check + non-text fixes.)

**Voice (adapter + provider)** — Implement `VoiceProvider` (Retell); manage call lifecycle; serve in-call tools; persist sessions. See Phase 4. Pub: `call.started`, `call.ended`, `intent.detected`. Sub: `call.requested` (outbound). DB: **`call_sessions`**. Provider: Retell + Plivo/Exotel.

**AI** — Single LLM seam; build prompt (tenant persona + injected memory + KB); execute tool loop (`loops<5` guard exists); structured extraction. API: `generateReply(ctx)`, `summarize(text)`, `embed(text)`, `extract(text, schema)`. Add: bounded retry + timeout. Provider: Gemini 2.5 Flash.

**Scheduling** — Availability, booking (server-side validated; `uniq_doctor_slot`), reminders. API: `getAvailability`, `bookAppointment` (transactional), `cancel`, `claimDueReminders(LIMIT)`. Pub: `appointment.booked`, `appointment.cancelled`, `reminder.due`. Sub: `intent.detected(book)`. DB: `appointments`, availability, reminder tables.

**Workflow** — Match rules to events; execute actions with claim-dedup + depth limit. API: `evaluate(event)`. Pub: `action.requested`. Sub: any domain event. DB: `workflows`, `workflow_runs`.

**CRM** — Contacts/leads/stages, auto-updated from memory. API: `upsertContact`, `updateStage`. Pub: `lead.updated`. Sub: `memory.updated`. DB: `crm_*`.

**Knowledge** — Ingest docs; retrieve top-k (HNSW). API: `ingest(tenantId, doc)`, `retrieve(tenantId, query, k)`. Pub: —. Sub: —. DB: `knowledge_chunks` (+ HNSW). Provider: embeddings.

**Notifications** — Turn domain events into outbound messages on the right channel. API: `request({tenantId, customerId, channel, template, vars})`. Pub: `notification.requested`. Sub: `appointment.booked`, `call.ended`, `reminder.due`. DB: outbound queue.

**Collections** — Unchanged crash-safe payment reminders. (Add `LIMIT`.) Reuses advisory locks + reaper.

**Handoff** — Human-takeover state per conversation. API: `takeover`, `release`, `status`. DB: handoff columns (evolve `active_handoff_customer` → join table before 100 for multi-customer).

**Admin** — Operator routes (existing) + later tenant-facing auth via the existing `users` table. Carries session/cookie/rate-limit fixes.

**Onboarding** (deferred) — Provisioning pipeline (Phase 9).

**Entitlements** (seam now) — Plan config + `checkLimit(tenantId, resource)`; usage counters. Enforcement wired at Phase 13; config defined early so call sites can reference it.

---

## Phase 4 — Voice Module

**We integrate, we do not build telephony.** Retell runs the real-time audio loop (STT/LLM/TTS, turn-taking, barge-in). We provide per-tenant configuration and in-call tools, and we persist outcomes.

### VoiceProvider interface (one implementation: Retell)

```
interface VoiceProvider {
  // provisioning (onboarding)
  createAgent(tenant): Promise<{ providerAgentId }>
  updateAgent(providerAgentId, config): Promise<void>
  attachNumber(providerAgentId, phoneNumber): Promise<void>

  // outbound
  startOutboundCall(args: {
    tenantId, customerId, toNumber, providerAgentId, contextVariables
  }): Promise<{ providerCallId }>

  // inbound + lifecycle (provider → our webhook)
  verifyWebhook(req): boolean
  parseEvent(payload): VoiceEvent   // → { type: 'call.started'|'call.ended'|'tool.invoked'|'transcript.turn', ... }

  endCall(providerCallId): Promise<void>
  getRecording(providerCallId): Promise<string /* url */>
}
```

Everything above the interface emits **normalized** events into the existing event bus. The rest of the platform never knows it's Retell.

### Inbound flow
1. Customer calls the clinic's Plivo/Exotel number → SIP-routed to the Retell agent.
2. Retell answers; on call start it hits our **inbound webhook** → `Identity.resolveCustomer(by caller number)` → `Memory.getMemory(customerId)` → we return dynamic variables (caller name, last visit, open appointment) so the agent greets with context. *(Cross-channel recall starts here.)*
3. During the call the agent invokes **tools** (HTTP functions → our endpoints): `lookup_customer`, `get_availability`, `book_appointment` (reuses `appointmentService` — server-side validated, `uniq_doctor_slot` prevents double-book), `escalate_to_human`, `take_message`.
4. Call ends → Retell sends `call.ended` + transcript + recording URL → we persist `call_sessions`, emit `call.ended` → **Memory write-back** (summarize + embed, async, off the hot path), **Workflow** evaluation, **CRM** update, and a **post-call WhatsApp** confirmation via Notifications (24h-window/template-aware).

### Outbound flow
`reminder.due` / `workflow action: place_call` → `Notifications`/`Voice.startOutboundCall` with context variables → same tool surface → same `call.ended` write-back.

### Conversation state, interruptions, latency
- **State** is owned by the provider during the call; we hold only `call_sessions` (status, transcript, recording) and the injected/returned context. Our DB is not in the real-time loop.
- **Interruptions / barge-in / turn-taking:** provider-handled. We build none of it.
- **Latency rule:** in-call **tool webhooks must return < ~400ms** — single indexed query, no embedding, no LLM, no cross-service fan-out. All heavy work (summary, embeddings, CRM, notifications) runs **after** `call.ended`, reusing the existing off-hot-path extraction pattern.

### Handoff / voicemail / recordings
- **Handoff:** `escalate_to_human` tool → notify owner (Notifications) immediately; optional warm transfer to a staff number via the provider. Reuse the existing handoff state model.
- **After-hours / voicemail:** agent configured with business hours; outside hours it **books or takes a message** (`take_message` → store + notify) — never a dropped call.
- **Recordings:** store `recording_url` on `call_sessions`. **Compliance note:** call-recording consent and retention must be handled per Indian norms — add a disclosure at call start and a retention policy; surface in the Privacy Policy.

---

## Phase 5 — Customer Identity & Shared Memory

**Center of the system.** A customer is one entity per tenant; channel identifiers resolve to it.

### Resolution algorithm
```
resolveCustomer(tenantId, channelType, identifier, profile?):
  row = SELECT customer_id FROM channel_identifiers
        WHERE tenant_id=$1 AND channel_type=$2 AND identifier=$3
  if row: return customers[row.customer_id]
  # phone is the cross-channel join key for clinics
  if channelType in ('voice','whatsapp','sms'):
     c = SELECT * FROM customers WHERE tenant_id=$1 AND phone=$identifier
     if c:
        INSERT channel_identifiers(tenant_id, c.id, channelType, identifier)  # link
        return c
  c = INSERT customers(tenant_id, phone?, name from profile)   # create
  INSERT channel_identifiers(tenant_id, c.id, channelType, identifier)
  emit customer.created
  return c
```
Phone number is the practical cross-channel key for clinics (the same number calls and WhatsApps). Email/IG handles attach as additional identifiers over time.

### Conversation timeline & memory
- **Timeline:** all `messages` (every channel) + `call_sessions`, ordered by time, per `customer_id` → one unified history.
- **Memory:** `customer_memory` holds a rolling summary + embedding per customer. **Write-back** runs after each call/conversation: summarize the latest exchange, merge into the rolling summary, re-embed. **Retrieval** runs at the start of each new interaction (call or chat): load structured CRM fields + the rolling summary + top-k semantic recall, inject into the prompt/agent context.

### How Voice and WhatsApp stay synchronized
Both adapters call `resolveCustomer` → same `customer_id`. Both write `messages`/`call_sessions` against that id. Both trigger write-back into the same `customer_memory`. So when the customer who called yesterday sends a WhatsApp today, retrieval injects the call summary into the WhatsApp reply — and vice versa. **The synchronization is the shared customer + shared memory, not channel-to-channel plumbing.** This is the V2 differentiator, and it falls out of the data model for free.

---

## Phase 6 — Workflow Integration (event-driven)

No new orchestration layer — new event types on the existing bus, consumed by the existing engine.

| Trigger | Event published | Consumer | Action |
|---|---|---|---|
| Voice call resolves an intent | `intent.detected` | Workflow / Scheduling | Book, route, tag |
| Call ends | `call.ended` | Memory, CRM, Notifications | Write-back, lead update, WA summary |
| Workflow needs to call someone | `call.requested` | Voice | `startOutboundCall` |
| CRM lead stage changes | `lead.updated` | Notifications/Workflow | Trigger WA/voice follow-up |
| Reminder falls due | `reminder.due` | Notifications/Voice | Outbound WA **or** voice reminder |
| Appointment booked | `appointment.booked` | Notifications | WA confirmation |
| Inbound message (any channel) | `message.received` | AI/Workflow | Reply, rule match |

Rules stay declarative; the engine's claim-dedup (`rule_id, event_id`) and depth limit (`MAX_DEPTH=5`) already prevent loops and double-execution. "Reminder → voice" and "CRM → WhatsApp" are just rules whose action targets a different channel adapter.

---

## Phase 7 — Database Migrations

Continue the ordered single directory (`…/migrations`), numbering from the current head (assume `011+`). **Expand-contract** for renames so there is zero regression. Adopt a migration runner (`node-pg-migrate`) before multi-environment — but these can apply in the current manual flow first.

| # | Migration | Purpose | Risk | Rollback | Compatibility |
|---|---|---|---|---|---|
| 011 | `channel_identifiers` table | Cross-channel resolution | Low (additive) | `DROP TABLE` | None broken; new reads only |
| 012 | Backfill `channel_identifiers` | Link existing customers' phones as `whatsapp` ids | Low-med (data) | Delete inserted rows | Reads dual-source until cutover |
| 013 | `conversations`: add `channel` (default `whatsapp`); fix partial unique → `(tenant_id, customer_id) WHERE status='open'` | Channel-aware convos; fix logical inconsistency | Med (index recreate) | Revert default + index | Default keeps old rows valid |
| 014 | `messages`: add `channel` (default `whatsapp`), `direction`, `external_id` (backfill = `wamid`); add `message_type` + media ref; unique `(tenant_id, channel, external_id)` | Channel-agnostic + non-text storage | Med | Drop new cols | Dual-write `external_id` + `wamid` during transition |
| 015 | `call_sessions` table | Voice session records | Low (additive) | `DROP TABLE` | None broken |
| 016 | `customer_memory` table + HNSW index | Cross-channel rolling memory | Low (additive) | `DROP TABLE` | None broken |
| 017 | `messages`: drop `wamid` (post-cutover) | Complete the rename | Low (after verify) | Re-add col | Only after all writers use `external_id` |
| 018 | `tenants`: add `plan_id`; `usage_counters` table | Entitlements seam | Low (additive) | Drop col/table | Default plan keeps tenants valid |

Order: 011 → 012 → 013 → 014 → 015 → 016 → **(code cutover to `external_id`)** → 017 → 018. Keep `schema.sql` (fresh installs) updated in lockstep.

---

## Phase 8 — Implementation Order (PR-sized)

Each PR: 1–3 days, independently deployable, zero regression, clear acceptance. Existing WhatsApp flow stays behind a feature flag until parity is proven.

**M0 — Voice de-risk spike (GATE, ~3 days, not a repo PR).** Real Hindi + Telugu test calls via Retell + Plivo/Exotel. **Accept:** a human judges a Telugu call "good enough for a patient." *Nothing below starts until this passes.*

| PR | Objective | Files (indicative) | DB | Tests | Risk | Effort |
|---|---|---|---|---|---|---|
| 1 | Launch hardening A | `webhookRoutes`, `server`, `infra/config` | — | signature 401 test | Low | 1d |
| 2 | Launch hardening B | logging, `server`, health | — | health-down test | Low | 1d |
| 3 | Identity core | `modules/identity`, `customerService` | 011, 012 | resolution unit tests | Med (WA regression → flag) | 2–3d |
| 4 | Channel-agnostic storage | `conversationService`, `webhookController` | 013, 014 | non-text + dual-write tests | Med | 2d |
| 5 | Channel abstraction + WA adapter | `modules/channels/*` | — | adapter contract test | Med | 2d |
| 6 | VoiceProvider + Retell adapter | `modules/voice/*` | 015 | webhook parse tests | Med | 3d |
| 7 | Voice tools + inbound flow | `modules/voice/tools`, `scheduling` | — | tool contract tests | Med (booking) | 3d |
| 8 | Memory + write-back loop | `modules/memory/*`, `extractionHandler` | 016, 017 | write-back + recall tests | Med | 2–3d |
| 9 | Voice reliability + AI hardening | voice, `aiService`, crons, `adminRoutes` | — | handoff/after-hours; retry/timeout | Med | 2–3d |
| 10 | Outbound voice + reminders→voice | `notifications`, `reminderCron`, voice | — | outbound trigger test | Low | 2d |
| 11 | Clinic dashboard + tenant auth | `modules/admin`, `apps/admin-ui` | — | auth + isolation test | Med | 3d |
| 12 | Onboarding pipeline (deferred) | `modules/onboarding` | — | provisioning e2e | Med | 2–3d |
| 13 | Entitlements enforcement (deferred) | `modules/entitlements` | 018 | limit-check tests | Low | 2d |
| 14 | WhatsApp re-join (gated on Meta) | `channels/whatsapp` | — | cross-channel memory test | Low | 1–2d |

**Critical path to first paying clinic on voice:** M0 → PR1 → PR2 → PR3 → PR4 → PR6 → PR7 (≈ 4–6 weeks solo). PRs 5, 8, 9 harden it; 10–14 expand. PRs 12–13 are **deferred until after the first clinics**.

---

## Phase 9 — SaaS Onboarding (target: < 1 hour, deferred build)

Goal: a repeatable provisioning pipeline; manual/concierge first, automated later.

Steps (each an idempotent provisioning function, runnable as a script then a wizard):
1. **Tenant creation** — insert `tenants`, generate keys, set `plan_id`.
2. **Voice config** — `VoiceProvider.createAgent` from a vertical template (clinic persona, tools), set business name/services.
3. **Prompt config** — render system prompt from template + tenant details (hours, doctors, booking rules, escalation policy, "never give medical advice" guardrail).
4. **Knowledge base** — `Knowledge.ingest` the clinic's docs (services, FAQs, pricing sheet).
5. **Phone number** — provision/port a Plivo/Exotel number; `attachNumber`; configure SIP to the agent. *(Number provisioning + DLT is the slowest manual step — keep it human-assisted initially.)*
6. **Business hours / booking rules** — write to scheduling config.
7. **CRM setup** — seed stages/fields for the vertical.
8. **Test** — automated test call + test WhatsApp; assert booking writes a row.
9. **Activate** — flip tenant live; route real traffic.

Automate 1–4, 6, 7, 8; keep 5 (telephony/DLT) and 9 (go-live check) human-gated until volume justifies full automation. **Do not build the wizard before ~10 clinics are onboarded by hand** — the manual runbook teaches what to automate.

---

## Phase 10 — Pricing Architecture (config, not code)

Plans are **data**, not branches. A `plans` config (JSON or table) defines limits/features; `tenants.plan_id` points to one; `Entitlements.checkLimit(tenantId, resource)` reads the config; `usage_counters` meters consumption. **Upgrading = change `plan_id`.** No code change to add/alter a plan.

| Plan | Voice min/mo | Channels | Workflows | KB | Users | Integrations | Analytics | Support | Indicative ₹/mo |
|---|---|---|---|---|---|---|---|---|---|
| Free/Trial | ~50 | Voice only | 1 | 1 doc set | 1 | — | Basic | Email | ₹0 (14-day) |
| Starter | ~500 | Voice + WA | 5 | Small | 2 | 1 | Standard | Email | quote (~₹10–15k) |
| Growth | ~2,000 | + SMS | 20 | Medium | 5 | 3 | Advanced | Priority | quote |
| Professional | ~6,000 | + Email/IG | Unlimited | Large | 15 | Many | Full + export | Priority + onboarding | quote |
| Enterprise | Custom | All + future | Custom | Custom | Custom | Custom | Custom + SLA | Dedicated | custom |

Voice minutes metered against the plan; overage billed per-minute (pass-through + margin). **Per our GTM call, publish *structure* not numbers early — quote in the demo.** The architecture deliverable is the entitlements seam; the numbers stay flexible. **Build enforcement at PR13, not before** — early clinics are hand-configured.

---

## Phase 11 — Scalability (only justified changes)

**~100 tenants (now):** current single-process modular monolith is correct. Apply the launch fixes (Phase 8 PR1–2) and the cron `LIMIT` + Gemini retry (PR9). In-memory event bus, in-memory cron locks (advisory), and idempotent inserts are adequate. **Do nothing else.**

**~500 tenants:** add **structured redacted logging** (pino + request IDs) for incident response; **per-tenant send throttling** on WhatsApp/voice so one large clinic can't starve others; adopt the **migration runner**; consider **PgBouncer** for pooling. Evaluate (don't assume) moving the event bus to a **transactional outbox** *only if* observed message-loss on crash is non-trivial.

**~1000 tenants:** **durable webhook inbox + worker queue** (BullMQ/Redis) so process crashes never lose events; **read replica** for analytics/dashboard reads; **horizontally scale** the stateless web tier and workers (crons already safe via advisory locks + `SKIP LOCKED`); voice concurrency scales on the **provider** (Retell), not us. Tenant-facing auth hardening (CSRF, rate limits) matures here as the dashboard becomes load-bearing.

**Never pre-build.** Each tier is triggered by a metric (crash-loss rate, p95 latency, tenant count), not a calendar. The reviews validated that the current substrate carries you to hundreds of tenants — spend the runway on clinics, not on 1000-tenant infrastructure you don't have the tenants for.

---

## Execution summary

- **Three seams** (Identity, Channels, Voice), everything else preserved.
- **18 migrations**, expand-contract, zero-regression.
- **14 PRs**, critical path to a paying clinic on voice ≈ 4–6 weeks solo, gated on the M0 Telugu spike.
- **Phases 9–11 documented but deferred** — onboarding automation, pricing enforcement, and 1000-tenant infra are post-traction, not pre-launch.
- **Next action:** run **M0**. Do not write PR3 until a Telugu call sounds good.
