# Production-Readiness Audit — 2026-07-16

Read-only technical due-diligence of the repo at `main` @ `709ec0a`, judged against
the plan of record (`docs/zyon-first-launch-plan (2).md`, Issues 3–28) and the six
architecture invariants. Question answered: **is this system ready to serve its
first paying clinic, and then ten clinics?**

Evidence labels: `VERIFIED` (command run, output quoted) · `READ` (inferred from
cited code) · `UNVERIFIED` (could not check; reason given).

**Audit-run disclosures.** (1) A throwaway database `audit_genesis_20260716` was
created on the dev Neon instance for genesis/provision/validation/lifecycle checks
and dropped at the end. (2) Running the orphaned `tests/workflow/seedIntegration.test.js`
(finding F-005) mutated the dev DB: it deletes `workflow_executions` rows for the
oldest active tenant (its own `finally` does a blanket delete). No other non-throwaway
state was modified. (3) The live scripted-turn probe spent 2 Gemini calls on the dev key.

---

## 1. Executive summary

The WhatsApp text product is in genuinely good shape: genesis bootstrap, provisioning,
validation, the activation gate, admin hardening, correlation IDs, and turn traces all
passed live runtime checks in this audit — not just tests. 444/444 Node tests and 37/37
worker tests pass. All 233 SQL call sites are parameterized; tenant isolation held
under exhaustive enumeration; the Python worker is transport-only as specified.

**The voice half of the launch plan is unbuilt.** Issues 11–13 (DID→tenant resolution,
SIP inbound wiring, Plivo provider) do not exist beyond seams and stubs, and three
latent defects sit exactly on that path: voice turns only work for WhatsApp-credentialed
tenants (F-001), voice caller phone format will not match WhatsApp-stored phones
(F-003), and there is no DID routing at all. A voice-first customer #1 is blocked by
code, not just by the DID/KYC clock.

**One plan contradiction to state up front:** collections is not "feature-flagged OFF" —
no flag exists, its cron starts unconditionally, and its page is linked in every panel
nav (Issue 25's "collections hidden" is unmet). Writes remain unreachable, so exposure
is a read-only page over an empty table — a contradiction of the letter, not a leak.

**The single non-voice launch blocker is operational:** there is no backup/restore
story anywhere, in a system whose migration runner explicitly names "restore from
backup" as the only recovery path.

Readiness: **3 of 7 launch gates pass (43%)** — see §2. The remaining four are one
ops task (backups), one deploy (Issue 20), and the voice build (Issues 11–14).

---

## 2. Launch-gate table (customer #1)

Readiness % = gates passed ÷ total = **3/7 ≈ 43%**.

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| 1 | Genesis bootstrap works | **PASS** | VERIFIED on throwaway DB: `✓ genesis complete: applied schema.sql and stamped 21 migration(s)`; re-genesis refused (`database is not empty`); `db:migrate` → `no pending`; 24 tables created. Issue 19 doc additionally shows a scrubbed-env boot with `/health` 200 `{db:up}`. |
| 2 | Live WhatsApp round-trip on prod | **PENDING** | No production deploy exists. `docs/deploy/prod-readiness.md` §7: "next: Issue 20 runbook — genesis + smoke". No prod evidence log in repo. |
| 3 | Issue 14 voice gate | **PENDING-DID** | External DID/KYC clock, and blocked by missing Issues 11–13 plus F-001/F-003 (see findings). |
| 4 | Tenant isolation audit clean | **PASS** | All 233 query sites across 42 files enumerated (VERIFIED grep) and read. Every runtime tenant-scoped read/write filters by `tenant_id` except two letter-violations with no tenant-facing exposure: `appointmentService.js:171` (customer-name UPDATE by internal PK only) and dead export `identityService.getTimeline` (no production caller). pgvector retrieval is tenant-filtered (`knowledgeService.js:38-43`); event pipeline carries `tenant_id` on every envelope; workflow rule lookup is tenant-scoped (`workflowEngine.js:46-49`). Admin panel is platform-scoped (all tenants) by design — single operator, single password. |
| 5 | Issue 18 closed | **PASS** | Item-by-item in §4b. `adminSecurity.test.js` in the green suite; primitives read and confirmed (`security.js`, `server.js:56-75`, `adminRoutes.js:25-77`). |
| 6 | Backups exist with a tested restore | **FAIL** | No backup configuration, script, doc, or restore drill anywhere in the repo (VERIFIED: no hits for backup/restore outside `migrate.js`'s comment that recovery *is* restore-from-backup). Forward-only migrations make this the only recovery path. |
| 7 | One call traceable end-to-end | **PENDING** (dev evidence in hand) | VERIFIED in-process: the validation probe produced log line `probe_0986cbb99c974a9a` and a queryable `turn_traces` row with the same correlation id, stage timings, prompt hash+config version, token counts, and tool outcomes. Worker id-echo is test-covered (`internalVoice.js:672` trusted adoption). A real PSTN call cannot be traced until gates 2–3 clear. |

---

## 3. Issue-by-issue verification (plan of record, Issues 3–28)

| Issue | DoD judged against | Verdict | Evidence |
|---|---|---|---|
| 3 — CRM event-name fix | "regression test asserting extraction fires on a stored inbound message… red-before/green-after" | **COMPLETE** | `core/eventTypes.js:6` `'message.received'`; handler subscribes via constant (`extractionHandler.js:65`); `tests/crm/extraction.bus.test.js:205` asserts the canonical name. Suite green (VERIFIED). |
| 4 — tenant cache timer + invalidation | "wall-clock inflation gone; invalidation verified via changed config read-through" | **COMPLETE** | Per-entry `unref()`ed timers (`tenantService.js:26-36`); authed invalidation endpoint (`adminRoutes.js:326`); shutdown clears timers (`server.js:140`); `tenantCache.test.js` green. |
| 5 — retire `wamid` | "grep-clean of wamid outside comments; full suite green" | **COMPLETE** | VERIFIED grep: only the historical migration files (017/019 — the retirement record itself) and a local variable name in dev script `test-chat.js`. `external_id` sole identifier in schema + code. |
| 6 — migration runner + genesis | "fresh DB bootstraps from genesis via one command; runner refuses re-apply" | **COMPLETE** | VERIFIED live on throwaway DB (gate 1). `db:status` on dev DB: 21 applied (20 stamped, 022 run), 0 pending, no checksum warnings. |
| 7 — control-plane schema | "migration applies to fresh DB; schema.sql in lockstep" | **COMPLETE** | `020_control_plane.sql` present; genesis produced the control-plane tables (24-table count VERIFIED); `controlPlane.test.js` green. |
| 8 — configService | "invalid config rejected with path-level errors; loader cached + invalidable" | **COMPLETE** | `ConfigValidationError` carries dotted paths (`configService.js:30-41`); 60s lazy-TTL cache + scoped invalidation (`:146-206`); strict Zod schema read in full. Config tests green. |
| 9 — brain read-sites → configService | "full suite green; no behavior diff on scripted turns" | **COMPLETE** | Verdict "REPOINT class empty" documented with re-verified file:line evidence (`docs/per-tenant-read-inventory.md`). Zero-diff by zero changes; suite green. |
| 10 — clinic prompt renderer | "rendered prompt snapshot tests per language" | **COMPLETE** | 6 snapshots (en/hi/te × whatsapp/voice) in `tests/prompts/__snapshots__/`; guardrail renders last, non-configurable (`templates/clinic.js:189-197`); legacy `ai_prompt` demoted to override with WARN (`aiService.js:388-392`). |
| 11 — DID→tenant resolution | "`getTenantByChannel('voice', did)` reading `voice.did`… unknown-DID rejection" | **MISSING** | VERIFIED grep: no `getTenantByChannel`; the only runtime reader of `voice.did` is the validation check (`validationService.js:250`). Worker supplies `tenant_id` directly (`agent.py:309`). |
| 12 — LiveKit SIP inbound wiring | "Plivo test call reaches a worker-joined room with correct metadata" | **MISSING** | `agent.py:22`: "DARK / LOCAL ONLY: telephony stays noop… No PSTN." Caller/tenant come from dev env vars or dev room metadata; no SIP attribute extraction. |
| 13 — PlivoTelephonyProvider | "provider swap test (noop↔plivo) passes; seam untouched" | **MISSING (stub)** | `providers/plivo.js` — every method throws `NotImplemented`. The seam + registry conformance exists and is tested (`voice.unit.test.js:64-67`), but inbound v1 is absent. |
| 14 — live-call gate | "evidence log with transcript, row IDs, latency table. Nothing ships until this passes." | **UNVERIFIABLE (PENDING-DID)** | Requires a live DID + Issues 11–13. No evidence log exists. |
| 15 — provisioning CLI | "run-twice test = no duplicates; dry-run touches nothing" | **COMPLETE** | VERIFIED live: dry-run printed the plan, wrote 0 rows; run-twice returned the same tenant id with `skipping: tenant, config@v1`; row counts stayed 1/1/1. `seeds: []` is a documented deliberate deviation from the plan text (`provisioningService.js:18-28`). |
| 16 — validation, static | "seeded broken configs each fail with the right reason" | **COMPLETE** | VERIFIED live: bare tenant failed `kb.populated`/`kb.retrieval`/`whatsapp.config`/`whatsapp.live`/`turn.scripted` each with a precise reason; empty escalation numbers failed `numbers.e164`. Runs persisted to `validation_runs` (observed `[false,false]`). `validation.integration.test.js` green. |
| 17 — validation, dynamic + activation | "cannot activate an unvalidated tenant; can activate a validated one; cache invalidated on activation" | **COMPLETE** | VERIFIED live: activate refused `NOT_VALIDATED` pre-validation; `draft→validated→live(active=true)→paused` chain executed; caches evicted on activate/pause (`lifecycleService.js:169,183`). Live scripted probe: real Gemini booking, `book_appointment(200ms)`, appointment row written, synthetic customer purged (0 residual rows). |
| 18 — admin panel hardening | "checklist from spec's launch-fixes list all closed" | **COMPLETE** | §4b below, item by item. |
| 19 — production infrastructure | "env audit table committed" | **COMPLETE (doc)** | `docs/deploy/prod-readiness.md`: full env table, scrubbed-env boot evidence, drain ≈10ms evidence, region sign-off slots. The Railway/LiveKit projects themselves are ops state — UNVERIFIABLE from the repo. |
| 20 — genesis deploy + prod smoke | "prod evidence log started with both transcripts + row evidence" | **MISSING** | Not executed; doc §7 hands off to it. |
| 21 — correlation IDs | "single grep of one call's ID reconstructs its full path" | **COMPLETE** (dev-demonstrated) | VERIFIED for the probe chain (gate 7). Edges: fresh `wa_`/`adm_` ids, HMAC-trusted adoption of `call_` ids (`internalVoice.js:672-676`); bus inheritance (`core/events.js:17-43`); pino mixin (`logger.js:10-13`). Live PSTN chain pending gates 2–3. |
| 22 — turn_traces capture | "live prod call produces a queryable trace; measured hot-path delta ≈ 0" | **PARTIAL** | Mechanism complete and VERIFIED queryable from the live dev probe (gate 7). Write is fire-and-forget after dispatch (`writer.js`, `routes.js:234-236`); never-throw policy read + test-poisoned (`traces.integration`). "Live prod call" is impossible before Issues 20/14 — that residue is deployment, not code. |
| 23 — onboarding runbook + customer #1 | "customer #1 status='live'; first real patient interaction traced" | **MISSING** | No runbook document; no customer. |
| 24 — 48h live watch | "watch notes committed" | **MISSING** | Not applicable yet. |
| 25 — page: tenant detail | "renders live prod data… collections hidden" | **PARTIAL** | Page + routes complete and tested (`tenantDetail.test.js` green; editor/revisions/preview/lifecycle read in `adminRoutes.js:505-734`). But collections is linked in its nav (`tenant-detail.html:32`) — "collections hidden" unmet — and prod render pending Issue 20. |
| 26 — page: conversations | "renders live prod data" | **PARTIAL** | Complete in dev: cross-channel thread + `call_sessions` inline, keyset pagination on the migration-021 index (`adminRoutes.js:343-503`); `conversations.test.js` green. Prod render pending Issue 20. |
| 27 — page: trace viewer | "renders live prod data" | **MISSING** | No page exists. The two read APIs it needs are built and tested (`adminRoutes.js:744-790`, `tracesRoutes.test.js`). |
| 28 — runbook v2 + customer #2 | "stopwatch evidence" | **MISSING** | Not applicable yet. |

Test-suite baseline (VERIFIED): `npm test` → **444 pass / 0 fail, 84 suites, 79.3s, exit 0**.
Worker: `pytest` → **37/37 pass** with `VOICE_STREAM_TURNS=false`; 4 fail under ambient
dev `.env` leakage (F-014). Two workflow test files are outside the `npm test` list
entirely (F-005).

---

## 4. Risk audit

### 4a. Tenant isolation

Tables carrying `tenant_id`: all 22 app tables except `customer_tags` (junction,
scoped transitively through `customers`) and `tags`(has it). Every query site was
enumerated (233 sites / 42 files, VERIFIED count) and read. Results:

- **Clean:** message/conversation/customer paths, RAG retrieval (`WHERE tenant_id = $1`
  before ANN ordering), CRM upserts, workflow rule lookup + execution claims,
  notifications, collections, reminders, traces (insert carries tenant; retention
  joins tenants; queries filter), config/control-plane, validation, provisioning.
- **Letter-violations, no tenant-facing exposure (F-016):**
  `appointmentService.js:171-174` updates `customers.name` by PK without tenant
  filter (PK comes from the already-scoped resolver); `identityService.getTimeline`
  (`identityService.js:142-161`) has no tenant filter and **no production caller** —
  dead code.
- **By-design cross-tenant:** the admin panel reads any tenant (single platform
  operator, one password). If per-tenant panel users ever arrive, every
  `/api/conversations/:id`-style PK-only read becomes a leak path — recorded as a
  future boundary, not a current finding.
- **Voice:** `call_sessions` is fetched by bare id (`internalVoice.js:150`), but the
  id is issued by `call/start` behind HMAC and tenant is derived from the row, then
  customer/conversation are re-validated against that tenant (`:171-180`). Sound.

### 4b. Security

**Issue 18 checklist (all READ + tests green):**
cookie flags `httpOnly/sameSite=strict/secure(prod)/12h` (`server.js:65-75`);
trust-proxy gated to `NODE_ENV=production` (`server.js:56-64`, `trustProxy.test.js`);
login limiter 5/15min + API limiter 60/min (`adminRoutes.js:25-32`); constant-time
hashed compare (`security.js:16-20`); session regeneration on login — fixation
defense (`adminRoutes.js:65`); generic 401 + ~300ms delay (`adminRoutes.js:74-77`);
security headers nosniff/DENY/no-referrer (`security.js:27-32`); CSRF =
sameSite-strict primary + custom `x-zyon-admin` header on every mutating route
(VERIFIED: all POST/PUT/PATCH admin routes carry `requireAdminHeader`); in-memory
limiter with lazy prune (`security.js:52-81`); lockout recovery = restart.

**Webhooks:** Meta HMAC-SHA256 over the raw body with length-checked
`timingSafeEqual` (`whatsapp/routes.js:23-51`); GET verify checks
`WEBHOOK_VERIFY_TOKEN`. Internal voice: same HMAC scheme, `VOICE_INTERNAL_SECRET`
required, 401 when unset (`internalVoice.js:27-43`); correlation adoption only
behind auth. Plivo webhook auth: N/A — no Plivo webhook exists yet (Issue 13 missing);
must be part of that build.

**Secrets:** `.env` never tracked in git history (VERIFIED empty `git log --all -- .env`);
no key-shaped strings in the last 40 commits or the working tree (VERIFIED grep);
`npm audit --omit=dev`: **0 vulnerabilities** (VERIFIED). `wa_token` at rest:
AES-256-GCM with random IV (`utils/encryption.js`). Residuals: `ssl:
{ rejectUnauthorized: false }` in prod DB config (`db.js:24-26`) — acceptable on
Railway's internal network, noted; `SESSION_SECRET` falls back to `ADMIN_PASSWORD`
(`server.js:66`) — the prod doc mandates setting it (§1 of prod-readiness.md);
`.gitignore` contains a committed merge-conflict marker (F-013 hygiene).

**Injection:** all SQL parameterized; the four dynamic-SQL sites interpolate only
regex-constrained literal identifiers or fixed fragments (`tenant-lifecycle.js:77`,
`validate-tenant.js:78`, `adminRoutes.js:160,410`, `queryService.js:23`). URL
construction uses operator-owned `phone_number_id` (trusted input). Indirect prompt
injection via customer-authored memory/facts into the system prompt is inherent to
the design; blast radius is bounded by the two booking tools — accepted risk at
this scale (see §6).

### 4c. External-dependency failure modes

- **Gemini (timeout/429/5xx):** WhatsApp — reply generation failure is caught,
  logged, traced (`routes.js:195-199`); the inbound is stored; the customer gets
  silence (no retry, no fallback message — deliberate simplicity; see the rejected
  fallback item in §7). Voice — the 8s turn budget aborts the turn
  (`internalVoice.js:139`), worker speaks a static per-language apology and ends
  the call `failed` (`agent.py:200-205`); budget < worker patience is pinned on
  both sides. CRM extraction failures are non-fatal and logged.
- **Meta Cloud API:** reply path has no retry (loss is logged + traced). Cron sends
  classify errors (`classifySendError.js`): 429/5xx/network → retry ≤3, 131047 →
  `needs_template`, timeout → `needs_review` (human queue); all state transitions
  crash-safe via claim/reap (`reminderCron.js:41-126`, `collectionsCron.js:43-118`,
  advisory locks). The 24h window is computed from last inbound and Meta's
  131047 is handled reactively — correct approach.
- **Webhook redelivery:** ack-first 200 (`routes.js:67`), idempotent insert on
  `(tenant_id, channel, external_id)` — duplicates skipped, `MESSAGE_RECEIVED`
  emitted only for new rows (`channels/index.js:77-105`). Redelivery-safe.
  **Gap:** only `entry[0].changes[0].messages[0]` is processed — F-005.
- **Poison messages/events:** bus handlers are try/caught (`events.js:55-67`);
  workflow executions claim idempotently and mark `failed` — no retry loop, so no
  poison spin; a failing handler cannot take the process down.
- **Half-booked appointment:** impossible as a torn write — booking is a single
  INSERT guarded by `uniq_doctor_slot` with a friendly 23505 recovery
  (`appointmentService.js:177-200`); the owner notification is fire-and-forget
  *after* success and its failure lands in `notifications.sent_status`. The Issue-29
  point-of-no-return guarantees a committed booking's confirmation persists even
  when the voice turn aborts (`internalVoice.js:250-272`, verified by tests).
- **LiveKit/worker:** brain unreachable mid-call → apology + `call/end failed`;
  `call/end` itself failing leaves the session `in_progress` forever — no reaper
  (F-012). Voice turn inserts carry no `external_id`, so a hypothetical worker
  retry would double-process — the worker never retries by design; latent only.

### 4d. Domain correctness traps

- **IST:** consistently pinned `Asia/Kolkata` at every conversion (prompt date,
  slot math with explicit `+05:30` bounds, day-of-week from the calendar date,
  cron copy). The 24h WhatsApp window is epoch arithmetic — timezone-safe. No
  defect found (READ; slot-grid unit tests green).
- **E.164 divergence at ingress — F-003 (real trap):** WhatsApp stores customer
  phones as Meta digits (`919…`, no `+`); voice `call/start` passes `caller_id`
  verbatim into an exact-match phone lookup (`internalVoice.js:573-577`,
  `identityService.js:40-47`). A returning WhatsApp customer calling from
  `+919…` will not match and becomes a duplicate customer — cross-channel
  continuity breaks. The dev seed masks this by writing `+919…` directly.
  Owner-command auth normalizes digits (`routes.js:93-94`) — the pattern to reuse.
- **Telugu/Unicode:** UTF-8 end-to-end (Telugu literals in defaults/ack copy
  round-tripped through provisioning + validation on the throwaway DB —
  VERIFIED via `prompt.renders` across 3 languages); surrogate-pair-safe
  truncation in the voice prompt (`clinic.js:176-183`). Live Telugu TTS remains
  Issue-14 evidence. Reminder templates hardcode `language: {code:'en'}` and
  English copy (F-009).
- **Double-booking:** exact-slot race is closed by the partial unique index +
  23505 handling; off-grid times rejected (never snapped), grid source shared with
  availability (V-008, tests green). **But** `hours.holidays`, clinic `hours`,
  `booking.advance_days`, `buffer_minutes`, `allow_same_day` are validated,
  operator-editable, and **never enforced by the booking tool** — the AI can book
  a slot on a configured holiday if the doctor's weekly schedule covers that
  weekday (F-006). The live probe also showed the model booking on turn 1 despite
  the "confirm first" prompt rule when the request is fully specified — the
  confirm-first guard is prompt-level only (noted, not a finding at this scale).
- **Cache invalidation:** correct and honest — panel pause evicts in-process
  immediately; CLI pause on a running server leaves the WhatsApp path serving up
  to 5 min (documented at `lifecycleService.js:79-90`). Runbook item: pause from
  the panel.

### 4e. Deployment

Genesis yields a runnable system (gate 1 + Issue 19's scrubbed-env boot with
`/health` 200). `env.js`'s required list matches the prod doc's table exactly
(READ both). `/health` checks Postgres with `SELECT 1` (`server.js:87-95`) — real
depth for the Node service; worker liveness is the worker deployable's own concern
(none wired yet — arrives with Issues 11–14). Graceful drain covers every cron +
cache timer, measured ≈10ms (Issue 19 evidence). **Backups: nothing** (gate 6 FAIL).

### 4f. Observability

Correlation: fresh ids at public edges, trusted adoption on HMAC'd internal routes,
bus-inherited depth/causation, pino mixin stamping every in-chain line, worker echo
of the `call_` id. Traces: opened per turn on all three turn cores (WhatsApp route,
voice route JSON+SSE, validation probe), capture prompt provenance (hash + config
version + mode — never text), retrieval ids+scores, per-call LLM meta, tool
outcomes, abort semantics; flushed fire-and-forget after dispatch; per-tenant
retention cron with dry-run twin. **Demonstrated live** (gate 7): one id links the
probe's log line to its queryable trace row. Residual: `console.time`/`console.log`
in the WhatsApp hot path and core actions beside pino (F-013).

### 4g. Debt and simplification

- **Dead code (backlog item 10):** Node-side `voice/voiceProvider.js` + `voice/providers/sarvam.js`
  (no runtime caller — the worker owns STT/TTS via the LiveKit plugin; VERIFIED grep);
  `identityService.getTimeline`; module-local `crm/migration.sql` +
  `collections/migration.sql` (superseded by migrations 012/013); `spike/voice-retell/`;
  `scripts/update-prompt.js` (writes a legacy `ai_prompt` — a post-Issue-10 footgun);
  stale `.env` entries (`OLLAMA_*`, `DOCTOR_PHONE`, legacy `WHATSAPP_TOKEN`/`PHONE_NUMBER_ID`).
- **Inert config knobs:** `booking.advance_days/buffer_minutes/allow_same_day`,
  `hours` enforcement + `holidays` (F-006), `voice.sarvam_speaker`/`sarvam_voice_id`
  (worker reads env `SARVAM_TTS_SPEAKER`/models instead — per-tenant voice is not
  actually per-tenant yet; rides Issues 11–14), `notifications.on_booking/on_escalation`
  and `escalation.phone_numbers` (prompt-behavior only; alerts still use the legacy
  `owner_notify_phone` column — documented in the Issue 9 inventory).
- **Duplicated logic, documented and accepted:** `generateReply` vs
  `generateReplyStream` (pinned mirror, SSE dark); JSON vs SSE turn branches in
  `internalVoice.js` (intentional mirror); WhatsApp signature verify exists twice
  (`routes.js` + `adapter.verifyWebhook`, one unused at the route level).
- **Under-engineering (silent-loss paths):** workflow `send_whatsapp_message` and
  both reminder crons send WhatsApp messages that are never inserted into
  `messages` — invisible in the conversation thread and to the AI's own context
  (F-007); Meta webhook batching (F-004).
- **Over-engineering at this scale:** none material. The channel registry,
  telephony/voice seams, and event bus all have concrete second consumers built or
  scheduled. The one-implementation `VoiceProvider` Node seam is the exception —
  it is dead, not speculative (backlog item 10).

---

## 5. Findings

Severity ∈ {BLOCKS-CUSTOMER-1, FIX-BEFORE-48H-WATCH, BEFORE-CUSTOMER-10,
POST-LAUNCH}. Effort in Claude Code sessions.

**F-001 · BLOCKS-CUSTOMER-1 (voice-first) · 1 session — Voice turns require WhatsApp credentials.**
Both turn branches hydrate the tenant via `SELECT phone_number_id … AND active=true`
then `getByPhoneNumberId` (`internalVoice.js:163-168,385-390`), which returns null
for a PNID-less tenant and calls `decrypt(wa_token)` unconditionally
(`tenantService.js:49`; `decrypt(null)` throws, `encryption.js:15`). A voice-only
tenant — explicitly supported by the slug rationale (`schema.sql:50-52`) — fails
every turn with 404/500. READ; masked in dev by the seed's dummy WA credentials.
**Fix:** hydrate by tenant id with conditional decrypt (small helper in
tenantService; cache by id), keep the `active=true` gate.

**F-002 · BLOCKS-CUSTOMER-1 (voice-first) · 3+ sessions — Voice ingress unbuilt (Issues 11–13).**
No DID→tenant resolution (`voice.did` unread at runtime), no SIP metadata
extraction (worker is dev-mode only, `agent.py:22,309`), Plivo provider is a
throwing stub (`plivo.js`). This is the plan's own critical path, confirmed
missing — listed as a finding so the launch decision (WA-first vs voice-first) is
made consciously. Plivo webhook auth must be designed into this build.

**F-003 · BLOCKS-CUSTOMER-1 (voice-first) · 0.5 — Phone normalization diverges across channels.**
WhatsApp identifiers are Meta digits (`919…`); voice `caller_id` flows verbatim
into exact-match identity lookup (`internalVoice.js:573`, `identityService.js:40-47`).
A `+919…` caller duplicates an existing WA customer — cross-channel memory breaks.
**Fix:** normalize to one canonical form (digits) at every ingress before identity
lookup, as owner-command auth already does (`routes.js:93-94`).

**F-004 · BLOCKS-CUSTOMER-1 · 0.5 — No backup/restore story.**
Forward-only migrations name restore-from-backup as the sole recovery path
(`migrate.js:19`); nothing configures, documents, or tests a backup. UNVERIFIED
whether Railway's default PG backups will apply — prod doesn't exist yet.
**Fix:** enable/verify Railway PG backups at Issue 20, document the restore
command, and run one timed restore drill into a scratch DB. Gate customer #1 on it.

**F-005 · FIX-BEFORE-48H-WATCH · 0.5 — Meta webhook batching drops messages.**
Handler reads `entry?.[0]?.changes?.[0]` (`routes.js:70`) and `parseInbound` takes
`messages?.[0]` (`adapter.js:47`). A batched delivery (multiple entries/changes/
messages — Meta does batch under load/retry) silently drops all but the first:
not stored, no reply. **Fix:** three nested loops feeding the existing envelope
array (the downstream already accepts arrays).

**F-006 · FIX-BEFORE-48H-WATCH · 1 — Booking ignores holidays, clinic hours, and advance-window config.**
`hours.holidays`, `hours`, `booking.advance_days/buffer_minutes/allow_same_day`
are schema-validated and panel-editable but unenforced in
`bookAppointment`/`checkAvailability` (`appointmentService.js:76-200` reads only
`slot_minutes` + doctor schedules). The AI books on configured holidays.
**Fix:** enforce holidays + advance_days in both tool functions (same shared-source
pattern as V-008); explicitly defer buffer/same-day with a schema comment if unused.

**F-007 · FIX-BEFORE-48H-WATCH · 0.5 — Orphaned tests; one stale and dev-DB-mutating.**
`tests/workflow/workflowEngine.test.js` (passes) and `seedIntegration.test.js`
(fails; legacy script-style; deletes real `workflow_executions` rows) are not in
the hand-maintained `npm test` list (VERIFIED: 1 pass / 1 fail when run directly).
**Fix:** add `workflowEngine.test.js` to the list; delete `seedIntegration.test.js`
(its coverage is superseded by `workflowEngine.test.js` + `seedIntegration`'s
event names are pre-rename). Consider generating the test list by glob.

**F-008 · BEFORE-CUSTOMER-10 · 1 — Non-reply outbound sends are invisible.**
Workflow `send_whatsapp_message` (`coreActions.js:37-77`) and both reminder crons
send WhatsApp messages without inserting a `messages` row: the thread in the panel
and the AI's own history never see them. **Fix:** insert an outbound `messages`
row (sender `'system'` or `'ai'`) at each send site, or route them through
`dispatchOutbound` + persist like the reply path.

**F-009 · BEFORE-CUSTOMER-10 · 0.5 — Reminder language is hardcoded English.**
Free-text reminder copy is English and template sends pin `language: {code:'en'}`
(`reminderCron.js:150-152,266`). Telugu-first patients get English reminders.
**Fix:** pick copy/template language from `customers.preferred_language` falling
back to `languages.default`.

**F-010 · BEFORE-CUSTOMER-10 · 0.5 — Collections is not flagged off and is nav-visible.**
Invariant 3 says "feature-flagged OFF… not reachable through any config or UI
path". Reality: `collectionsModule.init()` runs unconditionally (`server.js:105`;
cron every 30 min), the read-only page is linked on every panel page (VERIFIED,
8 files incl. `tenant-detail.html:32` — Issue 25's "collections hidden" unmet).
Writes are unreachable (no UI/API writes; no seed rule; `place_call` unregistered).
**Fix:** `COLLECTIONS_ENABLED=false` gate around init (actions + cron) and remove
the nav links.

**F-011 · POST-LAUNCH · 0.5 — Validation `--skip` silently ignores non-skippable checks.**
CLIs accept any check name (`validate-tenant.js:59-67`), but the service honors
`skippable` only (`validationService.js:271-272`): `--skip whatsapp.config` is
accepted, ignored, and the run fails with no hint (observed live). Also: a run with
all material checks skipped still counts "passed" for activation — surface skipped
counts in the activate confirmation. **Fix:** error on non-skippable names (mirror
the admin route's stricter behavior) + show skips at activation.

**F-012 · POST-LAUNCH · 0.5 — Stuck `in_progress` call_sessions have no reaper.**
If the worker's `call/end` never lands (crash, network), the session stays
`in_progress` forever (`brain_client.py:213-235`, `callSessions.js:65`). **Fix:**
a small sweep in an existing cron: `in_progress AND started_at < now()-interval '2h'
→ failed`.

**F-013 · POST-LAUNCH · 0.5 — Logging/hygiene sweep.**
`console.time/log` beside pino on the WhatsApp hot path and in core actions
(`routes.js:81-84`, `channels/index.js:57-72`, `actions.js`, `coreActions.js`);
committed merge-conflict marker at the end of `.gitignore`; `GET /api/tenants/:id/reminders`
lacks the UUID guard (malformed id → 22P02 500). One tidy pass.

**F-014 · POST-LAUNCH · 0.5 — Worker tests inherit ambient env.**
4/37 pytest failures with the repo's `.env` present (`VOICE_STREAM_TURNS=true`
leaks via `load_dotenv()` walking up); 37/37 with it pinned false (VERIFIED both).
**Fix:** pin the env in `conftest.py` (monkeypatch/delenv).

**F-015 · POST-LAUNCH · 1 — Genesis-vs-replay lockstep is unmechanized.**
The lockstep rule is discipline + review; no test diffs a genesis-built schema
against a migrations-replayed one (READ `migrate.test.js` — genesis/adopt/refusal
covered, equivalence not). One drift silently ships a wrong prod DB (CLAUDE.md's
own words). **Fix:** a test that builds both on scratch DBs and diffs
`information_schema` + index definitions.

**F-016 · POST-LAUNCH · 0.5 — Isolation letter-violations.**
`appointmentService.js:171` (customers UPDATE by PK only — add `AND tenant_id=$3`);
delete dead `getTimeline` or add the tenant filter. Zero current exposure; keeps
the "every access filtered" invariant grep-clean.

**F-017 · POST-LAUNCH · 0.5 — Event-name literal hygiene.**
`lead_created`/`lead_updated`/`payment_*` are bare underscore literals
(`extractionHandler.js:155`, `seedRules.js`, `collectionsCron.js:190,219`) beside
the dot-form constants in `eventTypes.js`. Internally consistent today; add the
constants so a rename can't half-land (the exact bug class Issue 3 fixed).

---

## 6. Prioritized backlog (one session each, paste-ready)

1. **fix(ops): backup + tested restore for prod Postgres** (F-004) — enable/verify
   Railway PG backups; document restore; run one drill into a scratch DB.
   DoD: restore drill log committed with timings; runbook section added. *Blocks customer #1; do at/before Issue 20.*
2. **fix(voice): tenant hydration by id, WA-credential-optional** (F-001) — new
   `tenantService.getForVoice(tenantId)` (or extend `getById`) with conditional
   decrypt; both turn branches use it. DoD: red test = voice turn on a tenant with
   `phone_number_id IS NULL` and on one with PNID-but-no-token; green after; suite green.
3. **fix(identity): canonical phone normalization at every ingress** (F-003) —
   digits-only normalize in `call/start` + `resolveCustomer` boundary. DoD: red test =
   WA customer (`919…`) matched when calling as `+919…`; green after.
4. **fix(webhook): process all entries/changes/messages in one delivery** (F-005) —
   DoD: red test = two-message payload stores two rows + replies to both; green after.
5. **fix(tests): repair npm-test list; delete stale seedIntegration** (F-007) —
   DoD: `npm test` includes workflowEngine tests; seedIntegration removed; count > 444.
6. **feat(booking): enforce holidays + advance_days in both booking tools** (F-006) —
   shared-source pattern per V-008. DoD: red tests = booking on a configured holiday
   and beyond advance_days both rejected with tool-friendly errors; availability
   excludes them; green after.
7. **feat(messages): persist non-reply outbound sends** (F-008) — DoD: workflow +
   reminder sends visible in the conversation thread; history includes them.
8. **fix(reminders): per-customer language for reminder copy/template** (F-009) —
   DoD: Telugu-preferring customer receives Telugu copy; template language code follows.
9. **chore(collections): COLLECTIONS_ENABLED gate + remove nav links** (F-010) —
   DoD: flag off ⇒ no cron, no actions, no nav entry; flag on restores today's behavior.
10. **chore(debt): dead-code sweep** (§4g dead code, F-013, F-016, F-017) — voiceProvider/sarvam
    Node modules, getTimeline, module migration.sql files, spike/, update-prompt.js,
    conflict marker, console.* pass, event-name constants. DoD: grep-clean; suite green.
11. **test(db): genesis-vs-replay schema equivalence** (F-015) — DoD: failing test on
    an induced drift; green on current tree.
12. **fix(validation): strict --skip + skip-visibility at activation; call-session reaper** (F-011, F-012).

Issues 11–14 and 20/23/24/27 remain the plan of record's own open items — the
backlog above does not duplicate them; items 2–3 are prerequisites to Issue 14.

---

## 7. Rejected recommendations

Each rejected because its payoff assumes scale or failure modes this company does
not have (1→10 clinics, low hundreds of calls/month, one operator):

- **Durable event bus / outbox + worker** — in-memory bus on a single instance is
  the documented design; volumes make loss windows negligible (`workflowEngine.js:107-117`).
- **Redis/Postgres session store + distributed rate limiter** — one operator, one
  instance; restart-as-recovery is documented and acceptable.
- **Cross-instance cache invalidation fan-out** — single instance by design; the
  5-min CLI-pause lag is documented with a panel-button workaround.
- **ORM / query builder** — 233 parameterized raw-SQL sites audited clean; a
  migration would churn every module for zero correctness gain.
- **Retry queue for reply-path sends** — crons already retry their sends; a missed
  chat reply at this volume is a shrug, not an outage.
- **Reply fallback message on Gemini failure** — silence + trace is acceptable at
  launch; revisit only if the 48h watch shows real frequency.
- **pgvector partitioning / per-tenant HNSW** — tens-to-hundreds of chunks per
  tenant; the tenant-filtered query is already correct.
- **helmet/CSP adoption** — three targeted headers cover a JSON API + static panel.
- **Multi-user admin / RBAC** — single founder-operator; sessions + one password
  match reality. Becomes real work only when a second human gets panel access.
- **Worker liveness in `/health`** — the worker is a separate deployable with its
  own lifecycle; the Node health check answering for it would lie in both directions.
- **Prompt-injection hardening layer for customer memory** — tool surface is two
  booking functions with server-side validation; guardrail renders last. Revisit
  when tools grow teeth.
- **Turning SSE streaming on now** — PR9C is deliberately dark pending colocated
  prod measurement; that decision is correct, keep it.
- **Load testing** — hundreds of interactions/month; the statement timeout and turn
  budget are the right protections.
- **APM / log-drain SaaS** — pino JSON + correlation ids + turn traces already
  answer "what happened"; Railway log retention suffices at this size.

---

## 8. UNREVIEWED

Verdicts above make no claims about these; they were not read (or only greped):

- `web/` — entire Next.js marketing site (out of runtime scope).
- `design-reference/` — static HTML references.
- `spike/voice-retell/` — dead spike; greped for secrets only (one benign
  `access_token` console.log of an API response in `trigger.js:45`).
- `public/admin/*.js` / `*.html` internals — greped for nav links and the
  `adminFetch` CSRF wrapper only; not line-audited (server-side authz was audited).
- Migration bodies `002–016`, `018`, `020–022` — not read line-by-line; covered
  collectively by genesis table-count, `db:status` checksum verification, and the
  green migrate tests. (`017`/`019` partially read via the wamid grep.)
- `docs/ZYON_V2_SPEC.md`, `docs/architecture/ARCHITECTURE.md`,
  `docs/reviews/voice-review-2026-07.md`, `docs/meta-template-setup.md`,
  `PR3–PR9C*.md` — consulted only where cited.
- Test file bodies except those cited (the suite's pass/fail counts are VERIFIED).
- `voice-agent/tests/*` bodies — executed (37/37), not read.
- `scripts/seed_voice_test_customer.js` beyond line 50; `scripts/test-chat.js`
  beyond its first 35 lines.
- `samples/clinic-knowledge.md`, `provision/sunrise-dental.json` beyond the read shown.
- Dependency tree beyond `npm audit` (0 vulns) — no license/supply-chain review.
