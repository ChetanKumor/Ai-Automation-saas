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
Status: partially evidenced on the Plivo side, unconfirmed on the Meta side.

## A-006 — Latency on Railway with co-located Postgres lands at 0.6–1.5s first audio
Depends on it: demo credibility and the "sounds human" claim
Cheapest test: the genesis deploy itself. Measure on the first production call.
Status: modelled, not measured. ~55–65% of observed dev latency attributed to local environment and Neon cold starts.
