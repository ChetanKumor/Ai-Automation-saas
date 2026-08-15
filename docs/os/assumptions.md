# Assumptions

Beliefs the plan depends on that are not yet evidenced. Each needs the cheapest test that would settle it.

When an assumption is tested it leaves this file: it becomes a fact in `state.md`, or it kills the work that depended on it. An assumption that sits here untested for months is a decision made by default.

**Format:** claim · what depends on it · cheapest test · status

---

## A-001 — A Hyderabad dental clinic will pay a recurring fee for an AI receptionist
Depends on it: everything
Cheapest test: quote a real price to ten clinic owners and count who asks about contract terms rather than saying "send me details." Costs a week and zero code.
Status: **untested.** Zero clinics have been asked to pay. This is the largest unpriced risk in the company and no amount of engineering reduces it.

## A-002 — Telugu voice quality is good enough that a patient completes a booking without switching to a human
Depends on it: the entire voice wedge, the premium positioning, the data moat
Cheapest test: ten real inbound calls on production, counting completed bookings without escalation.
Status: partially evidenced — a real Sarvam Telugu booking fixture exists (DEMO-00). Not yet tested with strangers on live telephony.

## A-003 — Distribution through dental supply/equipment distributors beats cold outreach
Depends on it: the go-to-market plan for the first ten clinics
Cheapest test: one conversation with one distributor about a referral arrangement. Note the healthcare referral-fee constraint — platform booking fees rather than per-referral payments.
Status: untested. Costs one meeting.

## A-004 — The portal shortens the sales cycle or onboarding time
Depends on it: the justification for D-001 (~15–18 sessions already spent)
Cheapest test: onboard clinic #1 and time it. Note whether the portal appears in the sale at all.
Status: untested. Settles automatically at clinic #1 — see D-001.

## A-005 — The Udyam route satisfies both Plivo and Meta
Depends on it: C-1 timeline, and therefore the launch date
Cheapest test: Plivo documentation explicitly accepts Udyam; Meta's requirements are less explicit about MSME certificates. Confirm with a CA and, if uncertain, ask Meta support before choosing the entity route — the entity choice is expensive to reverse.
Status: partially evidenced on the Plivo side. On the Meta side, **partially evidenced via BSP documentation** — Meta's India flow offers Sole Proprietorship as a business type, and MSME/Udyam appears on Business Solution Provider accepted-document lists — but **not confirmed against Meta's own country-specific registry**. Cheapest test unchanged: ask Meta support before choosing the entity route.

## A-006 — Latency on Railway with co-located Postgres lands at 0.6–1.5s first audio
Depends on it: demo credibility and the "sounds human" claim
Cheapest test: the genesis deploy itself. Measure on the first production call.
Status: modelled, not measured. ~55–65% of observed dev latency attributed to local environment and Neon cold starts.
Scope note: the prod-genesis session settles the **Node brain-path half only**. STT and TTS run in the Python worker (`voice-agent/`, Sarvam saaras:v3 + bulbul:v3) and remain **unmeasured until a real call** — no repo evidence can close them.

## A-007 — Portal-written configuration actually reaches the model at runtime
Depends on it: D-001's entire justification and the ~15–18 sessions spent on the portal
Cheapest test: for a tenant with a non-null `tenants.ai_prompt`, trace which portal-written config fields reach the prompt and which are overridden by the legacy path.
Status: **tested this session — FALSE for legacy-prompt tenants, true otherwise.**
Outcome (2026-07-27, Issue 34 option (a)): unchanged as a statement of fact — the
precedence below is deliberate and was not touched. What changed is who can land in it:
the admin form no longer offers a prompt field and the create route refuses a non-empty
`ai_prompt`, so **no tenant is born legacy by accident any more.** Deliberate creation via
`scripts/update-prompt.js` still works, so the analysis below stays live for that
population and for existing legacy tenants.

`src/modules/ai/aiService.js:466-467` — `configForPrompt` opens with
`if (hasLegacyPrompt(tenant)) return null;`. The tenant config document is **never read**.
`src/modules/ai/aiService.js:400-405` — `resolvePromptHead` returns the legacy text
verbatim before the renderer is reached. Both are deliberate and documented ("Legacy
tenants take ZERO new calls — their path is byte-identical to pre-Issue-10").

**Shadowed** — written by the portal, rendered only by `templates/clinic.js`, therefore
absent from a legacy tenant's prompt:

| Portal page (spec §5) | Config path | Renderer site |
|---|---|---|
| 5.2 Clinic profile | `identity.*` → `config.business` | `clinic.js:252` |
| 5.3 Hours & holidays | `hours.*` | `clinic.js:308` |
| 5.4 Pricing | `pricing.*` | `clinic.js:370` |
| 5.6 Booking rules (prompt copy) | `booking.*` | `clinic.js:371` |
| 5.9 Receptionist | `personality.*` (name, style, length, custom) | `clinic.js:286,297,344,352` |
| 5.10 Safety & handoff | `escalation.*` | `clinic.js:319,372` |
| — | `languages`, `greeting`, `recording_consent`, `tools` | `clinic.js:253,327,336,310` |

**Survives** — bypasses the prompt head entirely:

- **Booking-rule enforcement** — `appointmentService.js:26-58` reads `configService.getTenantConfig`
  directly; `slot_minutes`, `advance_days`, `buffer_minutes`, `allow_same_day`, `hours`
  are enforced server-side regardless of prompt mode. The AI is *told* nothing but is
  *refused* correctly.
- **Doctors (5.5)** — `tenant_entities`, read by the availability path.
- **FAQs / Documents (5.7, 5.8)** — `knowledge_chunks`, injected into the prompt **tail**
  at `aiService.js:489-491`, downstream of the head split.
- The outer tail (`aiService.js:511-534`) and the GUARD-01 identity line.

Net: config-derived *facts* vanish; *guards* hold. The failure mode is a receptionist that
quotes nothing and knows no hours — not one that books on a holiday.

Blast radius is bounded: `provisioningService.js:196,226` sets `ai_prompt: null` ("born on
the renderer"), so every portal-provisioned tenant is on the rendered path. Only the admin
tenant-create form (`public/admin/tenant-new.html:39`), `scripts/update-prompt.js`, and the
voice seed script set a legacy prompt. ⚠️ **Superseded by Issue 34 (2026-07-27):** the
admin form is no longer one of them — the field and the route's acceptance of the
parameter are both gone. Two surfaces remain, both deliberate.

## A-008 — `voice.did` has no dedicated write surface
Depends on it: Issues 11–14 being demonstrable end-to-end; anyone assuming a provisioned clinic arrives with its phone number set
Cheapest test: already run (Issue 11 session, `9be2382`) — grep `src/`, `scripts/`, `tests/`. `config.voice.did` is declared (`config/schema.js:257`, `defaults.js:109`), read by `validation/validationService.js:259-264` and `tenantService.getByDid`, and written by nothing with a UI or a CLI flag: not the Issue 15 provisioning CLI, not the portal (`portal/routes.js:1433,1606` say so and preserve it across saves), no script.
Status: **confirmed true.** Same class as `tenants.owner_notify_phone`, which B1 found had no production writer *after* it had shipped a silent no-op. **Not a blocker** — the admin JSON config editor sets a DID today through `configService.writeTenantConfig`, validated like any other field; what is missing is a labelled input. Filed as **Issue 36**, deliberately not built: nothing needs configuring until Issue 12 or 13 has a caller, and C-2 is unfiled. Recorded here so the next session that assumes a DID is set has to notice it isn't.

## A-009 — An owner editing a shadowed field is told their edit took effect
Depends on it: whether A-007 is a latent trap or an active one
Cheapest test: read the portal's save path for a legacy-prompt tenant and check for a warning surface.
Status: **confirmed true when written — mitigation now built (2026-07-27).**
F-F001 (`6ceb8f0`) gave the owner the warning the portal never had; Issue 34 option (a)
then removed the accidental route into the state at all. The paragraph below describes the
gap as it stood when filed; it is no longer the current state.

The condition is surfaced to the *operator* three ways: an advisory validation check
(`validationService.js:294-298`), `has_ai_prompt` on the admin detail route
(`adminRoutes.js:531`) rendering the banner at `public/admin/tenant-detail.html:104`, and
a per-turn WARN at `aiService.js:402`. `src/portal/protections.js:30-33` documents the same
gap for the safety panel.

**The portal itself has no such banner.** An owner editing pricing on a legacy tenant gets
a saved-successfully confirmation and a new config version, with no indication the value
will never be spoken. Evidenced at `aiService.js:466-467` and `400-405`; mitigation not
built. Filed as **Issue 34** in `docs/specs/zyon-first-launch-plan.md` (Phase 8), with the
full finding at `docs/specs/issue-34-legacy-prompt-shadows-portal-config.md`. Not fixed in
the session that found it.

## A-010 — `customers.preferred_language` holds a value the config schema would accept
Depends on it: any per-language literal selected by a stored customer language — the V1c greeting, the SSE ack copy, and anything later keyed on a caller's language
Cheapest test: already run (V1c session) — read the write path, then read a real row. `customerService.js:69-73` writes the turn's `language` verbatim, and that value is Sarvam STT's (`voice-agent/agent.py:523-524`, `ev.language`), forwarded on `delegate_turn` and never checked against `configSchema`'s `LANG_CODES`. The dev database's own caller row (`d9cf814a…`) holds **`en-IN`**.
Status: **confirmed FALSE — the assumption does not hold, and it had already cost something.** The config document is keyed on bare codes (`te`/`hi`/`en`); the column holds BCP-47. A greeting selected with the stored value directly misses every key and falls through `pickLine`'s English fallback, so a Telugu clinic's returning Telugu caller would have been greeted in English by a route returning 200 — with a WARN that reads as a stale-config notice, not a bug. The same divergence had already made the SSE ack copy correct only by coincidence: its table was keyed on `te-IN`, so it worked for STT-derived values and silently fell back to English for a tenant-default `te`.
V1c normalises at ONE boundary — `configLang` in `src/modules/config/schema.js` — and repointed both readers through it (`internalVoice.js` greeting + `ackTextFor`). Unresolvable now means *tenant default plus a named WARN*, never English by accident. **The writer is unchanged and still unvalidated**, filed as **Issue 37**: the column will keep accumulating values no schema admits, so every future reader inherits the obligation to normalise. Recorded here because the natural assumption — "it's a language column, it holds a language code we support" — is the one that produces the bug.

## A-011 — India's WhatsApp service-message rate will be ~₹0.14 when Meta starts charging on 2026-10-01
Depends on it: every cap and the overage rate in D-015. Meta's per-message charge is
~48% of the ₹0.2912 per-reply cost the caps are solved from — the other ~52% is
Gemini, which is verified and does not move with this.
Cheapest test: read Meta's own published India rate on or after 2026-09-01. Costs
nothing and requires no code. Meta stated it would publish per-market rates before
that date.
Status: **modelled, not verified.** ₹0.14 is the midpoint of a ₹0.13–0.145 India
utility/auth range taken from secondary sources — BSP rate-card pages surfaced by
web search, not Meta's own documentation. The rate has never been fetched from
developers.facebook.com and should be before it is relied on again.

**Provenance warning.** Several BSP pages in the same search results stated that
service messages "will continue to remain free." They were stale against Meta's
2026-07-01 announcement. A model built on them would carry this cost at zero. Treat
BSP pages as unreliable for anything post-dating July 2026 and prefer Meta primary
documentation.

**Two dated triggers, both external, neither a filing (deliberately not in clocks.md —
no counterparty, no reference number, no owner action):**

- **2026-09-01** — Meta publishes per-market rates. Compare the published India figure
  against ₹0.14 and re-derive per the sensitivity below.
- **2026-10-01** — the charge takes effect. Service replies inside the 24-hour
  customer-service window become billable at the market utility/auth rate with no
  volume discount. Applies to replies sent by a person or a third-party AI tool;
  Meta's own Business Agent is exempt. Changes COGS whether or not any clinic has
  signed by then.

**Sensitivity — what breaks, in order.** Let X be the published rate. Per-reply cost
is ₹0.1512 (Gemini, fixed) + X.

1. **The ₹0.75 overage rate is the fragile number.** It crosses the 60% floor at
   X = ₹0.1488 — six percent above the modelled figure. At ₹0.15 it is already 59.8%.
   This is the first thing to check on 2026-09-01, before the caps.
2. **The three caps erode smoothly with no cliff.** At X = ₹0.145 they are
   6,048 / 12,423 / 18,635; at ₹0.15, 5,944 / 12,210 / 18,316; at ₹0.20,
   5,074 / 10,424 / 15,636. Recompute as
   `cap = (price × 0.40 − fixed) ÷ (0.1512 + X + 0.0667X)`, the last term being
   booking-confirmation templates.
3. **The tier structure fails at X = ₹0.240**, where Pro's cap meets its own included
   allowance. Starter survives to ₹0.436, Growth to ₹0.304.

Also re-derive if the caps move: the included allowances (set at ~half each cap), the
conversation translations (~500 / ~1,333 / ~2,333, being caps ÷ 6 replies), and the
margin-at-cap figures. D-015's Review field already carries the 2026-09-01 trigger.

**Still unverified beyond the rate itself:** 6 AI replies per conversation, 4,000
input / 150 output tokens per reply, 20% of conversations producing a booking, and
fixed per-clinic infrastructure at ₹150/₹200/₹300 — all ESTIMATED, none measured,
all inputs to the same caps. Production usage settles them; Meta's rate does not.