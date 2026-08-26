# Conversation data model — audit

Filed: 2026-08-26
At commit: `474761b` (working tree carries the prior session's uncommitted
`shootD5b.js` fix and `state.md` edits)
Scope: **AUDIT ONLY.** No schema change, no migration, no route, no UI. Every
schema in §4 and every migration in §5 is **PROPOSED**, not written.

Three portal screens are proposed. They already exist as static demo pages, and
this audit uses those pages as the specification, because they are the only
concrete statement of what the screens contain:

| Screen | Demo page | Data file |
|---|---|---|
| Clinic Snapshot | `public/demo/dashboard.html` | `public/demo/dashboard.json` |
| Inbox | `public/demo/inbox.html` | `public/demo/inbox.json` |
| Patient Thread | `public/demo/index.html` | `public/demo/fixture.json` |

---

## The four findings that decide everything downstream

Stated up front so they are not buried.

1. **Voice and WhatsApp already converge, and the convergence is forced, not
   optional.** Both channels call the same `getOrCreateOpenConversation`
   (`conversationService.js:3-13`), whose `ON CONFLICT` arbiter is
   `(tenant_id, customer_id) WHERE status = 'open'` — **channel is not in the
   key.** A voice call from a customer with an open WhatsApp thread *reuses that
   thread's row*. "One patient · one thread · two channels" is not a thing to be
   built; it is the current behaviour. §3, §4.

2. **The English gloss is absent, and is not derivable.** No column stores it,
   no code produces it, and in the demo fixture it is **hand-authored** — the
   one field in `fixture.json`'s provenance block that is not marked *REAL*.
   Under the portal's standing rule that it never invents translation, the
   Patient Thread cannot show the gloss until something is built to produce it.
   §5 (Q5), §3.

3. **The portal has no conversational read surface at all.** Every one of the
   34 `/portal/api/*` routes is config, readiness, lifecycle, doctors, FAQs,
   test-turn or config history. The only conversation list and detail endpoints
   in the codebase are `/admin/api/conversations` and
   `/admin/api/conversations/:id`, behind the single operator password. §2 (Q2).

4. **Demo isolation is structural in the read direction and conventional in the
   write direction.** The demo pages cannot reach the database — they `fetch`
   sibling static JSON only. But two seed scripts write fabricated rows to
   whatever `DATABASE_URL` points at, under a hard-coded tenant UUID, with **no
   production refusal** of the kind `seed-portal-owner.js:92-93` already has.
   §7.

---

## 1. Current architecture — what exists, cited

### 1.1 Q1 — the complete `schema.sql` table inventory

23 tables (`grep -c '^CREATE TABLE' src/db/schema.sql` → 23), plus
`schema_migrations` which the runner creates at migrate time and which is not in
`schema.sql`.

| # | Table | Line | Purpose | Conversational? |
|---|---|---|---|---|
| 1 | `tenants` | `schema.sql:44` | the businesses; Meta credentials, legacy `ai_prompt`, lifecycle `status` | no |
| 2 | `users` | `:93` | dashboard/portal logins; scrypt hash, session epoch | no |
| 3 | `customers` | `:134` | the CRM contact record — phone, name, `preferred_language` | **yes — the patient identity** |
| 4 | `conversations` | `:163` | the thread; `mode` (ai/human), `status`, `channel`, rolling `summary` | **yes — the thread grouping key** |
| 5 | `messages` | `:205` | every turn in and out, both channels | **yes — the turns** |
| 6 | `tags` | `:235` | CRM labels per tenant | no |
| 7 | `customer_tags` | `:246` | many-to-many customer↔tag | indirectly |
| 8 | `customer_memory` | `:261` | long-term key/value facts about a customer | **yes — but see §1.4** |
| 9 | `knowledge_chunks` | `:289` | RAG corpus + `vector(768)` embedding | no (tenant knowledge, not patient) |
| 10 | `tenant_entities` | `:316` | flexible config store — doctor schedules | no |
| 11 | `appointments` | `:339` | bookings — doctor, time, status, reminder state | **yes — the outcome** |
| 12 | `notifications` | `:376` | log of owner alerts | indirectly |
| 13 | `handoff_sessions` | `:391` | log of owner interventions | **yes — the escalation record** |
| 14 | `leads` | `:409` | CRM pipeline, auto-extracted from messages | **yes — derived disposition** |
| 15 | `payment_schedules` | `:445` | collections / payment reminders | no |
| 16 | `workflow_rules` | `:480` | event-driven automation per tenant | no |
| 17 | `workflow_executions` | `:501` | audit log of rule firings | no |
| 18 | `channel_identifiers` | `:517` | cross-channel identity map | **yes — the channel join key** |
| 19 | `call_sessions` | `:539` | one row per phone call; per-call metadata | **yes — the voice envelope** |
| 20 | `tenant_configs` | `:575` | current versioned JSONB behaviour config | no |
| 21 | `tenant_config_revisions` | `:583` | append-only config history | no |
| 22 | `validation_runs` | `:598` | validation run log | no |
| 23 | `turn_traces` | `:620` | one mechanics row per AI turn — timings, retrieval, tool calls | **yes — turn mechanics, not content** |

`call_sessions`' own header comment states the design intent plainly
(`schema.sql:536-537`): *"one row per phone call. Turns live in `messages`; this
records per-call metadata."*

### 1.2 Q1 — the required one-line verdicts

| Item | Verdict |
|---|---|
| conversation / session | `conversations` (`schema.sql:163`) — one row per open thread per customer per tenant |
| individual turns | `messages` (`:205`) — one row per turn, both channels |
| turn text | `messages.content` (`:217`), `TEXT NOT NULL` |
| **language per turn** | **ABSENT.** Nearest: `customers.preferred_language` (`:143`, per *customer*) and `call_sessions.language_detected` (`:549`, per *call*). Neither is per turn. |
| channel (voice / WhatsApp) | `messages.channel` (`:212`, default `'whatsapp'`) and `conversations.channel` (`:168`) — but see §3 on `conversations.channel` being unreliable |
| patient identity | `customers` (`:134`); `UNIQUE (tenant_id, phone)` (`:149`) |
| phone number | `customers.phone` (`:138`); also `channel_identifiers.identifier` (`:522`), `call_sessions.from_number` / `to_number` (`:547-548`) |
| timestamps | `messages.created_at` (`:221`); `conversations.last_message_at` / `created_at` / `updated_at` (`:181-183`); `call_sessions.started_at` / `ended_at` / `duration_seconds` (`:552-554`) |
| handoff / escalation events | `handoff_sessions` (`:391`) — **but only ever written by the WhatsApp owner-command path, see §1.4** |
| appointments | `appointments` (`:339`) — `doctor_name`, `appointment_time`, `status`, reminder fields |
| **outcome / disposition** | **ABSENT.** `conversations.status` is `open`/`closed`/`pending` (`:173-174`) — a lifecycle state, not an outcome. Nearest proxies: `leads.stage` (`:421-422`) and `appointments.status` (`:349-350`). Neither says "AI handled" vs "needs staff". |
| `tenant_id` on each of the above | Present and `NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` on **every** conversational table: `customers:136`, `conversations:165`, `messages:207`, `customer_memory:263`, `appointments:341`, `handoff_sessions:393`, `leads:411`, `channel_identifiers:519`, `call_sessions:541`, `turn_traces:622`. |

Two exceptions to the project's *"every table has `tenant_id`"* rule, both
pre-existing and neither in scope here:

- `customer_tags` (`:246-252`) has **no** `tenant_id` — it is a pure join table
  on `(customer_id, tag_id)`, each of which is tenant-scoped by its parent.
- `workflow_executions.tenant_id` (`:503`) is `NOT NULL` but carries **no
  foreign key** to `tenants`, unlike every other table.

### 1.3 Q1 — every index and foreign key on anything conversational

**Foreign keys**

| Table | Column | → | On delete |
|---|---|---|---|
| `customers` | `tenant_id` | `tenants(id)` | CASCADE (`:136`) |
| `conversations` | `tenant_id` | `tenants(id)` | CASCADE (`:165`) |
| `conversations` | `customer_id` | `customers(id)` | CASCADE (`:166`) |
| `conversations` | `assigned_user_id` | `users(id)` | SET NULL (`:175`) |
| `messages` | `tenant_id` | `tenants(id)` | CASCADE (`:207`) |
| `messages` | `conversation_id` | `conversations(id)` | CASCADE (`:208`) |
| `messages` | `customer_id` | `customers(id)` | CASCADE (`:209`) |
| `customer_memory` | `tenant_id`, `customer_id` | `tenants`, `customers` | CASCADE (`:263-264`) |
| `appointments` | `tenant_id`, `customer_id` | `tenants`, `customers` | CASCADE (`:341-342`) |
| `handoff_sessions` | `tenant_id`, `customer_id` | `tenants`, `customers` | CASCADE (`:393-394`) |
| `leads` | `tenant_id`, `customer_id` | `tenants`, `customers` | CASCADE (`:411-412`) |
| `leads` | `conversation_id` | `conversations(id)` | **SET NULL** (`:413`) |
| `channel_identifiers` | `tenant_id`, `customer_id` | `tenants`, `customers` | CASCADE (`:519-520`) |
| `call_sessions` | `tenant_id`, `customer_id` | `tenants`, `customers` | CASCADE (`:541-542`) |
| `call_sessions` | `conversation_id` | `conversations(id)` | **SET NULL** (`:543`) |
| `turn_traces` | `tenant_id` | `tenants(id)` | CASCADE (`:622`) |
| `turn_traces` | `conversation_id` | `conversations(id)` | **SET NULL** (`:623`) |
| `turn_traces` | `call_session_id` | `call_sessions(id)` | **SET NULL** (`:624`) |

**Note the asymmetry.** `messages.conversation_id` CASCADEs, but
`call_sessions.conversation_id` and `turn_traces.conversation_id` SET NULL. So
deleting a conversation destroys its turns but *orphans* its call metadata and
its traces. `schema.sql:617-618` states the reason for `turn_traces` — *"probe
traces survive synthetic cleanup"* — which is deliberate, but it means a
Patient Thread joining `call_sessions` to `conversations` can find call rows
with a null `conversation_id`.

**Indexes**

| Index | Definition | Line |
|---|---|---|
| `idx_customers_tenant` | `customers(tenant_id)` | `:152` |
| *(unique)* | `customers UNIQUE (tenant_id, phone)` | `:149` |
| `idx_conversations_customer` | `conversations(customer_id)` | `:186` |
| `idx_conversations_tenant_status` | `conversations(tenant_id, status)` | `:187` |
| `idx_conversations_tenant_updated` | `conversations(tenant_id, updated_at DESC, id DESC)` | `:191` |
| `uniq_open_conversation` | **UNIQUE** `conversations(tenant_id, customer_id) WHERE status='open'` | `:194-196` |
| `idx_messages_conversation` | `messages(conversation_id, created_at)` | `:224` |
| `idx_messages_customer` | `messages(customer_id, created_at)` | `:225` |
| `uniq_msg_external` | **UNIQUE** `messages(tenant_id, channel, external_id) WHERE external_id IS NOT NULL` | `:228-229` |
| `idx_customer_memory_customer` | `customer_memory(customer_id)` | `:277` |
| `idx_appointments_tenant_time` | `appointments(tenant_id, appointment_time)` | `:361` |
| `uniq_doctor_slot` | **UNIQUE** `appointments(tenant_id, doctor_name, appointment_time) WHERE status='booked'` | `:364-366` |
| `idx_appointments_reminder_due` | `appointments(reminder_status, appointment_time) WHERE reminder_status='pending'` | `:368-370` |
| `idx_handoff_sessions_tenant` | `handoff_sessions(tenant_id)` | `:401` |
| `idx_handoff_sessions_active` | **UNIQUE** `handoff_sessions(tenant_id, customer_id) WHERE ended_at IS NULL` | `:402-403` |
| `idx_leads_tenant` / `idx_leads_tenant_stage` | `leads(tenant_id)` / `(tenant_id, stage)` | `:430-431` |
| `uniq_active_lead_per_customer` | **UNIQUE** `leads(tenant_id, customer_id) WHERE stage NOT IN ('converted','lost')` | `:434-436` |
| `idx_channel_identifiers_lookup` | `channel_identifiers(tenant_id, channel_type, identifier)` | `:528-529` |
| `idx_channel_identifiers_customer` | `channel_identifiers(customer_id)` | `:531-532` |
| *(unique)* | `channel_identifiers UNIQUE (tenant_id, channel_type, identifier)` | `:525` |
| `idx_call_sessions_tenant_customer` | `call_sessions(tenant_id, customer_id)` | `:559-560` |
| `idx_call_sessions_external` | `call_sessions(external_call_id)` | `:562-563` |
| `idx_turn_traces_tenant_created` | `turn_traces(tenant_id, created_at DESC)` | `:639` |
| `idx_turn_traces_conversation` | `turn_traces(conversation_id)` | `:640` |
| `idx_turn_traces_correlation` | `turn_traces(correlation_id)` | `:641` |

**Two index gaps that matter for the proposed screens**, both stated as facts
about the index list above, not as recommendations:

- There is **no `messages(tenant_id, created_at)`**. Every existing message
  index is scoped by `conversation_id` or `customer_id`. A tenant-wide
  time-range aggregate — which is what every Snapshot card is — has no index to
  ride.
- There is **no `call_sessions(tenant_id, started_at)`**. The only tenant-scoped
  call index is `(tenant_id, customer_id)`. "Calls this week" cannot use it.

---

## 2. Q2 — producers and consumers

### 2.1 Inbound WhatsApp, end to end

1. Meta POSTs to `/webhook`. Mounted at `server.js:26` with
   `express.raw({type:'application/json'})` so the body stays a Buffer for
   signature verification.
2. `whatsapp/routes.js:260` — `router.post('/', correlation, verifySignature, handle)`.
   `verifySignature` (`:23-51`) HMACs the raw body against `META_APP_SECRET`
   and parses to JSON.
3. `handle` (`:66`) responds **200 immediately** (`:67`) then processes.
4. **Status callbacks are discarded.** `:79-84`: when `value.messages` is empty
   and `value.statuses` is present, one `logger.info` fires carrying only
   `status` and `recipient_id`, then `continue`. **Nothing is written.** This is
   the C-5 answer — see §2.4.
5. Tenant resolved from `value.metadata.phone_number_id` via
   `tenantService.getByPhoneNumberId` (`:89`), 5-minute TTL cache.
6. Owner messages split out at `:100-118` and routed to `ownerCommands.handle`;
   customer messages continue.
7. `adapter.parseInbound` (`:124` → `whatsapp/adapter.js:46-72`) maps each Meta
   message to an `InboundEnvelope` — `identifier: msg.from`,
   `externalId: msg.id`, text extracted per type by `extractMessageContent`
   (`adapter.js:9-29`).
8. `handleInbound(envelopes)` (`:130` → `channels/index.js:51-116`) — **the
   channel-agnostic ingest**:
   - customer resolved (`index.js:60-67`) — `identityService.resolveCustomer`
     when `IDENTITY_RESOLUTION_ENABLED === 'true'`, otherwise
     `customerService.findOrCreate`. Both normalise to E.164; see §4.
   - conversation via `conversationService.getOrCreateOpenConversation(tenantId,
     customer.id, 'whatsapp')` (`:71-73`).
   - **inbound message INSERT** (`:79-89`) with
     `ON CONFLICT (tenant_id, channel, external_id) WHERE external_id IS NOT NULL
     DO NOTHING RETURNING id`; `rowCount === 0` means duplicate, skip (`:91-94`).
   - `MESSAGE_RECEIVED` emitted on the event bus (`:96-107`) carrying
     `channel` and `msg_type`.
9. Back in `routes.js`, per result: non-text messages get
   `UPDATE conversations SET last_message_at = NOW()` and stop (`:136-141`).
10. Text messages open a `turn_traces` collector (`:147-151`), re-read
    `conversations.mode` (`:155-158`), and stop if `mode === 'human'` or
    `!tenant.ai_enabled` (`:160-178`).
11. `assembleConversationContext` (`:184-191`) fetches RAG chunks, history and
    `customer_memory` facts.
12. `aiService.generateReply` (`:200-203`) with `channel: 'whatsapp'`.
13. `dispatchOutbound` (`:216-221`) sends, returning the wamid.
14. **outbound message INSERT** (`:233-239`) — `direction 'outbound'`,
    `sender 'ai'`, `channel 'whatsapp'`, `external_id = sentWamid`.
15. `trace.flush()` in the `finally` (`:245`).

**Written, per inbound WhatsApp text turn:** one `messages` row inbound, one
`messages` row outbound, `conversations.last_message_at`, `customers.last_seen_at`,
one `turn_traces` row, and — via the event bus — possibly one `leads` row.

### 2.2 Inbound voice, end to end

The Python worker is transport. The Node brain owns every write. Mounted only
when `VOICE_ENABLED === 'true'` (`server.js:31-35`).

**`POST /internal/voice/call/start`** (`internalVoice.js:764` → `handleCallStart:631`):
- HMAC over the raw body (`authenticate:30-46`), secret `VOICE_INTERNAL_SECRET`.
- Tenant checked active (`:639-642`).
- `identityService.resolveCustomer({channelType: channel /* 'voice' */,
  identifier: caller_id})` (`:645-649`) — **always** identity resolution, with no
  feature flag, unlike WhatsApp.
- `conversationService.getOrCreateOpenConversation(tenant_id, customer.id,
  'voice')` (`:652-654`) — **the same function WhatsApp calls.**
- `voiceChannelAdapter.startSession` (`:657-664`) →
  `callSessions.create` (`callSessions.js:27-36`) inserts the `call_sessions`
  row with `started_at = NOW()` and `status: 'in_progress'`
  (`voiceChannelAdapter.js:55`).
- Greeting built and returned; never allowed to fail the bridge (`:666-675`).

**`POST /internal/voice/turn`** (`:766` → `handleTurn:107`):
- Hydrates tenant, customer and conversation **from the `call_sessions` row**
  (`:159-186`). The comment at `:157-158` is explicit: *"The call_session is the
  canonical owner of all three."* The worker never resolves identity itself.
- Language via `customerService.resolveLanguage` (`:190`) — stored prior wins;
  STT detection is persisted only when the prior is null
  (`customerService.js:58-78`).
- **inbound message INSERT** (`:197-203`) — `channel 'voice'`, `msg_type 'text'`.
  **No `external_id`** — voice turns have no idempotency key.
- Same `MESSAGE_RECEIVED` event as WhatsApp (`:211-221`), `channel: 'voice'`.
- Same mode/`ai_enabled` gate (`:224-228`).
- Same `assembleConversationContext` (`:237-245`) — the comment at `:235` calls
  it *"the SAME helper the WhatsApp route uses"*.
- Same `aiService.generateReply`, `channel: 'voice'` (`:251-254`).
- **outbound message INSERT** (`:260-265`), then
  `UPDATE conversations SET last_message_at = NOW()` (`:266`).
- Reply is **returned** to the worker for TTS, not pushed (`:279`).

**`POST /internal/voice/call/end`** (`:765` → `handleCallEnd:709`): updates
`call_sessions` status / `ended_at` / `duration_seconds` through
`callSessions.updateStatus` (`callSessions.js:58-69`), guarded on
`status = 'in_progress'` so a duplicate end is an idempotent no-op
(`internalVoice.js:742-748`).

**Q3's sub-question — does "the Python worker is transport-only" hold for
persistence?** Yes, and more strongly than for reasoning. There is no database
access anywhere in the worker's path: it holds only `call_session_id` and posts
HMAC-signed JSON. Every `INSERT` and `UPDATE` on the voice path is in
`internalVoice.js` or `callSessions.js`, both Node. I found no exception.

### 2.3 What the brain persists per turn — nothing

`src/modules/ai/aiService.js` contains **zero** database calls. A grep for
`db.` and `require('...db')` in that file returns no lines. The brain is a pure
function of the context handed to it; all persistence is at the route boundary
(`messages`), in the trace collector (`turn_traces`), or in event-bus
subscribers (`leads`).

Two consequences worth stating:

- **`customer_memory` has no writer.** Across all of `src/` the table is
  *read* once — `contextAssembler.js:79` — and *counted* once, in the residue
  check at `scriptedTurnCheck.js:216`. **Nothing writes it.** The "long-term AI
  memory" described at `schema.sql:256-259` is, at HEAD, permanently empty
  unless something outside `src/` populates it.
- **`handoff_sessions` has exactly one writer**, and it is not the AI.
  `ownerCommands.js:98-104` (TAKEOVER), `:151-155` (MSG increments
  `message_count`), `:224` (DONE sets `ended_at`). All three are reached only by
  an **owner typing a text command over WhatsApp**. There is no automatic
  AI→human escalation anywhere, and no voice path to a handoff row at all.

### 2.4 Q2 — is the Meta `pricing` object persisted per message per tenant?

**No. ABSENT.**

Meta delivers `pricing` inside the `statuses[]` array of a status webhook. The
only place `value.statuses` is touched in this codebase is
`whatsapp/routes.js:79-84`:

```
if (!value.messages?.length) {
  if (value.statuses) {
    logger.info({ status: value.statuses[0]?.status,
                  recipientId: value.statuses[0]?.recipient_id },
                'webhook status update');
  }
  continue;
}
```

Two fields are logged from `statuses[0]`; the array is then discarded and the
loop continues. No table has a pricing, billing, `conversation_category`,
`billable` or `conversation_id`-from-Meta column — a grep for those terms across
`src/db/schema.sql` and all 26 migrations returns nothing. The `pricing` hits in
`src/` are all `config.pricing`, the *clinic's treatment price list*
(`config/schema.js:168`, `defaults.js:50`, `prompts/templates/clinic.js:112`) —
an unrelated concept that happens to share the word.

So C-5's requirement does **not** already exist. See §7.

### 2.5 Q2 — every `/api/` route that reads conversational data

**Portal (`/portal/api/*`, `src/portal/routes.js`) — 34 routes, and NOT ONE
reads conversational data.** Enumerated: `login`, `logout`, `me`, `readiness`,
`readiness/check`, `lifecycle/{activate,resume,pause}`, `onboarding` (×2),
`config/{identity,hours,pricing,booking,safety,receptionist}` (get+post each),
`protections`, `doctors` (×4), `faqs` (×3), `test/turn`, `knowledge-summary`,
`history` (×3). Config, readiness, lifecycle, knowledge, and a stateless test
turn. No `messages`, no `conversations`, no `customers`, no `appointments`.

**Admin (`/admin/api/*`, `src/admin/adminRoutes.js`)** — the only conversational
reads in the codebase, all behind `requireAuth` (single `ADMIN_PASSWORD`
operator session, not tenant-scoped):

| Route | Line | Reads |
|---|---|---|
| `GET /api/conversations` | `:398` | `conversations` ⋈ `tenants` ⋈ `customers`, with `message_count`, `array_agg(DISTINCT m.channel)`, and a lateral last-message preview |
| `GET /api/conversations/:id` | `:475` | meta + newest-500 `messages` (with `channel`, `direction`, `sender`, `msg_type`, `external_id`) + linked `call_sessions` |
| `GET /api/leads` | `:206` | `leads` |
| `GET /api/appointments` | `:278` | `appointments` |
| `GET /api/tenants/:id/reminders` | `:195` | `appointments` reminder state |
| `GET /api/notifications` | `:145` | `notifications` |
| `GET /api/traces`, `/api/traces/:turn_id` | `:992`, `:1026` | `turn_traces` |

**This is the single most reusable thing in the audit.**
`/admin/api/conversations` is already Inbox-shaped: it filters by `tenant_id`,
`status` and `channel` (the channel filter is an `EXISTS` over `messages`,
`:409-412`), keyset-paginates on `(updated_at, id)` (`:413-419`), and returns
per-conversation `channels: []` and an 80-character preview
(`previewOf:468-472`). `/admin/api/conversations/:id` is already Patient
Thread-shaped: ordered messages carrying `channel` per row, plus the
`call_sessions` for that conversation.

One other cross-channel read exists and is **unused by any route**:
`identityService.getTimeline(customerId)` (`identityService.js:150-169`) returns
every message for a customer across all conversations, ordered ascending. It
would be the natural Patient Thread query — except it **does not select
`m.channel`** (`:152-161`), so its output cannot distinguish a voice turn from a
WhatsApp message.

---

## 3. Q3 — do the two channels converge?

**Yes — at `conversations`, and unavoidably.**

The convergence point is one function:

```
conversationService.js:3-13
  INSERT INTO conversations (tenant_id, customer_id, channel)
  VALUES ($1, $2, $3)
  ON CONFLICT (tenant_id, customer_id) WHERE status = 'open'
  DO UPDATE SET updated_at = NOW()
  RETURNING *
```

The arbiter matches `uniq_open_conversation` (`schema.sql:194-196`), which is
`(tenant_id, customer_id) WHERE status='open'`. **`channel` is not in the
conflict key.** Both callers pass a channel that is only ever used on a genuine
insert:

- WhatsApp: `channels/index.js:71-73`, `envelope.channel` = `'whatsapp'`
- Voice: `internalVoice.js:652-654`, literal `'voice'`

So a returning customer's open thread is reused whichever channel they arrive
on. There is no divergence point to report — the convergence is at ingest, and
it is not opt-in.

**Where the model then becomes unreliable, and this is the finding:**

- **`conversations.channel` records only the channel that created the row.**
  `DO UPDATE SET updated_at = NOW()` never touches it. A thread opened by
  WhatsApp and continued by voice permanently reads `channel = 'whatsapp'`.
  `/admin/api/conversations/:id:518` returns this field as `channel`, and the
  list endpoint has evidently already worked around it — `:428` computes
  `array_agg(DISTINCT m.channel)` from `messages` instead of reading
  `c.channel`. **The per-message `channel` is the trustworthy one; the
  per-conversation `channel` is not.**
- **`messages.external_id` is WhatsApp-only in practice.** The WhatsApp path
  supplies it inbound (`channels/index.js:87`) and outbound
  (`routes.js:238`); the voice path supplies none at either
  `internalVoice.js:197-203` or `:260-265`. `uniq_msg_external` is partial
  (`WHERE external_id IS NOT NULL`, `schema.sql:228-229`), so voice rows are
  simply not covered by it. Voice turns have **no idempotency key**.
- **`appointments` is not linked to the conversation that produced it.** The
  INSERT at `appointmentService.js:368-372` writes only
  `(tenant_id, customer_id, doctor_name, appointment_time, status)`. There is no
  `conversation_id`, no `channel`, and no actor attribution. A booking can be
  attached to a *patient*, never to a *thread*.
- **`call_sessions.conversation_id` is nullable and SET NULL on delete**
  (`schema.sql:543`).

### Q3, restated for the record

| Question | Answer |
|---|---|
| Shared table? | Yes — `conversations` and `messages`, both channels |
| Shared model? | Yes — `getOrCreateOpenConversation`, `assembleConversationContext`, `aiService.generateReply` |
| Separate paths? | Only at the HTTP edge: `/webhook` vs `/internal/voice/*` |
| Divergence point | None at persistence. The edges converge at `channels/index.js:51` (WhatsApp) and `internalVoice.js:197` (voice), both writing `messages` |
| Worker transport-only for persistence? | **Confirmed.** Zero DB access on the Python side |

---

## 4. Q4 — identifiers

**Tenant / clinic identifier.** `tenants.id UUID PRIMARY KEY DEFAULT
gen_random_uuid()` (`schema.sql:45`). It reaches each write path differently:

- WhatsApp: resolved from `value.metadata.phone_number_id` →
  `tenantService.getByPhoneNumberId` (`routes.js:89`), backed by
  `tenants.phone_number_id UNIQUE` (`schema.sql:55`), 5-minute TTL cache.
- Voice: supplied in the `/call/start` body and validated against
  `tenants WHERE id = $1 AND active = true` (`internalVoice.js:639-641`); every
  subsequent turn re-derives it from the `call_sessions` row
  (`:159-165`) rather than trusting the worker.
- `tenants.slug UNIQUE` (`schema.sql:52`, migration 021) is the provisioning
  idempotency key — chosen over `phone_number_id` precisely because voice-first
  tenants may have none.

**Is a patient an entity, or just a phone string?** **An entity.** `customers`
(`schema.sql:134`) is a first-class row with `UNIQUE (tenant_id, phone)`
(`:149`), and every conversational table foreign-keys to `customers.id`, not to
a phone string. The one place a phone string is still used as an identity key is
`tenants.active_handoff_customer TEXT` (`:67`), read by `ownerCommands.js:120`
— a pre-existing wart, not on the thread path.

**Is there any thread / conversation grouping key today?** **Yes:
`conversations.id`**, and it is genuinely one-per-patient — enforced by the
partial unique index `uniq_open_conversation` (`schema.sql:194-196`). Every
message carries `conversation_id NOT NULL` (`:208`).

**Can a voice call and a WhatsApp thread from the same phone be joined?**
**Yes — automatically, and by two independent mechanisms.**

*Mechanism 1 — phone normalisation.* Both channels canonicalise to E.164 before
any DB operation:

- WhatsApp, flag off: `customerService.findOrCreate` calls
  `normalizePhone(phone)` at `customerService.js:5`.
- WhatsApp, flag on, and voice always: `identityService.resolveCustomer`
  normalises at `identityService.js:24-26` for any channel in
  `PHONE_CHANNELS = {whatsapp, voice, sms}` (`:10`).

`utils/phone.js:30-45` maps WhatsApp's bare-digit `wa_id` and voice's `+CC…`
`caller_id` onto the same string; its header comment (`phone.js:5-6`) states this
as the design goal. Both then hit `ON CONFLICT (tenant_id, phone)` on the same
unique index. **So the join happens even with `IDENTITY_RESOLUTION_ENABLED`
off** — the flag changes which code path resolves the customer, not whether the
two channels land on the same row.

*Mechanism 2 — `channel_identifiers`.* `identityService.js:47-88`: when a phone
channel resolves by phone fallback, it back-fills a
`channel_identifiers (tenant_id, customer_id, channel_type, identifier)` row
(`:67-72`) and emits `CUSTOMER_IDENTIFIED`. Subsequent arrivals hit the direct
lookup at `:29-37` first.

**Can the data model express "one patient · one thread · two channels" today?**

# YES.

- one patient — `customers`, `UNIQUE (tenant_id, phone)`, reached identically by
  both channels
- one thread — `conversations`, `uniq_open_conversation` on
  `(tenant_id, customer_id) WHERE status='open'`, **channel-blind**
- two channels — `messages.channel` per row, `'whatsapp'` or `'voice'`

`/admin/api/conversations/:id` already renders exactly this shape today
(`adminRoutes.js:493-510`): one conversation, its ordered messages each tagged
with a channel, and its `call_sessions`. The claim in the Patient Thread demo is
not aspirational about the *data model*. What is missing is everything on top of
it — see §5.

---

## 5. Q5 — what could power Patient Thread today

Given a real conversation that has actually occurred, element by element.

| Element | Backed by | Verdict |
|---|---|---|
| **patient name** | `customers.name` (`schema.sql:139`) | **REAL, often null.** WhatsApp fills it from the Meta profile — `adapter.js:56-57` extracts `contact.profile.name`, passed as `profile` and written at `identityService.js:107`. **Only on the identity path** — `customerService.findOrCreate` (the default, flag-off path) never writes `name` at all (`customerService.js:7-12`). Voice passes no `profile` (`internalVoice.js:645-649`), so a voice-first patient has `name = NULL` permanently. The demo's "Sravani Reddy" came from a seed constant (`capture_turn.js:44`), not from the channel. |
| **phone** | `customers.phone` (`:138`) | **REAL.** `NOT NULL`, E.164, unique per tenant. |
| **language** | `customers.preferred_language` (`:143`) | **REAL at the patient level; ABSENT at the turn level.** Written once by `customerService.resolveLanguage` (`customerService.js:67-75`) on first STT detection, guarded so a set prior is never overwritten. `call_sessions.language_detected` (`:549`) gives per-call granularity. **Nothing gives per-turn.** The demo's two-pane split — Telugu call, English WhatsApp — is representable per *call* but not per *message*. |
| **outcome** | — | **ABSENT.** `conversations.status` is `open`/`closed`/`pending` (`:173-174`), a lifecycle state. No column says "Appointment booked" vs "Needs staff". The demo's outcome card (`app.js:76-87`) is rendered from `fixture.appointment`, i.e. from the booking, not from an outcome field. |
| **doctor** | `appointments.doctor_name` (`:343`) | **REAL**, `TEXT NOT NULL`. |
| **date** | `appointments.appointment_time` (`:344`) | **REAL**, `TIMESTAMPTZ NOT NULL`. |
| **time** | same column | **REAL.** IST rendering is a presentation concern; `capture_result.json` shows it already being derived. |
| **booking status** | `appointments.status` (`:349-350`) | **REAL** — `booked` / `cancelled` / `rescheduled`. Note the demo's `fixture.appointment.status` is `booked`, and the schema has no `confirmed`. |
| **voice turns with timestamps** | `messages` WHERE `channel='voice'`, `content` + `created_at` (`:217`, `:221`) | **REAL.** Written at `internalVoice.js:197-203` (inbound) and `:260-265` (outbound). |
| **English gloss per turn** | — | **ABSENT — see below.** |
| **WhatsApp messages with timestamps** | `messages` WHERE `channel='whatsapp'` | **REAL.** |
| **"checked live availability"** | `turn_traces.tool_calls` (`:633`) | **REAL, with two caveats.** Populated from `metrics.recordToolExec` (`aiService.js:310`, `:449`) and written by `traces/writer.js:69`. Caveat 1: the row is aged out by `retentionCron.js:30-35` at the tenant's `retention_days` (default 365, `defaults.js:130`). Caveat 2: `turn_traces.conversation_id` is `ON DELETE SET NULL` (`:623`), so the link can be severed. The demo renders this from `fixture.call[].tools` (`app.js:96-98`), which corresponds to `capture_result.json`'s real `tools: [{name: "check_availability", …}]`. |

### The English gloss — the one to look at hardest

**Verdict: ABSENT. Not stored, not derivable, and hand-authored in the demo.**

Four independent lines of evidence:

1. **No column.** Grepping `translat`, `gloss`, `english_` and `transliterat`
   across `src/db/schema.sql` and all 26 files in `src/db/migrations/` returns
   **zero** hits.
2. **No producer.** The same grep across `src/` returns exactly two lines, both
   in `voice/providers/sarvam.js` — a doc-comment (`:14`) and the endpoint path
   `/speech-to-text-translate` (`:43`). And that call reads only
   `data.transcript` and `data.language_code` (`:46`). Even though the endpoint
   is Sarvam's *translate* endpoint, no English field is read from the response,
   and nothing downstream would have anywhere to put one.
3. **The machine-captured artifact has no gloss.** `scripts/demo/capture_result.json`
   — the real output of the real capture — contains `stt.transcript` and
   `turn.reply`, both Telugu, and **no `english_gloss` key anywhere.**
4. **The fixture's own provenance says so, by omission.**
   `public/demo/fixture.json`'s `provenance` block marks `caller_transcript`
   *"REAL. Sarvam Saaras STT output…Verbatim, never edited"*, `ai_reply`
   *"REAL. Output of aiService.generateReply…Verbatim, never edited"*, and
   `appointment` *"REAL appointments row (id 8667b5bc-…)"*. The `english_gloss`
   entry says only: *"Translations of the Telugu call lines, for display/reviewers
   only. The authoritative call text is the Telugu `text` field."* **It is the
   one field in the block not marked REAL.** The `whatsapp` entry is likewise
   marked *"HAND-AUTHORED English…illustrative."*

The demo renders it unconditionally at `public/demo/app.js:106` —
`<div class="turn__gloss">${esc(t.english_gloss)}</div>`.

**This is a hard blocker on the Patient Thread as drawn.** The portal's standing
rule is that it never invents vernacular or translation. A gloss column filled by
anything other than a real translation call would violate that rule; leaving the
gloss out changes what the screen is. The choice is a product decision, not a
schema one, and this audit does not make it. What it costs is sized in §5 (M-7)
and §8.

---

## 6. Q6 — what Inbox and Snapshot would require

### 6.1 Snapshot — the six cards

From `public/demo/dashboard.js:62-69` plus the language card at `:41-60`.

| # | Card | Query it needs | Data exists? |
|---|---|---|---|
| 1 | **Calls handled this week** | `COUNT(*) FROM call_sessions WHERE tenant_id=$1 AND started_at >= $2` — plus WhatsApp threads, since the demo's note says *"Voice + WhatsApp"* | **PARTIAL.** Voice: yes (`call_sessions.started_at`, `schema.sql:552`). WhatsApp has no session concept — a "conversation" would have to be defined as a burst of messages, which is a **new derived concept**, not a column. **No index**: `call_sessions` has only `(tenant_id, customer_id)`. |
| 2 | **Appointments booked by AI** | `COUNT(*) FROM appointments WHERE tenant_id=$1 AND created_at >= $2 AND booked_by='ai'` | **IMPOSSIBLE TODAY. Needs a new column.** `appointments` has no actor attribution — the INSERT at `appointmentService.js:368-372` writes five columns and none of them is *who*. Every row looks identical whether the AI booked it or a script did. `idx_appointments_tenant_time` is on `appointment_time`, not `created_at`, so even the time filter has no index. |
| 3 | **After-hours calls caught** | calls whose `started_at` falls outside the tenant's configured hours | **DERIVABLE, EXPENSIVE.** Needs `call_sessions.started_at` joined against `tenant_configs.config->'hours'` per row, in IST, honouring holidays. No column, no index, and the hours shape lives in JSONB. Correct but not cheap. |
| 4 | **Languages served** | `GROUP BY language` over the period | **PARTIAL.** Voice: `call_sessions.language_detected` (`:549`). WhatsApp: **nothing** — no per-message and no per-conversation language. `customers.preferred_language` is a patient-level prior, and using it would count *patients*, not *conversations*, which is a different number. |
| 5 | **Handled without staff %** | share of threads with no escalation | **EFFECTIVELY IMPOSSIBLE.** The only escalation record is `handoff_sessions`, written **exclusively** by the WhatsApp owner-command path (`ownerCommands.js:98-104`, `:151-155`, `:224`). Voice can never produce a row. `conversations.mode='human'` is the live-state proxy but is not a durable event — it flips back. |
| 6 | **Avg response time** | mean turn latency | **REAL but retention-bounded.** `turn_traces.stage_timings` carries `total_ms` (`schema.sql:629`), indexed by `idx_turn_traces_tenant_created` (`:639`). Aged out at `retention_days` (`retentionCron.js:30-35`). Good enough for a weekly card. |
| — | Calls-per-day bar row | `GROUP BY date_trunc('day', started_at)` | Same status as card 1 — voice yes, WhatsApp no, no index. |

**Snapshot verdict: 1 of 6 cards is real today (avg response time). 2 are
partial (calls, languages). 1 needs a new column (booked-by). 2 need a new event
concept (after-hours needs a derivation; handled-without-staff needs an
escalation event that voice can produce).**

### 6.2 Inbox — the list and the filters

The list (`inbox.js:52-82`) renders per thread: name, channel, language, status
(`handled` | `needs_staff`), an English snippet, and a timestamp. The filters
(`inbox.html:39-44`) are **All / Voice / WhatsApp / Needs staff**.

| Field | Query it needs | Data exists? |
|---|---|---|
| name | `customers.name` | **REAL, often null** — see §5. `/admin/api/conversations:451` already handles this with `customer_name \|\| customer_phone \|\| '—'`. |
| channel | `array_agg(DISTINCT m.channel)` over `messages` | **REAL.** Already implemented verbatim at `adminRoutes.js:428`. Do **not** read `conversations.channel` — §3. |
| language | — | **PARTIAL.** Same gap as Snapshot card 4. |
| **status: handled / needs_staff** | — | **IMPOSSIBLE TODAY. Needs a new column or table.** No column carries it. `conversations.status` is a lifecycle state; `conversations.mode` is a live toggle, not a disposition; `handoff_sessions` exists but only WhatsApp owner commands write it. |
| snippet | last message content | **PARTIAL.** `adminRoutes.js:433-437` already computes it with a `LEFT JOIN LATERAL`, and `previewOf:468-472` truncates to 80 chars and collapses non-text to `[type]`. **But the demo's snippets are English summaries, not verbatim text** — `inbox.json`'s own note says: *"Snippets are short English SUMMARIES of what the AI did — NOT verbatim transcripts, and NEVER fabricated Telugu."* A verbatim last message from a Telugu thread is Telugu. Producing an English summary is the same problem as the gloss. |
| timestamp | `conversations.updated_at` | **REAL**, and `idx_conversations_tenant_updated` (`:191`) already serves both the filter and the ordering with no Sort node. |

| Filter | Feasible? |
|---|---|
| All | **Yes** — `adminRoutes.js:407` |
| Voice | **Yes** — `EXISTS (SELECT 1 FROM messages WHERE conversation_id=c.id AND channel='voice')`, `adminRoutes.js:409-412` |
| WhatsApp | **Yes** — same |
| **Needs staff** | **No.** There is nothing to filter on. |

**Inbox verdict: the list is largely buildable today by tenant-scoping
`/admin/api/conversations`. Two of the four filters work. "Needs staff" — the
one filter that carries the product's value proposition — has no backing data
at all.**

### 6.3 The three gaps, classified as asked

| Gap | Impossible today | Needs a new column | Needs a new table |
|---|---|---|---|
| Turn language | ✓ | `messages.language` | — |
| English gloss / summary | ✓ | `messages.content_en` | — (but needs a producer; §5) |
| Booking attribution | ✓ | `appointments.booked_by`, `appointments.conversation_id` | — |
| Thread disposition (`handled`/`needs_staff`) | ✓ | `conversations.disposition` | — |
| Escalation as a durable event, voice included | ✓ | — | ✓ `conversation_events` |
| WhatsApp "session" for counting | ✓ | — | ✓ or a derivation rule |
| After-hours classification | derivable | — | — |

---

## 7. Q7 — demo / fixture isolation

**Where `public/demo/` lives and what serves it.** `public/demo/`, 15 files.
Served by `server.js:90` — `app.use(express.static(path.join(__dirname,
'public')))`. **No auth middleware.** It is mounted after `/portal` and
`/admin`, but `express.static` has no guard of its own, so `/demo/index.html`,
`/demo/inbox.html` and `/demo/dashboard.html` are publicly reachable on any
server that boots this file. Contrast `/admin`, whose static mount sits behind
the router's `requireAuth` (`adminRoutes.js:62`).

**Do the demo pages read any real endpoint?** **No — every byte is inline or
from a sibling static file.** A grep for `fetch(`, `XMLHttpRequest`,
`EventSource` and `WebSocket` across `public/demo/*.js` and `*.html` returns
exactly three calls:

- `app.js:140` → `fetch('./fixture.json')`
- `inbox.js:163` → `fetch('./inbox.json')`
- `dashboard.js:93` → `fetch('./dashboard.json')`

All three are relative paths to static JSON in the same directory. **No demo
page can reach the database, an API route, or anything with a tenant in it.**
That direction of isolation is structural and holds today.

**Do fixtures, seeds or test factories write to a database a production surface
could read?** **Yes — two of them, and this is the weak point.**

| Script | Target DB | Production guard |
|---|---|---|
| `scripts/seed_voice_test_customer.js` | `DATABASE_URL` verbatim (`:26`) | **NONE.** No `NODE_ENV` check anywhere in the file. Upserts tenant `11111111-1111-1111-1111-111111111111` (`:29`) with `business_name 'Smile Dental (Voice Dev)'` (`:37`), a doctor schedule, a customer, a `channel_identifiers` row, an open conversation and messages. |
| `scripts/demo/capture_turn.js` | `DATABASE_URL` verbatim (`:31`) | **NONE.** Same hard-coded tenant (`:39`). It does have a collision guard (`:56-63`) and purges + verifies residue afterwards (`capture_result.json.residue` is all zeros), but nothing stops it running against production. |
| `scripts/seed-portal-owner.js` | `DATABASE_URL` | **HAS ONE** — `:92-93`: *"NODE_ENV=production. This script writes a human-chosen password and will not run against production."* |
| The 17 scratch-minting test suites | a freshly-created scratch DB via `runner.genesis`, dropped after | structurally isolated (`tests/_support/testEnv.js:15-17`) |
| `scripts/portal/shoot*.js` | scratch DB, dropped in `finally` | structurally isolated |

So the pattern for a production refusal already exists in this repository, three
lines long, and the two demo/seed scripts do not have it.

**Is there an existing environment/mode flag distinguishing dev from prod?**
Yes — `process.env.NODE_ENV === 'production'`, used at `server.js:56`,
`portal/routes.js:65`, `db/db.js:24`, `migrate.js:83`, `logger.js:20` and
`seed-portal-owner.js:92`. It exists and is load-bearing; it is simply not
consulted by the two seed scripts.

### Could fabricated data reach a portal surface today, by any path?

| Path | Reachable? |
|---|---|
| Shared table | **Yes, in principle.** `seed_voice_test_customer.js` writes real `customers`/`conversations`/`messages` rows. They are indistinguishable from genuine rows — there is **no `is_synthetic`, `is_demo` or `source` column** on any conversational table. |
| Shared endpoint | **Yes, at the admin tier.** `/admin/api/conversations` with no `tenant_id` filter lists **every tenant's** conversations (`adminRoutes.js:407` makes `tenant_id` optional). A seeded demo tenant appears in that list. |
| Seeded tenant | **Yes.** Tenant `1111…1111` is hard-coded in both scripts and in `scriptedTurnCheck.js`'s neighbourhood; nothing marks it as non-production. |
| Fixture leakage | **Not into the portal, but into the marketing site.** `public/demo/fixture.json` is imported by `web/app/(marketing)/specimen/page.tsx:13` and `web/components/sections/Hero.tsx:12`, and is baked into the build output (`web/.next/server/app/(marketing)/page.js:22`). That is deliberate and documented (`state.md:2713`), and the fixture's Telugu is real — but the hand-authored `english_gloss` and `whatsapp` arrays ship with it. |
| Portal surface specifically | **Not today** — because the portal has no conversational read route at all (§2.5). **This safety is accidental.** It disappears the moment the first Inbox route is written. |

### The isolation guarantee that would have to hold

> **No row a portal surface can read may have been written by a fixture, seed,
> demo or test factory — and this must be true by construction, not by anyone
> remembering.**

**Current verdict: CONVENTIONAL, trending to ABSENT.**

- **Structural today:** demo *pages* cannot read the database (relative static
  `fetch` only); test suites cannot touch the dev DB (scratch-DB minting).
- **Conventional today:** the two seed scripts are kept off production by
  nobody running them there. There is no refusal, no marker column, and no
  tenant-level distinction.
- **Why it will fail:** the portal is currently safe only because it reads no
  conversational data. Section 6 proposes routes that read exactly that data.
  On the day the first one lands, the accidental guarantee is gone and only the
  convention remains.

**Can the current architecture provide the structural guarantee?** Yes, and
cheaply, because the seams already exist:

1. A `NODE_ENV=production` refusal in both seed scripts — the three-line pattern
   at `seed-portal-owner.js:92-93`, copied.
2. A tenant-level marker (`tenants.is_demo BOOLEAN NOT NULL DEFAULT false`, or a
   reserved slug) that every portal conversational query filters on, so the
   filter is one predicate in one place rather than a habit.
3. The scratch-DB pattern the test suites already use, extended to
   `capture_turn.js`, which would remove its need for a live DB entirely.

None of these is proposed as work here. They are stated because §7 asks whether
the architecture *can* provide it, and the answer is yes, with existing parts.

---

## 8. Proposed canonical conversation/thread schema — **PROPOSED ONLY**

**Nothing in this section is written. No migration file exists. No `schema.sql`
line is changed.**

The headline is that **no new canonical thread table is needed.** The audit's
own evidence (§3, §4) is that `customers` → `conversations` → `messages`
*already is* the canonical cross-channel model, and both channels already write
to it through one function. Proposing a parallel model would be building a
second version of something that works.

What is missing is per-turn attribution, a durable disposition, and booking
provenance. Additive columns plus one new event table cover all of it.

### P-1 · `messages` — per-turn attribution (columns, additive)

```sql
ALTER TABLE messages
  ADD COLUMN language   TEXT,        -- BCP-47-ish, e.g. 'te-IN'; NULL = unknown
  ADD COLUMN content_en TEXT;        -- English rendering; NULL = none produced
```

- `language` is written by both paths at the existing INSERT sites:
  `internalVoice.js:197-203` already has `effectiveLanguage` in scope one line
  earlier (`:190`); the WhatsApp path would carry it on the envelope.
- `content_en` is **nullable by design and must stay nullable**. NULL means *no
  translation was produced*, and the UI must render nothing rather than
  substitute the vernacular. This is the schema-level expression of the
  never-invent-translation rule. Filling it requires a translation producer that
  does not exist today — see M-7.
- Backfill: none possible for `language` on historical rows, and none should be
  attempted. Historic turns read NULL, which is honest.

### P-2 · `conversation_events` — the durable event log (new table)

The one genuinely new object. It exists because escalation, handoff and
disposition are *events*, and the only event record today
(`handoff_sessions`) is customer-scoped, WhatsApp-only, and reachable solely by
an owner typing a command.

```sql
CREATE TABLE conversation_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id)        ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id)  ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id)      ON DELETE CASCADE,
  call_session_id UUID          REFERENCES call_sessions(id)  ON DELETE SET NULL,

  type      TEXT NOT NULL,          -- 'escalated' | 'handled' | 'booked'
                                    -- | 'handoff_started' | 'handoff_ended'
  channel   TEXT NOT NULL,          -- 'whatsapp' | 'voice' — open set, as turn_traces.channel
  actor     TEXT NOT NULL           -- who caused it
              CHECK (actor IN ('ai', 'agent', 'system', 'customer')),
  detail    JSONB,                  -- type-specific; never free patient text
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversation_events_conversation
  ON conversation_events(conversation_id, created_at);
CREATE INDEX idx_conversation_events_tenant_type_created
  ON conversation_events(tenant_id, type, created_at DESC);
```

- `ON DELETE CASCADE` on `conversation_id`, deliberately unlike `turn_traces`
  (`schema.sql:623`). These are business events about a thread; if the thread is
  gone they are not evidence of anything, and under §9's retention concern they
  should go with it.
- `detail` must not carry patient utterances. Keeping conversational text
  confined to `messages` is what makes a future retention sweep tractable.
- Both channels can write it: voice at `internalVoice.js`, WhatsApp at
  `whatsapp/routes.js`, and the existing `MESSAGE_RECEIVED` bus already carries
  `channel` (`channels/index.js:105`, `internalVoice.js:219`).

### P-3 · `conversations` — the denormalised current disposition (column)

```sql
ALTER TABLE conversations
  ADD COLUMN disposition TEXT NOT NULL DEFAULT 'open'
    CHECK (disposition IN ('open', 'handled', 'needs_staff', 'booked'));

CREATE INDEX idx_conversations_tenant_disposition_updated
  ON conversations(tenant_id, disposition, updated_at DESC, id DESC);
```

Strictly a materialised read of the latest `conversation_events` row.
`conversation_events` is the truth; this column is what makes the Inbox's
"Needs staff" filter one index scan instead of a correlated subquery. The index
mirrors `idx_conversations_tenant_updated` (`schema.sql:191`) so it serves the
`WHERE` and the `ORDER BY` together, which is the reason that index is shaped
the way it is.

### P-4 · `appointments` — booking provenance (columns, additive)

```sql
ALTER TABLE appointments
  ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN booked_by       TEXT NOT NULL DEFAULT 'unknown'
    CHECK (booked_by IN ('ai', 'agent', 'system', 'unknown'));

CREATE INDEX idx_appointments_tenant_created
  ON appointments(tenant_id, created_at DESC);
```

- `booked_by` is Snapshot card 2, which is impossible without it.
- `'unknown'` is the default precisely so historical rows are not retroactively
  claimed as AI bookings. A truthful Snapshot must exclude them, not assume.
- `conversation_id` is SET NULL rather than CASCADE: a booking outlives the
  thread that produced it, and deleting the thread must not delete the
  appointment.
- The new index exists because `idx_appointments_tenant_time`
  (`schema.sql:361`) is on `appointment_time`, and "booked this week" filters on
  `created_at`.

### P-5 · `call_sessions` and `conversations.channel` — no change, one rule

No schema change. One rule, to be honoured by every new query:

> **Derive a thread's channels from `messages.channel`, never from
> `conversations.channel`.**

`conversations.channel` records only the creating channel and is never updated
(§3). `/admin/api/conversations:428` already does the right thing with
`array_agg(DISTINCT m.channel)`; the portal routes must copy that, not the
`c.channel` read at `:518`.

### P-6 · Index additions for Snapshot

```sql
CREATE INDEX idx_messages_tenant_created    ON messages(tenant_id, created_at DESC);
CREATE INDEX idx_call_sessions_tenant_started ON call_sessions(tenant_id, started_at DESC);
```

Both gaps are identified in §1.3. Every Snapshot card is a tenant-wide
time-range aggregate, and neither table has an index for one today.

### How voice and WhatsApp both write to it

They already do, through the seam that exists. Nothing about the ingest topology
changes:

| Write | WhatsApp site | Voice site |
|---|---|---|
| `messages` (+ `language`, `content_en`) | `channels/index.js:79-89` inbound, `whatsapp/routes.js:233-239` outbound | `internalVoice.js:197-203` inbound, `:260-265` outbound |
| `conversation_events` | `whatsapp/routes.js`, on the `mode==='human'` branch at `:160-178` | `internalVoice.js`, on the equivalent branch at `:224-228` |
| `conversations.disposition` | one shared helper, called from both | same helper |
| `appointments.conversation_id` / `booked_by` | `appointmentService.js:368-372` — one INSERT, both channels reach it | same |

`appointments` is the cleanest case: there is exactly **one** booking INSERT
site (plus its reschedule twin at `:514-518`), reached identically from both
channels, so provenance is a two-column change at one place.

---

## 9. Required migrations and API changes — enumerated and sized

### Migrations — **PROPOSED, NONE WRITTEN**

Numbering continues from `027_password_changed_at.sql`. Per the lockstep rule in
`CLAUDE.md`, each ships with the matching `schema.sql` edit in the same change.

| # | File | Contents | Size |
|---|---|---|---|
| M-1 | `028_message_language.sql` | P-1: `messages.language`, `messages.content_en` | **XS** — two nullable `ADD COLUMN`s, no rewrite, no backfill |
| M-2 | `029_conversation_events.sql` | P-2: the table + two indexes | **S** — one new table, no data movement |
| M-3 | `030_conversation_disposition.sql` | P-3: column + composite index | **S** — `NOT NULL DEFAULT` is metadata-only on PG 11+; the index build is the cost |
| M-4 | `031_appointment_provenance.sql` | P-4: two columns + `idx_appointments_tenant_created` | **S** |
| M-5 | `032_conversation_read_indexes.sql` | P-6: the two Snapshot indexes | **S** — pure index build. Note `CREATE INDEX CONCURRENTLY` is **forbidden** by `CLAUDE.md`; the runner wraps each file in a transaction |

M-1 through M-5 are all additive. No column is dropped, no type changed, no
constraint tightened on existing data. Nothing here can fail on a populated
table other than by running long.

### API changes

| # | Change | Size |
|---|---|---|
| A-1 | Write `language` at all four `messages` INSERT sites | **XS** — voice already has `effectiveLanguage` in scope at `internalVoice.js:190`; WhatsApp needs it threaded onto the envelope (`channels/index.js` typedef `:12-23`) |
| A-2 | Emit `conversation_events` from both mode-gate branches (`whatsapp/routes.js:160-178`, `internalVoice.js:224-228`) plus `ownerCommands.js:98`/`:224` | **M** — the first real behaviour change; needs the AI to have *any* escalation signal, which today it does not |
| A-3 | Maintain `conversations.disposition` from A-2's events, one shared helper | **S** |
| A-4 | Set `conversation_id` + `booked_by` at `appointmentService.js:368-372` and `:514-518` | **XS** — both call sites already have the conversation in scope |
| A-5 | `GET /portal/api/conversations` — tenant-scoped Inbox list | **S** — port `adminRoutes.js:398-465`, replace the optional `tenant_id` query param with the session's tenant, keep `array_agg(DISTINCT m.channel)` and the keyset cursor |
| A-6 | `GET /portal/api/conversations/:id` — Patient Thread detail | **S** — port `adminRoutes.js:475-531`, add a tenant check on the meta query, add `language`/`content_en` to the message projection |
| A-7 | `GET /portal/api/snapshot` — the six cards | **M** — five aggregates, one JSONB-joined hours classification, plus a WhatsApp-session definition that does not exist yet |
| A-8 | Portal pages: Inbox, Patient Thread, Snapshot | **L** — three new pages on the existing shell |
| A-9 | A translation producer for `content_en` | **L, and gated on a product decision.** See below |

### A-9 is the one that is not merely work

There is no translation capability in this codebase. Sarvam's
`/speech-to-text-translate` is already called (`sarvam.js:43`) but only
`data.transcript` and `data.language_code` are read (`:46`), and the Gemini
brain is never asked for a rendering. Producing `content_en` means a new
per-turn external call, with a latency budget, a failure mode, a cost per turn,
and a quota. Every one of those is a decision, not an implementation.

Until it is made, `content_en` stays NULL and the Patient Thread shows the
vernacular alone. **That is the honest version of the screen**, and it is
consistent with the standing rule. This audit's recommendation is to ship it
that way and treat the gloss as its own scoped piece of work.

---

## 10. Implementation order

Each phase is gated on the one before it. The gating is real: A-5 cannot be
tenant-scoped safely before §7's isolation guarantee is structural, and the
Inbox's headline filter cannot exist before A-2.

**Phase 0 · Isolation, before any portal route reads a message**
M-0 (no migration — script changes only): add the `NODE_ENV=production` refusal
from `seed-portal-owner.js:92-93` to `seed_voice_test_customer.js` and
`capture_turn.js`; decide the demo-tenant marker.
*Unblocks:* every later phase. *Why first:* the portal is currently safe only
because it reads no conversational data. Phase 2 removes that accident.

**Phase 1 · Data foundation** — M-1, M-2, M-3, M-4, M-5, A-1, A-2, A-3, A-4.
*Unblocks:* everything. *Note:* A-2 is the substantive one — it requires
deciding what makes the AI say "I need a human", which today it never does.

**Phase 2 · Patient Thread** — A-6, plus its page.
*Unblocks:* the proof surface. *Depends on:* M-1 (per-turn language), M-4
(booking on the thread). *Ships without:* `content_en`. Can be built directly on
`adminRoutes.js:475-531`, which already returns the right shape.

**Phase 3 · Inbox** — A-5, plus its page.
*Depends on:* M-3 for the "Needs staff" filter, and on Phase 2 for a detail page
to link to. *Ships with:* three of four filters working on day one; the fourth
arrives with A-2's events.

**Phase 4 · Snapshot** — A-7, plus its page.
*Depends on:* M-4 (card 2), M-2 (card 5), M-5 (indexes on cards 1/3/6), and a
WhatsApp-session definition. Last because it depends on the most.

**Deferred, unscheduled** — A-9 (`content_en` producer). Not on the critical
path for any screen. Slots in after Phase 2 whenever the product decision is
made.

---

## 11. Risks and compatibility

### 11.1 Is genesis really still greenfield? **YES — verified, and it is the
key fact in this audit.**

- `docs/os/state.md` records production deployments as **0**, and this audit
  independently confirms there is no prod evidence log anywhere in the repo:
  `docs/deploy/` contains only `prod-readiness.md` and `audit/`.
- The first production deploy is Issue 20, and per `CLAUDE.md` it runs exactly
  `db:genesis`, which **bootstraps from `schema.sql` and stamps `002`–`027` as
  already-applied without replaying them.**
- Therefore: **on the first deploy, only `schema.sql` executes.** Migrations
  M-1…M-5 would be *stamped, never run*. Their sequencing cost against
  production data is exactly zero, because there is no production data.

**So the claim in the brief is true, and it is narrower and sharper than it
sounds.** The window is not "migrations are cheap right now". It is: *any
conversation-model change folded into `schema.sql` before Issue 20 costs
**nothing at all** — no migration ordering, no lock, no backfill, no rewrite —
because the first production database is created from `schema.sql` in one
statement.* After Issue 20 every one of these becomes a real migration against
real patient data.

Two honest qualifications:

- The lockstep rule (`CLAUDE.md`) means both files change either way, so the
  *authoring* cost is identical before and after. What genesis saves is
  **execution** cost and risk, not writing.
- All five proposed migrations are additive and would be cheap even after
  genesis. The expensive class — `NOT NULL` without a default, type changes,
  constraint tightening, backfills — is deliberately absent from §8. So this is
  a real but bounded advantage, and it should not be used to justify rushing the
  design. **Getting P-2's event vocabulary wrong is far more expensive than
  running M-2 six months late.**

### 11.2 Retention and privacy — named, not solved

Storing patient conversation text is different in kind from storing config, and
this repository is not currently set up for the difference. Three specific,
cited facts:

1. **The config promises a retention window that no code enforces for
   conversations.** `config/schema.js:376` declares
   `retention_days: z.number().int().min(30).max(3650).default(365)` with the
   comment *"days to retain conversation/customer data"*. The only consumer is
   `retentionCron.js`, whose `DELETE_SQL` (`:30-35`) targets **`turn_traces`
   and nothing else**. A repository-wide grep finds no
   `DELETE FROM messages`, `conversations`, `customers` or `call_sessions`
   anywhere in `src/` other than the synthetic-probe cleanup at
   `scriptedTurnCheck.js:205`. **Patient conversation text is currently retained
   forever, under a config field that says otherwise.**

2. **`turn_traces` was designed to hold no content, and that design must not be
   relaxed.** `schema.sql:611-618` is explicit — *"Mechanics only… prompt
   provenance (hash + config version + mode — never the full text)"*. It is the
   one conversational table with a working retention sweep, which is exactly why
   it must stay content-free. §8's `conversation_events.detail` follows the same
   rule for the same reason.

3. **Adding `content_en` doubles the sensitive surface.** A stored English
   translation of a patient's medical enquiry is not less sensitive than the
   Telugu original — it is more legible to more people. If A-9 ever ships,
   `content_en` must fall under the same retention rule as `messages.content`,
   and the rule has to exist first.

Naming, not solving, as instructed: **a conversation retention sweep does not
exist, `retention_days` currently misdescribes itself, and the first tenant with
real patient data makes both a live problem.** Whether Indian DPDP obligations
attach, and on what timetable, is a founder/counsel question this audit does not
touch.

### 11.3 Meta's 24-hour window and C-5

**The 24-hour window: touches this, but only by reading.** Two crons already
compute it — `reminderCron.js:167` logs *"reminder skipped — outside 24h window,
no template"* against `last_inbound_at`, and `collectionsCron.js:134` does the
same for collections. Both derive the window from message timestamps rather than
storing it, which is the right shape and needs no change. §8 adds nothing here.

**C-5: does not exist in the data, and this audit's finding is that the gap is
real.** C-5 — *WhatsApp service messages become billable*, due **2026-10-01** —
is documented at `docs/analysis/prantivo-pricing-decision-entries.md:159-166`. It
is **not in `clocks.md`**; D-015 says so itself (`decisions.md:767-772`): both
C-4 and C-5 *"remain to be appended by whoever is authorised to."* Per
`CLAUDE.md` I may not write `clocks.md`, so this stays a note.

The technical fact: **per-message billing data is discarded today**
(§2.4). Meta's `pricing` object arrives in the status webhook and
`whatsapp/routes.js:79-84` logs two fields and drops the rest. After 2026-10-01,
every AI reply inside the customer-service window becomes chargeable at the
utility/auth rate, and D-015's margin model — 60% floor with no slack — depends
on knowing the per-tenant reply count and category.

Capturing it is **small and independent of everything else in this audit**: a
`message_pricing` table or three columns on `messages` keyed by the wamid, and a
handful of lines where the `continue` currently is. It shares no schema and no
sequencing with §8. It is called out here only because §11 asked whether C-5
touches this, and the honest answer is: *not architecturally, but the data it
will need is being thrown away every day, and it too is free before genesis.*

### 11.4 Compatibility

- **No breaking change is proposed.** Every §8 item is `ADD COLUMN` nullable,
  `ADD COLUMN NOT NULL DEFAULT`, `CREATE TABLE` or `CREATE INDEX`.
- **`conversations.channel` stays wrong and stays present.** §8 does not fix it,
  because fixing it means either updating it on every cross-channel turn (a
  write on the hot path for a field nothing needs) or dropping it (a breaking
  change to `/admin/api/conversations/:id:518`). The rule in P-5 costs nothing
  and is sufficient.
- **Voice turns still have no `external_id`.** §8 does not change that.
  `uniq_msg_external` is partial, so voice is simply outside it. Worth a
  separate decision, not folded in here.
- **`customer_memory` remains unwritten.** Out of scope, but any future "what
  the AI remembers about this patient" element on the Patient Thread would find
  the table empty (§2.3).

---

## 12. Honest sizing

Sessions, at this repository's observed pace. "Needs Issue 20 first" means the
work is *cheaper or safer* before the first production deploy, not that it is
blocked by it.

| Phase | Contents | Sessions | Issue 20 first? |
|---|---|---|---|
| **0 · Isolation** | prod refusals in 2 seed scripts; demo-tenant marker decision | **1** | **No — do this BEFORE Issue 20.** It is a precondition for deploying anything that reads patient data. |
| **1 · Data foundation** | M-1…M-5, A-1, A-3, A-4 | **2** | **Cheaper before.** Folded into `schema.sql` pre-genesis they cost zero execution. After, five real migrations. |
| **1b · Escalation semantics** | A-2 — deciding and implementing what makes the AI escalate | **1–2** | No. This is a product decision with code attached, not a schema one. It is the highest-uncertainty item in the plan. |
| **2 · Patient Thread** | A-6 + page, no gloss | **2** | No. Builds on `adminRoutes.js:475-531`. |
| **3 · Inbox** | A-5 + page | **1–2** | No. |
| **4 · Snapshot** | A-7 + page, incl. the WhatsApp-session definition and hours classification | **2–3** | No, but needs Phase 1's indexes or it will be slow on real volume. |
| **Deferred · gloss** | A-9 — translation producer, latency/cost/quota decision, then `content_en` | **2+**, and a decision first | No. Independent. |
| **Independent · C-5 capture** | persist Meta `pricing` per message | **1** | **Cheaper before**, same genesis argument as Phase 1. |

**Total for the three screens as drawn, minus the gloss: 9–13 sessions**, of
which **3** (Phase 0, Phase 1, C-5) are meaningfully cheaper before Issue 20 and
**1–2** (Phase 1b) are gated on a product decision rather than on code.

The single largest risk to that estimate is Phase 1b. Everything else in this
plan is well-understood plumbing over a data model that already does the hard
part; "what makes the receptionist decide it needs a human" is a genuinely open
question, and both the Inbox's headline filter and the Snapshot's headline
percentage are downstream of the answer.

---

## Appendix · Questions this audit could not answer without changing code

Per the session's stop rule, reported rather than investigated:

1. **What the Meta `pricing` object actually contains for this tenant's
   traffic.** It is discarded at `whatsapp/routes.js:82` before anything can
   inspect it. Answering it means logging or persisting it — a code change.
   Meta's published schema is the substitute, and it is external documentation,
   not repository evidence.
2. **Whether `content_en` is achievable within the voice turn budget.** The
   server-side deadline is 8000 ms (`internalVoice.js:75-78`), strictly below
   the worker's 10 s patience. Whether a translation call fits is measurable
   only by making one.
3. **What real per-turn language distribution looks like.** There are zero
   production deployments, so there is no data. Every Snapshot number in
   `dashboard.json` is, by its own note, *"static, internally-consistent demo
   numbers"*.
4. **Whether `customer_memory` is written by anything outside `src/`.** I
   verified no writer exists in `src/`; a writer in the voice worker or an
   operator's ad-hoc SQL cannot be ruled out from the repository alone.
