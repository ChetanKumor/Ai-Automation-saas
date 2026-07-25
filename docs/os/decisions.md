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
