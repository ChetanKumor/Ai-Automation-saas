# Pricing decision — register entries, paste-ready

Everything below is text for you to append. I cannot write to your repo or produce a
`git diff` from here — `/mnt/project/` is a read-only knowledge snapshot with no `.git`.
Run §5 to produce items 4 and 5 of your request.

---

## 0. Before you paste — verify the numbers

```powershell
# Highest decision number in force, and whether D-006 / D-015 are still unappended
git grep -oE "^## D-[0-9]+" -- docs/os/decisions.md | Sort-Object -Unique
Get-Content docs/os/decisions.md.draft -ErrorAction SilentlyContinue | Select-String "^## D-"

# Highest assumption number
git grep -oE "^## A-[0-9]+|^\*\*A-[0-9]+" -- docs/os/assumptions.md | Sort-Object -Unique

# Confirm no pricing entry already exists that this would contradict
git grep -niE "4,?999|5,?000|pricing|per month|subscription" -- docs/os/decisions.md
```

Last confirmed state from your S0 session: D-001–D-005 and D-007–D-014 in force, **D-006
reserved by an unappended draft**. Whether the web-program H5 override was appended as
D-015 decides whether this entry is **D-015 or D-016**. Do not assume — you caught this
exact trap on D-014.

---

## 1. `docs/os/decisions.md` — append

```markdown
## D-0NN — Three-tier launch pricing with COGS-derived usage caps

Date: 2026-08-14
Overrides: G-PAY — "do not generalise anything: plans, entitlements, roles,
permissions" — by launching three priced tiers before any clinic has paid.

Decision:
  Starter  ₹5,000/mo · 3,000 AI replies included · hard cap 6,000  · overage ₹0.75/reply
  Growth   ₹10,000/mo · 8,000 AI replies included · hard cap 12,500 · overage ₹0.70/reply
  Pro      ₹15,000/mo · 14,000 AI replies included · hard cap 18,500 · overage ₹0.65/reply
  Setup    ₹10,000 listed, waived for the first ten clinics.
  Tiers differ by allowance only. No feature gating.
  Voice is not sold on any tier — see A-0NN.

  Basis: gross-margin floor 60%, target 70%+ at normal usage. Caps solved backwards
  from the floor at ₹0.2912 per AI reply (Gemini 2.5 Flash 4,000 in / 150 out at
  ₹96/USD = ₹0.1512, plus Meta service message ₹0.14). Margin at cap: 60.9% /
  60.4% / 60.9%. Margin at normal usage: 84.4% / 81.2% / 78.4%.

  Metered dimension: AI replies, and only AI replies. Conversations are displayed,
  not metered — cost scales with replies, so a conversation cap lets a 20-exchange
  thread through at 3x the cost of a 6-exchange one. Tokens, RAG retrievals,
  storage and workflow runs are derivatives of reply count and are not metered.

  Cap behaviour: 80% notice, 90% upgrade prompt, 100% overage begins, hard cap
  disables AI replies only. Human handoff, the portal and staff replies remain
  live at all times. Usage notices go to the clinic owner, never into a patient
  conversation.

Reason: A-001 cannot be tested without a price, and a single unlimited plan has no
mechanism to convert usage growth into revenue. Overage is deliberately priced at
61% marginal margin — below the margin of an upgrade — so the incentive never
favours keeping a clinic overspending on a cheaper tier.

Falsifiable prediction: by 2027-02-14, with ≥10 paying clinics, at least two sit on
Growth or Pro. If all ten are on Starter, the ladder converted nothing, the tier
boundaries were placed against imagined usage, and the structure collapses to one
plan plus overage.

Review: 2027-02-14. Earlier trigger — 2026-09-01, when Meta publishes India's
service-message rate. The caps sit ON the 60% floor by construction and have no
slack; if the published rate exceeds ₹0.14 all three are re-derived, not patched.

Note: the margin figures exclude support cost, which is opex, not COGS. At ₹5,000/mo
support is the binding constraint on clinic count long before COGS is — two founder
hours per clinic per month is a full-time job at fifty clinics. This is the reason
Starter's cap is set at roughly 2x plausible entry-tier usage rather than tight to it.
```

---

## 2. `docs/os/assumptions.md` — append two

```markdown
## A-0NN — Voice sells as a paid add-on, not bundled into a tier

Status: UNTESTED — no production voice minutes exist. Plivo is a throwing stub
(`src/modules/telephony/providers/plivo.js`, every method raises NotImplemented);
C-2 is unfiled.

Provisional shape: ₹3,000/month including 300 voice minutes, overage ₹8/minute,
hard safety cap 400 minutes, owner-configurable downward, defaulting on.
At ₹2.95/minute this gives 70.5% margin at the included allowance and 63% marginal
margin on overage.

Why an add-on and not bundled — this is arithmetic, not preference:
  300 minutes bundled into Starter ₹5,000 gives 43.2% gross margin at the 6,000-reply
  cap, breaching the D-0NN floor. Holding 60% while bundled forces the reply cap from
  6,000 down to 3,310 — 310 above the included allowance, making overage meaningless.
  The mirror calculation: alongside a 6,000-reply cap, the voice allowance that fits
  inside 60% is 15 minutes. As a separate add-on, ₹8,000 combined gives 79.2% at
  normal usage and 64.5% at cap.

What would falsify or revise this: real Plivo India inbound rates (currently UNKNOWN —
their India per-minute rate is not published on a static page, and their 60-second
minimum with round-up makes short calls cost more than the rate implies), plus the
distribution of voice minutes per clinic. The mean is not the number that matters here;
the tail is what breaks a flat allowance.

Do not finalise voice pricing before both exist.

Review: when C-2 clears and 30 days of production call data exist.
```

```markdown
## A-0NN — A multi-branch clinic segment exists and will pay ~10x Starter

Status: UNTESTED — zero clinics of any size have been asked to pay. No enterprise
prospect has been identified, contacted or scoped.

Claim: clinic groups with 5+ branches or hospital groups constitute a distinct
segment that will pay ₹40,000–₹60,000+/month.

Origin: a July 2026 externally-prepared pricing report and companion workbook
(AI-CustomerOps-*). NOTE: that document's stated Phase 2 is "The AI Operating System
for Appointment-Based Businesses" — the framing retired under §5. Its Enterprise tier
is inherited from that framing and carries no COGS model, no usage profile, no cap and
no named prospect. Its cost assumptions also predate Meta's 1 October 2026 change and
model service replies as free.

This is recorded as an assumption, not a decision, because none of the inputs required
to price it exist. It is NOT in force and must not be quoted to a prospect.

What would make it real: one identified multi-branch prospect, their actual reply and
call volume, and a cap derived the same way D-0NN's were.

Review: gated on G-TEN — ten paying clinics and ninety days of production transcripts.
```

---

## 3. `docs/os/clocks.md` — append two external clocks

Neither is currently tracked, and both can invalidate D-0NN's caps without anyone
touching the repo.

```markdown
## C-4 — Meta publishes India service-message rate
Due:    2026-09-01 (Meta's stated commitment)
Filed:  n/a — no action required, this is a publication date to watch
Blocks: D-0NN's caps. All three sit on the 60% floor with no slack. Modelled at
        ₹0.14 (current India utility/auth rate). If the published rate is higher,
        every cap is re-derived.
Action: check https://developers.facebook.com/docs/whatsapp/pricing on 2026-09-01,
        re-run the model, amend D-0NN if the rate moved.

## C-5 — WhatsApp service messages become billable
Due:    2026-10-01
Filed:  n/a — external, unavoidable
Blocks: nothing directly; changes COGS whether or not Prantivo has customers by then.
Effect: every AI reply inside the 24-hour customer-service window becomes chargeable
        at the utility/auth rate, no volume discount. Meta's own Business Agent is
        exempt; third-party assistants are not. This is 48% of the ₹0.2912 reply cost
        in D-0NN and it is currently ₹0.
```

---

## 4. Final pricing table

| | Starter | Growth | Pro |
|---|---|---|---|
| **Price** | ₹5,000 | ₹10,000 | ₹15,000 |
| **Incl. GST (18%)** | ₹5,900 | ₹11,800 | ₹17,700 |
| **Included AI replies** | 3,000 | 8,000 | 14,000 |
| **≈ conversations** | ~500 | ~1,333 | ~2,333 |
| **Hard cap** | 6,000 | 12,500 | 18,500 |
| **Overage** | ₹0.75/reply | ₹0.70/reply | ₹0.65/reply |
| **Setup** | ₹10,000 listed, waived for first ten | same | same |
| **Voice** | add-on, not yet sold | same | same |
| **COGS at normal** | ₹781 | ₹1,883 | ₹3,245 |
| **GM at normal** | **84.4%** | **81.2%** | **78.4%** |
| **COGS at cap** | ₹1,953 | ₹3,956 | ₹5,860 |
| **GM at cap** | **60.9%** | **60.4%** | **60.9%** |

Four usage levels, COGS ₹ / GM %:

| Plan | Low (35%) | Normal (70%) | Included full | At cap |
|---|---|---|---|---|
| Starter | 466 / 90.7% | 781 / 84.4% | 1,052 / 79.0% | 1,953 / **60.9%** |
| Growth | 1,041 / 89.6% | 1,883 / 81.2% | 2,604 / 74.0% | 3,956 / **60.4%** |
| Pro | 1,773 / 88.2% | 3,245 / 78.4% | 4,507 / 70.0% | 5,860 / **60.9%** |

Upgrade incentive check: 6,000 replies on Starter = 60.9%. The identical volume on
Growth = **80.0%**. Usage growth pulls revenue up.

---

## 5. Final usage and cost assumptions, labelled

**VERIFIED** — Gemini 2.5 Flash $0.30/M in, $2.50/M out · Sarvam STT ₹30/hour ·
Sarvam TTS `bulbul:v3` ₹30/10,000 chars · WhatsApp India utility/auth ~₹0.13–0.145 ·
service messages become billable 2026-10-01 with no volume discount · Plivo bills a
60-second minimum rounded up · Plivo requires a registered Indian entity for Indian
numbers.

**ESTIMATED** — ₹96/USD planning rate · Meta's October India service rate at ₹0.14 ·
4,000 input / 150 output tokens per reply (unified across voice and WhatsApp because
architecture invariant 1 makes them the same prompt path) · 6 AI replies per
conversation · fixed per-clinic infra ₹150 / ₹200 / ₹300 by tier · 20% of conversations
produce a booking, 2 utility templates each · voice ₹2.95/min from a 2-minute call,
1,000 agent characters, ₹0.50/min telephony.

**UNKNOWN — NEEDS PRODUCTION DATA** — actual replies per conversation · actual
conversations per clinic per month **and their distribution** · where real clinics fall
against these tier boundaries · voice minutes per clinic and the tail · Plivo's real
India inbound per-minute rate · whether a Hyderabad clinic pays ₹5,000 at all (A-001,
still the largest unpriced risk in the company).

**The honest limitation, restated so it survives into the register.** The caps are
margin-safe at any usage level — that is arithmetic and it holds. Where the boundaries
sit relative to real clinics is unknown. My "normal" is 500 conversations/month; the
uploaded workbook's "average clinic" is 800. Two documents, same unmeasured variable,
60% apart. If real usage clusters low, every clinic sits in Starter and the ladder
converts nothing. If it clusters high, Starter's cap fires constantly. Neither breaks
margin; both break the expansion thesis. That is what the 2027-02-14 prediction tests.

---

## 6. Commands — run these to produce items 4 and 5

```powershell
# after appending the three files
git diff docs/os/decisions.md docs/os/assumptions.md docs/os/clocks.md | tee scripts/out/pricing-diff.txt
git status
node scripts/os-check.js          # docs/os/ changes only — should pass
```

`os-check.js` tolerates `docs/os/` changes, so this should exit 0 without a provenance
commit. If it does not, stop and report rather than working around it.

Then one commit:

```powershell
git add docs/os/decisions.md docs/os/assumptions.md docs/os/clocks.md
git commit -m "docs: record three-tier launch pricing (D-0NN), voice and enterprise assumptions, Meta pricing clocks"
```

Nothing here touches `web/`, `src/`, or any product code. The website sessions
(S1–S6 in `prantivo-web-copy-sessions.md`) remain unstarted, and S3 — the pricing and
FAQ session — is now unblocked, since S0 item 3 has an answer for the first time.
