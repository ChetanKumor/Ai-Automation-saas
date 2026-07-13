# Zyon — Architecture Reference & Approved Extension Points

> **Doc type:** Internal architecture RFC (reference).
> **Status:** Committed reference. Describes the system as built and the approved seams for extension. Not a plan, not a roadmap.
> **Date:** 2026-07-13.
> **Audience:** Future implementation sessions (Claude Code), reviewers, the founder.
> **Precedence:** `zyon-first-launch-plan.md` is the plan of record for launch sequencing. This document is the architecture reference. `ZYON_V2_SPEC.md` remains the historical implementation spec; decisions it contains that were superseded during implementation are listed in §2.4 and must not be re-litigated.

---

## 1. Purpose and non-goals

This document records three things: (1) the current architecture, (2) the current implementation status, and (3) the approved extension points that fit the architecture as built — with Organizational Learning specified in full as the principal future capability.

Non-goals, stated to bind future sessions as much as this one:

- It does not redesign the product. Zyon is a vertical-depth AI receptionist for Indian SMB clinics. Broader framings ("AI Operating System for Businesses" and equivalents) were explicitly shelved; any resurfacing of them should be flagged, not elaborated. Strategic reframing is gated on **ten paying customers plus ninety days of real production transcripts**.
- It does not expand launch scope. The launch priorities are unchanged: telephony go-live (Issues 11–14), post-review fixes (Issues 31–33), genesis production deploy (Issue 20), first customer onboarded manually with supervised call monitoring.
- It does not schedule anything. Where phases appear (§8), the gates are customer counts and metrics, not dates.

Everything in §6 (Organizational Learning) is a **future capability specified at extension-point fidelity**: invariants, seams, and gates are fixed here; detailed design (taxonomies, heuristics, rubrics, de-identification mechanics) is explicitly deferred until real transcripts exist, because designing those against imagined data encodes guesses.

---

## 2. Current architecture

### 2.1 Product definition

Zyon is a multi-tenant AI Customer Operations Platform sold as a vernacular AI receptionist for Indian SMB clinics — dental and healthcare first. It answers the clinic's phone and WhatsApp in Telugu, Hindi, and English; books, reschedules, and cancels appointments; remembers each patient across channels; escalates to a human when needed; and gives the operator a panel over all of it. The strategic wedge is Indian-language voice quality (Sarvam) at Indian SMB price points — a position that survives because it compounds per-clinic, not because any single component is unreplicable.

Product surface at launch: **Voice AI**, **WhatsApp AI**, **CRM**, **Knowledge Base (RAG)**, **Appointment Management**, **Workflows**, **Operator Panel**, all multi-tenant. Collections exists in code but is feature-flagged OFF for the clinic vertical (§5.6).

### 2.2 Topology

A modular monolith with one deliberate split:

- **Node.js/Express process — the sole reasoning brain.** All prompting, the Gemini 2.5 Flash tool loop, booking logic, identity resolution, memory, CRM, knowledge retrieval, workflows, notifications, handoff, admin. If a decision is made anywhere in the system, it is made here.
- **Python LiveKit worker — transport only.** Joins LiveKit rooms, moves audio, invokes Sarvam STT/TTS, relays turns to the brain over HTTP. It holds zero business logic and zero tenant knowledge beyond what a call needs in flight. This boundary is an invariant: business logic never migrates into the worker.
- **PostgreSQL, raw SQL, no ORM**, with pgvector (HNSW) for retrieval and embeddings.
- **In-memory event bus** with depth limiting (`MAX_DEPTH=5`); declarative workflow engine with claim-dedup.
- **Deployment target:** Railway — Node service, worker service, and Postgres colocated in one region; LiveKit Cloud project in the nearest region.

```
Caller ──PSTN──▶ Plivo DID ──SIP──▶ LiveKit ──rtc──▶ Python worker (transport only)
                                                       │   Sarvam Saaras v3 (STT)
                                                       │   Sarvam Bulbul v3 (TTS)
                                                       ▼
                                  Node/Express brain (single reasoning process)
                                  prompt render · Gemini 2.5 Flash tool loop ·
                                  identity · memory · scheduling · CRM · KB ·
                                  workflows · notifications · handoff · admin
                                                       │
Patient ──WhatsApp Cloud API──▶ webhook ──▶ WA adapter┘        PostgreSQL (raw SQL,
                                                                pgvector/HNSW)
```

### 2.3 Module inventory

Boundary rule (binding): each module owns its tables and exposes a thin service API; cross-module communication is the event bus or an explicit service call — never another module's tables.

| Module | Responsibility | Owns |
|---|---|---|
| tenant | Tenant context; encrypted per-tenant channel credentials; 5-min credential cache + invalidation | `tenants`, credential columns |
| config | Versioned tenant configuration; Zod validation; clinic prompt renderer; tenant status lifecycle | `tenant_configs`, `tenant_config_revisions`, `validation_runs`, `tenants.status` |
| identity | Resolve any channel identifier to one customer per tenant; create on first contact | `customers`, `channel_identifiers` |
| memory | Channel-agnostic conversations/messages; rolling per-customer summary + embedding; write-back loop | `conversations`, `messages`, `customer_memory` |
| channels | `ChannelAdapter` contract; inbound normalization to a common envelope; outbound routing | — |
| channels/whatsapp | WA Cloud API adapter: verified webhook, non-text storage, 24h window + templates, owner commands | WA session columns |
| voice | Worker runtime integration; `TelephonyProvider` seam (Plivo first); in-call tools; session persistence | `call_sessions` |
| ai | Single LLM seam: prompt assembly, tool loop (bounded), summarize/embed/extract; retry + timeout | — |
| scheduling | Availability, transactional booking (`uniq_doctor_slot`), reminders (crash-safe cron, `LIMIT`) | `appointments`, availability, reminders |
| workflow | Declarative rules over events; claim-dedup (`rule_id, event_id`); depth limit | `workflows`, `workflow_runs` |
| crm | Contacts/leads/stages, auto-updated from memory events | `crm_*` |
| knowledge | Per-tenant ingest and top-k retrieval (pgvector + HNSW) | `knowledge_chunks` |
| notifications | Domain events → outbound messages on the right channel | outbound queue |
| collections | Payment reminders (crash-safe); **flag OFF for clinic vertical** | collections tables |
| handoff | Human-takeover state; owner commands surface | handoff columns |
| admin / operator panel | Operator routes + static panel UI; hardening at Issue 18; pages grow per Issues 25–27 | — |
| provisioning + validation | Idempotent `provision-tenant` CLI; static + dynamic validation; activation gate | writes via config module |
| observability | Redacted structured logging (pino); correlation IDs; async `turn_traces` | `turn_traces` |

### 2.4 Superseded decisions (do not re-litigate)

`ZYON_V2_SPEC.md` predates implementation. The following of its locked decisions were superseded and the launch plan is authoritative:

1. **Voice provider.** The spec locked Retell AI. Implementation replaced it with a self-orchestrated pipeline: LiveKit (RTC/SIP) + Python worker (transport) + Sarvam Saaras v3 STT / Bulbul v3 TTS, with all reasoning in the brain. What survived is the *seam philosophy*: telephony sits behind a `TelephonyProvider` interface (Plivo is the first and only implementation, inbound v1); "we do not build telephony" still holds — Plivo and LiveKit carry PSTN and RTC.
2. **Migration posture.** Expand-contract sequencing assumed a live production database. None exists. First deploy is greenfield: prod DB initialized from `schema.sql` (genesis baseline) via the migration runner. The `wamid` dual-write/column is retired pre-launch (Issue 5) precisely because there is no live data to protect. **After first deploy, expand-contract returns as the rule** for any rename/drop.
3. **Migration numbering.** Spec numbers 011–018 map to real repo numbers at +3 offset (repo head was 013 before V2 work): identity = 014/015; channel-agnostic storage = 016/017; the wamid drop was ~020 before being retired pre-launch. Cited spec numbers in old commits should be read with this offset.
4. **Compliance frame.** The spec's HIPAA mention (part of the Retell rationale) is moot. The governing frame is India's DPDP Act (§6.7).
5. **SSE turn streaming.** Dark-shipped behind `VOICE_STREAM_TURNS=false` in dev. Production config sets it `true` at deploy (Issue 19/20). This is a config flip, not a code change, and is the only pre-MVP latency optimization sanctioned.

### 2.5 Voice pipeline

**Inbound flow.** Caller dials the clinic's Plivo DID → SIP trunk into LiveKit → dispatch rule places the call in a room → worker joins, extracts SIP metadata (caller/called numbers) → brain `call/start`: resolve tenant by DID (`voice.did` in tenant config; unknown DIDs rejected), resolve customer by caller number via identity, load CRM fields + rolling memory + top-k recall, return greeting context. The greeting includes the per-language recording/consent line from config; **recordings are OFF in v1** — transcripts only. Per turn: Saaras STT → brain `internal/voice/turn` (SSE streaming when the flag is on) → Gemini tool loop (bounded < 5) → Bulbul TTS via the worker.

**Hot-path rules (binding).** In-call tools (availability lookup, booking through `scheduling` with `uniq_doctor_slot`, escalate-to-human, take-message) must return in well under ~400 ms — single indexed queries, no embeddings, no LLM, no fan-out. Everything heavy (summary, embeddings, CRM update, notifications, trace writes) runs after `call.ended`, off the hot path, reusing the established extraction pattern. Call state lives in the worker/LiveKit during the call; the database holds `call_sessions` and traces and is not in the real-time loop.

**Latency envelope (production, colocated, SSE on):** 0.6–1.2 s to first audio on normal turns; 0.8–1.5 s to acknowledgment on booking turns. These are the numbers to hold, measured per stage via `turn_traces` (§2.12). See §4 for why dev measurements must never drive decisions against this envelope.

**Outbound voice** is deferred; Issue 13 is inbound-only. The reminders→voice path remains a documented workflow rule target for later.

### 2.6 WhatsApp pipeline

WA Cloud API webhook (signature-verified, with the length-check hardening) → WhatsApp adapter normalizes inbound — including non-text, stored with type + media reference — into the channel-agnostic envelope → identity resolution → the same brain, same tools, same memory. Outbound respects the 24-hour window with template fallback. Owner commands (TAKEOVER / MSG / DONE / STATUS) drive the handoff state. Meta Business Verification and Tech Provider status are pending external dependencies; customer #1's WhatsApp rides the manual WABA setup (launch plan Issue 2). Voice and WhatsApp can go live independently for customer #1 — whichever external clock clears first ships first.

### 2.7 Identity and customer memory

One customer per tenant; `channel_identifiers` resolves any channel identifier to that customer, with phone number as the practical cross-channel join key for clinics. The unified timeline is all `messages` (every channel) plus `call_sessions`, ordered per customer. `customer_memory` holds a rolling summary + embedding per customer; write-back runs after each call/conversation; retrieval runs at the start of each new interaction and injects CRM fields, the rolling summary, and top-k semantic recall into the prompt. Cross-channel synchronization *is* the shared customer plus shared memory — there is no channel-to-channel plumbing, and none should be added.

A distinction this document relies on later: **customer memory is a runtime, per-customer, automatic feature that already exists. Organizational Learning (§6) is an offline, per-tenant/per-platform, human-gated capability that does not.** They read some of the same signals; they never share a write path.

### 2.8 Events and workflows

The in-memory bus with `MAX_DEPTH=5` carries the domain events; the workflow engine matches declarative rules with claim-dedup on `(rule_id, event_id)`. Core events: `message.received`, `intent.detected`, `call.started`, `call.ended`, `appointment.booked`, `appointment.cancelled`, `reminder.due`, `lead.updated`, `memory.updated`, `customer.created`, `notification.requested`, `call.requested`. The reuse rule that shaped V2 still binds: new capabilities are new event types and new rules on the existing bus and engine — never a new orchestration layer.

### 2.9 Multi-tenancy and isolation

Isolation is structural: `tenant_id` scopes every table and every query; the knowledge base is a per-tenant namespace within `knowledge_chunks` (no shared embedding space across tenants); channel credentials are encrypted per tenant with a short cache and an invalidation endpoint; unknown DIDs are rejected before any tenant context loads. Tenants move through an enforced status lifecycle — draft → validated → live → paused — and **activation refuses unless the latest validation run passed**.

Deliberately not used at this scale, per the locked out-of-scope list: PostgreSQL RLS, composite-FK enforcement, microservices, durable inbox/outbox, Redis session store, DLQ, circuit breakers. Each has a metric-based trigger at the ~500 and ~1000 tenant tiers; none has a calendar-based one.

### 2.10 Configuration control plane

Tenant behavior is data, not code. `tenant_configs` (versioned JSONB) + `tenant_config_revisions` + `validation_runs`, fronted by a Zod-validated `configService` covering: languages, per-language greetings, hours and holidays, booking rules, escalation policy, owner numbers, personality, tool toggles, `voice.did`, per-language recording-consent line (recordings OFF in v1), and `retention_days`. The clinic prompt renderer composes the vertical template with tenant config — the no-medical-advice guardrail and consent line are baked into the template, and the freeform `ai_prompt` is demoted to an override. All brain read-sites go through `configService`.

This matters beyond launch mechanics: **the config revision → validation → activation pipeline is the platform's only sanctioned path for changing a tenant's behavior.** §6 leans on this property hard — it is the pre-built apply-path for every tenant-scoped learned improvement.

### 2.11 Data and deployment

Genesis: production Postgres is initialized from `schema.sql` via the migration runner; `schema.sql` and the ordered migrations stay in lockstep; every post-genesis schema change is a migration under the runner. Railway production: Node + worker + Postgres colocated (the latency prerequisite); LiveKit prod project in the same region; environment reconciled against `env.js`'s required list; **the production Gemini key is billing-enabled and split from dev** (§4). Transcripts are stored; audio recordings are not (v1); `retention_days` from tenant config governs retention.

### 2.12 Observability

Three layers, all landing before customer #1: redacted structured logging (pino); a correlation ID threaded request → turn → worker → DB writes → events, such that one grep reconstructs a call's full path (Issue 21); and `turn_traces` written asynchronously after TTS dispatch — stage timings (including context-assembly sub-timings), retrieved chunk IDs, prompt reference, LLM metadata, tool calls, and error, with retention from config and a measured hot-path delta of ~0 (Issue 22).

`turn_traces` deserves emphasis: it is the primary substrate for everything in §6. Retrieved-chunk IDs give knowledge hit/miss analysis; the prompt reference gives revision-level attribution; stage timings give the latency ground truth. No additional capture is required for Phase 1 learning to function.

---

## 3. Implementation status

### 3.1 Built

Voice engine complete: LiveKit worker runtime, Sarvam Saaras v3 STT and Bulbul v3 TTS integration, Gemini 2.5 Flash reasoning, SSE turn mode dark-shipped behind `VOICE_STREAM_TURNS=false`. Core platform complete across PRs 1–7: webhook hardening, structured logging, customer identity, channel-agnostic storage, channel abstraction, voice provider seam, worker runtime. Multi-tenant Postgres, event bus, workflow engine, CRM, knowledge base/RAG, customer memory with write-back, tool calling, and WhatsApp integration are all implemented. The operator panel exists as the static admin app; its hardening (Issue 18) gates first internet exposure.

### 3.2 Remaining to customer #1 (per the launch plan, plan of record)

- **External clocks, started first because no code shortens them:** Issue 1 — Plivo account, SIP trunking, Indian DID for customer #1, KYC/DLT submission, LiveKit Cloud project. Issue 2 — manual WABA setup. *The DID/KYC/DLT clock is likely the true launch gate; as of this document its start has not been confirmed.*
- **Build clock:** hygiene (Issues 3–6, including wamid retirement and the migration runner) → config engine (7–10) → **Plivo/voice go-live (11–14)**, ending in the Issue 14 live-call gate: real phone → DID → LiveKit → worker → brain → Sarvam reply, Telugu booking writes a row, latency within budget, consent line spoken — *nothing ships to a customer until this passes* → provisioning + validation (15–17) → panel hardening + prod infra + **genesis deploy (18–20)**, where `VOICE_STREAM_TURNS=true` is set in prod config → observability (21–22) → onboarding runbook + customer #1 live + 48-hour watch (23–24).
- **Post-adversarial-review fixes:** Issues 31–33 are in queue; triage them against the critical path before Issue 20.
- Panel pages (25–27) and runbook v2 / customer #2 (28) follow onboarding.

### 3.3 Standing preflight

Any session that measures latency or tests voice **stops until the billing-enabled Gemini key is confirmed in use**. The free-tier quota (20 requests/day) has corrupted measurement evidence across multiple sessions; this is a mandatory STOP condition, not a preference.

---

## 4. Operating principles (binding on all future work)

1. **Runtime evidence standard.** Nothing is complete until it produces runtime evidence. Passing tests are necessary, never sufficient. Evidence lives in conventional-commit bodies and, where applicable, evidence logs (Issue 14, Issue 20 pattern).
2. **Measurement discipline.** Roughly 55–65% of observed dev latency is local environment and Neon cold starts, not product latency. Railway with colocated Postgres collapses most of it. **Never make optimization decisions from dev measurements.** All optimizations beyond the SSE config flip are classified DO AFTER MVP or DON'T DO until real production transcripts exist.
3. **Session discipline.** One issue per Claude Code session; verify-first with explicit STOP conditions; conventional commits; branches fast-forward onto main — no merge commits, no PR ceremony.
4. **Scope discipline.** Tracked bugs and out-of-scope items are explicitly excluded from every PR. One atomic PR per session.
5. **Never pre-build.** Scale tiers (§2.9) and learning phases (§8) are triggered by metrics and customer counts, not by calendar or enthusiasm.

---

## 5. Approved extension points

An approved extension point is a seam that already exists in the codebase plus a documented trigger for building on it. Anything not on this list is a redesign proposal and belongs in a vision review — which is gated (§1).

1. **TelephonyProvider seam.** Plivo is the only implementation. A second provider (e.g., Exotel) is built only when a concrete second provider is required; the noop↔plivo swap test is the seam's proof. Trigger: a real customer or region Plivo cannot serve.
2. **ChannelAdapter registry.** SMS, email, Instagram slot in as adapters emitting the same envelope; the brain and memory are already channel-agnostic. Trigger: plan-gated demand, and not before entitlements enforcement exists — channels are the pricing table's axis.
3. **Entitlements enforcement.** The seam exists (`plan_id`, `usage_counters`, limit-check call sites); plans are data, upgrading is a `plan_id` change. Trigger: after the first clinics; early customers are hand-configured.
4. **Onboarding automation.** The provisioning CLI + validation pipeline is the substrate; the runbook (v1 at customer #1, v2 at customer #2, target < 15 minutes software path) teaches what to automate. Trigger: do not build the wizard before ~10 clinics are onboarded by hand.
5. **Operator panel evolution.** New pages ride the Issues 25–27 pattern: render live prod data on the existing static panel, no new stack. Trigger: an operating need proven by the live watch or by tenants.
6. **Collections re-enable.** Code exists and stays; the flag is OFF for the clinic vertical on ethical/reputational grounds (patient dunning). Re-enabling is a per-vertical decision requiring explicit sign-off; it is never a default and never a launch item.
7. **Organizational Learning.** The principal approved extension point; specified in §6 and phased in §8.

---

## 6. Organizational Learning (extension point specification)

### 6.1 What it is

Organizational Learning is the systematic conversion of real customer interactions into **reviewed, versioned improvements** to the platform's knowledge bases, prompts, workflows, configuration, and evaluation suites. Two properties define it in Zyon's architecture, and both are invariants:

1. **The runtime is an observer-emitter, never a self-modifier.** Production components emit signals (events, traces, outcomes). No component reads a learned conclusion and changes its own behavior. There is no code path — now or in any phase — through which model output mutates prompts, knowledge, workflow rules, or configuration.
2. **Learning produces artifacts, not weights.** Improvements are KB entries, config revisions, prompt-template changes, workflow rules, and eval sets — human-approved, versioned, and applied through the same paths a human change would take. Fine-tuning or otherwise training model weights on customer data is out of scope at every phase (§6.5). The moat is the artifact and eval corpus, not custom weights; this also keeps the LLM seam swappable and the data-protection posture simple.

"Continuous improvement without changing business logic automatically" therefore means: automation may raise the **quality and cadence of proposals**; it never removes the human approval step, and the applied change always travels through validation and activation like any other change.

### 6.2 Why it is valuable

Three reasons, all specific to Zyon's position:

- **The defensible asset is vernacular conversation quality, and its failure modes are only discoverable from real calls.** Telugu/Hindi code-switching, honorific register, STT confusions on clinic and doctor names, region-specific phrasing of booking requests — none of this is in any competitor's training data or in ours a priori. Every reviewed transcript converts an invisible failure mode into a permanent artifact.
- **Per-clinic quality compounds retention.** Each clinic's hours, doctors, services, and FAQ are different; a receptionist that gets measurably better at *this clinic* every week is the vertical-depth promise made concrete.
- **Evals over real transcripts are what let a solo founder change prompts without regression fear.** This is the runtime-evidence standard applied to model behavior: a prompt revision without an eval pass is the same category of claim as a PR without runtime evidence.

### 6.3 Relationship to existing memory

`customer_memory` (§2.7) is runtime, per-customer, automatic, and shipped. Organizational Learning is offline, per-tenant and per-platform, human-gated, and not shipped. Learning reads conversation records and traces; it never writes into `customer_memory`, and `customer_memory` never feeds cross-tenant aggregation. Conflating the two is a design error; this section exists partly to prevent it.

### 6.4 The four levels

| Level | Unit of learning | Primary signals | Outputs | Isolation property |
|---|---|---|---|---|
| **1 — Individual Conversation Learning** | One conversation or call | Disposition; operator annotations; trace anomalies; explicit feedback | Gap-list entries, prompt-issue notes, golden-transcript candidates | Entirely within one tenant and one conversation |
| **2 — Clinic-Level Learning** | One tenant across its history | Aggregates of L1 signals within the tenant | Tenant KB entries; config/prompt-overlay revisions; workflow-rule candidates; pronunciation entries | Entirely within one tenant; structural (`tenant_id`) |
| **3 — Cross-Conversation Learning** | Patterns across conversations spanning tenants — about **platform behavior only** | Content-free categorical/statistical features extracted inside each tenant boundary | Base vertical-template improvements; pipeline tuning; eval-suite additions | De-identification boundary; aggregate store has no text and no read path to messages |
| **4 — Organization-Level Insights** | Zyon the company | Portfolio metrics; onboarding friction; eval benchmark trends | Product/vertical/pricing decisions; playbook evolution | Internal-only; metrics not content; never enters any runtime, prompt, or tenant surface |

**Level 1 — Individual Conversation Learning.** The unit is a single conversation or call. Signals: outcome disposition (derivable today by joining `call_sessions`/`conversations` to `appointments` — no new capture needed); operator annotations made during supervised onboarding calls and the 48-hour watch; trace anomalies (tool errors, retrieval misses, latency-budget breaches, guardrail trips); explicit customer feedback when offered. Consumers: the tenant's knowledge gap list, a prompt-issue list, and the golden-transcript candidate list. In Phase 1 all of this is a human reading transcripts and traces — deliberately.

**Level 2 — Clinic-Level Learning.** The unit is one tenant across all its conversations. Aggregations: unanswered-question clusters become KB entries; recurring intents without workflow coverage become rule candidates; observed language mix and terminology tune the tenant's config and prompt overlay; booking-funnel drop-off points localize flow fixes; clinic and doctor names that Saaras or Bulbul mishandle become tenant pronunciation entries. Every output lands through an existing apply path: config revision → validation → activation, `Knowledge.ingest`, or a human-authored workflow rule. Isolation is structural — every learning row carries `tenant_id`, same as everything else.

**Level 3 — Cross-Conversation Learning.** The unit is patterns across conversations spanning tenants, restricted to **how the platform behaves — never what clinics or patients said**. The mechanism: a feature-extraction step runs *inside* each tenant boundary and emits only categorical/statistical features — STT confusion patterns with PII and clinic-identifying terms stripped, a turn-taking failure taxonomy, per-stage latency distributions, tool-error classes, guardrail-trip rates, prompt-regression signatures keyed by prompt reference. The cross-tenant aggregate store has no text columns and no read path to `messages` or `call_sessions`. Outputs: improvements to the base vertical template (git change, eval-gated across tenants' golden sets), voice-pipeline tuning, and eval-suite additions. The de-identification method itself is a deferred Phase-3 design decision (§9) — it must be designed against real data and the DPDP rules then in force, not imagined now.

**Level 4 — Organization-Level Insights.** The unit is Zyon the company. Portfolio metrics across tenants (containment, booking completion, handoff rates), onboarding friction trends from runbook executions, vertical playbook evolution, pricing and packaging evidence, and eval benchmark trajectories. These are consumed by the founder for product and business decisions. They are internal-only: never surfaced to any tenant, never entering any prompt, KB, or runtime path; metrics, never content.

### 6.5 What may be learned — and what must never be

**May be learned** (each within its level's isolation rules): conversation dispositions; intent frequencies; unanswered-question clusters; operator corrections; booking-funnel drop-off points; KB retrieval hit/miss statistics; per-stage latency and interruption statistics; STT confidence distributions; tool-error classes; template-message performance; pronunciation corrections for clinic/doctor names; which prompt revisions correlate with which behavior shifts.

**Must never be learned** — invariants with their enforcement:

| Invariant | Rule | Enforcement |
|---|---|---|
| Raw transcripts or messages crossing the tenant boundary | Never, at any level | Learning tables are `tenant_id`-scoped; the L3 aggregate store has no text columns and no read path to `messages`/`call_sessions` |
| PII (names, phone numbers, addresses, identifiers) inside learned artifacts | Never, at any level | Identity lives in `identity`/`crm` only; within-tenant artifacts reference `customer_id` at most; L3/L4 artifacts carry no identifiers of any kind |
| Patient health information as learning content | Never | The disposition taxonomy is operational (booked / rescheduled / handed-off / message-taken / abandoned), never clinical; medical content in transcripts is excluded from artifacts |
| Clinic commercial data across tenants (pricing, rosters, volumes) | Never as content | L4 uses coarse internal metrics only, never surfaced outside the company |
| Payment or financial transaction data | Never enters learning tables | No ingestion path; Collections data is out of learning scope entirely |
| Conversations under handoff or flagged sensitive | Excluded beyond disposition counts | Flag checked at extraction time |
| Training or fine-tuning model weights on customer data | Out of scope at every phase | No such pipeline exists or is planned; learning = artifacts, not weights (§6.1) |

### 6.6 Human approval requirements

Every artifact type has a named approval and a pre-built apply path:

| Artifact | Proposed by | Approved by | Apply path | Rollback |
|---|---|---|---|---|
| Tenant KB entry | Gap queue (human in P1, assisted later) | Founder/operator | `Knowledge.ingest` into the tenant namespace | Remove/replace entry |
| Tenant config / prompt overlay | Failure clusters, operator notes | Founder | Config revision → static + dynamic validation → activation | Revert to prior revision |
| Base vertical template | Cross-tenant failure taxonomy (P3) | Founder, via code review discipline | Git change + full eval pass across tenants' golden sets → deploy | Git revert |
| Workflow rule | Intent-gap report | Founder (authors the rule) | Declarative rule on the existing engine | Disable rule |
| Analytics-triggered change | Metric review | Becomes one of the above | One of the above | As above |

The rule underneath the table: **a metric never applies itself, and model output never applies itself.** Solo-founder reality, stated honestly: the approver is the founder through Phase 2; proposer/approver role separation is a Phase-3 control once staff exists. Until then the compensating controls are the eval gate (nothing activates without a passing validation run) and the audit trail (`tenant_config_revisions` + `validation_runs` + conventional-commit evidence already constitute one).

### 6.7 Privacy, security, and compliance

- **Isolation is structural, not procedural.** `tenant_id` on every learning row; per-tenant KB namespaces; no shared embedding space; the L3 boundary as specified in §6.4.
- **Access control** rides operator-panel auth (hardened at Issue 18); role-scoped access to learning surfaces arrives with roles at Phase 3.
- **Audit** is inherited: config revisions, validation runs, and commit evidence make every applied learning artifact attributable to a person, a proposal, and a passing validation.
- **Retention.** Raw signals (transcripts, traces, annotations) honor tenant `retention_days`. Approved artifacts must contain no personal data by construction (§6.5), so they legitimately survive raw-signal expiry.
- **Recordings are OFF in v1**, which keeps the sensitive surface to text and simplifies everything above.
- **DPDP Act 2023 alignment.** The per-language consent line at call start covers the interaction itself. Before any Phase-2 automation: confirm the clinic-facing terms and consent language cover use of interactions for service improvement, and take one counsel pass on the processor/fiduciary role split between Zyon and the clinic. Flagged as a hard pre-Phase-2 item in §9. Nothing in this design depends on a permissive reading — the never-learn invariants hold regardless.

### 6.8 Feedback loops

Three loops, each defined as signal → artifact → approval → deploy → measure:

- **Loop A — Operator loop** (cadence: minutes to days). Supervised calls and the 48-hour-watch pattern produce annotations → KB entries and config corrections → validated activation → the next calls confirm or refute. This loop exists informally from customer #1 onward because manual onboarding with supervised monitoring is already the plan.
- **Loop B — Outcome loop** (cadence: weekly). Committed SQL over dispositions, funnel, and handoff reasons → weekly review → candidates fed into Loop A's apply paths → next week's numbers close the loop.
- **Loop C — Regression loop** (cadence: per change). Golden-set eval runs gate every prompt/config revision → activation blocked on failure → prompt-reference attribution in traces catches anything that escapes to production.

### 6.9 AI evaluation pipeline

The seed already ships at launch: Issue 17's dynamic validation drives a scripted booking turn through the `internal/voice/turn` harness in test mode, persists a `validation_run`, and the activation endpoint refuses without a pass. The evaluation pipeline is that mechanism, extended:

1. **Golden transcript sets per tenant**, curated by a human from real traces (raw text is fine within the tenant boundary). Candidates accumulate from Phase 1 as a list; they become a maintained set in Phase 2.
2. **Replay harness:** the same turn endpoint, with pinned tool mocks and a frozen KB snapshot, so a run isolates the change under test.
3. **Metrics:** task completion; KB-groundedness (the answer is supported by the retrieved chunks recorded in the trace); guardrail adherence (no medical advice; consent line present); language quality for Telugu/Hindi — initially a human-scored rubric with native-speaker judgment on a small N, because automating vernacular quality scoring before real data exists would be exactly the kind of guess this document forbids; latency-budget adherence per stage.
4. **Gate:** template and overlay revisions require an eval pass before activation — mechanically, more `validation_runs` feeding the existing activation refusal.

Audio-in-the-loop replay (Sarvam STT/TTS inside the harness) is Phase 3; text-level replay catches the majority of regressions at a fraction of the cost. Framing that binds: **evals are the runtime-evidence standard applied to model behavior.**

### 6.10 Knowledge refinement

Gap detection: `turn_traces` already records retrieved chunk IDs per turn. Misses — empty or low-similarity retrievals on answerable intents, or operator-marked wrong answers — feed a per-tenant gap queue. A human writes the entry; `Knowledge.ingest` applies it to the tenant namespace. Stale detection: chunks unretrieved for a configured window, or contradicted by operator corrections, enter a review queue. Nothing crosses tenants; a KB entry is always a clinic's own knowledge.

### 6.11 Prompt refinement

Two layers already exist and are sufficient: the vertical base template (git-controlled) and the tenant overlay (config-controlled). Refinement is proposing a revision from failure clusters, passing the eval gate, and activating. The prompt reference stored in every trace attributes behavior shifts and regressions to specific revisions; rollback is a revision revert. The freeform `ai_prompt` override stays demoted — learning proposes **structured** config changes and template diffs, never freeform prompt blobs, because structure is what makes validation and attribution possible.

### 6.12 Workflow refinement

A periodic report — `intent.detected` frequencies with no matching rule, plus `workflow_runs` failure rates — surfaces candidates. A human authors the declarative rule; the engine is unchanged, and its claim-dedup and depth limit already bound the blast radius of any new rule. Rule success is measured through the same runs table. No engine features are required at any phase of this capability.

### 6.13 Analytics-driven improvement

The metric set is defined now so Phase 1 doesn't invent it under pressure; it is computed later: containment rate (resolved without handoff), booking completion rate, handoff rate with reasons, mid-flow abandonment, first-audio latency p50/p95 and per-stage breakdown from traces, STT confidence distribution, KB retrieval hit rate, intent volumes, and WhatsApp template delivery/response rates. SQL-first: a handful of committed queries and a weekly snapshot in Phase 1; operator-panel dashboards ride the Issues 25–27 pattern in Phase 3. Analytics reads never touch the hot path; a read replica is a ~1000-tenant-tier decision per the established scaling triggers, not a learning requirement.

### 6.14 Integration with existing subsystems

**CRM.** Dispositions join `crm_*` stages for funnel ground truth; learning may *propose* stage-model adjustments for a tenant, applied like any config change. PII stays in CRM and identity — learning artifacts reference `customer_id` at most, within tenant, and L3/L4 never see it.

**Voice AI.** The voice path is the richest emitter — `call.started`/`call.ended`, per-turn traces with stage timings and STT confidence — and a consumer of exactly two learned artifact types: the rendered prompt from approved revisions, and (Phase 2+) per-tenant pronunciation entries for clinic and doctor names in Telugu/Hindi, applied through tenant config like everything else. The worker itself learns nothing and changes for nothing; it remains transport.

**WhatsApp AI.** Emits `message.received` and notification outcomes; contributes template performance statistics. Because both channels share one brain, one KB, and one prompt pipeline, every approved improvement applies to WhatsApp automatically — there is no channel-specific learning path to build.

**Knowledge Base.** The gap queue feeds it; versioned ingest applies to it; retrieval statistics from traces evaluate it. The KB is both the most frequent destination of learning and its cheapest win.

**Workflows.** Intent-gap reports in; human-authored declarative rules out; `workflow_runs` metrics back. The engine is a fixed point.

**Analytics.** Consumer of every learning table and producer of Loop B's triggers; its aggregates are also the raw material for Level 4.

### 6.15 Architectural attachment — why this costs the launch path nothing

| Learning need | Existing mechanism (all shipping at launch) |
|---|---|
| Signal capture | Event bus subscription (depth-limited); `turn_traces` (async, ~0 hot-path delta); durable channel-agnostic `messages` + `call_sessions` |
| Attribution | Correlation IDs end-to-end; prompt reference per trace |
| Tenant-scoped application | Config revision → static + dynamic validation → activation; `Knowledge.ingest`; declarative workflow rules |
| Platform-scoped application | Git-controlled vertical template + eval gate |
| Approval and audit | `tenant_config_revisions` + `validation_runs` + activation refusal + commit evidence |
| Isolation | `tenant_id` scoping; per-tenant KB namespaces; module-boundary rule |

The learning capability, when built (Phase 2), is one new module owning its own tables, subscribing to existing events, reading traces, and writing through existing apply paths — fully consistent with the module-boundary rule, touching no hot path, requiring no change to any existing table, and adding no orchestration. That is the test this section had to pass to qualify as an extension point rather than a redesign.

---

## 7. Explicitly NOT before launch

None of the following is built, scaffolded, migrated for, or prototyped before customer #1 is live:

- No learning module, learning tables, or learning migrations.
- No annotation UI or annotation schema.
- No golden sets and no eval extension beyond Issue 17's scripted validation as specced.
- No metrics jobs, dashboards, or scheduled analytics; not even the "five committed queries" (Phase 1 work).
- No gap-detection automation and no candidate generation.
- No de-identification pipeline and nothing cross-tenant.
- No pronunciation-lexicon feature.
- No new event types introduced for learning purposes.
- No fine-tuning experiments — at any phase, per §6.5.

Rationale, once: every deferred item's *design* depends on data that does not exist yet — the disposition taxonomy needs real calls, gap heuristics need real retrieval misses, the Telugu/Hindi rubric needs real transcripts, the de-identification method needs real feature distributions. Building now encodes guesses, burns launch runway, and violates the ten-customer gate this document inherits. The launch plan already ships everything learning later needs (storage, traces, correlation IDs, versioned configs, the validation harness); the only learning-relevant obligation in Phase 0 is **not cutting Issues 21–22**.

---

## 8. Phased implementation plan

### Phase 0 — Launch (current)

- **Gate:** none; in progress.
- **Scope:** the launch plan as written — external clocks (Issue 1 DID/KYC/DLT, Issue 2 WABA) started first; Issues 3–24 on the build clock; Issues 31–33 triaged against the critical path; `VOICE_STREAM_TURNS=true` in prod config at deploy; customer #1 onboarded manually with supervised call monitoring; 48-hour live watch.
- **Learning scope:** none. Issues 21–22 ship because they are launch observability; that they double as the learning substrate is a consequence, not a justification.
- **Exit:** customer #1 `status='live'`; first real patient interaction traced end-to-end; watch notes committed and defects filed as issues.

### Phase 1 — Post first customer

- **Gate:** Phase 0 exit.
- **Scope — manual Level 1, capped:** weekly transcript-and-trace review; a manual KB gap list worked through existing ingest; config corrections through the existing revision → validation → activation path; a golden-candidate transcript list (a file, not a system); a weekly metric snapshot from ~5 committed SQL queries; the disposition taxonomy drafted from real calls.
- **Constraints:** ≤ 2–3 hours/week; zero new schema; zero new tooling. If it needs a migration, it is Phase 2 work being smuggled forward.
- **Exit:** ≥ 10 golden candidates for customer #1; disposition taxonomy v1; two full Loop-B cycles executed with at least one applied, validated improvement each.

### Phase 2 — Post ten customers

- **Gate:** ten paying customers **and** ≥ 90 days of production transcripts — deliberately the same gate that unlocks vision review, so learning systematization and strategic reflection draw on the same evidence base.
- **Scope — systematize Level 2:** a learning module owning its own tables (annotations, KB gap queue, golden sets) under the migration runner; eval runs over golden sets wired into the existing activation gate; retrieval-miss detection from traces; a review-queue panel page on the Issues 25–27 pattern; the metric queries productized; the prompt-revision workflow formalized (propose → eval → activate → attribute); Telugu/Hindi rubric v1 with a named scoring process; **DPDP counsel pass and consent-language confirmation before any automation runs** (§6.7).
- **Explicitly excluded:** anything cross-tenant.
- **Exit:** every prompt/config revision eval-gated as a matter of mechanism, not discipline; the gap queue driving weekly KB improvements across tenants.

### Phase 3 — Production scale

- **Gate:** metric-triggered, consistent with the platform's scaling philosophy — the tenant count and interaction volume at which manual review no longer covers the surface. Not a calendar date.
- **Scope:** Level 3 — in-tenant feature extraction, the de-identification boundary designed against real data and the DPDP rules then in force, cross-tenant aggregates, and the base-template improvement loop (git + full eval pass); Level 4 portfolio reporting, internal-only; audio-in-the-loop replay evals; operator-panel dashboards; automated candidate generation (proposals only — approval remains human); proposer/approver role separation as staff exists; retention automation for learning signals.
- **Exit:** open-ended; governed by the same never-pre-build rule as everything else in this document.

---

## 9. Deferred decisions

Owned decisions with the phase that owns them — deferred deliberately, not forgotten:

1. Disposition taxonomy — Phase 1, from real calls.
2. Annotation storage (dedicated table vs. panel-side field) — Phase 2.
3. Golden-set size and refresh policy — Phase 2.
4. Telugu/Hindi quality rubric and who scores it — Phase 2.
5. DPDP consent surface for improvement-use of interactions + counsel pass on the Zyon/clinic role split — hard gate before Phase 2 automation.
6. De-identification method for Level 3 feature extraction — Phase 3, against real data and current rules.
7. Dashboard scope and metrics presentation — Phase 3.

---

## 10. References

- `zyon-first-launch-plan.md` — plan of record for launch sequencing; authoritative where this document and it overlap.
- `ZYON_V2_SPEC.md` — historical implementation spec; superseded items listed in §2.4.
- Commit bodies on main — runtime evidence per the operating principles in §4.
