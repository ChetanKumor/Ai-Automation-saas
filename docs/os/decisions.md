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

## D-011 — One embedding deadline was three deadlines wearing one number; D-010's residual fired
Date: 2026-08-10
Overrides: **amends D-010, which is left standing and unedited** (append-only). D-010's
  changes 2, 3 and 4 are untouched, its 3,000 ms derivation is not revisited, and its
  Prediction/Falsifier/Review lines still read exactly as written. What changes is the
  *scope* of its change 1: 3,000 ms stops being the deadline for every embedding call and
  becomes the deadline for the path it was derived for. It does **not** amend D-009 or
  `INV-R1`: R1's tenant predicate, its call shape, and the local-vs-exported `embed`
  binding split are all untouched — which fires D-009's review trigger again ("at the first
  change to `src/modules/knowledge/knowledgeService.js`"), recorded at the end of this entry.
Decision: `knowledgeService.embed(text, signal, budget)` takes a budget **class**, and each
  call site declares which one it is. Three classes, each with its own default and its own
  env override:

  | Call site | Class | Bound | Env |
  |---|---|---|---|
  | `getRelevantChunks` (6 production entry points, `01-map.md` §2.2) | `turn` | **3,000 ms** | `EMBED_TIMEOUT_MS` |
  | `createChunk`, `updateChunk` (portal FAQ save) | `interactive` | **10,000 ms** | `EMBED_TIMEOUT_INTERACTIVE_MS` |
  | `storeChunks` (`scripts/ingest-knowledge.js`, `--kb-dir`) | `batch` | **30,000 ms** | `EMBED_TIMEOUT_BATCH_MS` |
  | `embedWarmup.warmEmbeddings` (boot, new) | `batch` | **30,000 ms** | `EMBED_TIMEOUT_BATCH_MS` |

  The **default, and the fallback for an unknown class name, is `turn`** — the tightest,
  not the most generous. A call site added later that forgets to classify itself, or
  misspells its class, gets the bound whose failure costs one turn's grounding, never the
  one that lets a request hang for thirty seconds.
  Unchanged from D-010, deliberately: the deadline still lives **inside** `embed`'s body, so
  the local-vs-exported binding split does not have to move; it **composes** with a caller
  `signal`; an already-aborted signal throws **before dispatch**; and an expiry still
  carries `code: 'EMBED_TIMEOUT'` — now also naming which bound fired and carrying `budget`
  as a field, because with three deadlines "the embedding deadline fired" identifies nothing
  actionable.

D-010's stated residual FIRED, and this is the register working rather than the register
  being wrong. D-010 recorded, against U-4: *"five samples on one machine against one region
  is not a distribution, and the cold-start floor in particular rests on a single
  observation."* One commit later that single observation was contradicted — in the suite,
  not in production. `tests/portal/portalFaqs.integration.test.js:465` POSTs a FAQ;
  `createChunk` makes the first **cold** embedding call of that test process; under
  `node --test`'s 20-way file parallelism it exceeded 3,000 ms and the route **500'd**.
  The measured cold spread, one machine, one network, one region:

  | Where | Cold | Warm |
  |---|---|---|
  | D-010 (uncontended, one process) | **2,555 ms** | 459 / 543 / 546 / 625 |
  | Session 3, first attempt (uncontended) | 1,281 / 1,371 ms | — |
  | Session 3, first attempt (20-way parallelism) | **above 3,000 ms** | — |
  | Session 3, this pass (20-way parallelism, 12 real calls, 3 processes) | **613 / 653 / 756 ms** | 431–478, median 459 |

  **613 ms to above 3,000 ms is a spread of at least 4.9x**, and Railway's path to Google
  will not be tighter than localhost's. The lesson is not "3,000 was too small". It is that
  **a bound derived by adding headroom to the last healthy sample is a bet on a distribution
  nobody has**, and that the same number cannot be right for a caller inside an 8,000 ms
  turn budget and a caller with none.

The derivations, each naming the budget it serves and the measurement it rests on:
  - **`turn` = 3,000 ms, unchanged.** D-010's derivation in full. Ceiling: the 8,000 ms
    voice turn budget (`internalVoice.js:65-68`) less 300–465 ms hydration, with generation,
    tool rounds and persistence still to come. Its asymmetry survives *only here*: a
    spurious expiry costs **grounding on one turn** and nothing more, because
    `contextAssembler.js:67-70` returns `[]` and D-010's change 4 keeps the anti-invention
    instruction in the zero-chunk prompt. Cheap to fire, expensive to miss.
  - **`interactive` = 10,000 ms.** Budget served: an owner holding a Save button. Ceiling:
    **nothing else on that request can end it** (`server.timeout` defaults to 0;
    `public/portal/faqs.js` sets no fetch timeout — `02-ingestion.md` §D.3), so this bound
    *is* the request's bound; the largest bound any other step carries is
    `DB_STATEMENT_TIMEOUT_MS` = 5,000 ms and §D.3's table lists five DB steps on this save,
    two of them plural, so the route already tolerates tens of seconds of database. Floor:
    measured **from 3,000 ms, the only value ever observed to fire** — 5,000 ms would sit
    1.7x above it, *inside* the observed spread; 10,000 ms sits 3.3x above it, outside it.
    The asymmetry inverts here: a spurious expiry is a 500 on a save the owner watched fail;
    a late one costs them patience.
  - **`batch` = 30,000 ms.** Budget served: none — an operator at a terminal, no socket,
    nothing waiting. Floor: >=10x every cold measurement in this register and >=10x the value
    known to fire; a call that reaches 30 s is wedged, not slow. It must be the most generous
    of the three because **its spurious expiry is the most expensive**: `storeChunks` commits
    row by row with no transaction, and `ingestKnowledge`'s resume check is
    `SELECT 1 … AND source = $2` — so an expiry at chunk 14 of 25 leaves the document
    half-ingested **and makes the re-run report it as `skipped`**, i.e. a permanently partial
    knowledge base reported as clean. Ceiling: the run must still terminate — measured with
    the repo's own `chunkText`, a 9–14 KB markdown document yields 23–26 chunks, so a fully
    wedged file ends in ~12 minutes instead of never.

Also shipped, and deliberately NOT presented as the fix: **warming the embedding path at
  boot** (`server.js`, after `app.listen`, never awaited, never under `node --test`,
  `EMBED_WARMUP=false` to disable). A cold portal save succeeds now because the interactive
  bound accommodates it, not because anything was warmed. Warming removes the cold
  connection cost from the first request after a deploy — which on the genesis deploy is the
  demo — and, being `batch`-classed, **measures** a slow cold start rather than truncating it
  at 3,000 ms into the one value that carries no information. It logs that measurement, so
  every deploy from here contributes a sample to exactly the residual D-010 left open. Real
  boot: 729 ms warm call, 458 ms for the next embed in the same process.

Prediction: no embedding call from this repository can exceed its class's bound, and no
  owner-facing FAQ save fails for a reason the voice turn's budget caused. `EMBED_TIMEOUT`
  in production logs now names its class, so the next occurrence identifies which caller and
  which bound without a bisect. Observable at the first production deploy and in the
  `embed_warmup` line.
Falsifier: `EMBED_TIMEOUT` with `budget: 'interactive'` or `budget: 'batch'` appearing at a
  rate not attributable to real Google slowness — i.e. a bound still derived too tight. Or
  the inverse and more likely one: the `turn` class firing often enough that turns are
  routinely ungrounded, in which case the honest answer is that retrieval does not fit in a
  voice turn at all and the fix is upstream of the deadline, not a bigger number. **Note
  what is NOT a falsifier: another single measurement.** That is what put us here.
Review: at the first production deploy, or 2026-11-01, whichever is first. Bring the
  accumulated `embed_warmup` samples — by then the cold-start floor should rest on a
  distribution rather than on any one session's afternoon.
Outcome: pending

**D-009's triggered review, recorded here (append-only; D-009 itself is untouched).**
This is the second change to `src/modules/knowledge/knowledgeService.js` since D-009 and it
again leaves R1's tenant predicate alone, so D-009's prediction is still **not exercised** and
its outcome stays `pending`. `T-1`/`T-2` pass at this commit — verified by running
`tests/knowledge/retrievalIsolation.integration.test.js` directly, not inferred from the suite
total. What this session adds to the second-order claim is that those tests also survived a
change to `embed`'s **arity**: they stub the transport at
`GenerativeModel.prototype.embedContent`, so a third argument passed straight through them.

**A note on `os:check`, which is not itself a decision but changes what every future entry
means by "green".** The gate now refuses on `# fail`, `# cancelled` **and** `# skipped`, and
on any of those counters being unparseable. Before this, `# fail 0` was the whole test, and
`# fail` counts one of the three ways a test can end without passing — Session 2 hit
`# cancelled 4, # fail 0` for real and the gate called it green. Any past entry quoting a
clean run is quoting a weaker claim than an entry written after this commit.

## D-012 — The provisioning CLI reports the tenant, not the argument; write semantics deliberately unchanged
Date: 2026-08-10
Overrides: nothing. Amends no prior entry. It acts on **P5-1**
  (`docs/os/audits/rag/05-isolation.md` §A.6) and implements **T-3** from §F.4, and it
  leaves **D2-01** / **Q2-4** (`02-ingestion.md` §D.2) open on purpose — see the split
  below.
Decision: on the `--kb-dir` provisioning path, what the operator SEES changes and what the
  CLI WRITES does not. Three changes, all in `scripts/provision-tenant.js` plus four
  read-only functions in `src/modules/provisioning/provisioningService.js`:

  1. **The target is resolved and displayed before the first row is written.**
     `describeTarget(definition)` parses the definition through the same
     `definitionSchema` the write uses — so the slug displayed is provably the slug written
     to — then READS `tenants`, `tenant_configs` and a `GROUP BY` over
     `knowledge_chunks.source`. `business_name`, slug, tenant id, status/active, config
     version and the current chunk count by source prefix are printed from those rows.
     Then a confirmation, skippable with `--yes`; a missing terminal is a **refusal**, not
     a default-yes.
  2. **`--dry-run` performs the same resolution and display**, then exits without writing.
     It used to return at `provisioningService.js:189-207`, before the slug lookup at
     `:210`, so it echoed the operator's own input.
  3. **After the run the tenant is read again** and rows actually present are reported per
     source file beside the label the run assigned (`attempted ingested → observed 1
     row(s)`). Disagreements are marked `⚠ DISCREPANCY` and nothing else happens.

  Plus **T-3**: `tests/provisioning/kbTenantBinding.integration.test.js` ingests one
  `--kb-dir` into tenant A and then tenant B and asserts both hold full copies with A's
  rows untouched.

**THE MEASUREMENT THAT SIZES THIS.** The finding was not argued, it was executed against a
  seeded scratch database. HEAD's CLI, one missing hyphen in the slug
  (`smile-dental` → `smiledental`), same `--kb-dir`:

```
✓ provisioned 'smiledental'  (tenant b25c00a2-…)
  created:  tenant, config@v1
  kb:       ingested 2 doc(s): hours.md, services.md
  3. Knowledge base ingested. Add more docs any time with --kb-dir.
exit=0
```

  A **second tenant** was created and the clinic's whole knowledge base ingested into it,
  and the run reported success. The operator's only signal was the filenames they had just
  typed. The same command now prints the target first and refuses (§A.6's mis-aim, with the
  CREATE path still open underneath it), writing nothing.

**WHAT `--dry-run` NOW SHOWS, AND WHY IT IS THE WHOLE POINT.** The definition file and the
  database row are allowed to carry different names, and until now only the file's name
  ever reached the screen:

```
── Target — read from the database, not from your arguments ──
  business_name:    Smile Dental (Voice Dev)      ← the row
  slug:             smile-dental
  tenant id:        e9070982-8c3f-453e-9e44-22e2f9071a58
  knowledge_chunks: 12 row(s) — by source prefix:
      faq                                8 row(s)
      hours.md                           4 row(s)
───────────────────────────────────────────────────────────
DRY RUN — no rows written.
{ "tenant": { "business_name": "Sunrise Dental Care", … } }   ← the file
```

  Both halves are printed and **labelled separately**. Conflating them is what made the old
  dry run structurally incapable of catching a mis-aim, and the test that pins it asserts
  the row's name appears in the target block and the file's name does not.

**THE ONE BEHAVIOUR THAT IS REFUSED, AND WHY IT IS SCOPED THE WAY IT IS.** §6.1(b) of the
  session brief required an unresolved tenant to fail loudly and not create. Applied
  literally to every path that would disable tenant creation, which is the CLI's purpose.
  It is therefore scoped to **`--kb-dir` against a slug that names no tenant**, which is
  exactly where the audit found the hazard: `--kb-dir` is step 3 of the runbook the CLI
  itself prints, so on the documented path the tenant always already exists, and a slug
  that does not resolve there is a typo rather than a new clinic. Creating a tenant is
  still one command — the same one without `--kb-dir`. **This guard is the one `--yes`
  cannot skip**, deliberately: a confirmation prompt is worth nothing in the
  non-interactive case, which is the case a runbook actually runs in.

**WHAT WAS NOT CHANGED, AND THE EVIDENCE.** `ingestKnowledge`, `provisionTenant` and
  `writeConfigV1` are **byte-identical to HEAD** — extracted from both revisions and
  compared, 1240 / 4659 / 414 bytes each. The diff of
  `src/modules/provisioning/provisioningService.js` is two hunks, both pure insertions
  (`@@ -156,0 +157,108 @@` and `@@ -299,0 +408,5 @@`), with **zero removed lines**. The
  `source` dedup (`WHERE tenant_id = $1 AND source = $2`), the skip semantics
  (`result.skipped.push(source); continue`) and the write order are what they were.

**WHAT THE READ-BACK REVEALED AND THIS SESSION DID NOT ACT ON — the input the next session
  is waiting on.** The per-source report now puts a number on screen where there was none,
  and the number cannot answer the question it invites. `hours.md attempted skipped
  observed 4 row(s)` is printed identically whether the document is complete or was
  truncated by a failure at chunk 5 of 26: **nothing in the schema records how many chunks
  a document should have** (`schema.sql:289-301` — no status column, no expected count, no
  completion flag), so "fully ingested" and "partially ingested and skipped" are the same
  observation. That is D2-01/Q2-4 exactly, and it is now VISIBLE rather than invisible,
  which is as far as a reporting change can take it. Fixing it means changing the dedup key
  or adding a marker, i.e. changing what is written.

Also unresolved and deliberately not touched: the opposite retry semantics of
  `provisioningService.ingestKnowledge` (dedups by source) and `scripts/ingest-knowledge.js`
  (no dedup — a re-run duplicates rows 1..N−1); wrapping `storeChunks` in a transaction;
  and the product-surface question of whether document chunks should be deletable at all
  (`faqService.js:109-112` filters them out of the FAQ editor, and there is no admin chunk
  route, so a mis-aimed document is still removable only in `psql`).

Prediction: an operator running the onboarding runbook against the wrong clinic sees the
  wrong clinic's name before they confirm, and a mistyped slug on the `--kb-dir` path
  cannot mint a tenant at all. Observable at customer #1, which is P5-1's stated trigger.
Falsifier: a mis-aimed ingest that still lands — i.e. the operator reads the target block
  and confirms anyway, which would mean the display is present but not legible, not that
  the read is wrong. Also: `--yes` becoming the habitual invocation, which would reduce
  change 1 to change 3 (a report after the fact) and leave only the unresolved-slug refusal
  doing prevention.
Review: at customer #1's onboarding, or when Session 4B changes the dedup key — whichever
  is first. Bring the per-source `attempted → observed` output from the real run.
Outcome: pending
