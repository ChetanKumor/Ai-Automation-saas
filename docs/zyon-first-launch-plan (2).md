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

**Issue 11 — feat: DID→tenant resolution.**
`getTenantByChannel('voice', did)` reading `voice.did` from config; unknown-DID
rejection path. DoD: unit tests incl. tenant isolation.

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
