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
