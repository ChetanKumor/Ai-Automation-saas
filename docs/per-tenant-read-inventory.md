# Per-Tenant Read Inventory (Issue 9)

**Verdict: the REPOINT class is empty — zero runtime changes.** Every read of
per-tenant state either belongs to a writer that hasn't moved yet, a worker
that doesn't take per-call config yet, or a config section that has no runtime
read at all (where adding one would be new behavior, out of Issue 9's scope).

Provenance: the inventory was performed 2026-07-07 on branch
`issue9-config-repoint` (whose only commit, 824194e, is a test-infra fix).
This document was reconstructed after the fact and **every row below was
re-verified against `main` @ 824194e with fresh file:line evidence** — nothing
here is transcribed from session memory. Data claims (dev tenant rows) were
re-checked against the live dev database on 2026-07-07.

## Classification legend

| Class | Meaning |
|---|---|
| `REPOINT` | Read should move to configService now (Issue 9's target class — **empty**) |
| `DEFER-WRITER` | Value is written by a live write path (admin create/PATCH, owner commands); repointing the read before the writer moves would split-brain. Moves with provisioning/control-plane work (Issues 15, 25). |
| `DEFER-WORKER` | Value is consumed by the Python voice worker via env, not per-call from the brain. Moves with the voice-config wiring (Issues 11–14). |
| `SKIP-ISSUE-10` | The `ai_prompt` read — explicitly reserved for Issue 10 (prompt renderer). |
| `SKIP-NO-BEHAVIOR` | Config section has **no runtime read today**; wiring one is a new config-driven feature, not a repoint. |

## Runtime reads of `tenants` columns

All rows come through `tenantService.js:42` (`SELECT id, business_name,
phone_number_id, wa_token, ai_prompt, ai_enabled, owner_notify_phone,
active_handoff_customer …`), cached per `phone_number_id`.

| Column | Runtime read site(s) | Class | Notes |
|---|---|---|---|
| `ai_prompt` | `src/modules/ai/aiService.js:331` — the ONLY runtime read, inside `buildSystemPrompt()` (`aiService.js:305`), the single prompt-assembly point for both channels (callers: `generateReply` `:93` ← `whatsapp/routes.js:168`; `generateReplyStream` `:204` ← `internalVoice.js:185` JSON turn and `:363` SSE turn). Writers: `adminRoutes.js:60-63` (create), `scripts/update-prompt.js:7`, admin form `public/admin/tenant-new.html:38,69`. | `SKIP-ISSUE-10` | Current quirk: a null `ai_prompt` renders the literal string `"null"` into the prompt (template interpolation, `aiService.js:331`) — dev tenant 'Test Biz' hits this today. Issue 10's precedence chain replaces this line. |
| `business_name` | `reminderCron.js:88,152,273`; `collectionsCron.js:90,249`; `seedRules.js:24,44`; `notificationService.js:16` (log only); admin list/join queries (`adminRoutes.js:46,75,143,177,212,247`) | `DEFER-WRITER` | Written only at create (`adminRoutes.js:60-63`). Config twin is `business.display_name` — see landmine #4 ('New Clinic'). |
| `ai_enabled` | `whatsapp/routes.js:132`; `internalVoice.js:165,337` (mode gates) | `DEFER-WRITER` | Written at create. No config twin (channel toggles `whatsapp.enabled` / `voice.enabled` exist but are unread — see below). |
| `owner_notify_phone` | `whatsapp/routes.js:87,135,140` (owner-command auth + handoff alert); `notificationService.js:14-21` | — | **Unrepresentable in config**: `notifications.owner_numbers` requires E.164 (`schema.js:20,79`), but the dev value `'1210047605526057'` is a `phone_number_id` (verified live 2026-07-07). It also doubles as owner-command **authentication** (`routes.js:87`). Untangling is an Issue 25 design decision, not a repoint. |
| `active_handoff_customer` | `ownerCommands.js:93,185,231` (read-write) | — | Live mutable state, not config. Permanently out of scope for configService. |
| `reminders_enabled`, `reminder_hours_before`, `reminder_template_id` | `reminderCron.js:88`; admin PATCH/GET `adminRoutes.js:114,125` | `DEFER-WRITER` | Live admin write path; no config section exists for reminders yet. |
| `wa_token`, `phone_number_id`, `waba_id` | WhatsApp send path / tenant resolution | — | Secrets/identifiers stay in `tenants` columns by design (`schema.js:11-13` SECRETS RULE). Never move. |

## Config sections with no runtime read (`SKIP-NO-BEHAVIOR`)

The **only** runtime consumer of configService today is the admin cache-invalidate
endpoint (`adminRoutes.js:7,284`). Every section below is stored, validated,
versioned — and read by nothing:

`greeting`, `hours`, `booking.*`, `escalation.*`, `notifications.on_*`,
`personality.*`, `tools.booking`, `crm.extraction.*`, `voice.*`,
`whatsapp.enabled`, `recording_consent.*`, `retention_days`,
`languages.*`, `business.timezone` (see landmine #2), `business.display_name`
(see landmine #4).

Adding a read = adding config-driven behavior. Issue 10 takes `greeting`,
`hours`, `personality`, `recording_consent`, `languages`, `business.display_name`,
`escalation.enabled` into the prompt renderer. The rest route to their named
issues below or remain future work.

## Landmines

The items this document exists to preserve. Each was re-verified 2026-07-07.

### 1. Worker-env voice params diverge from config defaults → Issues 11–14

The Sarvam voice is configured in the **Python worker's env**, not per-call:
`voice-agent/agent.py:71-73` reads `SARVAM_STT_MODEL` (default `saaras:v3`),
`SARVAM_TTS_MODEL` (default `bulbul:v3`), `SARVAM_TTS_SPEAKER` (default
`shubh`); dev env pins `bulbul:v3`/`shubh` (`voice-agent/.env.example:53-55`).
The brain's `/call/start` bridge does **not** pass voice params per-call
(`internalVoice.js:497-501` returns only session/customer/conversation ids).

**Divergence:** config defaults say `sarvam_speaker: 'anushka'`,
`sarvam_voice_id: 'bulbul:v2'` (`src/modules/config/defaults.js:73-74`) —
a v2-era voice the worker no longer uses. Whoever wires `voice.*` per-call
(Issues 11–14) must correct the defaults (and note `anushka` may not be valid
for `bulbul:v3`), or every tenant silently changes voice on cutover.

Also: the Node-side Sarvam adapter is **dead code** — nothing in `src/`
requires `src/modules/voice/voiceProvider.js` (which registers
`providers/sarvam.js`); only tests and the PR6 doc reference it.

### 2. Timezone is structural IST — cannot repoint `business.timezone`

Hardcoded `'+05:30'` offset literals in date arithmetic:
`appointmentService.js:66` (day-window bounds), `appointmentService.js:86`
(appointment-time normalization), plus the tool schema tells the model to emit
IST (`aiService.js:38`) and prompt/cron rendering pins `Asia/Kolkata`
(`aiService.js:318-319`, `reminderCron`). Repointing `business.timezone`
requires rewriting the date arithmetic wholesale; repointing only some sites
would put booking and rendering in different timezones (split-brain). Do it
all-or-nothing, as its own issue.

### 3. `MESSAGE_RECEIVED` has no `channel` field — **named prerequisite for extraction gating**

The event payload is `{ tenant_id, customer_id, conversation_id, message_id,
text, mode }` — **no `channel`** — at every emit site:
`src/modules/channels/index.js:90-97` (WhatsApp), `internalVoice.js:155-162`
(voice JSON turn), `internalVoice.js:326` (voice SSE turn).

The CRM extraction consumer (`extractionHandler.js:43-46`) gates only on
`mode === 'human'`, so extraction runs per-message on **both** channels today —
including a Gemini call per voice utterance. But the config policy is keyed
per-channel: `crm.extraction.whatsapp: 'per_message'`, `crm.extraction.voice:
'off'` (`schema.js:96-101`, defaults `defaults.js:63-68`, per Issue 3).

**Prerequisite:** whichever issue wires `crm.extraction.*` gating MUST first
add `channel` to the `MESSAGE_RECEIVED` envelope (all three emit sites) —
the consumer cannot enforce a per-channel policy on an envelope that doesn't
say which channel it came from. Do not let this be rediscovered mid-issue.

### 4. Backfill planted `display_name: 'New Clinic'` on every dev tenant

`scripts/backfill-tenant-configs.js:33` writes `clinicDefaults` verbatim
(deep-merge of `{}`), so `business.display_name = 'New Clinic'`
(`defaults.js:18`) regardless of the tenant's real `business_name`. Verified
live 2026-07-07: all 3 dev tenants ('Test Biz', 'Dr.Sharma Dental Clinic',
'Smile Dental (Voice Dev)') carry config `display_name: 'New Clinic'`.

Any read of `business.display_name` (Issue 10's renderer included) surfaces
'New Clinic' in customer-visible copy until corrected. Root fix is Issue 15
making create/config atomic; until then, correcting the rows is manual data
work, and a backfill re-run re-plants the default for any tenant still missing
a config row.

### 5. Voice greeting plumbing exists worker-side but is dead — Issues 11–14

`voice-agent/agent.py:387-389` already reads `started.get("greeting")` from
the `/call/start` response and would speak it — but the brain never supplies
one (`internalVoice.js:497-501`). **No greeting is spoken today.** Wiring
`config.greeting` into `/call/start` is a behavior change (new spoken line)
that belongs to the voice-config issues, not to a repoint — and Issue 10's
renderer must account for this topology (greeting-as-instruction in the
prompt does not double-greet, because nothing else greets).

## Baselines

Behavioral baselines (WA 2-turn scripted chat incl. tool loop; voice
call/start → turn → call/end via HMAC on `/internal/voice`) were captured
in-session during Issue 9 and matched post-change (the null change). They were
not committed as artifacts; Issue 10 captures its own baselines per its spec.
