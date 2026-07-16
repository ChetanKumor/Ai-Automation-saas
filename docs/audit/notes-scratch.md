# Audit scratch notes (2026-07-16) — working memory, not the report

## Phase 0 inventory
- 277 tracked files. Node app ~9.5k LOC src+scripts+server; voice-agent (py) ~700 LOC + tests; web/ = Next.js marketing site (out of core scope); spike/voice-retell = dead spike.
- package.json: express 5, pg, pino, zod, node-cron, express-session, axios, @google/generative-ai, dotenv. devDep: nodemon. Tests: node --test with EXPLICIT file list (risk: new test file not added → silently not run; historyExclusion was added — check list covers all tests/ files).
- env.js REQUIRED: DATABASE_URL, GEMINI_API_KEY, WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD. Optional: SESSION_SECRET (len>=32 enforced if present), PORT, IDENTITY_RESOLUTION_ENABLED, VOICE_*, TURN_BUDGET_MS, DB_STATEMENT_TIMEOUT_MS.
- .env (dev): has WHATSAPP_TOKEN/PHONE_NUMBER_ID legacy vars, OLLAMA_* (dead), DOCTOR_PHONE (dead?), SESSION_SECRET ABSENT → session secret falls back to ADMIN_PASSWORD (server.js:66). DB = Neon ap-southeast-1 (sslmode=require in URL; db.js ssl flag only in prod but URL param governs).
- Migrations 002..022 on disk; schema.sql = genesis (001 folded in). Tables: tenants, users, customers, conversations, messages, tags, customer_tags(NO tenant_id — junction), customer_memory, knowledge_chunks, tenant_entities, appointments, notifications, handoff_sessions, leads, payment_schedules, workflow_rules, workflow_executions(tenant_id no FK), channel_identifiers, call_sessions, tenant_configs, tenant_config_revisions, validation_runs, turn_traces. + schema_migrations (runner).
- server.js: /health does SELECT 1 (DB yes, worker liveness NO). trust proxy gated NODE_ENV=production. Session cookie httpOnly/sameSite=strict/secure(prod)/12h. In-memory session store (documented tradeoff). Graceful shutdown: server.close → crons stop → tenantService.stop → pool close; 10s force timer.
- db.js: statement_timeout via startup `options` (Neon-compatible), default 5000ms; ssl rejectUnauthorized:false in prod (accepts any cert — note).

## Findings candidates (running list)
- [F?] Webhook batching: routes.js:70 reads entry[0].changes[0] only; adapter.parseInbound takes messages[0] only → 2nd+ messages in one Meta POST silently dropped (not stored). Meta does batch. Evidence READ routes.js:70, adapter.js:47.
- [F?] console.time/console.log in prod hot path (routes.js) — non-structured stdout beside pino. Debt.
- [F?] WA send failure → reply lost silently (no retry/queue), routes.js:215-219. Also AI failure → customer silence. Failure-mode note.
- [F?] session secret fallback chain SESSION_SECRET || ADMIN_PASSWORD (server.js:66) — secret reuse; prod-readiness doc probably mandates SESSION_SECRET; verify.
- [F?] db.js ssl rejectUnauthorized:false in prod — MITM-tolerant TLS to Postgres. Railway internal net mitigates; note POST-LAUNCH.
- [F?] schema.sql §19 comment "No runtime code reads these yet" — stale (configService reads them). Doc drift only.
- [F?] CLAUDE.md says uniq_open_conversation_per_customer ON conversations(customer_id); actual index is uniq_open_conversation ON (tenant_id, customer_id) (schema.sql:178). Doc drift only.
- mode-check race (routes.js:145-150): human takeover mid-generation → AI still replies once. Known coexistence limitation; note only.

## Read so far
server.js, package.json, env.js, db.js, migrate.js, schema.sql, whatsapp/routes.js, whatsapp/adapter.js, utils/hmac.js, plan of record.

## To verify at runtime
- npm test (running bg id bjv70cfk3)
- genesis on scratch Neon DB audit_genesis_<ts> (create via pg from repo node_modules; DROP after)
- provision-tenant --dry-run
- validate-tenant CLI (scripted harness; needs VOICE_ENABLED? check)

## Runtime evidence (VERIFIED)
- npm test: 444/444 pass, 84 suites, 0 fail, 79.3s, exit 0.
- ORPHANED TESTS: tests/workflow/{seedIntegration,workflowEngine}.test.js NOT in npm-test list. workflowEngine passes standalone; seedIntegration FAILS (legacy script-style, old underscore event names `lead_created`, mutates dev DB — my run deleted workflow_executions rows for oldest dev tenant; disclosed).
- Genesis (scratch DB audit_genesis_20260716 on Neon): "✓ genesis complete: applied schema.sql and stamped 21 migration(s)"; re-genesis refused (non-empty); db:migrate "no pending"; 24 tables (23 app + schema_migrations).
- provision --dry-run: plan printed, "no rows written", tenants count 0 after. Real run x2: idempotent (skipping: tenant, config@v1), same tenant id, 1/1/1 rows. seeds:[] — no workflow seeds for clinic vertical (check provisioningService intent).
- Validation catalog runs 13 named checks; bare tenant: 5 honest fails (kb x2, whatsapp x2, turn.scripted "no doctor schedules"), voice.config gated skip.
- Lifecycle chain on probe tenant: REFUSED NOT_VALIDATED before validation; validate --skip kb,turn → draft→validated; activate → live(active=true); pause → paused(active=false). Wrong-state refusals all correct.
- Papercut: CLI --skip accepts non-skippable names (whatsapp.config) but service silently ignores → operator sees FAIL with no hint the skip was ignored (validate-tenant.js expandSkips accepts any CHECK_NAME; validationService skipReason honors skippable-only).
- Footgun (note): all-material-checks-skipped run still counts "passed" → can activate. Skips recorded honestly; operator choice. POST-LAUNCH note.
- Doc drift: configService header "No runtime consumer reads this yet" stale; schema.sql §19 same.
- clinicDefaults: whatsapp.enabled=true, voice.enabled=false, escalation.enabled=true w/ EMPTY numbers (=> bare provision fails numbers.e164 — validation catches; fine).
- Scratch DB kept alive for possible turn.scripted probe; DROP at end of audit.

## Voice path findings (READ)
- F-VOICE-ONLY-TENANT: internalVoice handleTurn+SSE hydrate tenant via SELECT phone_number_id → tenantService.getByPhoneNumberId (internalVoice.js:163-168, 385-390). Voice-only tenant (PNID null — supported per schema.sql:50-52 slug rationale) → 404 'tenant credentials not found' EVERY turn. PNID set but wa_token null → decrypt(null) throws (tenantService.js:49, encryption.js:15) → 500. Voice turns REQUIRE WA-credentialed tenant. Blocks voice-first customer.
- Issue 11 DID→tenant resolution: MISSING. Only reader of voice.did is validation check (validationService.js:250). No getTenantByChannel anywhere. Worker passes tenant_id from room metadata or VOICE_TENANT_ID env (agent.py:309).
- Issue 12 SIP inbound wiring: MISSING. agent.py explicitly "DARK / LOCAL ONLY: telephony stays noop... No PSTN" (agent.py:22). No SIP metadata extraction.
- Issue 13 Plivo provider: STUB — all methods throw NotImplemented (plivo.js). Seam (telephonyProvider registry w/ conformance checks) exists.
- Invariant 1 (worker transport-only): HOLDS. BrainStubLLM raises if reached; no DB; static apologies; delegates all turns (agent.py:116-123, brain_client.py).
- brain_client: no retries by design (apology + end 'failed'); call_end failure → call_sessions stuck 'in_progress' forever (no reaper) — minor.
- Voice inbound messages have NO external_id (internalVoice.js:191-197) → no idempotency for /turn retries; worker never retries, so latent only.
- internalVoice startSession hardcodes provider:'noop' (line 589).
- Terminal-transition guard V-004 verified in code (callSessions.js:65 WHERE status='in_progress'; adapter emits call.ended only on actual transition).
- call_session lookup by id w/o tenant (internalVoice.js:150) — id IS the capability behind HMAC; tenant derived from row; customer/conversation validated against tenant after. OK.
- Ack copy VOICE_ACK_COPY te/hi/en (internalVoice.js:50) — brain-authored ✓.
- TURN_BUDGET_MS 8000 < worker VOICE_TURN_TIMEOUT_S 10s pinned relationship documented both sides.

## Other module findings (READ)
- coreActions.send_whatsapp_message sends but never INSERTs messages row → workflow-sent texts invisible in history/panel (coreActions.js:37-77). notify_owner also no notifications-table row (two notification paths: notificationService writes log; coreActions.notify_owner doesn't).
- extractionHandler emits legacy underscore events lead_created/lead_updated (extractionHandler.js:155-156); seedRules subscribes to same → consistent but off-convention vs eventTypes.js dot-names. place_call action unregistered → overdue_escalation rule permanently 'skipped'.
- Collections: NO feature flag exists. collectionsModule.init() unconditional (server.js:105) — cron every 30min. Admin GET /api/collections read-only; NO UI/API write path to payment_schedules; workflow rules not creatable via panel; schedule_payment_reminder action reachable only via manually-inserted rule. Invariant-3 verdict: writes unreachable ✓, but "feature-flagged OFF" literally false.
- Admin: mutating routes = requireAuth+apiLimiter+requireAdminHeader ✓; login limiter 5/15min + ~300ms delay + session.regenerate ✓; safeEqual sha256+timingSafeEqual ✓; headers nosniff/DENY/no-referrer ✓. GET reminders routes lack UUID guard (22P02→500) — papercut. Panel is cross-tenant by design (single operator).
- identityService.getTimeline: NO tenant filter + NO production caller (dead export) — remove or scope.
- appointmentService: advance_days/buffer_minutes/allow_same_day/hours+holidays NOT enforced in booking (only slot_minutes + doctor schedule + past-check). Config knobs validated+editable but inert. bookAppointment UPDATE customers name w/o tenant filter (appointmentService.js:171-174) — PK-only, internal id, letter-of-invariant violation.
- conversations upsert ON CONFLICT (tenant_id, customer_id) WHERE status='open' matches schema partial idx ✓ (CLAUDE.md says customer_id only — doc drift).
- knowledgeService.getRelevantChunks tenant-filtered ✓ (pgvector leak-path clean). storeChunks sequential embed loop (ingest-time only).
- workflowEngine: (rule_id, event_id) idempotent claim ✓ depth guard ✓ tenant-scoped rule lookup ✓.
- Webhook sig verify: HMAC sha256 timingSafeEqual + length check, raw body ✓ (routes.js:23-51 + adapter.verifyWebhook duplicate impl — minor duplication).
- classifySendError: 429/5xx/network→retryable; 131047→needs_template ✓ (used by collections + reminder crons; NOT by the live reply path — reply send failure = logged drop).

## Final runtime evidence (appended at report time)
- turn.scripted LIVE probe on scratch DB: PASS — booked appt 106ec4c6 (Dr. Audit 2026-07-30 16:30) in 1 turn, book_appointment(200ms), turn 2944ms, synthetic purged 0 residue. Note: model booked on turn 1 despite confirm-first prompt rule (fully-specified request).
- turn_traces row VERIFIED queryable: correlation probe_0986cbb99c974a9a, stage_timings, prompt {hash, mode:rendered, config_version:1}, llm meta (2 calls, 2000 in/129 out), tool_calls outcome ok/success — Phase 2f evidence.
- Python worker: 37/37 pass with VOICE_STREAM_TURNS=false; 4/37 fail under ambient .env leak (VOICE_STREAM_TURNS=true) — test isolation gap, not product bug.
- npm audit --omit=dev: 0 vulnerabilities.
- wamid grep: clean (only migration record files + dev-script var name).
- Secrets: .env never tracked; no key patterns in last 40 commits/worktree; .gitignore has committed conflict marker (>>>>>>> 1a7b8f0).
- E.164 divergence trap found: WA stores digits (919…), voice caller_id verbatim (+919…) → exact-match identity duplicates customer (F-003).
- Scratch DB audit_genesis_20260716 DROPPED.

## Phase 1 verdicts (summary)
COMPLETE: 3,4,5,6,7,8,9,10,15,16,17,18,19(doc),21(dev-evid)
PARTIAL: 22 (prod-call evid pending), 25 (collections not hidden + prod), 26 (prod)
MISSING: 11,12,13,20,23,24,27,28
UNVERIFIABLE: 14 (PENDING-DID)
Gates: 3/7 pass (genesis, isolation, Issue18); FAIL backups; PENDING WA-prod/voice/trace-e2e.
