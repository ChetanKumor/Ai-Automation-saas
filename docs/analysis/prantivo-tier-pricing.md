# Prantivo — three-tier pricing with COGS-derived caps

Date: 2026-08-14 · ₹96/USD throughout · supersedes the ₹88/USD figures in
`prantivo-unit-economics.md`

---

## 0. Gate status

G-PAY is false — zero clinics have paid. Its standing prohibition is *"do not generalise
anything: plans, entitlements, roles, permissions."* Three tiers with entitlement
boundaries is exactly that. Proceeding is a legitimate founder override; it needs a
`decisions.md` entry with a falsifiable prediction, and draft text is in §10.

**What the override actually costs you, stated once.** The caps below are *margin-safe* —
that part is arithmetic and it holds. What they are not is *well-placed*. Placing a tier
boundary correctly requires knowing where clinics cluster, and nobody knows. My "normal"
is 500 conversations/month; the uploaded workbook's "average clinic" is 800. That is a 60%
disagreement between two documents about the same unmeasured variable, and it is the whole
risk. If real usage clusters at 150 conversations, all ten clinics sit in Starter forever
and the ladder does nothing. If it clusters at 1,200, Starter's cap fires constantly and
you have built a product that annoys its own customers. **The margins are safe at any
placement. The revenue expansion is not.** Revisit boundaries at ten clinics.

---

## 1. Reconciliation of the previous model

Three defects, all corrected.

| Defect | Before | Now |
|---|---|---|
| Exchange rate | ₹88/USD | **₹96/USD** |
| Token assumption | 4,000 in (voice) vs 3,500 in (WhatsApp), unjustified | **4,000 in / 150 out everywhere** |
| Cost unit | computed per scenario | **one atom: cost per AI reply** |

**Why one token profile is correct rather than merely tidy.** Architecture invariant 1
makes Node the sole reasoning brain and the Python worker transport-only. A voice turn and
a WhatsApp reply therefore traverse the same code path, the same system prompt, the same
RAG retrieval and the same history structure. Different token counts would imply two
reasoning paths, which the architecture forbids. The split was an error of inattention,
not a modelling choice.

### The atom

| Component | Rate | Per reply | Label |
|---|---|---|---|
| Gemini input | $0.30/M × 96 = ₹28.80/M | 4,000 tok → ₹0.1152 | **VERIFIED** |
| Gemini output | $2.50/M × 96 = ₹240/M | 150 tok → ₹0.0360 | **VERIFIED** |
| Meta service message | ₹0.14 | ₹0.1400 | **ESTIMATED** — Oct-1 rate unpublished |
| | | **₹0.2912** | |

Gemini and Meta are near-equal contributors — 52%/48%. Neither dominates, so neither
alone is worth optimising; both scale linearly with reply count, which is why reply count
is the only thing that needs metering.

**The single largest uncertainty in this document** is that ₹0.14. Meta publishes India's
October service-message rate before 1 September. If it lands at ₹0.145 nothing moves. If
Meta prices service messages above utility, every cap below tightens proportionally.
Re-run this model on 1 September; it is a one-line change.

### Fixed per-clinic infrastructure

₹150 / ₹200 / ₹300 per clinic per month by tier — **ESTIMATED**, amortised across 10–50
clinics. Deliberately low because the repo genuinely lacks Redis, any queue, any email
transport, object storage and any observability vendor. The uploaded workbook charges
₹200 core infra + ₹75 email/SMS + ₹300 support = ₹575/clinic for Starter. Two of those
three lines are components that do not exist, and the third is opex.

**Support is excluded from every gross-margin figure here**, per your instruction. It is
real and it is dangerous, but it is opex — see §8.

---

## 2. Caps derived from margin, not from price

Solving `replies = (price × (1 − target GM) − fixed) ÷ ₹0.2912`:

| Price | 80% | 75% | 70% | 65% | **60%** |
|---|---|---|---|---|---|
| ₹5,000 | 2,828 | 3,660 | 4,492 | 5,323 | **6,155** |
| ₹10,000 | 5,989 | 7,653 | 9,316 | 10,980 | **12,644** |
| ₹15,000 | 8,984 | 11,479 | 13,975 | 16,470 | **18,966** |

Note the caps are *not* proportional to price. ₹10,000 buys 2.03× Starter's cap and
₹15,000 buys 3.08×, because fixed infrastructure is a smaller share of a larger plan.
Strict proportionality would have under-provisioned the upper tiers.

**Design rule.** Hard cap = the 60% column, rounded down to a memorable number. Included
allowance = roughly half the cap, which puts realistic usage in the high-70s/low-80s.

---

## 3. The three plans

| Plan | Price | Included | Hard cap |
|---|---|---|---|
| Starter | ₹5,000 | 3,000 replies · ~500 conversations | 6,000 |
| Growth | ₹10,000 | 8,000 replies · ~1,333 conversations | 12,500 |
| Pro | ₹15,000 | 14,000 replies · ~2,333 conversations | 18,500 |

### Run against four usage levels

COGS ₹ / gross margin %. Low = 35% of allowance, Normal = 70%, High = allowance fully
burned, Max = at the hard cap.

| Plan | Low | Normal | High | **Max allowed** |
|---|---|---|---|---|
| **Starter** ₹5,000 | 466 / **90.7%** | 781 / **84.4%** | 1,052 / **79.0%** | 1,953 / **60.9%** |
| **Growth** ₹10,000 | 1,041 / **89.6%** | 1,883 / **81.2%** | 2,604 / **74.0%** | 3,956 / **60.4%** |
| **Pro** ₹15,000 | 1,773 / **88.2%** | 3,245 / **78.4%** | 4,507 / **70.0%** | 5,860 / **60.9%** |

**Every cell clears 60%. Every normal-usage cell clears 78%.** Both targets met, with the
floor hit exactly at the cap by construction.

### Why each cap exists

- **Starter 6,000** — the 60% line is 6,155. Rounded down to 6,000 for legibility and a
  small margin of safety against the unpublished Meta rate. Translates to ~1,000
  conversations, roughly double what a 1–2 chair clinic should plausibly generate, so the
  cap should almost never fire on the intended customer. A cap that fires often on the
  entry tier is a support burden, not a revenue mechanism.
- **Growth 12,500** — the 60% line is 12,644. 12,500 is the round number below it. Note
  12,644 is only 2.05× Starter's, not 2× exactly — the fixed-cost dilution is small at
  these prices and the caps end up nearly proportional by coincidence, not design.
- **Pro 18,500** — the 60% line is 18,966. Rounded down harder here because Pro carries the
  most absolute rupees of exposure and the Meta rate uncertainty compounds with volume.

### The upgrade incentive is real, not decorative

| Scenario | Gross margin |
|---|---|
| 6,000 replies on Starter (at cap) | **60.9%** |
| The identical 6,000 replies on Growth | **80.0%** |

A clinic that outgrows Starter is worth 19 margin points more on Growth. That is the
property you asked for — usage growth pulls revenue up rather than eroding it — and it
falls out of the structure rather than being asserted.

---

## 4. Meter one dimension, not ten

You listed ten candidates. My recommendation is one on WhatsApp today and one on voice
later.

| Dimension | Verdict |
|---|---|
| **AI replies** | **METER THIS.** Cost scales linearly with it. Visible in the portal. One number the clinic can hold in their head |
| WhatsApp conversations | **Display, don't meter.** A 20-exchange conversation costs 3× a 6-exchange one; a conversation cap lets that through |
| LLM tokens | Derivative of replies. Metering it exposes an implementation detail no clinic can act on |
| RAG retrievals | Derivative. One retrieval per reply by construction |
| Storage / database | Text rows and 768-dim embeddings. Pennies at any plausible volume |
| Workflow runs | Derivative of conversations. Not independently billable |
| TTS chars / STT min / telephony | **Not separate products.** These are the inputs to a voice minute — see §5 |
| Voice minutes | **METER THIS, when voice ships** |

**Communicate in conversations, meter in replies.** The plan page says "about 500 patient
conversations a month"; the usage bar counts replies. One meter, one number, with a human
translation on top. Two simultaneous caps ("500 conversations *or* 3,000 replies,
whichever first") is the design that generates support tickets.

---

## 5. Voice — future model, not launch

Recomputed at ₹96/USD with the reconciled token profile. Assumptions: 2-minute call,
6 turns, ~1,000 characters of agent speech.

| Component | Per call | Per minute | Share |
|---|---|---|---|
| Sarvam TTS | ₹3.00 | ₹1.50 | **51%** |
| Sarvam STT | ₹1.00 | ₹0.50 | 17% |
| Gemini | ₹0.91 | ₹0.45 | 15% |
| Telephony | ₹1.00 | ₹0.50 | 17% |
| **Total** | **₹5.91** | **₹2.95** | |

Telephony is **UNKNOWN — MUST CONFIRM**; Plivo's India inbound rate is not on a static
page and their 60-second minimum with round-up makes short calls cost more than the rate
implies. Nothing below is final until real minutes exist.

### Add-on, not bundled

| Add-on price | 75% GM | 70% GM | 65% GM | 60% GM |
|---|---|---|---|---|
| ₹2,000 | 169 min | 203 min | 236 min | 270 min |
| ₹3,000 | 253 min | 304 min | 355 min | 406 min |
| ₹4,000 | 338 min | 406 min | 473 min | 541 min |

**Proposed shape, to be re-derived against real usage:** ₹3,000/month including
**300 minutes** (70.5% GM), overage at **₹8/minute** (63% marginal margin), hard safety cap
at **400 minutes** (60.6% GM), owner-configurable downward, defaulting on.

### Why an add-on rather than bundled into the tiers

If voice were bundled, here is the headroom left after included WhatsApp usage:

| Plan | at 70% GM | at 65% | at 60% |
|---|---|---|---|
| Starter | 151 min | 236 min | 321 min |
| Growth | 134 min | 303 min | 472 min |
| Pro | **0 min** | 251 min | 505 min |

Pro at 70% has *zero* room for voice — its WhatsApp allowance already consumes the entire
margin budget. Bundling would force either a smaller WhatsApp allowance or a lower margin
target on exactly the tier meant to be most profitable. **Separating voice keeps the
WhatsApp ladder clean and prices the volatile cost where the volatility is.**

**Do not finalise any of this until Plivo's real rate and production minute distribution
exist.** The mean is not the number that matters; the tail is.

---

## 6. Approaching-the-limit experience

The customer-facing frame matters as much as the thresholds. Not *"you can only spend
₹5,000"* — rather *"Starter includes this much; if the clinic grows, there's a bigger
plan."*

| Point | Behaviour | Message |
|---|---|---|
| 80% of included | In-portal banner, one email | "You've used 80% of this month's allowance. At this pace you'll finish around the 26th." |
| 90% | Banner + WhatsApp to the owner | "You're approaching your plan limit." Show the Growth comparison with *their* numbers |
| 100% of included | **Service continues.** Overage begins at ₹0.75/reply | "You've passed your included usage. Extra replies bill at ₹0.75. Growth would cover this — here's the comparison." |
| Hard cap | AI stops replying. **Handoff stays live.** Owner alerted immediately | "Safety cap reached. Your team can still reply in the same thread. Raise the cap or upgrade in one click." |

Two design rules that matter more than the thresholds:

1. **The hard cap disables the AI, never the inbox.** A patient must never message a clinic
   and get silence. The handoff path, the portal, and staff replies all keep working. The
   cap protects your COGS, not your product's reason for existing.
2. **The 80% and 90% notices go to the owner, never the patient.** Nothing about your
   billing should ever be visible in a patient conversation.

**Overage at ₹0.75/reply** gives 61% margin on the marginal reply — deliberately just above
the floor, so overage is never *more* profitable than an upgrade. If overage were priced at
₹1.00 (71% margin) you would quietly prefer customers to stay on Starter and overspend,
which is the incentive structure that makes SaaS pricing adversarial.

**Build requirement.** Per-tenant reply counting has to exist before any of this ships.
Without it there is no meter, no threshold, no cap, and no invoice line. This is the one
piece of engineering the pricing decision actually mandates, and it precedes voice.

---

## 7. Charm pricing and the setup fee

### ₹5,000 / ₹10,000 / ₹15,000 — round numbers. Not ₹4,999.

Charm pricing does its work at a self-serve checkout where the left digit is scanned in a
fraction of a second among competing options. You have no checkout. Your first ten sales
are a founder across a desk from a clinic owner, and in that setting ₹4,999 reads as retail
technique, which is a small credibility cost at exactly the moment you're asking someone to
trust a company with no customers.

Three reasons the round number is actively better here:

1. **The ladder is legible.** "Five, ten, fifteen" is one mental object. "4,999 / 9,999 /
   14,999" is three numbers you have to round anyway to compare.
2. **GST arithmetic is clean.** ₹5,000 + 18% = ₹5,900. ₹4,999 + 18% = ₹5,898.82, which
   appears on an invoice and looks like a mistake.
3. **Negotiation headroom.** Starting at ₹5,000 lets you concede to ₹4,500 as a real
   founding-clinic gesture. Starting at ₹4,999 makes the same concession look like
   ₹4,499 — a worse number to say out loud.

The complexity isn't worth it because there is no mechanism through which it pays.

### Setup fee: list ₹10,000, waive it for founding clinics

Grounded in actual onboarding effort, not convention. Loading prices, timings, doctors and
treatments, configuring the tenant, and connecting the WhatsApp number is realistically
4–6 founder hours for the first clinics — and manual WABA onboarding is the correct launch
path at your scale, so that work is genuinely yours to do.

**₹10,000 is roughly ₹2,000/hour, which is honest cost recovery, not margin.** ₹5,000 would
underprice your own time; zero would signal the work is trivial and invite the assumption
that changes are free forever.

**But waive it for the first ten.** A-001 is untested; the binding constraint is getting a
clinic to say yes at all, and ₹10,000 of friction on that conversation is expensive
relative to ₹100,000 of setup revenue you will never see if nobody signs. A listed price
that you waive is worth more than no price: it makes the waiver a concession the clinic can
feel, and it establishes the number you'll charge clinic eleven.

---

## 8. What still threatens these margins

**Support is the real one, and it is not in any margin figure above.** At ₹5,000/month,
two founder hours per clinic per month is the constraint on how many clinics one person can
carry — long before COGS becomes a problem. Ten clinics is twenty hours a month. Fifty is a
full-time job that does not exist. This kills the company before it dents the gross margin,
and it is the reason to keep the entry tier's cap generous enough that it rarely fires.

**The 1 October Meta change**, at an unpublished India rate. Modelled at ₹0.14. Re-run on
1 September.

**Prompt and context growth.** Input tokens are 96% of Gemini token volume. A system prompt
that doubles doubles the Gemini half of the atom, which moves every cap. Treat the 4,000-token
budget as a number to defend in code review, not a passive observation.

**Agent verbosity, once voice ships.** TTS is 51% of voice COGS and every extra sentence
costs twice — once in characters, once in the STT and telephony seconds the patient spends
listening. `bulbul:v2` at ₹15/10k halves the largest line if quality permits. That is a
measurable A/B against production transcripts, not a decision to take here.

Negligible and deliberately unmodelled: storage, database growth, backups, logging volume,
retries, idle infrastructure, and every component the repo does not contain.

---

## 9. Founder recommendation

If I were you, launching tomorrow:

| | Starter | Growth | Pro |
|---|---|---|---|
| **Price** | ₹5,000 | ₹10,000 | ₹15,000 |
| **Incl. GST** | ₹5,900 | ₹11,800 | ₹17,700 |
| **Included** | 3,000 AI replies<br>~500 conversations | 8,000 AI replies<br>~1,333 conversations | 14,000 AI replies<br>~2,333 conversations |
| **Hard cap** | 6,000 replies | 12,500 replies | 18,500 replies |
| **Overage** | ₹0.75/reply | ₹0.70/reply | ₹0.65/reply |
| **Future voice** | add-on ₹3,000 / 300 min | add-on ₹3,000 / 300 min | add-on ₹3,000 / 300 min |
| **Expected COGS** | ₹781 | ₹1,883 | ₹3,245 |
| **Expected GM** | **84.4%** | **81.2%** | **78.4%** |
| **GM at cap** | **60.9%** | **60.4%** | **60.9%** |
| **Why a clinic picks it** | 1–2 chairs, one doctor. Enough for every enquiry a small clinic gets, and the cap is roughly 2× realistic use | 3–5 chairs with front-desk staff. The tier where the AI is replacing measurable labour, not supplementing it | Multi-doctor or multi-branch. Bought for volume headroom and priority response, not for features |

**Setup: ₹10,000 listed, waived for the first ten clinics.**

Note the tiers differ by **allowance, not features**. Feature-gating is entitlement design,
which G-PAY forbids, and it is also the wrong call commercially at ten customers: gating
the analytics dashboard behind Growth means Starter clinics can't see the value that would
make them upgrade. Sell capacity, ship everything to everyone, and let usage sort them.

### The three questions, answered

**Can a clinic at maximum allowed usage on ₹5,000 still leave ≥60%?** Yes — **60.9%** at
6,000 replies. The cap was solved for exactly this and rounded down.

**₹10,000?** Yes — **60.4%** at 12,500.

**₹15,000?** Yes — **60.9%** at 18,500.

No cap needs reducing. All three sit on the floor by construction rather than by luck,
which is also the reason none of them has slack: if Meta's October rate exceeds ₹0.14,
all three tighten together and the model must be re-run rather than patched.

---

## 10. Decision entry

```markdown
## D-0NN — Three-tier launch pricing ahead of G-PAY

Date: 2026-08-14
Overrides: G-PAY — "do not generalise anything: plans, entitlements, roles,
permissions" — by launching three priced tiers before any clinic has paid.

Decision: Starter ₹5,000 / 3,000 replies / cap 6,000 · Growth ₹10,000 / 8,000 /
cap 12,500 · Pro ₹15,000 / 14,000 / cap 18,500. Setup ₹10,000 listed, waived for
the first ten. Voice not sold. Caps derived from a 60% gross-margin floor at
₹0.2912 per AI reply (₹96/USD, Gemini 2.5 Flash + Meta service message at the
current India utility rate).

Reason: A-001 cannot be tested without a price, and a single unlimited plan has
no mechanism to convert usage growth into revenue.

Falsifiable prediction: by 2027-02-14, with ≥10 paying clinics, at least two sit
on Growth or Pro. If all ten are on Starter, the ladder converted nothing, the
tier boundaries were placed against imagined usage, and the structure collapses
to one plan plus overage.

Review: 2027-02-14, or 2026-09-01 if Meta's published India service-message rate
differs materially from ₹0.14 — in which case every cap is re-derived, not patched.
```

---

## 11. Evidence labels

**VERIFIED** — Sarvam STT ₹30/hr · Sarvam TTS `bulbul:v3` ₹30/10k chars · Gemini 2.5 Flash
$0.30/$2.50 per M · WhatsApp India utility/auth ~₹0.13–0.145 · service messages become
billable 1 Oct 2026 with no volume discount · Plivo 60-second minimum billing · Plivo
requires a registered Indian entity for Indian numbers.

**ESTIMATED** — Meta's October India service rate at ₹0.14 (published before 1 Sep) ·
fixed per-clinic infra ₹150/200/300 · ₹96/USD · 4,000 in / 150 out tokens per reply ·
6 replies per conversation · 1,000 agent characters per 2-minute call · telephony
₹0.50/min.

**UNKNOWN — NEEDS PRODUCTION DATA** — actual replies per conversation · actual
conversations per clinic per month and their *distribution* · where clinics cluster
against these tier boundaries · voice minutes per clinic and the tail · Plivo's real India
inbound rate · whether a Hyderabad clinic pays ₹5,000 at all, which is A-001 and remains
the largest unpriced risk in the company.
