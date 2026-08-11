# Zyon — First Production Launch Plan (greenfield)

> Plan of record, replacing the migration-upgrade runbook. There is no existing
> production deployment and no existing production customers. Prod is born
> fresh: DB initialized from `schema.sql` (genesis baseline). No expand-contract,
> no upgrade windows, no legacy-data rollback.
>
> Workflow unchanged: one issue per Claude Code session, conventional commits,
> prompt files produced per issue, runtime evidence before anything is "done".

---

## Launch strategy in one paragraph

Two clocks run in parallel from day 1. The **external clock** (Plivo DID +
KYC/DLT, WhatsApp manual setup for customer #1) is started immediately because
no code shortens it and it is likely the long pole. The **build clock** runs
the critical path: hygiene fixes → retire wamid while it's free → migration
runner → config engine → Plivo/voice go-live gate → provisioning + validation →
panel hardening → genesis deploy → traces → onboard customer #1 with a runbook
that customer #2 turns into the <15-minute path. Voice and WhatsApp can go
live for customer #1 independently — whichever external clock finishes first
ships first.

**Windfall from the greenfield correction:** the wamid column drop (old PR8)
needed a production verification window only to protect live data. There is no
live data. Issue 5 retires it now, permanently deleting that ceremony — but
only if done **before** first deploy. After launch it reverts to
expand-contract. Do not let it slip past Issue 20.

---

## Phase 0 — External clocks (start today; ops, not code)

**Issue 1 (ops) — Telephony procurement.**
Plivo account; SIP trunking enabled; Indian DID ordered for customer #1
(clinic-presented number); KYC/DLT documentation submitted; LiveKit Cloud
project created (region nearest Railway deployment region).
DoD: DID order + KYC submission confirmations logged; expected-availability
date recorded.

**Issue 2 (ops) — WhatsApp path for customer #1.**
Manual (pre-Tech-Provider) setup started: WABA, number, webhook plan.
DoD: setup initiated; blocking steps + dates logged.

## Phase 1 — Pre-launch hygiene (parallel with Phase 0)

**Issue 3 — fix: CRM event-name mismatch.**
`message_received` → `message.received`; regression test asserting extraction
fires on a stored inbound message. DoD: test red-before/green-after.

**Issue 4 — fix: tenant cache timer + invalidation.**
`unref()` the cache timer; add authenticated cache-invalidation endpoint.
DoD: test wall-clock inflation gone; invalidation verified via changed config
read-through.

**Issue 5 — chore: retire `wamid` (pre-launch only).**
Remove column from `schema.sql`, remove dual-write, retarget any remaining
reads/tests to `external_id`. DoD: grep-clean of wamid outside comments; full
suite green; note in commit that this supersedes old PR8.

**Issue 6 — chore: migration runner + genesis baseline.**
Adopt runner (`node-pg-migrate` or minimal `schema_migrations` + ordered SQL);
declare current `schema.sql` the genesis; all future schema change = migration.
DoD: fresh DB bootstraps from genesis via one command; runner refuses re-apply.

## Phase 2 — Configuration engine

**Issue 7 — feat: control-plane schema (first migration under the runner).**
`tenant_configs` (version, JSONB), `tenant_config_revisions`,
`validation_runs`, `tenants.status` (draft→validated→live→paused).
DoD: migration applies to fresh DB; schema.sql in lockstep.

**Issue 8 — feat: configService.**
Zod schema — languages, greeting per language, hours, holidays, booking rules,
escalation, owner numbers, personality, tool toggles, `voice.did`,
`recording_consent` (line per language; recordings OFF in v1),
`retention_days`. Defaults+merge, `getTenantConfig`, invalidation hook.
DoD: invalid config rejected with path-level errors; loader cached + invalidable.

**Issue 9 — refactor: brain read-sites → configService.**
Behavior-preserving repoint of prompt data, hours, greeting, escalation reads.
Split WA-path/voice-path into two issues if it runs long.
DoD: full suite green; no behavior diff on scripted turns.

**Issue 10 — feat: clinic prompt renderer.**
Vertical template + tenant config → system prompt; no-medical-advice guardrail
and consent line baked in; freeform `ai_prompt` demoted to override.
DoD: rendered prompt snapshot tests per language.

## Phase 3 — Plivo / voice go-live (critical build path)

**Issue 11 — feat: DID→tenant resolution.** **DONE.**
`tenantService.getByDid(dialledNumber)` reading `voice.did` from the tenant
config document (`tenant_configs.config`, JSONB — no column, no migration, no
index); unknown-DID rejection path. DoD: integration tests incl. tenant
isolation.

⚠️ **Named `getByDid`, NOT the `getTenantByChannel('voice', did)` this line
carried until the issue shipped** — and `docs/ZYON_V2_SPEC.md:118` still lists
the old name, deliberately left as the historical spec it is. A two-argument
dispatcher whose first argument has exactly one legal value is a seam for
Issues 12/13, which Issue 11's scope forbids building; the codebase's actual
convention is one named resolver per channel identifier
(`getByPhoneNumberId`), not a dispatcher. Renamed here in the shipping commit
so that a future session re-running the audit's
`VERIFIED grep: no getTenantByChannel`
(`docs/deploy/audit/2026-07-production-readiness.md:77`) does not read zero
hits as "unstarted".

⚠️ **Unwired.** The resolver has no production caller — Issue 12 supplies the
dialled number. Its only evidence is its tests.

**Issue 12 — feat: LiveKit SIP inbound wiring.**
Inbound trunk + dispatch rule; worker extracts SIP metadata (caller/called
numbers) and passes real values to `call/start` (replacing dev-injected ones).
Session starts with a Phase-0 read of current LiveKit SIP docs; STOP if the
trunk/dispatch model differs from assumptions. DoD: Plivo test call reaches a
worker-joined room with correct metadata in logs.

**Issue 13 — feat: PlivoTelephonyProvider (inbound v1).**
Implementation behind the existing TelephonyProvider seam: trunk reference,
hangup/lifecycle handling, call metadata. Outbound is out of scope.
DoD: provider swap test (noop↔plivo) passes; seam untouched.

**Issue 14 — verify: live-call gate (runtime evidence).**
Real phone → DID → LiveKit → worker → brain → Sarvam reply. Caller identity
resolves; Telugu booking books a row; `call_sessions` correct;
per-stage latency within the PR9A budget; consent line spoken.
DoD: evidence log with transcript, row IDs, latency table. **Nothing ships to
a customer until this passes.**

## Phase 4 — Provisioning + validation

**Issue 15 — feat: provisioningService + `provision-tenant` CLI.**
Idempotent by slug, `--dry-run`; creates tenant (draft) + config v1 + rendered
prompt + workflow/CRM/notification seeds + KB namespace (+ optional
`--kb-dir` ingest). Collections feature-flagged OFF for clinic vertical.
DoD: run-twice test = no duplicates; dry-run touches nothing.

**Issue 16 — feat: validation, static.**
Zod completeness, prompt renders per language, hours/escalation sanity
(E.164), KB min chunk count + retrieval smoke, WA credential check
(skippable), consent line present. Persists `validation_runs`.
DoD: seeded broken configs each fail with the right reason.

**Issue 17 — feat: validation, dynamic + activation.**
Scripted booking turn via the PR7 `/internal/voice/turn` harness in test mode;
activation endpoint refuses unless latest run passed; status lifecycle
enforced. DoD: cannot activate an unvalidated tenant; can activate a validated
one; cache invalidated on activation.

## Phase 5 — First production deploy

**Issue 18 — chore: admin panel hardening (pre-exposure gate).**
Cookie flags, rate limiting, constant-time/hashed password compare, session
config. The panel goes internet-facing for the first time at Issue 20 — this
blocks it. DoD: checklist from spec's launch-fixes list all closed.

**Issue 19 (ops) — production infrastructure.**
Railway prod project: Node service + worker service + Postgres, colocated
region (per the latency prerequisite); LiveKit prod project same region; env
vars reconciled against `env.js`'s required list; prod Gemini key =
billing-enabled, split from dev; secrets set. DoD: env audit table committed.

**Issue 20 (ops) — genesis deploy + prod smoke.**
Initialize DB from genesis via the runner; deploy Node + worker; `/health`
green; panel over HTTPS; then live smoke on an internal pilot tenant: one real
WhatsApp round-trip AND one real phone call in prod. DoD: prod evidence log
started with both transcripts + row evidence.

## Phase 6 — Observability before customers

**Issue 21 — feat: correlation IDs.**
One ID threaded request→turn→worker→DB writes→events, present in all logs.
DoD: single grep of one call's ID reconstructs its full path.

**Issue 22 — feat: `turn_traces` capture.**
Async write after TTS dispatch (never on the hot path): stage timings
(reusing `contextAssembler` sub-timings), retrieved chunk ids, prompt ref, LLM
meta, tool calls, error; retention from config. DoD: live prod call produces a
queryable trace; measured hot-path delta ≈ 0.

## Phase 7 — Onboard + make repeatable

**Issue 23 (ops) — Onboarding runbook v1 + customer #1 live.**
Written as executed: gather clinic info → config file (git) → provision CLI →
KB ingest → DID attach → WA attach (if ready) → validate → owner test call →
consent sign-off → activate. Every friction point logged.
DoD: customer #1 status='live'; first real patient interaction traced.

**Issue 24 (ops) — 48h live watch.**
Daily trace/log review; defects filed as issues, not hot-fixed silently.
DoD: watch notes committed; defect list triaged.

**Issue 25 — feat: page — tenant detail** (effective config + JSON edit w/
server-side Zod, validation history, activate button; collections hidden).
**Issue 26 — feat: page — conversations** (both channels, messages +
call_sessions on one thread).
**Issue 27 — feat: page — trace viewer** (per-turn waterfall, expandable
detail).
Each DoD: renders live prod data; rides existing static panel; no new stack.

**Issue 28 — Runbook v2 + customer #2.**
Fold in #1's friction; target: software path (config→provision→validate→
activate) under 15 minutes, measured. DoD: stopwatch evidence.

## Phase 8 — Post-plan additions

Issues 1–28 above are the original plan. The sequence did not stop there.
**These plan-of-record numbers are the only issue sequence this project has** —
there is no GitHub issue tracker in use, and nothing in the repo references one.
Allocate the next free number here; do not restart at 29.

**Issue 29 — feat: turn cancellation + coordinated deadlines (V-001/V-003).**
**DONE** (`1605954`). Combined close/deadline `AbortSignal` threaded through the
voice turn; `TURN_BUDGET_MS` pinned strictly below the worker's
`VOICE_TURN_TIMEOUT_S`; app-pool `statement_timeout`; point-of-no-return so a
committed booking's confirmation always persists. Evidenced across 12 files —
`src/routes/internalVoice.js:58,116,220,248`, `src/modules/ai/aiService.js:22,82,190,216,310`,
`src/db/db.js:4`, `src/infra/config/env.js:59`, `src/modules/traces/writer.js:9,16`,
`src/modules/traces/collector.js:79`, `src/modules/knowledge/knowledgeService.js:7`,
`src/modules/conversation/contextAssembler.js:42`,
`tests/voice/voiceCancellation.integration.test.js:18,148`,
`tests/db/statementTimeout.test.js:3,17`, `.env.example:65`,
`docs/deploy/prod-readiness.md:51-52`.

**Issue 30 — fix: per-channel extraction policy (V-002).**
**DONE** (`2948a10`, merged `dabe207`). `channel` + `msg_type` ride the
`MESSAGE_RECEIVED` event; voice extraction defaults OFF. Evidenced at
`src/modules/config/schema.js:250`, `tests/crm/extraction.bus.test.js:94,312`,
`tests/voice/voiceLifecycle.integration.test.js:181`.

**Issues 31–33 — allocated, unverified.**
Allocated to the voice-review sessions V-004 (`5bb60ab`, terminal-transition guard
on `call_sessions`), V-008 (`629f7fb`, slot-grid validation from
`booking.slot_minutes`) and V-009 (`f097b77`, history excluded by id not OFFSET).
Those commits landed under their V-numbers and **write no `Issue NN` string
anywhere in the repo**, so the mapping is recollection, not repo evidence —
recorded here so the numbers are not reissued. ⚠️ unverified.

**Issue 34 — fix: admin-created tenants silently ignore all portal-written prompt copy.**
**DONE.** Shipped in two halves. A non-null `tenants.ai_prompt` short-circuits the
config read entirely (`src/modules/ai/aiService.js:466-467`, `400-405`), so every
portal-written prompt field is inert while booking enforcement, doctors and knowledge
chunks survive. Full finding, the shadowed/survives tables, both options and the
recommendation: **[`issue-34-legacy-prompt-shadows-portal-config.md`](issue-34-legacy-prompt-shadows-portal-config.md)**.

- **The warning (F-F001, `6ceb8f0`).** The portal now tells an owner when their saved
  settings are shadowed, and names which fields are inert. A safety net over the
  hazard, not a removal of it — legacy tenants exist and can still be created
  deliberately, so the notice stays.
- **The hazard (option (a), this commit).** The free-text prompt field is gone from
  `public/admin/tenant-new.html`, and `POST /admin/api/tenants` refuses a non-empty
  `ai_prompt` rather than quietly honouring it — removing the input alone would have
  left the API surface unchanged and invited a rebuilt UI to reset the trap. Admin-
  created tenants are now born on the renderer, matching `provisioningService.js:226`.

The precedence chain in `aiService` is untouched, as the finding requires. Setting a
legacy prompt remains possible **on purpose** via `scripts/update-prompt.js`; the issue
removed the accident, not the capability. Covered by `tests/admin/tenantCreate.test.js`
(form + route, 5 tests).

**Issue 35 — feat: migrate the voice worker to Sarvam realtime STT + telephony tuning.**
Allocated; prompt at `docs/prompts/issue-35-sarvam-realtime-stt.md`. Not started.

**Issue 36 — chore: no operator surface writes `voice.did`.**
Filed by the Issue 11 session, **not built, and NOT a launch blocker.** Verified by
grep across `src/`, `scripts/` and `tests/`: `voice.did` is declared
(`src/modules/config/schema.js:257`, `defaults.js:109`), read by validation
(`src/modules/validation/validationService.js:259-264`) and now by
`tenantService.getByDid`, and **written by nothing that has a UI or a CLI flag**.
The Issue 15 provisioning CLI does not set it; the portal deliberately does not
(`src/portal/routes.js:1433,1606` say so, and preserve it across saves); no script
touches it.

**Severity is ergonomics, not correctness.** The path is not broken — an operator can
set a DID today through the admin JSON config editor, which goes through
`configService.writeTenantConfig` and validates it against `E164` like any other
field. What is missing is a labelled field, so setting a clinic's phone number means
hand-editing a JSON document.

Recorded because this is structurally the same shape as **B1's
`tenants.owner_notify_phone`** — a field the runtime keys on that no product surface
populates — and that one was expensive precisely because it was found late. This one
is found before it has a caller. Do it when Issue 12 or 13 makes a DID something an
operator actually needs to enter; there is nothing to configure until then, and
external clock C-2 (Plivo DID) is still unfiled.

**Issue 37 — chore: `customers.preferred_language` is written unvalidated.**
Filed by the V1c session, **not built.** `customerService.js:69-73` writes whatever
string arrived as the turn's `language` straight into the column, on first detection:

```sql
UPDATE customers SET preferred_language = $1
 WHERE id = $2 AND tenant_id = $3 AND preferred_language IS NULL
```

The value originates outside this system. Sarvam STT sets it
(`voice-agent/agent.py:523-524`, `ev.language`), the worker forwards it on
`delegate_turn`, and nothing between the socket and the UPDATE checks it against
`configSchema`'s `LANG_CODES`. So the column that names a customer's language is
constrained by the config schema in intent and by nothing at all in fact: it holds
`te-IN` today because that is what the vendor happens to emit, and would hold
`ta-IN`, `zh`, or a vendor error string just as readily.

**This is the divergence `configLang` was built to absorb, not to hide.** V1c
normalises at the read boundary (`src/modules/config/schema.js`), so an unresolvable
value now falls back to the tenant default with a WARN instead of silently becoming
an English greeting — but the column still accumulates values no schema admits, and
every future reader inherits the same obligation. Two candidate fixes, neither
chosen here: normalise on WRITE (cheap, but rewrites history's meaning and discards a
signal about what STT actually returns), or add a CHECK constraint and reject
(honest, but turns a vendor surprise into a failed turn on the call path).

**Not a launch blocker and not a correctness bug at HEAD** — the one reader that
matters reads through `configLang`, and `resolveLanguage`'s other consumer
(`ackTextFor`) was repointed through it in the same commit. Recorded so the next
reader of that column does not assume it holds a `LANG_CODES` value.

**Issue 38 — chore: the worker's TTS language ignores the greeting's language.**
Observed during V1c's dev-room run, **not built.** `agent.py:501` constructs the
Sarvam TTS with `target_language_code=language_prior or DEFAULT_LANGUAGE`, where
`language_prior` comes from room metadata and `DEFAULT_LANGUAGE` is `te-IN`. The
greeting's language is resolved independently, by the brain, from the caller's
stored `preferred_language` — and `/call/start` returns only the text.

Measured, not inferred: with the dev caller stored as `en-IN`, `/call/start`
returned *"Hello! Welcome. How can I help you today?"* and the worker synthesised it
with `target_language_code: "te-IN"` — an English sentence spoken by a
Telugu-configured voice. The first turn then corrects it, because
`_switch_tts_language` runs on the brain's `language` in the turn response.

So the mismatch is confined to the greeting, which is exactly the utterance V1c
added. Fixing it means either returning the resolved language code beside the
greeting on `/call/start` (small, and the payload is already there) or having the
worker send its `language_prior`. Deliberately out of V1c's scope — that session was
explicitly barred from TTS changes — and the greeting is intelligible either way,
so this is quality, not breakage.

---

## Cut lines & critical path

- **Customer #1 live** requires Issues 1–24 minus 25–27 (pages are
  post-onboarding). Build-clock estimate at one-issue-per-session cadence:
  ~3–4 weeks. The external DID/KYC clock is likely the true gate — hence
  Issue 1 today.
- Issues 3–10 need no telephony and proceed regardless of Plivo timing.
- Issue 5 (wamid retirement) is only cheap **before** Issue 20. If launch
  pressure forces dropping it, it returns as expand-contract later — decide
  consciously, log the decision.
- Voice-first or WA-first go-live for customer #1 is determined by whichever
  external clock (Issue 1 vs Issue 2) clears first; the architecture supports
  either alone.
