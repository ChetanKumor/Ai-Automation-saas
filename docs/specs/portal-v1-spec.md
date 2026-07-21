# Prantivo Clinic Portal v1 — Owner-Facing AI Receptionist Configuration
Product specification + phased Claude Code implementation plan.
Commit this file as `docs/specs/portal-v1.md`. Every implementation session reads it first; it is the source of truth. Changes to scope are edits to this file, not verbal drift.

---

## 0. Decision record

- This build is an **explicit founder roadmap decision** (2026-07-17), not customer-validated work. Recorded overrides: (a) the standing gate holding platform work to ten paying customers + ninety days of production transcripts; (b) the founder's own `ai-startup-os` operating rules ("do not build full SaaS initially; prioritize demo → outreach → close"). Both are consciously overridden here. This section exists so the decision is auditable, not to relitigate it.
- Facts of scope: this build does not advance any of the 7 launch gates and has no external-clock dependency. Business registration, Plivo KYC/DLT, and Meta onboarding remain parallel founder-ops items with independent lead times.
- Honest sizing: **~15–18 Claude Code sessions ≈ 3–4 weeks** at current cadence (one issue per session).
- Definition of success (v1 complete): see §11.

## 1. Product definition

- **User:** the clinic owner. Non-technical. One owner account per tenant. v1 has a single role (`owner`); staff roles are v2.
- **Job:** configure, verify, and operate their AI receptionist end-to-end with zero developer involvement — facts (prices, hours, doctors), behavior (greeting, tone, voice), knowledge (FAQs, documents), safety (escalation, handoff), then test and go live.
- **Naming rule (binding for all UI copy):** the product is the **"AI Receptionist."** The phrase "AI Employee" never appears in the portal. Plain language throughout; every control named by what the owner recognizes, not how the system is built.

## 2. Architecture position

**Reused unchanged (backend):** configService (strict Zod schema, versioned writes, cached loader + invalidation) · prompt renderer (config-driven, guardrail-anchored) · prompt preview · validation catalog (13 named checks; 14 since P3-S8 appended `doctor.schedule`) + lifecycle chain (draft → validated → live → paused) · knowledge_chunks + ingestion (tenant-scoped pgvector) · config revisions · multi-tenant isolation · `normalizePhone` (F-003) · turn_traces.

**Net-new subsystems (the actual build):**
1. **Portal auth + tenant-scoped sessions** — the largest new risk surface in the system. Everything else is forms.
2. Portal API namespace (`/portal/api/...`) — thin, owner-safe wrappers over existing services.
3. Portal UI shell + pages (static stack, see below).
4. FAQ / document editors writing knowledge_chunks.
5. Owner-safe readiness + go-live wrappers over the validation catalog and lifecycle service.

**Stack decision:** static HTML/CSS/JS served by the existing `express.static('public')`, one shared tokens stylesheet, no SPA, no framework, no bundler. Rationale: matches the admin panel and demo pages, zero build tooling for a solo maintainer, and the portal is forms — not an app that needs client-side state. Revisit only at Portal v2. (This is a deliberate constraint; sessions must not introduce React/Vite "while they're in there.")

## 3. Access model & security invariants

**Accounts.** The existing `users` table is extended (greenfield: edit `schema.sql` + matching dev migration): `password_hash` (Node `crypto.scrypt` — no new dependency), `role` (v1: `'owner'`), `last_login_at`. Account creation v1 is **operator-assisted**: a small addition to the existing admin panel creates the owner account with a temporary password. No self-signup. Password reset v1 = operator regenerates. (v2: WhatsApp/email reset.)

**Sessions.** Distinct cookie (`portal.sid`), httpOnly, sameSite=strict, secure in prod, 12h TTL. Login rate-limited mirroring the admin pattern (5 attempts / 15 min + ~300ms constant delay + `session.regenerate` on success). Inherits the documented in-memory-store tradeoff (single instance).

**Hard invariants — every portal session enforces and tests these:**
- **INV-1** `tenant_id` derives **only** from the session's user row. No portal route ever reads a tenant identifier from params, body, or query. Cross-tenant negative tests are mandatory in the suite.
- **INV-2** Every config write goes through configService (Zod validation, revision written, cache invalidated). No raw SQL from portal routes.
- **INV-3** Owners cannot skip validation checks (skips remain operator-only), cannot modify guardrails, and never see collections surfaces.
- **INV-4** Every revision records the acting user id.
- **INV-5** Uploads: type/size validated, stored outside the web root; derived chunks tenant-scoped like all others.
- **INV-6** Every phone field passes through `normalizePhone`; invalid input is rejected with a clear message, never silently rewritten.

## 4. Information architecture & global patterns

**Sidebar (order = owner mental model, not system structure):**
Home (Readiness) · Clinic profile · Hours & holidays · Pricing · Doctors · Booking rules · FAQs · Documents · Receptionist · Safety & handoff · Test · History — plus a state-aware **Go live / Live / Paused** control in the header.

**Global form pattern.** Each page is one or more cards; each card has its own **Save**. Save → `POST /portal/api/config/<section>` → Zod-validated partial → configService versioned write → response returns the updated section, the new version number, and **refreshed validation deltas**. UI shows `Saved · v{N}` toast and updates any readiness warnings that changed. No autosave, no optimistic UI.

**Copy rules.** Active voice; a control says exactly what it does ("Save changes," not "Submit"); the same action keeps the same name through the flow. Empty states are instructions ("Add your first doctor so patients can book with them"), never blank panels. Errors name the fix, never apologize, never go vague.

**Design language.** Evolve `public/demo/shared.css` into `public/portal/tokens.css`: same teal accent, Noto Sans (Telugu/Devanagari self-hosted, already in repo), same radius/shadow/spacing rhythm — the portal must read as the same product as the demo and (eventually) the operator panel. Components: page header, card, form row, field + help text, badge, toast, confirm modal, simple table. Restrained; the signature element portal-wide is the **readiness ring** on Home (score as a filled ring with the check list beneath) — one memorable device, everything else quiet.

## 5. Pages

Each page below lists: fields → backend mapping → validation → notable states.

### 5.1 Home (Readiness)
- Readiness score = material checks passed / material total, rendered as the ring + per-check rows.
- Each check row: friendly label, state (pass / action needed / operator-run), and a link to the page that fixes it. Copy map (extend as checks evolve):
  - kb checks → "Add at least 5 FAQs or upload one document" → FAQs
  - numbers/e164 → "Add an escalation phone number" → Safety & handoff
  - doctor-schedule checks → "Add a doctor and their weekly hours" → Doctors
  - whatsapp config checks → "WhatsApp connection — handled by Prantivo during onboarding" (owner-visible, operator-actioned)
  - turn.scripted → "Test call — run by Prantivo before go-live" (operator-run in v1)
- Status banner: Draft / Validated / Live / Paused, with one-line meaning.

### 5.2 Clinic profile → `identity.*`
Clinic name · address + landmark · phone numbers[] (INV-6) · website (optional) · languages enabled (Telugu / Hindi / English toggles; at least one required). Timezone is displayed as Asia/Kolkata, not editable (v1 constant).

### 5.3 Hours & holidays → `hours.*`, `escalation.after_hours_message`
Per-day rows (open, close, closed-toggle) · holidays[] (date + label) · after-hours message (per enabled language, optional; falls back to default) · emergency contact number (INV-6). Validation: close > open; duplicate holiday dates rejected.

### 5.4 Pricing → `pricing.*`
Consultation fee (INR, integer) · follow-up fee · emergency visit fee · payment methods (UPI / cash / card multi-select) · insurance stance (enum: not accepted / selected insurers / note) · **treatments table**: name, price, `price_from` flag ("starts at ₹X"), duration minutes (optional), notes (optional). Cap 50 rows; archive, never delete (referenced history).
Behavioral contract (spec-level, enforced by renderer): the receptionist quotes prices **verbatim from this section**; a treatment not listed here → existing uncertainty guardrail ("I'll check and get back to you"). If the renderer does not already emit a bounded pricing FACTS block, Phase 2 S6 adds it (verify first — Issue 10 may already cover it).

### 5.5 Doctors
CRUD: name · specialization · languages · weekly schedule grid (per-day start/end) · leave dates[].
**Mapping rule:** source of truth is whatever storage `appointmentService` reads for booking **today**. The implementation session begins by verifying that mapping and writes to it. Creating a parallel doctors table is a STOP condition.

**Verified mapping (P3-S8, 2026-07-21) — two scope corrections against the storage as it actually is.** Doctor schedules are rows in `tenant_entities` (`type='schedule'`), payload `{ doctor, days:['Mon',…], start, end }`, read by `appointmentService.getSchedules` and consumed by both `checkAvailability` and `bookAppointment`. Consequences, both founder-approved:
- **No per-day start/end.** The row carries ONE window plus a days array. Two rows per doctor to fake per-day hours is a divergence trap: `checkAvailability` loops all rows while `bookAppointment` `.find()`s only the first, so the second row's slots would be offered and then refused — the F-006 bug class. v1 ships days + one window; per-day hours is a storage + `appointmentService` change and needs its own issue.
- **Leave dates DEFERRED.** Booking has no concept of doctor absence (`evaluateDay` knows past / same-day / advance window / holiday / closed day, nothing else). A leave UI here would promise a refusal booking does not make. Deferred to its own issue where the storage and the enforcement land together.
- **Deactivation = archive**, by flipping the row to `type='schedule_archived'` — the type is what `getSchedules` filters on, so booking honors it with no change to `appointmentService`. An `active` flag inside the JSONB would NOT work: nothing reads it, so the doctor would still be offered. A doctor with appointments is archived rather than deleted; one without is deleted outright.

### 5.6 Booking rules → `booking.*`
slot_minutes (10/15/20/30) · advance_days · allow_same_day · buffer_minutes · cancellation policy (text) · reschedule policy (text) · walk-in policy (text). Policy texts are facts the receptionist states, not logic.
**Hard dependency: F-006.** The audit found advance_days / buffer / allow_same_day / hours+holidays are validated and editable but **not enforced** in booking. This page must not ship before F-006 lands (Phase 3 S7), or the UI misrepresents behavior.

### 5.7 FAQs → knowledge_chunks (`source:'faq'`)
Q/A list editor: question, answer, optional language tag. Cap 100. Save = upsert chunk (re-embed on edit); delete removes the chunk. Note in UI help: "Your receptionist answers from these — keep answers short and factual." (Embedding cost is per-save; acceptable at this scale.)

### 5.8 Documents → knowledge_chunks (`source:'document'`)
PDF upload ≤10MB → server-side text extraction → chunk → store; document list with delete (cascades its chunks). Extraction may require one vetted dependency — flagged as the single allowed new dep, in its own session (or the page defers to Phase 4b and v1 ships FAQ-only knowledge).
Placement guidance shown in-UI: "Exact facts (prices, hours, doctors) belong in their pages. Documents are for everything else — care instructions, policies, procedure info."

### 5.9 Receptionist → `persona.*`, `voice.*`
Receptionist display name (used only for self-introduction — never to address patients) · greeting per enabled language (textarea; Telugu/Hindi rendered in Noto) · tone (professional / warm) · response length (concise / standard) · voice speaker (Sarvam bulbul:v3 speaker list, constant) · speaking pace (0.8–1.2). No voice-provider or LLM-provider selection — architecture invariant (Sarvam + Gemini), not a setting.

### 5.10 Safety & handoff → `escalation.*`, `handoff.*`
Escalation numbers[] (INV-6) · handoff conditions: emergency keywords (on/off), caller asks for a human (on/off), receptionist unsure after N turns (N bounded) · emergency guidance text.
**Built-in protections panel (read-only, always visible):** never invents prices · never invents patient names · says "I'll check and get back to you" when unsure · answers only from clinic-approved information. These are platform invariants anchored in the prompt template — displayed as trust features, never configurable (INV-3).

### 5.11 Test your receptionist
Text chat, `channel:'test'`, through the **real** renderer + brain. Each reply shows a small provenance line from turn_traces: config version used, tool calls made, whether knowledge was retrieved. Rate limit 20/day/tenant with a visible counter.
Constraint: genuinely useful only on a **paid Gemini key** (free tier collides with real traffic and testing). v1 is text-only; voice verification is a phone call to the clinic's number after go-live — a browser voice tester is explicitly out of scope.

### 5.12 History
Revisions table: timestamp, section, acting user. View any snapshot. **Restore** writes a new version copying the old one — history is never rewritten.

### 5.13 Go live
Readiness summary → **Go live** enabled only when all material checks pass → calls the existing lifecycle validate → activate. Pause / Resume with confirmation ("Paused: calls and messages are not answered by the receptionist"). Owner-facing flow has no skip mechanism (INV-3).

## 6. Onboarding wizard

Linear guided pass over the same forms (no duplicate form code — each step embeds the page's card): Profile → Hours → Doctors → Pricing → Greeting → FAQs (min 5) → Review readiness → Go live. Progress persisted (`meta.onboarding_step`); resumable; steps skippable except where a material check blocks go-live. Target: a fresh clinic fully configured in **under 45 minutes unaided**.

## 7. Data placement rules

- **tenant_configs** — every exact, enumerable fact and behavior knob: identity, hours, holidays, pricing + treatments, booking rules, persona, voice, escalation, handoff. Anything the receptionist must state verbatim.
- **knowledge_chunks** — prose and long-tail: FAQs, documents, policy explanations. Anything answered by retrieval.
- **Prompt template (invariants)** — the guardrails in §5.10. Not data, not configurable.
- **Dynamic per-turn injection** — resolved caller identity (or the explicit "unknown caller — use no name" guardrail), current date/time, live availability via tools, retrieved chunks.
- **Pricing rule restated:** answered verbatim from the config-rendered FACTS block. Never from model memory.

## 8. Validation & readiness

Material checks gate go-live (kb minimum, escalation number, doctor schedule, whatsapp config, scripted turn); advisory checks warn only. Score counts material checks. Owner sees the friendly copy map (§5.1); operator retains the full catalog, skip powers, and validation history in the existing admin panel. The all-material-skips footgun from the audit remains operator-only by construction.

## 9. Explicit v1 exclusions

logo upload (nothing consumes it) · currency selection (INR constant) · discounts (free-text discounts invite the receptionist into price negotiation — pricing-honesty risk) · voice/LLM provider choice (architecture invariant) · staff roles & permissions (single owner) · self-serve password reset (operator-assisted) · browser voice testing (phone test post-launch) · analytics (separate roadmap item) · collections (feature-flagged OFF, invisible) · Telugu/Hindi portal localization (UI is English v1; the receptionist itself is multilingual regardless).

## 10. Phased implementation plan (Claude Code)

Standing rules apply to every session: one issue per session · conventional commits · fast-forward onto main · runtime evidence to close (suite green count + **screenshots for every UI session** + cross-tenant negative tests wherever a route is added). Model guidance: **Sonnet 4.6 high** for backend/forms/CRUD sessions; **Opus 4.8 xhigh** for the two design-defining sessions (P1-S2 shell, P6-S18 polish).

**Prerequisites:** portal auth before any page · F-006 before Booking rules (§5.6) · paid Gemini key before the Test page is honestly usable (§5.11).

**Phase 1 — Foundation (3 sessions)**
- S1 Portal auth backend: users extension, scrypt hashing, login/logout, session middleware, `requirePortalAuth` attaching tenant from user row, rate limits, INV-1 negative tests. DoD: owner logs in; cross-tenant access provably impossible in tests.
- S2 Portal shell: tokens.css, nav, page scaffold, Home/Readiness read-only wired to validation runs. DoD: screenshots desktop + 380px; readiness ring live against a real tenant.
- S3 Operator-side "create owner account" in admin panel + hardening pass (headers, limits, session config parity). DoD: end-to-end — operator creates account, owner logs in fresh.

**Phase 2 — Core facts (3 sessions)**
- S4 Clinic profile page. S5 Hours & holidays. S6 Pricing (+ verify/add renderer FACTS block). DoD each: save → new config version → prompt preview reflects it → screenshots.

**Phase 3 — People & rules (4 sessions)**
- S7 **F-006 enforcement** (booking respects advance_days / buffer / same-day / hours + holidays; red-before/green-after per knob). S8 Doctors (verify existing storage mapping first — parallel table = STOP). S9 Booking rules page. S10 Safety & handoff page (+ invariants panel).

**Phase 4 — Knowledge (2–3 sessions)**
- S11 FAQ editor → chunks (edit = re-embed, delete = remove; caps). S12 PDF upload + extraction (single vetted dep, flagged) — or defer to v1.1 and ship FAQ-only.

**Phase 5 — Receptionist & test (3 sessions)**
- S13 Receptionist page (persona + voice, bounded speaker list). S14 Test page (real pipeline, trace provenance line, rate limit + counter). S15 "What your receptionist knows" owner preview over the existing prompt-preview endpoint.

**Phase 6 — Wizard & go-live (3 sessions)**
- S16 Onboarding wizard (embeds existing cards; resumable). S17 History page (revisions, snapshot view, restore-as-new-version). S18 Go-live flow + full empty/error-state sweep + mobile pass. DoD: §11 acceptance run, recorded.

## 11. v1 acceptance criteria

On a fresh tenant: the operator creates an owner account; the owner, on a phone, completes the wizard **unaided in under 45 minutes**; readiness reaches green; they press Go live; they then edit a treatment price and the Test page quotes the new price on the next message — with zero developer involvement at any step. The suite is green throughout, and every portal route carries a passing cross-tenant negative test.
