# State

The company as of a date. Amend whenever reality diverges. A stale line here is a defect, not a detail.

**Last verified: 2026-07-24**
**Bootstrap note:** this file was seeded from conversation recollection, not from the repo. Every line below is marked ⚠️ until confirmed against the repo, and the OS treats recollection as unverified by construction. Confirm, correct, delete the markers, commit.

---

## Product

- **Prantivo** (formerly Zyon) — vernacular AI receptionist for Indian SMB dental clinics.
- Channels: **voice and WhatsApp**. Languages: Telugu, Hindi, English.
- Wedge: Hyderabad-area dental clinics.
- Product name in every surface and pitch: **AI Receptionist**. Retired framings: "AI Operating System for Businesses", "AI Employees".

## Customers

- Paying: **0**
- Pilots / live tenants: **0**
- Production deployments: **0** — first deploy is greenfield, DB initialised fresh from `schema.sql`

## Gate status

| Gate | Status |
|---|---|
| G-CLOCK | ❌ false — no external clock filed |
| G-PROOF | ❌ false — no production, no live call |
| G-PAY | ❌ false |
| G-TEN | ❌ false |

## Launch gates (from `docs/audit/2026-07-production-readiness.md`)

⚠️ **Paste the seven gates here verbatim with their identifiers.** The OS ranks work by which gate it closes (H3); without the list in a referenceable form, H3 cannot be applied and the hierarchy silently degrades to H4. This is the highest-value line in this file.

1. …
2. …
3. …
4. …
5. …
6. …
7. …

## Engineering ⚠️

- Test suite: **583 tests / 0 fail**
- Audit findings closed: F-001, F-003, F-004, F-005, F-007, F-010
- Portal v1: sessions S1–S6 complete (auth, shell + readiness, operator accounts, clinic profile, hours & holidays, pricing)
- Demo: DEMO-00 (real Sarvam Telugu booking fixture), DEMO-01 (two-pane patient thread proof surface)
- Remaining before first live call: Issues 11–13 (voice), Issue 14 (live-call gate, blocked on DID), Issue 20 (genesis deploy)

## Stack (frozen) ⚠️

Node reasoning brain (sole reasoning engine) · Python LiveKit worker (transport only) · PostgreSQL raw SQL + pgvector · Gemini 2.5 Flash · Sarvam saaras:v3 STT + Bulbul v3 TTS · Plivo · WhatsApp Cloud API · Railway · Neon (dev/test)

## Architecture invariants ⚠️

Node is the sole reasoning brain · tenant_id scoping everywhere · `configService` is the single config path · parameterised SQL only · all branches fast-forward onto main · one issue per session · runtime evidence closes a session

## Known open risks

- **Distribution is the existential risk**, not capability. Clinic sales in India are trust-based; the durable asset is an exclusive channel plus outcome-labelled vernacular transcripts.
- Test-suite nondeterminism traced to Neon network latency; local PostgreSQL on 5433 recommended for the test path.
- `VOICE_STREAM_TURNS=true` is the only perceptual latency fix required at deploy.
