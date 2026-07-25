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
voice seed script set a legacy prompt.

## A-008 — An owner editing a shadowed field is told their edit took effect
Depends on it: whether A-007 is a latent trap or an active one
Cheapest test: read the portal's save path for a legacy-prompt tenant and check for a warning surface.
Status: **confirmed true — and the mitigation is not built.**

The condition is surfaced to the *operator* three ways: an advisory validation check
(`validationService.js:294-298`), `has_ai_prompt` on the admin detail route
(`adminRoutes.js:531`) rendering the banner at `public/admin/tenant-detail.html:104`, and
a per-turn WARN at `aiService.js:402`. `src/portal/protections.js:30-33` documents the same
gap for the safety panel.

**The portal itself has no such banner.** An owner editing pricing on a legacy tenant gets
a saved-successfully confirmation and a new config version, with no indication the value
will never be spoken. Evidenced at `aiService.js:466-467` and `400-405`; mitigation not
built. Filed as an issue; not fixed in the session that found it.
