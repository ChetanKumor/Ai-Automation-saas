# Voice Subsystem Review — pre-Customer-#1 (adversarial)

**Date:** 2026-07-11
**Reviewed at:** `dfb915d057ba5134c04c8f3f14e54bac5fc06ffa` (`chore(deploy): production readiness…`, local `main`)
**Working tree:** clean at review start (verified `git status --porcelain` empty).
**Reviewer:** Claude Code, hostile-review session. Zero code changed; throwaway probes deleted.

---

## Executive verdict

The voice architecture is sound — Node is genuinely the only brain, the worker is genuinely transport-only, and correlation/traces/tenant-scoping are in better shape than most systems at this stage — but the turn pipeline has one launch-blocking flaw: the default (JSON) turn path has **no cancellation or deadline coupling** between the worker's 10-second give-up and the server, so a slow booking turn ends with the caller hearing "technical trouble, call again later" while the server books the appointment anyway (tool execution after client abandon was reproduced live in this review). After fixing V-001 and the two HIGHs (voice extraction policy not enforced; no server-side external-call deadlines), I am moderately-to-highly confident this pipeline is safe for a single clinic at modest call volume — the remaining MEDIUMs are recoverable operator-visible defects, not silent corruption, and the substrate (isolation, idempotent booking constraint, trace/correlation plumbing) held up under deliberate abuse.

---

## Preflight

- Commit range examined: `90c02fc..dfb915d` (control-plane schema → prod readiness). Voice-relevant recent commits: `9e222b7` (correlation ids), `64313ac` (turn traces), `c094256` (lifecycle + turn.scripted), plus the PR6/PR9A/PR9C voice stack already on main.
- No uncommitted changes to voice code at review time. (Local `.env` files differ from committed examples — noted where relevant, not a code finding.)
- Known-context ledger re-verified: items 1–8 and 10 **hold** (worker contains zero reasoning — `agent.py` llm_node is a pure forwarding shim, `turn_context.py` extracts only the latest user text; HMAC + fresh-id trust boundary as designed; voice re-reads `active` per turn at `internalVoice.js:124/311`; bus capture-and-restore verified at `core/events.js:45-50`; workflow `MAX_WORKFLOW_DEPTH` guard present). Item 9 is **violated** — see V-002. Item 10's "dev key now paid" did not hold in this environment (live 429 `free_tier_requests, limit: 5` observed) — environmental, not a code finding, but the quota-contention mechanism it exposed is real (V-002).

---

## Findings

### V-001 — Worker abandons a turn at 10s; the server keeps executing it, including booking writes

```
ID: V-001
Severity: BLOCKER
Evidence: [reproduced]
Where: voice-agent/agent.py:52 (TURN_TIMEOUT_S=10), voice-agent/brain_client.py:107
  (per-request timeout, no retry), src/routes/internalVoice.js:85-220 (JSON branch:
  no res.on('close'), no AbortSignal), src/modules/ai/aiService.js:144-176
  (sendMessage without signal or deadline; tool loop continues unconditionally)
Root cause: cancellation propagates end-to-end only on the SSE path
  (res.on('close') → AbortSignal → throwIfAborted between tool rounds,
  internalVoice.js:268-272 + aiService.js:240-250). The default JSON path has
  neither disconnect detection nor a server-side deadline, and the worker's
  BrainError path speaks a static apology and ends the call 'failed' with no
  retry (agent.py:200-206). The two sides' timeout budgets are uncoordinated.
Runtime impact: any turn slower than 10s (a booking turn is ≥2 Gemini calls +
  tool DB work; simple probe turns measured 2.3-3.1s server-side, so tail
  latency crosses 10s under normal Gemini variance) makes the caller hear
  "technical trouble, please call again later" and the call ends — while the
  server finishes the turn: tools execute, book_appointment commits, the
  outbound message persists, and the trace records a clean success.
Reproduction path: live-reproduced. Client aborted a JSON /turn at 500ms;
  server-side the turn continued: gemini_call_1 completed (~1.2s), then
  check_availability executed ~2s AFTER the client was gone (turn trace
  had_tools:true, correlation call_247c8d6143ca415b). The same mechanism with
  book_appointment commits a booking the caller believes failed.
Customer #1 exposure: YES — one slow Gemini day + one booking turn in week
  one produces a ghost booking plus a confused re-booking caller (double
  appointment under two slots, or a "taken" slot nobody knows about).
Recommended fix: (1) wire res.on('close') + AbortSignal into the JSON branch
  exactly as SSE does, checked between Gemini calls and before each tool
  execution; (2) pick ONE turn budget — server deadline slightly under the
  worker timeout — so the server never outlives the worker's patience. Size: M.
Blocks launch: YES
```

### V-002 — `crm.extraction.voice: 'off'` is declared but never enforced; extraction runs on every voice utterance

```
ID: V-002
Severity: HIGH
Evidence: [reproduced]
Where: src/modules/crm/extractionHandler.js:43-108 (unconditional
  MESSAGE_RECEIVED subscriber, no channel or policy check),
  src/routes/internalVoice.js:164-171 and 342-349 (voice emits MESSAGE_RECEIVED
  per finalized utterance), src/modules/config/schema.js:97-99 (policy knob,
  default 'off' — zero readers anywhere in src/),
  src/modules/crm/extractionHandler.js:87 (source hardcoded 'whatsapp')
Root cause: the extraction policy exists only as config schema; the handler
  gates on conversation mode alone. MESSAGE_RECEIVED carries no channel field
  (previously-recorded landmine), so the handler couldn't distinguish voice
  even if it tried. This violates known-context ledger item 9 (voice
  extraction defaults OFF by explicit decision).
Runtime impact: one extra Gemini generateContent per spoken utterance —
  roughly doubling model-call volume per call — plus junk leads: the live
  probe's "hello, what services do you offer?" created a lead
  (lead_created, intent medium) tagged source:'whatsapp'. Worse, extraction
  calls and turn calls share one API key/quota: in the probe, extraction
  traffic consumed the per-minute quota and the ACTUAL TURN failed with 429
  mid-tool-loop (captured in its turn trace). On a paid key the starvation
  threshold moves; the contention mechanism remains.
Reproduction path: live-reproduced (server log: lead_created/lead_updated per
  voice turn; 429 turn trace on the same call).
Customer #1 exposure: YES — every call inflates Gemini spend and pollutes the
  CRM with mislabeled leads from day one.
Recommended fix: add channel to the MESSAGE_RECEIVED payload (both emit
  sites + WhatsApp's), read the tenant's crm.extraction policy in the
  handler, default voice to off per the decision. Size: S.
Blocks launch: YES (S-sized, realistic week-one hit)
```

### V-003 — No deadline on any server-side external call: a turn can hang for minutes

```
ID: V-003
Severity: HIGH
Evidence: [static-analysis]
Where: src/modules/ai/aiService.js:146 (chat.sendMessage — no timeout, no
  signal; up to 6 sequential calls per turn via the tool loop),
  src/modules/knowledge/knowledgeService.js:8-13 (embedContent inside every
  turn's fetch_parallel — RAG *errors* are caught, hangs are not),
  src/db/db.js:4-9 (pg Pool: no statement_timeout / connectionTimeoutMillis)
Root cause: every external await on the JSON turn path relies on transport
  defaults (undici ~300s headers/body timeouts; Postgres none). Nothing owns
  a turn-level deadline.
Runtime impact: worst case a single JSON turn occupies the server for tens of
  minutes (6 × ~300s) after the worker abandoned it at 10s; a wedged Postgres
  statement (lock, network half-open) hangs its turn indefinitely. Requests
  don't hold pool clients between queries (verified — see Pass 4 note), so
  this leaks turns, not connections; but during drain (server.js:128-131,
  10s force-exit) such turns are killed mid-write, feeding V-006's torn-write
  window.
Reproduction path: reasoning-only — requires stalling Gemini/Postgres;
  mechanism is the absence of any code that could bound it (grep: no
  AbortSignal/timeout reaches sendMessage or embedContent on the JSON path;
  db.js sets no timeouts).
Customer #1 exposure: unlikely in week one (needs a provider stall), but the
  blast radius when it happens includes every later cleanup question.
Recommended fix: one AbortSignal.timeout(TURN_BUDGET_MS) threaded through
  Gemini + embedding calls (shares V-001's plumbing), plus
  statement_timeout/connectionTimeoutMillis on the pool. Size: S (on top of
  V-001's signal plumbing).
Blocks launch: yes as part of the V-001 fix (same plumbing); not separately.
```

### V-004 — call_sessions has no state machine: ended calls can be re-ended, flipped, and still take turns

```
ID: V-004
Severity: MEDIUM
Evidence: [reproduced]
Where: src/modules/voice/callSessions.js:43-62 (updateStatus: COALESCE
  update, no status guard), src/modules/channels/voice/voiceChannelAdapter.js:66-78
  (endSession emits call.ended on every successful update),
  src/routes/internalVoice.js:109-119 and 297-307 (turn hydration checks
  bridging, never status)
Root cause: no WHERE status = 'in_progress' (or equivalent transition check)
  on the terminal update, and turn hydration doesn't check the session state.
Runtime impact: reproduced live — call/end('completed', 42s) then
  call/end('failed', 7s) both returned 200; the row ended status='failed',
  duration=7, and call.ended was emitted twice into the bus (workflow rules
  and future post-call automation fire twice). An SSE turn then processed
  fully against the already-'failed' session. A crashing worker whose
  shutdown callback races a duplicate delivery rewrites history silently.
Reproduction path: live-reproduced (probe steps 5-6).
Customer #1 exposure: partial — needs a duplicate/late call/end or a
  worker restart mid-teardown; plausible but not daily. Double call.ended
  becomes customer-visible the day a post-call notification subscribes.
Recommended fix: updateStatus terminal transitions guard on current status
  (in_progress → completed|failed only; second call is a no-op returning the
  row, no re-emit); optionally reject turns on non-in_progress sessions.
  Size: S.
Blocks launch: no (fix pre-launch anyway — it is S and closes V-005's worst
  replay consequence too)
```

### V-005 — /internal/voice/turn is replayable and non-idempotent

```
ID: V-005
Severity: MEDIUM
Evidence: [reproduced]
Where: src/utils/hmac.js:28-35 (body-only HMAC — no timestamp, no nonce, no
  path binding), src/routes/internalVoice.js:150-156 and 333-339 (voice
  message INSERTs carry no external_id/dedup key — unlike WhatsApp's
  ON CONFLICT dedup)
Root cause: the signature authenticates bytes, not a request instance: any
  captured signed body verifies forever. Voice has no natural per-utterance
  id, so the WhatsApp idempotency pattern has no key to hang on; nothing
  else (nonce, turn counter) substitutes.
Runtime impact: reproduced — posting the identical signed body twice produced
  two inbound rows, two full Gemini turns, two lead-extraction calls. A
  replayed booking-confirmation turn re-runs book_appointment (same slot is
  absorbed by uniq_doctor_slot; a relative date like "tomorrow" re-resolved
  later books a different day). Requires network position on the internal
  path (Railway private networking) or a compromised worker — not reachable
  from the public internet.
Reproduction path: live-reproduced (probe step 3: marker rows n=2).
Customer #1 exposure: no — the worker never retries by design
  (brain_client.py has zero retry paths), and the transport is private;
  this is defense-in-depth, not a week-one hazard.
Recommended fix: include a timestamp + per-turn nonce in the signed body and
  reject stale/seen nonces (worker already generates per-call state to hold
  it); that gives the messages insert a dedup key for free. Size: M.
Blocks launch: no
```

### V-006 — Stranded call_sessions: nothing reconciles `in_progress` rows whose call/end never arrived

```
ID: V-006
Severity: MEDIUM
Evidence: [static-analysis]
Where: voice-agent/agent.py:341-357 (_on_shutdown posts call_end ONCE;
  BrainError is logged and dropped), voice-agent/agent.py:322 (call_start
  timeout after server-side commit orphans the new row), src/routes/
  internalVoice.js:480-528 (call/start not idempotent; each duplicate
  dispatch creates a fresh in_progress row; external_call_id is always null
  — provider 'noop' — so idx_call_sessions_external has nothing to key on);
  no sweeper anywhere in src/ touches call_sessions by staleness (grep:
  the only writers are create/updateStatus).
Root cause: call/end is best-effort exactly once from a process that is, by
  definition, dying when it runs; there is no server-side janitor and no
  call-identity key to reconcile against.
Runtime impact: worker crash mid-call, Node being down at hangup time, or a
  timed-out-but-committed call/start each leave a permanent
  status='in_progress' row: duration/status analytics lie, dashboards show
  phantom live calls, and CALL_ENDED consumers (memory write-back, post-call
  workflows when they arrive) never fire for those calls. The caller
  experience is unaffected; conversations stay open, which is normal here.
Reproduction path: reasoning-only (kill the worker between call/start and
  call/end; row stays in_progress forever — verified there is no code path
  that could close it).
Customer #1 exposure: partial — a single worker crash in week one creates one
  immortal phantom call; harmless until something consumes call.ended.
Recommended fix: a small staleness sweep (in_progress AND started_at < now()
  - interval '2 hours' → failed, emit call.ended) piggybacked on an existing
  cron; populate external_call_id with the LiveKit room name at call/start
  to give duplicates a dedup key. Size: S.
Blocks launch: no
```

### V-007 — SSE turn: deltas already spoken are not persisted when the model fails mid-stream

```
ID: V-007
Severity: MEDIUM
Evidence: [static-analysis]
Where: src/routes/internalVoice.js:426-440 (catch: the aborted path persists
  partialText via persistPartialOutbound, the ERROR path does not — it sends
  the 'error' event and ends), voice-agent/agent.py:276-281 (worker then
  speaks the apology on top of whatever was already synthesized)
Root cause: partial-persistence was built for the disconnect path only;
  mid-stream model/tool failure after forwarded deltas discards partialText.
Runtime impact: the caller heard N seconds of reply + an apology, but the
  conversation history contains only the inbound; the next turn's context
  (and any human agent reading the thread) is missing words that were
  actually spoken — the brain can contradict or repeat itself on the next
  turn. Failed turns do trace (verified live: 429 trace), so debugging
  survives; the transcript does not.
Reproduction path: reasoning-only (needs a Gemini failure between first delta
  and done — the live 429 hit call 2 of a tool round, before any delta).
Customer #1 exposure: only with VOICE_STREAM_TURNS=true, which is dark; no
  for a launch on the JSON path.
Recommended fix: the error path persists partialText exactly like the abort
  path (guard against double-insert), and marks the trace error as
  post-delta. Size: S.
Blocks launch: no
```

### V-008 — Booking accepts off-grid times: slot uniqueness is exact-timestamp only

```
ID: V-008
Severity: MEDIUM
Evidence: [static-analysis]
Where: src/modules/appointment/appointmentService.js:85-127 (validates day +
  working hours only; never that appointment_time lies on the
  generateSlots grid, never re-checks the booked set),
  src/db/schema.sql:326-329 (uniq_doctor_slot on exact timestamp)
Root cause: availability is slot-quantized (generateSlots), booking is not;
  the unique index only collides on byte-identical timestamps.
Runtime impact: a model-supplied 10:31 books "successfully" while 10:30 is
  taken — the doctor is double-booked in every real sense, and the 10:31 row
  never appears as a conflict to anyone. Voice raises the odds: STT +
  spoken-time parsing ("ten thirty-ish") is exactly how a non-grid ISO
  timestamp gets invented, and the system prompt's instruction to echo exact
  slots is the only guard.
Reproduction path: reasoning-only for the model step; the DB behavior is
  definitional (unique index on exact value).
Customer #1 exposure: partial — needs one hallucinated/misparsed time in
  week one; the failure is silent when it happens (both patients show up).
Recommended fix: bookAppointment validates the requested time against the
  schedule's generated slot grid and rejects non-grid times back to the
  model (it already round-trips tool errors well). Size: S.
Blocks launch: no (borderline — S fix, silent-failure class; recommend
  pre-launch)
```

### V-009 — History fetch assumes "newest row is mine": cross-channel writes corrupt turn context

```
ID: V-009
Severity: MEDIUM
Evidence: [static-analysis]
Where: src/modules/customer/customerService.js:14-24 (ORDER BY created_at
  DESC OFFSET 1 — no id tiebreaker, positional exclusion of the
  just-inserted inbound), src/routes/internalVoice.js:150 + 182 (insert then
  fetch as separate statements)
Root cause: OFFSET 1 encodes "the row I just inserted is the newest in this
  conversation", but voice and WhatsApp share one open conversation BY
  DESIGN (identity bridge, internalVoice.js:494-503) — a WhatsApp inbound or
  an agent reply landing between the voice insert and the history read makes
  OFFSET 1 skip the WRONG row: the current transcript then appears both as
  history and as the user message, and the newer WhatsApp message vanishes
  from context. created_at ties (same-ms writes) make the order itself
  nondeterministic.
Runtime impact: subtly wrong prompt context on exactly the flagship scenario
  (customer WhatsApps while on a call); no data corruption — the rows
  themselves are fine.
Reproduction path: reasoning-only (needs a timed cross-channel write; the
  window is the ~600ms between persist_inbound and fetch_parallel_history
  measured live).
Customer #1 exposure: partial — requires simultaneous channel use in the
  same second; will happen eventually, not necessarily week one.
Recommended fix: exclude by id (WHERE id != $justInserted) instead of
  OFFSET 1, add id DESC as the tiebreaker. Size: S.
Blocks launch: no
```

### V-010 — "Never dead air" has unguarded exits in the worker/tool-loop edges

```
ID: V-010
Severity: LOW
Evidence: [static-analysis]
Where: voice-agent/brain_client.py:110 (resp.json() ValueError is not
  httpx.HTTPError → escapes the BrainError contract → llm_node dies without
  apology or _signal_end: silence, call stays up),
  src/modules/ai/aiService.js:161-178 (5-round loop exhaustion returns
  text() of a functionCall response — empty string → worker yields nothing:
  a silent turn), voice-agent/agent.py:221-222 (empty reply is deliberately
  silence — correct for the mode-gate, wrong as the loop-exhaustion
  surface), plus a safety-blocked candidate makes response.text() throw →
  500 → apology → whole call ends 'failed' for one blocked reply.
Root cause: the dead-air guarantee is enforced only on the BrainError path;
  three exits produce silence or over-termination instead of a spoken
  fallback.
Runtime impact: a turn of silence the caller has to talk over, or a call
  torn down for a single filtered reply. All rare (non-JSON 2xx, 5 tool
  rounds, safety block).
Reproduction path: reasoning-only; each trigger is external-provider-shaped.
Customer #1 exposure: no — each trigger is a tail event.
Recommended fix: catch ValueError in _post alongside HTTPError; map loop
  exhaustion and blocked candidates to an explicit in-language fallback
  sentence instead of ''/throw. Size: S.
Blocks launch: no
```

### V-011 — Aborted/abandoned turns trace as clean successes

```
ID: V-011
Severity: LOW
Evidence: [static-analysis]
Where: src/routes/internalVoice.js:404-409 and 427-432 (abort paths return
  without trace.setError*; finally flushes a trace with error:null),
  same for the JSON path when the worker times out (nothing on the server
  knows — V-001's observability shadow)
Root cause: cancellation is not one of the error classes the collector
  records; flush() reaches every exit (verified), but the row can't be
  distinguished from success.
Runtime impact: the operator debugging "caller says the bot hung up on me"
  finds only healthy-looking traces; interrupted turns are invisible in
  trace queries.
Reproduction path: reproduced-adjacent: the live abandoned turn's trace was
  distinguishable only because a 429 happened to fire after the client left.
Customer #1 exposure: no direct caller harm; it taxes week-one debugging.
Recommended fix: trace.setError({stage, message:'client aborted'}) — or a
  dedicated status field — on both abort paths. Size: S.
Blocks launch: no
```

### V-012 — Voice tenant hydration hard-depends on WhatsApp identity (phone_number_id)

```
ID: V-012
Severity: LOW
Evidence: [static-analysis]
Where: src/routes/internalVoice.js:123-128 and 310-315 (turn hydration:
  id → phone_number_id → tenantService.getByPhoneNumberId cache),
  src/modules/tenant/tenantService.js:38-56 (cache keyed by phone_number_id;
  NULL never matches)
Root cause: the voice path borrows the WhatsApp credential cache for tenant
  hydration; a tenant with phone_number_id NULL (provisioning allows it —
  tenantService.js:114-135 defaults null) 404s 'tenant credentials not
  found' on EVERY turn despite being active and voice-configured.
Runtime impact: a voice-only or not-yet-Meta-onboarded tenant cannot take a
  single AI turn; the failure mode (404 per turn → worker apology + call
  'failed') doesn't say why.
Reproduction path: reasoning-only (set phone_number_id NULL and replay the
  probe; not executed to keep dev-DB churn down).
Customer #1 exposure: no — Customer #1 is WhatsApp-first with Meta creds; it
  bites the first voice-led onboarding instead.
Recommended fix: hydrate the tenant row by id directly (a tenant-id-keyed
  cache entry or a one-shot decrypting SELECT), leaving getByPhoneNumberId
  to the webhook edge. Size: S/M.
Blocks launch: no
```

### V-013 — Tenant-scoping gaps on two voice-reachable writes (rule violation, not exploitable)

```
ID: V-013
Severity: LOW
Evidence: [static-analysis]
Where: src/modules/appointment/appointmentService.js:115-118 (UPDATE
  customers SET name … WHERE id = $2 — no tenant_id),
  src/modules/notification/notificationService.js:15/22/28 (UPDATE
  notifications … WHERE id = $2 — no tenant_id)
Root cause: both rely on UUID-PK uniqueness instead of the project's
  every-query-tenant-scoped rule; ids are server-resolved (call_session →
  customer), so no injection path exists today.
Runtime impact: none today. Every OTHER voice-path query verified
  tenant-scoped (full list in the Pass 5 table below); the call_sessions
  lookup by bare id at internalVoice.js:109/297/558 is intentional — the
  session id is the HMAC-holder's capability and tenant scope is derived
  from the row itself.
Reproduction path: n/a (defense-in-depth).
Customer #1 exposure: no.
Recommended fix: add tenant_id to both WHEREs. Size: S.
Blocks launch: no
```

### V-014 — PII in operational logs (patient names, phone numbers)

```
ID: V-014
Severity: LOW
Evidence: [reproduced]
Where: src/modules/ai/aiService.js:166,305 (tool call args logged verbatim at
  info — book_appointment args include patient_name),
  src/modules/identity/identityService.js:51 (phone at warn),
  src/modules/notification/notificationService.js:6 (patient name in
  notification content — DB, by design)
Root cause: tool args are logged whole for debuggability; no redaction layer.
Runtime impact: caller PII lands in platform log storage (Railway) with its
  own retention, outside the DB's control. Verified the GOOD side: no
  secrets (wa_token, API keys, HMAC secret) are logged anywhere on the voice
  path; transcripts are not logged; turn traces exclude message content,
  prompt text (hash only) and tool outputs (outcome status only) — the
  Issue-22 design held under live inspection.
Reproduction path: observed live ("tool call" line with args in the probe's
  server log).
Customer #1 exposure: not a malfunction; a compliance posture item for a
  clinic (health-adjacent PII).
Recommended fix: redact known-PII arg keys (patient_name, phone) from the
  tool-call log line. Size: S.
Blocks launch: no
```

### V-015 — Worker test suite is environment-sensitive (fails under the repo's own .env)

```
ID: V-015
Severity: LOW
Evidence: [reproduced]
Where: voice-agent/agent.py:60-61 (_stream_enabled reads os.environ at call
  time), voice-agent/tests/test_agent_shim.py (JSON-path tests don't pin
  VOICE_STREAM_TURNS), voice-agent/.env (local file currently sets it true)
Root cause: load_dotenv() at import time + call-time env reads mean the
  suite's behavior depends on the developer's .env.
Runtime impact: `pytest` fails 4/37 with the current local .env
  (VOICE_STREAM_TURNS=true) and passes 37/37 with it forced false —
  reproduced both ways this session. CI green is a function of CI's env,
  not the code.
Reproduction path: `pytest` vs `VOICE_STREAM_TURNS=false pytest` — live.
Customer #1 exposure: no (test hygiene).
Recommended fix: conftest fixture pins VOICE_STREAM_TURNS per test
  (monkeypatch), mirroring how the SSE tests opt in. Size: S.
Blocks launch: no
```

### V-016 — Postgres TLS without certificate verification in production

```
ID: V-016
Severity: LOW
Evidence: [static-analysis]
Where: src/db/db.js:6-8 (ssl: { rejectUnauthorized: false } when
  NODE_ENV=production)
Root cause: encrypts the DB link but accepts any certificate — a
  network-position attacker can MITM every tenant's data, including voice
  transcripts and wa_tokens in flight.
Runtime impact: none functionally; a trust-boundary posture issue. Common
  (often forced) on PaaS internal networks; deployment specifics are out of
  this review's scope, so this is recorded as code posture only.
Reproduction path: n/a.
Customer #1 exposure: no (requires provider-network compromise).
Recommended fix: verify-full with the platform CA bundle where Railway
  supports it. Size: S.
Blocks launch: no
```

---

## The eleven questions

1. **Is the voice architecture fundamentally correct?** Yes. The Node-is-the-only-brain invariant holds under inspection (ledger item 1 verified: `agent.py` forwards only the latest transcript, authors zero language beyond fixed apology/ack constants, resolves no identity); the identity bridge, single shared conversation, and trace/correlation substrate are coherent. The defects are in the timeout/cancellation seams, not the shape (V-001, V-003).
2. **Can any request hang forever?** Effectively no *forever*, but yes far too long: a JSON turn can outlive its caller by minutes bounded only by undici defaults, and an unbounded Postgres statement has no timeout at all (V-003). The SSE path is properly bounded end-to-end (worker read-timeout + hard cap + abort propagation — verified in code and live).
3. **Can any session leak?** Node-side no — collectors are WeakMap-keyed to the request context, tenant-cache timers are unref'd and shutdown-cleared, SSE listeners die with the response, and no code path holds a pool client across an external await (verified: the only getClient() user, identityService.resolveCustomer, does pure-DB work inside its transaction). DB-side yes: call_sessions rows strand in `in_progress` forever (V-006). Worker-side: per-job process isolation contains the pending `_finish_then_shutdown` task and the shared httpx client (no finding).
4. **Can any database write become inconsistent?** Yes, three ways: booking committed while the caller is told the turn failed (V-001); torn multi-statement turns on a mid-turn crash — inbound without outbound is benign, a booking whose confirming message never persisted is not, and nothing reconciles (V-001/V-003 window, drain force-exit at server.js:128); spoken-but-unpersisted SSE deltas (V-007). Cross-slot double booking via off-grid timestamps is definitional (V-008).
5. **Can correlation ever be lost?** No finding. Every async boundary on the voice path was enumerated: bus setImmediate (explicit capture-and-restore, core/events.js:45-50), fire-and-forget notification and trace flush (ALS flows through promise chains), the worker round-trip (id minted at call/start, echoed via shape-validated trusted header, internalVoice.js:576-585), stream callbacks (onDelta/onToolRound run inside the request context). Live probe: correlation ids present on every log line including tool calls and lead extraction. Only deploy-skew fragmentation is possible, and the worker WARNs loudly (agent.py:333-338).
6. **Can turn traces fail silently?** The write itself is honestly best-effort (WARN + drop, writer.js:74-79 — by design, ledger item 5) and flush() reaches every exit path of both branches (finally blocks, verified; a live failed turn produced a full 429 error trace). The gap is semantic: aborted/abandoned turns trace as successes (V-011).
7. **Is there any race condition?** Yes, three real ones: double call/end state flip (V-004, reproduced), cross-channel history interleave via OFFSET 1 (V-009), and duplicate call/start creating parallel in_progress sessions with no dedup key (V-006). CallState mutation is safe (single asyncio loop); Gemini/tool loops are sequential per turn; the booking write's race is correctly absorbed by uniq_doctor_slot + the 23505 handler (verified path).
8. **Is there any scalability bottleneck (new ones only)?** One: per-utterance extraction doubles Gemini call volume and contends for the same quota as the turn path — live-demonstrated as turn-starving 429s on this key (V-002). Beyond that, nothing new past the deferred-at-scale ledger; per-turn hydration is 5-6 sequential queries (~300-465ms measured), acceptable at clinic volume.
9. **Is there any security weakness?** HMAC verification is timing-safe and length-checked (hmac.js:28-35 — correct), correlation-header injection is shape-blocked, worker-supplied fields are validated/coerced at the boundary (call/end duration), and no SQL on the voice path is non-parameterized (verified by inspection of every query cited in Pass 5). Weaknesses: no replay protection (V-005, reproduced), PII in logs (V-014), DB TLS without verification (V-016). Node does trust `call_session_id` as a bearer capability — acceptable inside the HMAC boundary, noted at V-013.
10. **What MUST be fixed before Customer #1?** (1) V-001 — JSON-path cancellation + one coordinated turn budget [M]; (2) V-002 — enforce crm.extraction.voice, channel on MESSAGE_RECEIVED [S]; (3) V-003 — external-call deadlines + pg statement_timeout, same plumbing as V-001 [S]; (4) V-004 — call_sessions terminal-transition guard [S]; recommended in the same window because they're S and close silent-failure classes: V-008 (slot-grid validation) and V-009 (history exclusion by id).
11. **What can safely wait until after launch?** V-005 (replay hardening — private transport, no worker retries), V-006 (stranded-session sweep — add within the first weeks for analytics honesty), V-007 (dark until VOICE_STREAM_TURNS ships), V-010, V-011, V-012 (until a voice-first tenant exists), V-013, V-014 (do before any compliance conversation), V-015, V-016.

---

## Coverage

| Pass | Status | Notes |
|---|---|---|
| 1 — Lifecycle walk | **Complete** | Full map in appendix; every hop read at cited lines |
| 2 — Failure injection | **Complete** | Worker death, Node restart, STT/TTS stall, Gemini hang/429, double call/start, lost call/end, tool-success-turn-failure all walked; LiveKit-internal failure modes (room close semantics) taken on the plugin's contract, not re-derived |
| 3 — Concurrency & state | **Complete** | Cross-channel interleave, double call/end, duplicate call/start, CallState, asyncio task audit, ALS detachment sweep |
| 4 — Resource & leak audit | **Complete** | Pool-checkout discipline verified clean; timers/WeakMap/listeners/SSE lifetimes audited; worker per-job process isolation noted |
| 5 — Data integrity | **Complete** | Every voice-reachable write enumerated + tenant-scoping verified per query (V-013 lists the only two gaps); torn-write windows mapped |
| 6 — Cross-cutting sweeps | **Complete** | Correlation boundary enumeration, trace exit-path enumeration, HMAC/replay/log-hygiene/injection sweeps |
| 7 — Execute | **Partial** | Node suite 406/406; worker suite 37/37 (after pinning VOICE_STREAM_TURNS — the unpinned failure is V-015); live scripted turns: JSON happy path, exact-body replay, client-abort-mid-turn, double call/end, SSE turn — all against a real server + DB + Gemini. NOT run: a live LiveKit audio session (no room/PSTN in this environment) — the worker's audio loop is covered by its unit tests only |

**Not reviewed (out of scope by instruction):** Railway deployment, production secrets, genesis deploy, Meta onboarding, WhatsApp rollout.

---

## Appendix — lifecycle map (one call, end to end)

**Bridge (once per call):**
1. LiveKit dispatches job → `voice-agent/agent.py:300` `entrypoint(ctx)` → `ctx.connect()`
2. Tenant/caller from room metadata or env → `agent.py:306-316`
3. `BrainClient.call_start` → `brain_client.py:116-122` → signed POST
4. Node: `express.raw` → `authenticate` (HMAC over raw body) `internalVoice.js:27-43` → correlation middleware (fresh `call_` id) `internalVoice.js:581-583`
5. `handleCallStart` `internalVoice.js:480-528`: tenant active check :488 → `identityService.resolveCustomer` (channel_identifiers → phone fallback → transactional create) `identityService.js:17-140` → `conversationService.getOrCreateOpenConversation` (shared cross-channel) `conversationService.js:3-13` → `voiceChannelAdapter.startSession` → `callSessions.create` (status in_progress) `callSessions.js:15-37` → `emitCallStarted` `voice/events.js:12-21` → bus `core/events.js:8-53` (setImmediate + ctx restore) → workflow wildcard `workflowEngine.js:124`
6. Response `{call_session_id, customer_id, conversation_id, correlation_id}` → worker `CallState` `agent.py:101-114`; shutdown callback registered `agent.py:358`
7. Sarvam STT/TTS constructed (plugin-owned audio) `agent.py:362-372`; `AgentSession` starts, `turn_detection: stt` `agent.py:377-388`; STT language events update `call.language` `agent.py:391-394`

**Per turn (JSON default):**
8. Utterance finalized → framework calls `BrainAgent.llm_node` `agent.py:173` → `latest_user_text` `turn_context.py:12-36`
9. `delegate_turn` `brain_client.py:124-142` → signed POST, timeout 10s, echoes `X-Correlation-Id`
10. Node `handleTurn` `internalVoice.js:85-220`: timer `turnMetrics.js:36` + trace `collector.js:49-93` (WeakMap on ALS ctx) → hydrate: call_sessions by id :109 → tenant active :123 → `getByPhoneNumberId` (5-min cache) `tenantService.js:38-56` → customer :131 / conversation :136 (tenant-scoped) → `resolveLanguage` `customerService.js:36-56`
11. Persist inbound (channel='voice') :150 → emit MESSAGE_RECEIVED :164 → **extraction handler fires** `extractionHandler.js:43` (V-002)
12. Mode/ai_enabled gate :174 → `assembleConversationContext` `contextAssembler.js:43-77` (RAG embed `knowledgeService.js:27-40` ∥ history OFFSET 1 `customerService.js:14-24` ∥ memory) + retrieval trace :69-74
13. `aiService.generateReply` `aiService.js:79-179`: prompt diet :87-95 → `resolveSystemInstruction` (+prompt hash trace) :385-398 → `startChat` :136 → sendMessage loop :158-176 → `executeTool` :59-77 → `bookAppointment` `appointmentService.js:85-145` (23505 → "slot taken") + fire-and-forget owner notify `notificationService.js:5-31`
14. Persist outbound :201 → touch conversation :207 → `res.json` :210 → finally: `turn.emit()` (voice_turn_metrics) + `trace.flush()` → `writer.writeTrace` `writer.js:39-80`
15. Worker: yields reply_text as one chunk → Sarvam TTS speaks; `end_call` → `_signal_end` `agent.py:154-161` → drain → `ctx.shutdown` `agent.py:398-406`

**Per turn (SSE, dark):** same through step 12 via `handleTurnSSE` `internalVoice.js:245-445`; `startSSE` after validation :374; `generateReplyStream` `aiService.js:202-319` (sendMessageStream + AbortSignal; ack-on-tool-round → `FlushSentinel` `agent.py:256-260`; deltas forwarded); done after persistence :423; disconnect → `res.on('close')` :268 → abort → partial persist :407/:430.

**Hangup:** participant leaves / end signaled → job shutdown → `_on_shutdown` `agent.py:341-357` → `call_end` `brain_client.py:213-235` → Node `handleCallEnd` `internalVoice.js:540-574` (duration coerced :551) → `callSessions.updateStatus` (no state guard — V-004) → `emitCallEnded` → shared httpx client closed `agent.py:356`.
