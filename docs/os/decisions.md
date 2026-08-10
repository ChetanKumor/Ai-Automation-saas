# Decisions

Overrides and irreversible choices. Append-only. Never edit a past entry — supersede it with a new one.

An entry without a **falsifiable prediction** and a **review date** is a preference in the costume of a decision. The review is the entire point: it is what converts a pattern into learning instead of repetition.

**Format**

```
## D-NNN — <title>
Date: YYYY-MM-DD
Overrides: <gate / prohibition / prior decision, or "none">
Reason: <one sentence>
Prediction: <what will be observably true afterwards>
Review: YYYY-MM-DD
Outcome: <filled in on the review date — held / failed / partial, with evidence>
```

---

## D-001 — Build the owner-facing portal before any paying customer
Date: 2026-07-17
Overrides: G-PAY (no generalisation before one paying clinic); the standing ten-customer platform gate; the prior OS rule "do not build full SaaS initially; prioritize demo → outreach → close"
Reason: Founder roadmap decision — a self-serve configuration surface was judged necessary to make onboarding demonstrable.
Prediction: ⚠️ **backfilled — never recorded at the time.** The honest reconstruction is: *the portal will materially shorten the sales cycle or the onboarding time for clinic #1.* State it properly or mark it unrecoverable.
Review: **on the day clinic #1 is onboarded.** Measure actual onboarding time with a stopwatch, and note whether the portal was used at all during the sale. If clinic #1 is onboarded by hand without the portal touching the sale, the prediction failed and the lesson is priced.
Outcome: pending

## D-002 — Rewrite the AI Startup OS; move state out of the skill into `docs/os/`
Date: 2026-07-24
Overrides: none — replaces the previous OS in full
Reason: The old OS embedded a company snapshot in its own text; the snapshot went stale, the OS began asserting false things about the product, and it was overridden rather than corrected.
Prediction: Within the next ten sessions, at least one recommendation is visibly changed by the hierarchy or the displacement check — a specific piece of engineering work deferred in favour of a clock or a gate, and named as such.
Review: 2026-09-01
Outcome: pending

## D-003 — Per-surface session secrets deferred
Date: 2026-07-25
Overrides: none
Reason: the `PORTAL_SESSION_SECRET → SESSION_SECRET` fallback was retained in `3584240` as a deliberate deferral, not an oversight.
Prediction: before clinic #10, a portal session and an admin session will need independent invalidation, and sharing one secret will force a simultaneous logout of both surfaces.
Review: at clinic #10, or on the first session-invalidation incident, whichever comes first.
Outcome: pending

## D-004 — `docs/os/` established as canonical session memory
Date: 2026-07-25
Overrides: none; implements D-002
Reason: the four memory files lived outside the repository, so every session silently skipped the "load state" step of the OS protocol — `state.md` recorded 583 tests against an actual 830.
Prediction: within the next ten sessions, at least one Claude Code session opens by loading `docs/os/state.md` and visibly corrects a premise in its Phase 0 report as a result.
Review: 2026-09-15
Outcome: pending

## D-005 — Frontend modernisation program before any paying customer
Date: 2026-07-26
Overrides: G-CLOCK; H5 ranking — this work closes no gate, advances no clock,
  and answers no named prospect objection.
Reason: Founder judgement that interface credibility is a precondition for the
  first ten clinic conversations rather than a consequence of them.
Prediction: Across the first ten clinic conversations after this ships, interface
  quality appears in zero stated objections and at least one owner volunteers
  unprompted that the product looks credible. If the top-two objections remain
  price, trust, or Telugu accuracy — untested today per A-001 — the polish bought
  nothing sellable and the unspent backlog is cancelled, not continued.
Budget: 10 sessions, hard cap. public/admin/** excluded from all polish work.
  Overrun requires a new entry, not an extension of this one.
Review: after ten logged clinic conversations, or 2026-10-01, whichever is first.
Outcome: pending

## D-007 — Batch 1 portal overrun written off
Date: 2026-08-01
Overrides: none. This is **the new entry D-005's Budget clause requires** ("Overrun
  requires a new entry, not an extension of this one"). It does not amend D-005: that
  entry's cap, prediction and review date are untouched, and `D-006` is claimed by the
  unappended draft in `docs/os/decisions.md.draft`.
Decision: Batch 1 closed at 11 sessions against D-005's cap of 10. The eleventh session
  is **written off** — neither a debt carried forward nor a raised cap. D-005's cap
  stands at 10; the program stands at 11 against it.
Reason: the eleventh was the D5 split (components / mobile). The overrun's root cause was
  not the split. Four of eleven sessions went to defects the plan could not have listed,
  because the plan was written from a source-read audit and every one was only findable by
  measuring a running portal: the `--teal-600`/`--teal-700` naming collision, the absent
  global focus ring, `tokens.css:474`'s 10px overflow across eleven pages, and eight
  sub-44px touch targets including the go-live control.
Prediction: Batch 2, if scoped from measurement of the running portal rather than from
  reading source, comes in within its stated cap. If it overruns by more than one session,
  the estimating method is wrong and the cap mechanism is not the remedy.
Review: at Batch 2 close, or 2026-10-31, whichever is first.
Note: **Batch 2 is not scheduled.** G-PROOF remains false — no production deploy, no live
  call. Nothing is queued behind Batch 1. A written-off overrun is not clearance to start
  the next batch, and this entry must not be read as authorising one: per D-005's own
  terms, Batch 2 needs its own entry before a session may open it.
Outcome: pending

## D-008 — `os:check` exempts `docs/prompts/**` from the provenance diff
Date: 2026-08-07
Overrides: none — narrows the provenance rule in `scripts/os-check.js`, which is a
  mechanism rather than a gate or a prior decision entry.
Reason: `os:check` asserts two things — that the recorded state was verified at a commit,
  and that nothing since could have invalidated it — and a markdown prompt file is an input
  to a *future* session rather than a description of current state, so it cannot move a test
  count or falsify a line in `state.md`; `docs/os/` has carried this exemption from the
  start for exactly the same reason.
Trigger: `a797d144` added `docs/prompts/issue-35-sarvam-realtime-stt.md` and turned
  `os:check` red on a file that asserts nothing. It stopped the Issue 35 session at its
  first Phase 0 gate, and would have recurred for **every** future issue prompt, so the
  one-line `Verified-at` stamp was a symptom fix and was rejected as one.
Scope of the carve-out: `docs/os/` and `docs/prompts/` only. Deliberately **not** all of
  `docs/` — an audit, runbook, spec or architecture document *does* describe current state,
  and must keep invalidating a verification. Widening this to `docs/` would silently retire
  the check for `docs/architecture/ARCHITECTURE.md`, which is precisely the drift it exists
  to catch.
Prediction: the next issue prompt committed ahead of its session does not turn `os:check`
  red, and no red `os:check` between now and the review date is traceable to a file under
  `docs/prompts/`. Falsifier: if a `docs/prompts/` file is ever found to have invalidated a
  line in `state.md`, this carve-out is wrong and must be **reverted, not widened**.
Review: 2026-10-01
Outcome: pending

## D-009 — The R1 retrieval boundary is governed by INV-R1, its own invariant
Date: 2026-08-10
Overrides: none. This entry does **not** amend, renumber, reword or extend `INV-1`…`INV-6`,
  which are untouched and remain binding exactly as written. It names a boundary they were
  never scoped to reach.
Decision: **`INV-1` as written is portal-route-scoped.** Its text
  (`docs/specs/portal-v1-spec.md:40`) governs where a *route* may read a tenant identifier
  from — *"No portal route ever reads a tenant identifier from params, body, or query"* —
  and the suite honours it comprehensively at that layer: five named cross-tenant tests plus
  ~15 further INV-1 blocks across the portal suite (`05-isolation.md` §F.1). It says nothing
  about the SQL underneath, and **four of R1's six entry points are not portal routes at
  all** (WhatsApp inbound, voice turn JSON, voice turn SSE, and `checkKbRetrieval`'s
  caller-supplied argument — §A rows 1, 2, 3, 6). Phase 5 left "does INV-1 reach past the
  route layer" open as a founder call (**P5-11**). It is answered here, and the answer is
  that the retrieval query gets its own invariant rather than a stretched reading of INV-1:

  > **INV-R1** Every read of `knowledge_chunks` is tenant-scoped by a parameterised
  > predicate, and `getRelevantChunks` **denies** — returns no rows, or throws — whenever
  > the tenant cannot be resolved. It never defaults and never widens. A cross-tenant
  > negative test that **fails when the predicate is removed** is mandatory in the suite.

  Its regression defence is **T-1 and T-2** in
  `tests/knowledge/retrievalIsolation.integration.test.js` (`ce7a213`) — the two tests
  `05-isolation.md` §F.4 specified, and the last clause of INV-R1 is the property that was
  verified by executing it, not by reading the tests.
Reason: R1 is the only vector query in the repository and the only read whose rows reach a
  patient-facing prompt, it does not select `tenant_id` so nothing downstream can revalidate
  ownership (§B.R1), and Phase 5 measured that deleting its predicate left the suite at 989
  pass / 0 fail, byte-identical to baseline (§F.3, red-checked at §F.5).
Prediction: the next change that removes, defaults or conditionalises R1's tenant predicate
  turns the suite red in the same commit that makes it. Falsifier: a future session finds the
  predicate gone or weakened at HEAD with `npm test` green — in which case T-1/T-2 are
  passing for some reason other than the predicate, and **the tests are wrong, not the
  invariant**. Re-run the §F.5 mutation shim before trusting them again.
Deferred, deliberately: **P5-10 is not closed here.** `INV-1`…`INV-6` still live only in
  `docs/specs/portal-v1-spec.md:40-45`, declared binding by `portal-v2-spec.md:5`. Relocating
  them into `docs/os/` is a later session's work and was not attempted: it is a docs change
  *outside* `docs/os/`, so it cannot ride the commit that stamps `Verified-at` without
  tripping the `os:check` provenance tolerance — the same mechanism D-008 describes. Until
  that session runs, the pointer a reader of `docs/os/` needs is this entry.
Review: 2026-11-01, or at the first change to `src/modules/knowledge/knowledgeService.js`,
  whichever is first.
Outcome: pending

## D-010 — Every embedding call is bounded at 3,000 ms, and the zero-chunk prompt keeps its guard
Date: 2026-08-10
Overrides: none. It does **not** amend D-009 or `INV-R1`: R1's tenant predicate, its call
  shape, and the local-vs-exported `embed` binding at `knowledgeService.js:106` are all
  untouched. It is, however, the first change to
  `src/modules/knowledge/knowledgeService.js` since D-009, which **fires D-009's review
  trigger** ("Review: 2026-11-01, or at the first change to
  `src/modules/knowledge/knowledgeService.js`, whichever is first"). That review is
  recorded at the end of this entry rather than by editing D-009, which is append-only.
Decision: four changes, shipped in one commit because the fourth is the price of the first.
  1. `knowledgeService.embed` carries an internal **3,000 ms** deadline, overridable by
     `EMBED_TIMEOUT_MS` and read at call time. It lives **inside** the function body, not
     in a wrapper around the export, and it **composes** with a caller-supplied `signal`
     rather than replacing it.
  2. The SSE voice branch (`internalVoice.js:435-447`) passes its turn signal to
     `assembleConversationContext`. This is D-09 in `01-map.md` §5.
  3. A deadline expiry is distinguishable in the log: the error carries
     `code: 'EMBED_TIMEOUT'` and `contextAssembler.js:68` now emits `errCode`.
  4. A turn that retrieves **zero** chunks keeps the instruction not to invent
     information (Q4-3).

Why 3,000 ms — derived from measurement, not chosen. **U-4/U2-1/U5-4 were closed first**,
  because the number the timeout rests on had been quoted in three audit artifacts for
  three phases without ever being reproduced. Five calls through `embed()` itself against
  live `gemini-embedding-001` at `outputDimensionality: 768`:

  | # | text | ms |
  |---|---|---|
  | 1 | `what are your timings` (first call of a cold process) | **2,555** |
  | 2 | `do you do root canal` | 546 |
  | 3 | `రేపు అపాయింట్‌మెంట్ దొరుకుతుందా` | 625 |
  | 4 | `kitna kharcha aayega cleaning ka` | 543 |
  | 5 | `Q: Do you have parking?\nA: …` | 459 |

  Median 546 ms, mean 946 ms. **The FLOOR is call 1.** A cold process pays DNS + TLS on
  its first embedding, and 2,555 ms is 2.8× the top of the claimed 600–900 ms band. Any
  deadline below ~2.6 s would fire on the first turn after every deploy and after every
  idle-socket reap — converting a healthy call into an ungrounded one at exactly the
  moment (the genesis deploy) when the first real turn happens.
  **The CEILING is the voice turn budget.** 8,000 ms (`internalVoice.js:65-68`), less
  300–465 ms hydration (`01-map.md:75`), must still leave generation, up to two tool
  rounds, and outbound persistence room to finish. Retrieval cannot own half the turn.
  3,000 ms clears the measured cold call with ~17% headroom, is ~5.5× the warm median,
  and leaves 5,000 ms downstream.
  **The asymmetry settles the remaining doubt in favour of the smaller value.** Because
  change 4 ships alongside, a deadline that fires spuriously costs *grounding on one
  turn*, not the turn — the reply still goes out, still guarded. A deadline set too
  generously instead lets the 8,000 ms turn budget fire, and the caller hears the
  worker's static apology: the whole turn is lost. Cheap failure on one side, expensive
  on the other.

Why change 4 could not be deferred: `contextAssembler.js:67-70` catches every RAG failure
  and returns `[]`, and at HEAD zero chunks dropped the entire knowledge section —
  including the only occurrence of *"do not invent information"* anywhere in `src/`
  (`aiService.js:568`). A timeout converts a hang into a fast RAG failure, so change 1
  **raises the rate at which that path fires**. Shipping 1 without 4 would trade a hung
  turn for a confidently invented one, in Telugu, about a clinic the model knows nothing
  about — a worse outcome, not a better one. The rule applied: if a change increases the
  rate of a failure mode, the mitigation for that failure mode ships in the same commit.

Not changed, deliberately: the `embed` local-binding vs `module.exports.embed` split
  (`knowledgeService.js:106` vs `:192`/`:217`). The deadline was put inside the function
  body precisely so the split did not have to move — inside, all six entry points inherit
  the bound regardless of which binding they call; a wrapper on the export would have
  bounded four and missed R1, the one call on the patient-facing path.

Prediction: no embedding call from this repository can exceed ~3 s wall-clock, on any of
  the six entry points, and a turn whose retrieval fails still reaches the model with an
  instruction not to invent. Observable at the first production voice turn and in
  `EMBED_TIMEOUT` appearing (or not) in logs.
Falsifier: `EMBED_TIMEOUT` shows up in production logs at a rate that is not attributable
  to real Google slowness — i.e. the deadline is firing on healthy calls. Five samples on
  one machine against one region is **not a distribution** (see the UNVERIFIED note kept
  against U-4), so the cold-start floor in particular rests on a single observation. If
  that happens the answer is to raise the deadline toward 4,000 ms, **not** to remove it:
  unbounded was the state this entry exists to end.
Review: 2026-11-01, or at the first production voice turn, whichever is first.
Outcome: pending

**D-009's triggered review, recorded here (append-only; D-009 itself is untouched).**
D-009 predicted that the next change removing, defaulting or conditionalising R1's tenant
predicate would turn the suite red in the same commit. This session changed
`knowledgeService.js` without touching the predicate, and `T-1`/`T-2` in
`tests/knowledge/retrievalIsolation.integration.test.js` pass unchanged at this commit —
verified by running that file directly, not inferred from the suite total. The prediction
is **not yet exercised** (no session has attempted to weaken the predicate), so D-009's
outcome stays `pending`. What this session does confirm is the second-order claim: the
tests survive an unrelated edit to the module they defend, including one that changes
`embed`'s call signature to the SDK — they stub the transport at
`GenerativeModel.prototype.embedContent`, which is why the new `{ signal }` argument
passed straight through them.
