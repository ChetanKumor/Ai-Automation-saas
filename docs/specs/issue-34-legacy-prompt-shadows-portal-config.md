# Issue 34 — Admin-created tenants silently ignore all portal-written prompt copy

Appendix to `docs/specs/zyon-first-launch-plan.md`, which carries the compact entry and
remains the queue. Filed 2026-07-25 against `a33f54c`. Status: **open, not implemented.**

Origin: A-007 in `docs/os/assumptions.md`, found while reconciling project memory
against HEAD.

## Summary

For any tenant with a non-null `tenants.ai_prompt`, the tenant config document is
**never read**. Every portal page that writes to the config doc is shadowed at the
prompt. The owner sees a successful save and a new config version; the model never sees
the value.

Not a regression — the behaviour is deliberate, documented, and tested. The defect is
that the portal never tells anyone.

## Mechanism

- `src/modules/ai/aiService.js:466-467` — `configForPrompt` opens with
  `if (hasLegacyPrompt(tenant)) return null;`. Zero config reads. The comment states the
  intent: *"Legacy tenants take ZERO new calls — their path is byte-identical to
  pre-Issue-10."*
- `src/modules/ai/aiService.js:400-405` — `resolvePromptHead` returns
  `{ head: tenant.ai_prompt, mode: 'legacy' }` before the renderer is reached.

## Shadowed

Written by the portal, rendered only by `templates/clinic.js`, therefore absent from a
legacy tenant's prompt:

| Portal page (spec §5) | Config path | Renderer site |
|---|---|---|
| 5.2 Clinic profile | `identity.*` → `config.business` | `clinic.js:252` |
| 5.3 Hours & holidays | `hours.*` | `clinic.js:308` |
| 5.4 Pricing | `pricing.*` | `clinic.js:370` |
| 5.6 Booking rules (prompt copy) | `booking.*` | `clinic.js:371` |
| 5.9 Receptionist | `personality.*` (name, style, length, custom) | `clinic.js:286,297,344,352` |
| 5.10 Safety & handoff | `escalation.*` | `clinic.js:319,372` |
| — | `languages`, `greeting`, `recording_consent`, `tools` | `clinic.js:253,327,336,310` |

## Survives

Bypasses the prompt head entirely:

- **Booking-rule enforcement** — `appointmentService.js:26-58` reads
  `configService.getTenantConfig` directly; `slot_minutes`, `advance_days`,
  `buffer_minutes`, `allow_same_day`, `hours` are enforced server-side regardless of
  prompt mode. The AI is *told* nothing but is *refused* correctly.
- **Doctors (5.5)** — `tenant_entities`, read by the availability path.
- **FAQs / Documents (5.7, 5.8)** — `knowledge_chunks`, injected into the prompt **tail**
  at `aiService.js:489-491`, downstream of the head split.
- The outer tail (`aiService.js:511-534`) and the GUARD-01 identity line.

Net: config-derived *facts* vanish; *guards* hold. The failure mode is a receptionist
that quotes nothing and knows no hours — not one that books on a holiday.

## Blast radius

`provisioningService.js:196,226` sets `ai_prompt: null` ("born on the renderer"), so
every portal-provisioned tenant is on the rendered path. Only three surfaces set a legacy
prompt: the admin tenant-create form (`public/admin/tenant-new.html:39`),
`scripts/update-prompt.js` (already called "a post-Issue-10 footgun" in the July audit
§4g), and the voice seed script.

The condition is surfaced to the **operator** three ways — advisory validation check
(`validationService.js:294-298`), `has_ai_prompt` on the admin detail route
(`adminRoutes.js:531`) rendering the banner at `public/admin/tenant-detail.html:104`, and
a per-turn WARN at `aiService.js:402`. `src/portal/protections.js:30-33` documents the
same gap for the safety panel.

**Nothing surfaces it to the owner in the portal.** That is the gap.

## Options

**(a) Remove the legacy-prompt field from `public/admin/tenant-new.html:39`.**
New tenants can then only be born on the renderer, matching what `provisioningService`
already does. The column and the precedence chain stay for the tenants that have one.

**(b) Go-live check refusing activation of a tenant with both a non-null `ai_prompt` and
portal-written config.** Catches the conflict at the last gate before traffic.

## Recommendation: (a)

It removes the only ordinary path by which the trap gets set, rather than detecting the
trap after someone has fallen into it. It is a one-line deletion in a form plus its
handler, it needs no new state and no new check to keep correct, and it converges the
admin surface on the behaviour `provisioningService` already implements. (b) is strictly
later and strictly more code, and it still permits an owner to spend an hour in the
portal before anything tells them.

Neither is implemented — this is a finding, not a fix.

Do **not** "fix" the precedence order in `resolvePromptHead`. It is deliberate,
documented, and covered by tests; reversing it would change the prompt of every existing
legacy tenant without warning.

## DoD

Red test: a tenant with a non-null `ai_prompt` cannot be created through the admin form.
Existing legacy tenants keep their prompt and their precedence behaviour unchanged. Suite
green. `docs/os/assumptions.md` A-007/A-008 updated with the outcome.
